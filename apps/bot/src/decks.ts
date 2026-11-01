import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
  /** Waveform peaks for a newly loaded track (drawn on the deck page). */
  onWaveform?: (deck: DeckId, peaks: number[], durationMs: number) => void;
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
/** Start cue jumps this early so the hit lands on the beat through Discord. */
const CUE_PREROLL_MS = 140;
/** Audio written to disk while recording: 48 kHz stereo Int16. */
const REC_BYTES_PER_MS = 192;
/** Longest one-shot the sample bank will hold in memory. */
const SAMPLE_MAX_SEC = 12;

/**
 * Copy the bundled starter one-shots into `<dataDir>/samples` once. Existing
 * files are never touched, so an upload always wins over the default.
 */
function seedStarterSamples(): void {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = path.join(here, '..', 'assets', 'samples');
    if (!fs.existsSync(src)) return;
    const dest = path.join(config.dataDir, 'samples');
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      if (!/\.(wav|mp3|ogg|flac|m4a|opus)$/i.test(name)) continue;
      const target = path.join(dest, name);
      if (!fs.existsSync(target)) fs.copyFileSync(path.join(src, name), target);
    }
  } catch {
    /* the starter bank is a nicety — never block a deck on it */
  }
}

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
  /** One-shot pad bank: file path -> decoded 48 kHz stereo PCM. */
  private sampleCache = new Map<string, { pcm: Buffer; at: number }>();
  private sampleListCache: { files: string[]; at: number } | null = null;
  /** Tracks loaded this session, for the recording summary. */
  private history: Array<{ title: string; artist: string; at: number }> = [];
  private readonly opts: DeckControllerOptions;

  constructor(opts: DeckControllerOptions) {
    this.opts = opts;
    seedStarterSamples();
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
    const base = this.mixer.state();
    const samples = this.sampleFiles().map((f) => path.basename(f).replace(/\.[^.]+$/, ''));
    for (const slot of [base.a, base.b]) slot.samples = samples;
    return { ...base, sync, record: { ...this.record } };
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

    return this.cue(deck, file, track.name, (track.artists ?? []).join(', '), durationMs, track.uri);
  }

  /**
   * Cue a local file (a WAV/MP3 dropped straight on the page, or a starter
   * sample). Skips the resolver entirely — the bytes are already here.
   */
  async loadLocal(deck: DeckId, file: string, name: string): Promise<DeckActionResult> {
    if (!fs.existsSync(file)) return { ok: false, message: `That file vanished: ${name}` };
    const durationMs = (await probeDuration(file).catch(() => null)) ?? 0;
    if (!durationMs)
      return { ok: false, message: `Couldn't read audio from "${name}" — WAV, MP3, M4A, FLAC and OGG all work.` };
    return this.cue(deck, file, name, '', durationMs);
  }

  /** Shared tail of load/loadLocal: engage the decks and hand the file to the mixer. */
  private cue(
    deck: DeckId,
    file: string,
    name: string,
    artist: string,
    durationMs: number,
    uri?: string,
  ): DeckActionResult {
    this.engage();
    this.mixer.load(deck, { file, title: name, artist, durationMs, bpm: null }, { play: false });
    // Tempo is needed for SYNC, but detection costs a few hundred ms of ffmpeg —
    // never block the load on it.
    void estimateTempo(file)
      .then((bpm) => {
        if (bpm && this.mixer.state()[deck].source?.file === file) this.mixer.setBpm(deck, bpm);
      })
      .catch(() => {});
    // Waveform for the deck page — also off the critical path.
    void computePeaks(file)
      .then((peaks) => {
        if (peaks && this.mixer.state()[deck].source?.file === file) {
          this.opts.onWaveform?.(deck, peaks, durationMs);
        }
      })
      .catch(() => {});
    this.history.push({ title: name, artist, at: Date.now() });
    if (this.history.length > 300) this.history.splice(0, this.history.length - 300);
    if (uri) this.fileCache.set(uri, file);
    return {
      ok: true,
      message: `Deck ${deck.toUpperCase()} cued: **${name}**${durationMs ? ` (${Math.round(durationMs / 1000)}s)` : ''}.`,
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
    const st = this.mixer.state()[deck];
    const cue = st.cues[Math.round(slot) - 1];
    if (cue == null) {
      return {
        ok: false,
        message: `Cue ${slot} on ${deck.toUpperCase()} is empty — tap it again while playing to set it.`,
      };
    }
    // Start slightly before the cue so the hit lands ON the beat through
    // Discord's ~200 ms jitter buffer instead of after it.
    const preroll = st.playing ? CUE_PREROLL_MS : 0;
    this.mixer.seek(deck, Math.max(0, cue - preroll));
    return { ok: true, message: `Deck ${deck.toUpperCase()} → cue ${slot} (${formatMs(cue)}).` };
  }

  /** DJ filter knob: 0..1, centre = bypass. */
  filter(deck: DeckId, value: number): DeckActionResult {
    this.mixer.setFilterKnob(deck, value);
    const f = this.mixer.state()[deck].filter;
    const label = f.type === 'off' ? 'off' : `${f.type.toUpperCase()} ${Math.round(f.cutoff)} Hz`;
    return { ok: true, message: `Deck ${deck.toUpperCase()} filter ${label}.` };
  }

  /* ------------------------------------------------------------ sample bank -- */

  /** One-shots in `<dataDir>/samples` (sorted), cached briefly. */
  sampleFiles(): string[] {
    const cached = this.sampleListCache;
    if (cached && Date.now() - cached.at < 8_000) return cached.files;
    let files: string[] = [];
    try {
      const dir = path.join(config.dataDir, 'samples');
      files = fs
        .readdirSync(dir)
        .filter((f) => /\.(wav|mp3|ogg|flac|m4a|opus)$/i.test(f))
        .sort()
        .map((f) => path.join(dir, f));
    } catch {
      files = [];
    }
    this.sampleListCache = { files, at: Date.now() };
    return files;
  }

  /** Drop cached listing/PCM after an upload, and hand back the new pad list. */
  refreshSamples(): string[] {
    this.sampleListCache = null;
    this.sampleCache.clear();
    return this.sampleFiles().map((f) => path.basename(f).replace(/\.[^.]+$/, ''));
  }

  /** Fire pad `slot` (1-based) from the sample bank over the live mix. */
  async playSample(slot: number): Promise<DeckActionResult> {
    const files = this.sampleFiles();
    const file = files[Math.round(slot) - 1];
    if (!file) return { ok: false, message: `No sample in pad ${slot} — drop files in \`data/samples/\`.` };
    if (!this.engaged) return { ok: false, message: 'Load a deck first.' };
    const pcm = await this.samplePcm(file);
    if (!pcm) return { ok: false, message: `Couldn't decode ${path.basename(file)}.` };
    this.opts.voice.queueSfxPcm(pcm);
    return { ok: true, message: `▶ ${path.basename(file).replace(/\.[^.]+$/, '')}` };
  }

  /** Decode a one-shot to 48 kHz stereo s16le, cached (bounded). */
  private samplePcm(file: string): Promise<Buffer | null> {
    const cached = this.sampleCache.get(file);
    if (cached) return Promise.resolve(cached.pcm);
    return new Promise((resolve) => {
      let settled = false;
      const done = (v: Buffer | null): void => {
        if (settled) return;
        settled = true;
        resolve(v);
      };
      try {
        const proc = spawn(
          config.ffmpegPath,
          [
            '-hide_banner',
            '-loglevel',
            'error',
            '-i',
            file,
            '-t',
            String(SAMPLE_MAX_SEC),
            '-ac',
            '2',
            '-ar',
            '48000',
            '-f',
            's16le',
            'pipe:1',
          ],
          { windowsHide: true },
        );
        const chunks: Buffer[] = [];
        proc.stdout?.on('data', (d: Buffer) => chunks.push(d));
        proc.on('error', () => done(null));
        proc.on('close', (code) => {
          if (code !== 0 || chunks.length === 0) return done(null);
          const pcm = Buffer.concat(chunks);
          this.sampleCache.set(file, { pcm, at: Date.now() });
          // ~40 one-shots of 12 s is plenty; drop the oldest past that.
          while (this.sampleCache.size > 40) {
            const oldest = [...this.sampleCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
            if (!oldest) break;
            this.sampleCache.delete(oldest[0]);
          }
          done(pcm);
        });
      } catch {
        done(null);
      }
    });
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
    // Set stats: how many tracks went through the decks and the busiest artists.
    const counts = new Map<string, number>();
    for (const h of this.history) {
      const key = h.artist || 'unknown';
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const top = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([a, n]) => `${a} (${n})`)
      .join(', ');
    const stats = this.history.length
      ? ` · ${this.history.length} track${this.history.length === 1 ? '' : 's'}${top ? ` · ${top}` : ''}`
      : '';
    return {
      ok: true,
      message: url
        ? `🎚️ Set saved (${mins} min${stats}): ${url}`
        : `🎚️ Set saved on the server: \`${mp3}\` (${mins} min${stats}).`,
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

/**
 * Peak envelope for the deck page: decode to 8 kHz mono and keep the loudest
 * |sample| per bucket. 600 buckets is ~1 point per 4 px on a typical panel and
 * costs one fast ffmpeg pass over a local file.
 */
function computePeaks(file: string, buckets = 600): Promise<number[] | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: number[] | null): void => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    try {
      const proc = spawn(
        config.ffmpegPath,
        ['-hide_banner', '-loglevel', 'error', '-i', file, '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1'],
        { windowsHide: true },
      );
      const chunks: Buffer[] = [];
      let bytes = 0;
      const cap = 8000 * 2 * 60 * 30; // 30 min ceiling
      proc.stdout?.on('data', (d: Buffer) => {
        if (bytes < cap) {
          chunks.push(d);
          bytes += d.length;
        }
      });
      proc.on('error', () => done(null));
      proc.on('close', (code) => {
        if (code !== 0) return done(null);
        const pcm = Buffer.concat(chunks);
        const total = Math.floor(pcm.length / 2);
        if (total < buckets * 2) return done(null);
        const per = Math.floor(total / buckets);
        const peaks: number[] = [];
        for (let b = 0; b < buckets; b++) {
          let max = 0;
          const start = b * per;
          for (let i = start; i < start + per; i++) {
            const v = Math.abs(pcm.readInt16LE(i * 2));
            if (v > max) max = v;
          }
          // sqrt shape: quiet intros stay visible without the drops clipping flat.
          peaks.push(Number(Math.sqrt(max / 32768).toFixed(3)));
        }
        done(peaks);
      });
    } catch {
      done(null);
    }
  });
}

/** Encode the raw 48 kHz stereo s16le capture to mp3 (Discord-friendly). */ function encodeMp3(
  pcmFile: string,
  mp3File: string,
): Promise<boolean> {
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
