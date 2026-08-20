import fs from 'node:fs';
import path from 'node:path';
import { QueueManager } from './queue.js';
import { PlaybackController, type SendFn } from './playback.js';
import { VoiceManager } from './voice.js';
import type { LibrespotManager } from './librespot.js';
import { config } from './config.js';
import type { PlaybackState, TrackInfo } from '@vaporzr/shared';

/**
 * One guild's isolated playback: its own queue, voice connection, and playback
 * controller. Every server the bot serves gets a Session, so any number of
 * guilds can queue and stream independently at the same time.
 */
export class Session {
  readonly queue: QueueManager;
  readonly voice: VoiceManager;
  readonly playback: PlaybackController;

  constructor(
    readonly guildId: string,
    private librespot: LibrespotManager | null,
  ) {
    this.queue = new QueueManager();
    this.voice = new VoiceManager(() => {});
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
}

/**
 * Lazily creates per-guild Sessions and tracks which one the desktop/browser
 * panels + visualizer mirror (the "primary" guild — first one the bot joined).
 */
export class SessionManager {
  private sessions = new Map<string, Session>();
  private primaryGuildId: string | null = null;
  private librespot: LibrespotManager | null = null;
  private createdHooks: Array<(s: Session) => void> = [];
  private primaryHooks: Array<(s: Session | null) => void> = [];
  private saveTimers = new Map<string, NodeJS.Timeout>();

  /** Called once the bot's librespot instance exists (sessions are created after). */
  attachLibrespot(librespot: LibrespotManager | null): void {
    this.librespot = librespot;
  }

  private queueFileFor(guildId: string): string {
    return path.join(config.dataDir, 'queues', `${guildId}.json`);
  }

  private persist(guildId: string): void {
    const s = this.sessions.get(guildId);
    if (!s) return;
    const data = s.queue.serialize();
    const file = this.queueFileFor(guildId);
    if (data.tracks.length === 0) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        /* ignore */
      }
      return;
    }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(data, null, 2));
    } catch (err) {
      console.warn(`[vaporzr] could not persist queue for ${guildId}:`, err instanceof Error ? err.message : err);
    }
  }

  private schedulePersist(guildId: string): void {
    const timer = this.saveTimers.get(guildId);
    if (timer) clearTimeout(timer);
    this.saveTimers.set(guildId, setTimeout(() => this.persist(guildId), 3000));
  }

  private restore(guildId: string, s: Session): void {
    const file = this.queueFileFor(guildId);
    if (!fs.existsSync(file)) return;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8')) as {
        tracks: TrackInfo[];
        currentIndex: number;
        state: PlaybackState;
      };
      s.queue.restore(data);
      const restored = s.queue.getSnapshot().tracks.length;
      console.log(`[vaporzr] restored ${restored} queued track(s) for guild ${guildId} (paused)`);
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
