import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '@vaporzr/core/config';
import {
  DECK_CUE_SLOTS,
  DECK_EQ_MAX_DB,
  DECK_EQ_MIN_DB,
  DeckMixer,
  type DeckEq,
  type DeckId,
  type DeckMixerState,
  type DeckRecordState,
  type DeckSyncState,
} from '@vaporzr/core/deckMixer';
import { downloadToTempFile } from '@vaporzr/core/mediaDownload';
import type { ResolvedTrack } from '@vaporzr/core/spotify';
import { probeDuration } from '@vaporzr/core/suno';
import { estimateTempo } from '@vaporzr/core/tempo';
import type { VoiceManager } from './voice.js';

/**
 * One guild's live decks: resolution, downloads and the takeover of the voice
 * stream. The mixer itself (`@vaporzr/core/deckMixer`) is transport-agnostic;
 * everything Discord-specific — queue pause, voice start/stop, temp files,
 * recording and beat-lock — lives here.
 */

export interface DeckControllerOptions {
  guildId: string;
  voice: VoiceManager;
  /** Turn a query/URL into candidate tracks (the bot's `resolvePlayInput`). */
  resolve: (query: string) => Promise<ResolvedTrack[]>;
  /** Mint a playable stream URL for a track that has none (Spotify → YouTube). */
  resolveStream: (track: ResolvedTrack) => Promise<string | undefined>;
  /** Pause the normal queue before the decks take over the stream. */
  pauseQueue: () => void;
  /** Throttled state push (bridge broadcast). */
  onState: (state: DeckMixerState) => void;
  /** Publish a finished recording (Discord upload, CDN, …). Returns a URL. */
  uploadRecording?: (file: string, name: string) => Promise<string | null>;
}

export interface DeckActionResult {
  ok: boolean;
  message: string;
  /** Set when the action produced a file (a finished set recording). */
  file?: string;
  fileName?: string;
}

const EQ_BANDS: Array<keyof DeckEq> = ['low', 'mid', 'high'];
/** How often the beat-lock servo measures and corrects drift. */
const DRIFT_INTERVAL_MS = 400;
/** Audio written to disk while recording: 48 kHz stereo Int16. */
const REC_BYTES_PER_MS = 192;

interface Recording {
  stream: fs.WriteStream;
  file: string;
  startedAt: number;
  bytes: number;
}

export class DeckController {
  private mixer: DeckMixer;
  private engaged = false;
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private idleGuard: ReturnType<typeof setInterval> | null = null;
  private driftTimer: ReturnType<typeof setInterval> | null = null;
  /** Deck the other one is locked to, or null when lock is off. */
  private lockMaster: DeckId | null = null;
  private driftMs = 0;
  private rec: Recording | null = null;
  private record: DeckRecordState = { active: false, elapsedMs: 0, lastUrl: null, lastName: null };
  /** uri -> downloaded file, so re-loading a track doesn't re-download it. */
  private fileCache = new Map<string, string>();
  private readonly opts: DeckControllerOptions;

  constructor(opts: DeckControllerOptions) {
    this.opts = opts;
    this.mixer = new DeckMixer({
      sink: (pcm) => {
        // A set recording taps the master mix, engaged or not.
        this.tapRecording(pcm);
        if (!this.engaged) return true;
        // A live set is never "idle" — without this the voice layer's
        // auto-leave countdown fires mid-mix and the bot drops out.
        this.opts.voice.cancelIdleLeave();
        return this.opts.voice.feedPcm(pcm);
      },
      onState: () => this.schedulePush(),
    });
  }

  state(): DeckMixerState {
    const sync: DeckSyncState | null = this.lockMaster
      ? {
          master: this.lockMaster,
          follower: this.lockMaster === 'a' ? 'b' : 'a',
          driftMs: this.driftMs,
        }
      : null;
    return { ...this.mixer.state(), sync, record: { ...this.record } };
  }

  isEngaged(): boolean {
    return this.engaged;
  }

  /* ------------------------------------------------------------- loading -- */

  async load(deck: DeckId, query: string): Promise<DeckActionResult> {
    const q = query.trim();
    if (!q) return { ok: false, message: 'Give me something to load (a song name or a link).' };
    const tracks = await this.opts.resolve(q).catch(() => [] as ResolvedTrack[]);
    const track = tracks[0];
    if (!track) return { ok: false, message: `Couldn't find anything for "${q.slice(0, 60)}".` };

    let url = track.streamUrl;
    if (!url) url = await this.opts.resolveStream(track).catch(() => undefined);
    if (!url) return { ok: false, message: `Couldn't resolve a playable stream for "${track.name}".` };

    const file = await this.materialise(track, url);
    if (!file) return { ok: false, message: `Couldn't download "${track.name}".` };

    let durationMs = track.durationMs || 0;
    if (!durationMs) durationMs = (await probeDuration(file).catch(() => null)) ?? 0;

    this.engage();
    this.mixer.load(
      deck,
      {
        file,
        title: track.name,
        artist: (track.artists ?? []).join(', '),
        durationMs,
        bpm: null,
      },
      { play: false },
    );
    // Tempo is needed for SYNC, but detection costs a few hundred ms of ffmpeg —
    // never block the load on it.
    void estimateTempo(file)
      .then((bpm) => {
        if (bpm && this.mixer.state()[deck].source?.file === file) this.mixer.setBpm(deck, bpm);
      })
      .catch(() => {});
    return {
      ok: true,
      message: `Deck ${deck.toUpperCase()} cued: **${track.name}**${durationMs ? ` (${Math.round(durationMs / 1000)}s)` : ''}.`,
    };
  }

  /** Download to a seekable local file (googlevideo 403s ffmpeg's HTTPS client). */
  private async materialise(track: ResolvedTrack, url: string): Promise<string | null> {
    if (!/^https?:\/\//i.test(url)) return fs.existsSync(url) ? url : null;
    const cached = this.fileCache.get(track.uri);
    if (cached && fs.existsSync(cached)) return cached;
    const file = await downloadToTempFile(url);
    if (!file) return null;
    this.fileCache.set(track.uri, file);
    // Bound the cache: a long set shouldn't fill the container's /tmp.
    while (this.fileCache.size > 12) {
      const oldest = this.fileCache.keys().next().value;
      if (!oldest) break;
      const stale = this.fileCache.get(oldest);
      this.fileCache.delete(oldest);
      if (stale) fs.rm(stale, { force: true }, () => {});
    }
    return file;
  }

  /* ------------------------------------------------------------- controls -- */

  play(deck?: DeckId): DeckActionResult {
    if (!this.engaged) return { ok: false, message: 'Load a deck first.' };
    this.mixer.play(deck);
    return { ok: true, message: deck ? `Deck ${deck.toUpperCase()} rolling.` : 'Decks rolling.' };
  }

  pause(deck?: DeckId): DeckActionResult {
    this.mixer.pause(deck);
    return { ok: true, message: deck ? `Deck ${deck.toUpperCase()} paused.` : 'Decks paused.' };
  }

  seek(deck: DeckId, ms: number): DeckActionResult {
    this.mixer.seek(deck, Math.max(0, Math.round(ms)));
    return { ok: true, message: `Deck ${deck.toUpperCase()} → ${formatMs(ms)}.` };
  }

  /** Nudge a deck by ±ms — the manual fix for a drifting beat grid. */
  nudge(deck: DeckId, deltaMs: number): DeckActionResult {
    const pos = this.mixer.state()[deck].positionMs;
    return this.seek(deck, pos + deltaMs);
  }

  crossfader(x: number): DeckActionResult {
    this.mixer.setCrossfader(x);
    const pct = Math.round(this.mixer.getCrossfader() * 100);
    return { ok: true, message: `Crossfader ${pct}% → ${pct < 50 ? 'A' : pct > 50 ? 'B' : 'centre'}.` };
  }

  gain(deck: DeckId, value: number): DeckActionResult {
    this.mixer.setGain(deck, value);
    return { ok: true, message: `Deck ${deck.toUpperCase()} trim ${Math.round(value * 100)}%.` };
  }

  eq(deck: DeckId, band: keyof DeckEq, db: number): DeckActionResult {
    if (!EQ_BANDS.includes(band)) return { ok: false, message: 'Unknown EQ band.' };
    const clamped = Math.max(DECK_EQ_MIN_DB, Math.min(DECK_EQ_MAX_DB, Number.isFinite(db) ? db : 0));
    this.mixer.setEqBand(deck, band, clamped);
    const state = clamped <= DECK_EQ_MIN_DB + 0.5 ? 'killed' : `${clamped > 0 ? '+' : ''}${clamped} dB`;
    return { ok: true, message: `Deck ${deck.toUpperCase()} ${band} ${state}.` };
  }

  kill(deck: DeckId, band: keyof DeckEq): DeckActionResult {
    if (!EQ_BANDS.includes(band)) return { ok: false, message: 'Unknown EQ band.' };
    this.mixer.killBand(deck, band);
    const now = this.mixer.state()[deck].eq[band];
    return {
      ok: true,
      message: `Deck ${deck.toUpperCase()} ${band} ${now <= DECK_EQ_MIN_DB + 0.5 ? 'KILLED' : 'restored'}.`,
    };
  }

  tempo(deck: DeckId, ratio: number): DeckActionResult {
    this.mixer.setTempo(deck, ratio);
    return { ok: true, message: `Deck ${deck.toUpperCase()} tempo ${(ratio * 100).toFixed(1)}%.` };
  }

  /**
   * Beat-match the follower deck to the master (default: B → A): tempo first
   * (atempo, pitch preserved), then align the beat phase by re-seeking the
   * follower by less than one beat.
   *
   * The phase step assumes a grid anchored at the track's start, which is right
   * for most dance/pop edits and wrong for free-tempo intros — `nudge` exists
   * for the cases it gets wrong, and beat-lock (`lock`) keeps it honest after.
   */
  sync(master: DeckId = 'a'): DeckActionResult {
    const st = this.mixer.state();
    const follower: DeckId = master === 'a' ? 'b' : 'a';
    const m = st[master];
    const f = st[follower];
    const label = (id: DeckId): string => id.toUpperCase();
    if (!m.source || !f.source) return { ok: false, message: 'Load both decks before syncing.' };
    const bpmM = m.bpm;
    const bpmF = f.bpm;
    if (!bpmM || !bpmF) {
      return {
        ok: false,
        message: `No BPM yet on deck ${!bpmM ? label(master) : label(follower)} — give it a second (detection runs after load) or nudge manually.`,
      };
    }
    const ratio = bpmM / bpmF;
    if (ratio < 0.9 || ratio > 1.1) {
      return { ok: false, message: `${Math.round(bpmM)} vs ${Math.round(bpmF)} BPM is too far to beat-match cleanly.` };
    }
    if (Math.abs(ratio - 1) > 0.001) this.mixer.setTempo(follower, f.tempo * ratio);

    const beatMs = 60_000 / bpmM;
    const phaseM = (m.positionMs % beatMs) / beatMs;
    const phaseF = (f.positionMs % beatMs) / beatMs;
    let delta = (phaseM - phaseF) * beatMs;
    if (delta < -beatMs / 2) delta += beatMs;
    if (delta > beatMs / 2) delta -= beatMs;
    if (Math.abs(delta) > 12) this.mixer.seek(follower, f.positionMs + delta);

    return {
      ok: true,
      message: `Synced — ${label(follower)} stretched ${(ratio * 100).toFixed(1)}% to ${Math.round(bpmM)} BPM${Math.abs(delta) > 12 ? `, phase ${delta > 0 ? '+' : ''}${Math.round(delta)}ms` : ', already in phase'}.`,
    };
  }

  /* ------------------------------------------------------- cues and loops -- */

  setCue(deck: DeckId, slot: number, ms?: number): DeckActionResult {
    if (!Number.isFinite(slot) || slot < 1 || slot > DECK_CUE_SLOTS) {
      return { ok: false, message: `Hot cues are 1-${DECK_CUE_SLOTS}.` };
    }
    const st = this.mixer.state()[deck];
    if (!st.source) return { ok: false, message: `Deck ${deck.toUpperCase()} is empty.` };
    this.mixer.setCue(deck, slot, ms);
    const at = this.mixer.state()[deck].cues[Math.round(slot) - 1];
    return { ok: true, message: `Cue ${slot} on ${deck.toUpperCase()} → ${formatMs(at ?? 0)}.` };
  }

  jumpCue(deck: DeckId, slot: number): DeckActionResult {
    if (!this.mixer.jumpCue(deck, slot)) {
      return {
        ok: false,
        message: `Cue ${slot} on ${deck.toUpperCase()} is empty — tap it again while playing to set it.`,
      };
    }
    const at = this.mixer.state()[deck].positionMs;
    return { ok: true, message: `Deck ${deck.toUpperCase()} → cue ${slot} (${formatMs(at)}).` };
  }

  clearCue(deck: DeckId, slot: number): DeckActionResult {
    this.mixer.clearCue(deck, slot);
    return { ok: true, message: `Cue ${slot} on ${deck.toUpperCase()} cleared.` };
  }

  /** Loop the next `beats` beats from the current, beat-quantised position. */
  loopBeats(deck: DeckId, beats = 4): DeckActionResult {
    const st = this.mixer.state()[deck];
    if (!st.source) return { ok: false, message: `Deck ${deck.toUpperCase()} is empty.` };
    this.mixer.loopBeats(deck, beats);
    const loop = this.mixer.state()[deck].loop;
    const bpm = st.bpm ? `${Math.round(st.bpm)} BPM` : 'assumed 120 BPM';
    return {
      ok: true,
      message: `Deck ${deck.toUpperCase()} looping ${beats} beats (${bpm}, ${loop ? formatMs(loop.outMs - loop.inMs) : '—'}).`,
    };
  }

  loopToggle(deck: DeckId): DeckActionResult {
    const before = this.mixer.state()[deck].loop;
    this.mixer.toggleLoop(deck);
    const after = this.mixer.state()[deck].loop;
    return {
      ok: true,
      message: after
        ? `Deck ${deck.toUpperCase()} loop ${formatMs(after.inMs)}–${formatMs(after.outMs)}.`
        : before
          ? `Deck ${deck.toUpperCase()} loop off.`
          : `Deck ${deck.toUpperCase()} has no loop yet — \`loop <beats>\` first.`,
    };
  }

  loopClear(deck: DeckId): DeckActionResult {
    this.mixer.clearLoop(deck);
    return { ok: true, message: `Deck ${deck.toUpperCase()} loop cleared.` };
  }

  /* ------------------------------------------------------------ beat-lock -- */

  /**
   * Continuous beat-lock. The follower's phase error is measured every 400 ms
   * and corrected by a micro resample (±0.8%), so it converges without the
   * audible gap a decoder restart would cause. A large slip is fixed with one
   * hard seek.
   */
  lock(master: DeckId | null): DeckActionResult {
    if (!master) {
      this.lockMaster = null;
      this.stopDriftServo();
      this.mixer.setMicroTempo('a', 1);
      this.mixer.setMicroTempo('b', 1);
      this.driftMs = 0;
      this.opts.onState(this.state());
      return { ok: true, message: 'Beat-lock off.' };
    }
    const st = this.mixer.state();
    const follower: DeckId = master === 'a' ? 'b' : 'a';
    if (!st[master].source || !st[follower].source) {
      return { ok: false, message: 'Load both decks before locking them together.' };
    }
    const synced = this.sync(master);
    if (!synced.ok) return synced;
    this.lockMaster = master;
    this.startDriftServo();
    this.opts.onState(this.state());
    return { ok: true, message: `Locked ${follower.toUpperCase()} → ${master.toUpperCase()} — it will stay in phase.` };
  }

  private startDriftServo(): void {
    if (this.driftTimer) return;
    this.driftTimer = setInterval(() => this.servoTick(), DRIFT_INTERVAL_MS);
    this.driftTimer.unref?.();
  }

  private stopDriftServo(): void {
    if (!this.driftTimer) return;
    clearInterval(this.driftTimer);
    this.driftTimer = null;
  }

  private servoTick(): void {
    const master = this.lockMaster;
    if (!master) return;
    const follower: DeckId = master === 'a' ? 'b' : 'a';
    const st = this.mixer.state();
    const m = st[master];
    const f = st[follower];
    if (!m.playing || !f.playing || !m.bpm) {
      this.mixer.setMicroTempo(follower, 1);
      return;
    }
    const beatMs = 60_000 / m.bpm;
    let err = (f.positionMs % beatMs) - (m.positionMs % beatMs);
    if (err > beatMs / 2) err -= beatMs;
    if (err < -beatMs / 2) err += beatMs;
    this.driftMs = Math.round(err);

    if (Math.abs(err) > beatMs * 0.45) {
      // Half a beat out: only a hard jump can fix that.
      this.mixer.seek(follower, f.positionMs - err);
      this.mixer.setMicroTempo(follower, 1);
      this.schedulePush();
      return;
    }
    if (Math.abs(err) < 4) {
      this.mixer.setMicroTempo(follower, 1);
      return;
    }
    // Ahead (err > 0) → play slightly slower; the correction is proportional, so
    // it settles instead of oscillating.
    const correction = Math.max(-0.008, Math.min(0.008, -err / 9000));
    this.mixer.setMicroTempo(follower, 1 + correction);
  }

  /* ------------------------------------------------------------ recording -- */

  /** Start capturing the master mix to disk (mp3 when stopped). */
  recStart(): DeckActionResult {
    if (this.rec) return { ok: false, message: 'Already recording.' };
    if (!this.engaged) return { ok: false, message: 'Load a deck first — there is nothing to record.' };
    try {
      const dir = path.join(config.dataDir, 'decks');
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const file = path.join(dir, `set-${stamp}.pcm`);
      const stream = fs.createWriteStream(file);
      stream.on('error', (err) => console.warn(`[deck] recording write failed: ${err.message}`));
      this.rec = { stream, file, startedAt: Date.now(), bytes: 0 };
      this.record = { active: true, elapsedMs: 0, lastUrl: this.record.lastUrl, lastName: this.record.lastName };
      return { ok: true, message: '🔴 Recording the set.' };
    } catch (err) {
      return { ok: false, message: `Couldn't start recording: ${err instanceof Error ? err.message : err}` };
    }
  }

  /** Stop recording, encode to mp3 and publish it. */
  async recStop(): Promise<DeckActionResult> {
    const rec = this.rec;
    if (!rec) return { ok: false, message: 'Not recording.' };
    this.rec = null;
    await new Promise<void>((resolve) => rec.stream.end(() => resolve()));
    const mp3 = rec.file.replace(/\.pcm$/, '.mp3');
    const encoded = await encodeMp3(rec.file, mp3);
    fs.rm(rec.file, { force: true }, () => {});
    if (!encoded) {
      this.record = { ...this.record, active: false, elapsedMs: 0 };
      return { ok: false, message: 'Recording stopped but the mp3 encode failed.' };
    }
    const name = path.basename(mp3);
    const url = (await this.opts.uploadRecording?.(mp3, name).catch(() => null)) ?? null;
    this.record = { active: false, elapsedMs: 0, lastUrl: url, lastName: name };
    this.opts.onState(this.state());
    const mins = Math.round(rec.bytes / REC_BYTES_PER_MS / 1000 / 60);
    return {
      ok: true,
      message: url ? `🎚️ Set saved (${mins} min): ${url}` : `🎚️ Set saved on the server: \`${mp3}\` (${mins} min).`,
      file: url ? undefined : mp3,
      fileName: name,
    };
  }

  private tapRecording(pcm: Buffer): void {
    const rec = this.rec;
    if (!rec) return;
    rec.bytes += pcm.length;
    rec.stream.write(pcm);
    const elapsedMs = Math.round(rec.bytes / REC_BYTES_PER_MS);
    // Only push once a second; the panel clock interpolates between pushes.
    if (elapsedMs - this.record.elapsedMs >= 500) {
      this.record = { ...this.record, elapsedMs };
    }
  }

  /** Stop the decks and hand the stream back (queued music stays paused). */
  stop(): DeckActionResult {
    if (this.rec) void this.recStop().catch(() => {});
    this.lockMaster = null;
    this.stopDriftServo();
    this.mixer.stopAll();
    if (this.engaged) {
      this.engaged = false;
      try {
        this.opts.voice.stopStream();
      } catch {
        /* already down */
      }
      this.opts.voice.setExpectingPcm(false);
      this.opts.voice.setStreamDrain(null);
    }
    this.stopIdleGuard();
    this.opts.onState(this.state());
    return { ok: true, message: 'Decks down — queue is paused, `V@r` to bring the music back.' };
  }

  dispose(): void {
    this.stopIdleGuard();
    this.stopDriftServo();
    if (this.pushTimer) {
      clearTimeout(this.pushTimer);
      this.pushTimer = null;
    }
    if (this.rec) {
      this.rec.stream.end();
      this.rec = null;
    }
    this.mixer.stopAll();
    this.engaged = false;
    for (const file of this.fileCache.values()) fs.rm(file, { force: true }, () => {});
    this.fileCache.clear();
  }

  /* ------------------------------------------------------------ internals -- */

  /** Take the voice stream over from the queue. */
  private engage(): void {
    if (this.engaged) return;
    try {
      this.opts.pauseQueue();
    } catch {
      /* nothing was playing */
    }
    // startStream() tears down any queued audio and installs a fresh feed this
    // mixer can write into; the same path Spotify's PCM feed uses.
    this.opts.voice.startStream();
    this.opts.voice.setExpectingPcm(true);
    this.opts.voice.setStreamDrain(() => this.mixer.resumeSink());
    this.engaged = true;
    this.startIdleGuard();
  }

  private startIdleGuard(): void {
    if (this.idleGuard) return;
    this.idleGuard = setInterval(() => {
      if (!this.engaged) return;
      this.opts.voice.cancelIdleLeave();
    }, 20_000);
    this.idleGuard.unref?.();
  }

  private stopIdleGuard(): void {
    if (!this.idleGuard) return;
    clearInterval(this.idleGuard);
    this.idleGuard = null;
  }

  /** Coalesce mixer state changes: the panel wants ~4 updates a second, not
   *  one per 20 ms tick. */
  private schedulePush(): void {
    if (this.pushTimer) return;
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      this.opts.onState(this.mixer.state());
    }, 250);
  }
}

function formatMs(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** Encode the raw 48 kHz stereo s16le capture to mp3 (Discord-friendly). */
function encodeMp3(pcmFile: string, mp3File: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    try {
      const proc = spawn(
        config.ffmpegPath,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-f',
          's16le',
          '-ar',
          '48000',
          '-ac',
          '2',
          '-i',
          pcmFile,
          '-c:a',
          'libmp3lame',
          '-b:a',
          '192k',
          '-y',
          mp3File,
        ],
        { windowsHide: true },
      );
      const timer = setTimeout(() => {
        try {
          proc.kill();
        } catch {
          /* ignore */
        }
        done(false);
      }, 120_000);
      timer.unref?.();
      proc.on('error', () => {
        clearTimeout(timer);
        done(false);
      });
      proc.on('close', (code) => {
        clearTimeout(timer);
        done(code === 0 && fs.existsSync(mp3File));
      });
    } catch {
      done(false);
    }
  });
}
