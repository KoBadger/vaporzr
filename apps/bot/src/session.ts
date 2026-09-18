import fs from 'node:fs';
import path from 'node:path';
import { QueueManager } from './queue.js';
import { PlaybackController, type SendFn } from './playback.js';
import { VoiceManager } from './voice.js';
import type { SpotifyBackend } from './librespot.js';
import { config } from './config.js';
import type { PlaybackState, TrackInfo } from '@vaporzr/shared';
import * as EW from './endlesswave.js';

/**
 * One guild's isolated playback: its own queue, voice connection, and playback
 * controller. Every server the bot serves gets a Session, so any number of
 * guilds can queue and stream independently at the same time.
 */
export class Session {
  readonly queue: QueueManager;
  readonly voice: VoiceManager;
  readonly playback: PlaybackController;
  endlessWave = EW.createState();

  constructor(
    readonly guildId: string,
    private librespot: SpotifyBackend | null,
  ) {
    this.queue = new QueueManager();
    this.voice = new VoiceManager(() => {});
    this.voice.setFadeOut(config.crossfadeMs / 1000);
    this.voice.setDucking(config.ducking);
    this.playback = new PlaybackController(this.queue, () => {}, this.voice, this.librespot);
  }

  /** Feed the spectrum analyzer (only the primary session should). */
  setAnalyzer(enabled: boolean): void {
    this.playback.setAnalyzerTap(enabled);
  }

  /** Route visualizer state messages to a sink (bridge broadcast, or a no-op). */
  setVisualizerSink(fn: SendFn): void {
    this.playback.setSendVisualizer(fn);
  }

  /** Tap the raw PCM stream that feeds the voice channel (48 kHz stereo Int16). */
  setPcmSink(fn: ((data: Buffer) => void) | null): void {
    this.voice.setPcmTap(fn);
  }

  /**
   * Remove a queue track and, when it was the one playing, hand playback off to
   * the new current track (or stop when there is nothing left to advance to) so
   * audio never keeps playing a track the user just deleted.
   */
  removeFromQueue(index: number): TrackInfo | undefined {
    const before = this.queue.getSnapshot();
    const wasCurrent = index === before.currentIndex;
    const wasPlaying = this.queue.getState().playing;
    const hadNext = index < before.tracks.length - 1;
    const removed = this.queue.remove(index);
    if (!removed || !wasCurrent || !wasPlaying) return removed;

    if (hadNext) {
      // A later track is now current — start it.
      void this.playback.play().catch((err) => {
        console.warn(
          '[vaporzr] playback after removing the current track failed:',
          err instanceof Error ? err.message : err,
        );
      });
    } else {
      // The tail (or the whole queue) was removed: stop instead of replaying
      // the previous track, and drop out of the playing state.
      this.playback.stopAll();
      if (this.queue.getSnapshot().tracks.length > 0) {
        this.queue.setState({ playing: false });
      }
    }
    return removed;
  }
}

/**
 * Lazily creates per-guild Sessions and tracks which one the desktop/browser
 * panels + visualizer mirror (the "primary" guild — first one the bot joined).
 */
export class SessionManager {
  private sessions = new Map<string, Session>();
  private primaryGuildId: string | null = null;
  private librespot: SpotifyBackend | null = null;
  private createdHooks: Array<(s: Session) => void> = [];
  private primaryHooks: Array<(s: Session | null) => void> = [];
  private saveTimers = new Map<string, NodeJS.Timeout>();

  /** Called once the bot's librespot instance exists (sessions are created after). */
  attachLibrespot(librespot: SpotifyBackend | null): void {
    this.librespot = librespot;
  }

  private queueFileFor(guildId: string): string {
    return path.join(config.dataDir, 'queues', `${guildId}.json`);
  }

  private persist(guildId: string): void {
    const s = this.sessions.get(guildId);
    if (!s) return;
    const data = s.queue.serialize();
    const ew = EW.serializeState(s.endlessWave);
    const file = this.queueFileFor(guildId);
    if (data.tracks.length === 0 && !ew.active) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        /* ignore */
      }
      return;
    }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ ...data, endlessWave: ew }, null, 2));
    } catch (err) {
      console.warn(`[vaporzr] could not persist queue for ${guildId}:`, err instanceof Error ? err.message : err);
    }
  }

  private schedulePersist(guildId: string): void {
    const timer = this.saveTimers.get(guildId);
    if (timer) clearTimeout(timer);
    const t = setTimeout(() => this.persist(guildId), 3000);
    t.unref?.();
    this.saveTimers.set(guildId, t);
  }

  /**
   * Persist every guild immediately. Called on shutdown so a redeploy/restart
   * can't drop the last few seconds of queue changes still sitting on the 3s
   * debounce (process.exit() discards the unref'd timers).
   */
  flushAll(): void {
    const guildIds = new Set<string>([...this.saveTimers.keys(), ...this.sessions.keys()]);
    for (const guildId of guildIds) {
      const timer = this.saveTimers.get(guildId);
      if (timer) clearTimeout(timer);
      this.persist(guildId);
    }
    this.saveTimers.clear();
  }

  private restore(guildId: string, s: Session): void {
    const file = this.queueFileFor(guildId);
    if (!fs.existsSync(file)) return;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8')) as {
        tracks: TrackInfo[];
        currentIndex: number;
        state: PlaybackState;
        endlessWave?: unknown;
      };
      s.queue.restore(data);
      const restored = s.queue.getSnapshot().tracks.length;
      const wasPlaying = Boolean((data.state as { playing?: boolean } | undefined)?.playing);
      // A queue persisted while PAUSED is almost always stale (e.g. a redeploy
      // hours later). Restoring it silently made the next `V@p` look like it
      // "auto-added" a pile of extra tracks. Only resume queues that were
      // actually mid-playback; otherwise start the session clean.
      if (!wasPlaying && !config.keepPausedQueue) {
        s.queue.clear();
        console.log(
          `[vaporzr] ignoring stale paused queue for guild ${guildId} (${restored} track(s)) — starting fresh`,
        );
        return;
      }
      console.log(
        `[vaporzr] restored ${restored} queued track(s) for guild ${guildId} (${wasPlaying ? 'was playing' : 'paused, kept'})`,
      );
      // Warm the current + next stream URLs in the background so the first
      // play after a restart starts instantly instead of resolving cold.
      const cur = s.queue.getCurrentTrack();
      if (cur) s.playback.prefetchStream(cur);
      const snap = s.queue.getSnapshot();
      const next = snap.tracks[snap.currentIndex + 1];
      if (next) s.playback.prefetchStream(next);
      if (data.endlessWave) {
        s.endlessWave = EW.restoreState(data.endlessWave as Parameters<typeof EW.restoreState>[0]);
        if (s.endlessWave.active) {
          console.log(`[vaporzr] restored Endless Wave for guild ${guildId} (${s.endlessWave.generated} generated)`);
        }
      }
    } catch (err) {
      console.warn(`[vaporzr] could not restore queue for ${guildId}:`, err instanceof Error ? err.message : err);
    }
  }

  onSessionCreated(cb: (s: Session) => void): void {
    this.createdHooks.push(cb);
  }

  onPrimaryChanged(cb: (s: Session | null) => void): void {
    this.primaryHooks.push(cb);
  }

  /** The guild id the desktop/browser panels act on. */
  get guildId(): string | null {
    return this.primaryGuildId;
  }

  /** Get (creating if needed) the isolated session for a guild. */
  get(guildId: string): Session {
    let s = this.sessions.get(guildId);
    if (!s) {
      s = new Session(guildId, this.librespot);
      this.sessions.set(guildId, s);
      this.restore(guildId, s);
      s.queue.subscribe({
        onQueueChanged: () => this.schedulePersist(guildId),
        onStateChanged: () => this.schedulePersist(guildId),
      });
      for (const cb of this.createdHooks) cb(s);
      if (guildId === this.primaryGuildId) {
        for (const cb of this.primaryHooks) cb(s);
      }
    }
    return s;
  }

  /** The session the desktop/browser panel + visualizer currently mirror. */
  get primary(): Session | null {
    if (!this.primaryGuildId) return null;
    return this.sessions.get(this.primaryGuildId) ?? null;
  }

  /** Select which guild's playback the panel/visualizer mirrors. */
  setPrimary(guildId: string | null): void {
    this.primaryGuildId = guildId;
    for (const cb of this.primaryHooks) cb(this.primary);
  }

  all(): Session[] {
    return [...this.sessions.values()];
  }
}
