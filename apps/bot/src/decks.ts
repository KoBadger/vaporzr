import fs from 'node:fs';
import {
  DECK_EQ_MAX_DB,
  DECK_EQ_MIN_DB,
  DeckMixer,
  type DeckEq,
  type DeckId,
  type DeckMixerState,
} from '@vaporzr/core/deckMixer';
import { downloadToTempFile } from '@vaporzr/core/mediaDownload';
import type { ResolvedTrack } from '@vaporzr/core/spotify';
import { probeDuration } from '@vaporzr/core/suno';
import { estimateTempo } from '@vaporzr/core/tempo';
import type { VoiceManager } from './voice.js';

/**
 * One guild's live decks: resolution, downloads and the takeover of the voice
 * stream. The mixer itself (`@vaporzr/core/deckMixer`) is transport-agnostic;
 * everything Discord-specific — queue pause, voice start/stop, temp files —
 * lives here.
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
}

export interface DeckActionResult {
  ok: boolean;
  message: string;
}

const EQ_BANDS: Array<keyof DeckEq> = ['low', 'mid', 'high'];

export class DeckController {
  private mixer: DeckMixer;
  private engaged = false;
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private idleGuard: ReturnType<typeof setInterval> | null = null;
  /** uri -> downloaded file, so re-loading a track doesn't re-download it. */
  private fileCache = new Map<string, string>();
  private readonly opts: DeckControllerOptions;

  constructor(opts: DeckControllerOptions) {
    this.opts = opts;
    this.mixer = new DeckMixer({
      sink: (pcm) => {
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
    return this.mixer.state();
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
   * Beat-match deck B to deck A: tempo first (atempo, pitch preserved), then
   * align the beat phase by re-seeking B by less than one beat.
   *
   * The phase step assumes a grid anchored at the track's start, which is right
   * for most dance/pop edits and wrong for free-tempo intros — `nudge` exists
   * for the cases it gets wrong.
   */
  sync(): DeckActionResult {
    const st = this.mixer.state();
    const a = st.a;
    const b = st.b;
    if (!a.source || !b.source) return { ok: false, message: 'Load both decks before syncing.' };
    const bpmA = a.bpm;
    const bpmB = b.bpm;
    if (!bpmA || !bpmB) {
      return {
        ok: false,
        message: `No BPM yet on ${!bpmA ? 'deck A' : 'deck B'} — give it a second (detection runs after load) or nudge manually.`,
      };
    }
    const ratio = bpmA / bpmB;
    if (ratio < 0.9 || ratio > 1.1) {
      return { ok: false, message: `${Math.round(bpmA)} vs ${Math.round(bpmB)} BPM is too far to beat-match cleanly.` };
    }
    if (Math.abs(ratio - 1) > 0.001) this.mixer.setTempo('b', b.tempo * ratio);

    const beatMs = 60_000 / bpmA;
    const phaseA = (a.positionMs % beatMs) / beatMs;
    const phaseB = (b.positionMs % beatMs) / beatMs;
    let delta = (phaseA - phaseB) * beatMs;
    if (delta < -beatMs / 2) delta += beatMs;
    if (delta > beatMs / 2) delta -= beatMs;
    if (Math.abs(delta) > 12) this.mixer.seek('b', b.positionMs + delta);

    return {
      ok: true,
      message: `Synced — B stretched ${(ratio * 100).toFixed(1)}% to ${Math.round(bpmA)} BPM${Math.abs(delta) > 12 ? `, phase ${delta > 0 ? '+' : ''}${Math.round(delta)}ms` : ', already in phase'}.`,
    };
  }

  /** Stop the decks and hand the stream back (queued music stays paused). */
  stop(): DeckActionResult {
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
    this.opts.onState(this.mixer.state());
    return { ok: true, message: 'Decks down — queue is paused, `V@r` to bring the music back.' };
  }

  dispose(): void {
    this.stopIdleGuard();
    if (this.pushTimer) {
      clearTimeout(this.pushTimer);
      this.pushTimer = null;
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
