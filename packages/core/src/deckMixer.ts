import { type ChildProcess, spawn } from 'node:child_process';
import { config } from '@vaporzr/core/config';
import type { DeckEq, DeckId, DeckMixerState, DeckSlotState, DeckSource } from '@vaporzr/shared';

/**
 * Live two-deck mixer.
 *
 * The bot normally streams ONE ffmpeg output into Discord. A live deck needs
 * two playheads that can be started, cued, nudged, EQ'd and crossfaded at any
 * moment, so this module owns the audio instead: one decoder per deck, a ring
 * buffer each, and a fixed 20 ms tick that sums both decks (with EQ + gain)
 * into the single PCM feed the voice transport accepts.
 *
 * Everything here is transport-agnostic — the caller supplies a `sink` for the
 * mixed 48 kHz stereo Int16 PCM. Discord voice is the only caller today.
 */

export type { DeckEq, DeckId, DeckMixerState, DeckSlotState, DeckSource };

/** EQ band gains in dB. -40 is treated as a kill, 0 is flat. */
export const DECK_EQ_MIN_DB = -40;
export const DECK_EQ_MAX_DB = 6;
export const FLAT_EQ: DeckEq = { low: 0, mid: 0, high: 0 };

export interface DeckMixerOptions {
  ffmpegPath?: string;
  /** Receives mixed 48 kHz stereo Int16 PCM. Return false to apply backpressure. */
  sink: (pcm: Buffer) => boolean;
  /** Called on discrete state changes (load / play / pause / seek / end). */
  onState?: () => void;
  /** Called when a deck runs off the end of its track. */
  onDeckEnd?: (deck: DeckId) => void;
  sampleRate?: number;
  frameMs?: number;
}

const DEFAULT_SAMPLE_RATE = 48_000;
const DEFAULT_FRAME_MS = 20; // matches Discord's Opus frame size
/** Leave headroom so two full-level decks summing don't clip. */
const MASTER_HEADROOM = 0.9;

/* ------------------------------------------------------------------ DSP ---- */

export interface BiquadCoefs {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

export interface BiquadState {
  x1: number;
  x2: number;
  y1: number;
  y2: number;
}

export const IDENTITY_BIQUAD: BiquadCoefs = { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 };

export const newBiquadState = (): BiquadState => ({ x1: 0, x2: 0, y1: 0, y2: 0 });

/** Direct-form-I biquad. Coefficients must already be normalised by a0. */
export function applyBiquad(c: BiquadCoefs, s: BiquadState, x: number): number {
  const y = c.b0 * x + c.b1 * s.x1 + c.b2 * s.x2 - c.a1 * s.y1 - c.a2 * s.y2;
  s.x2 = s.x1;
  s.x1 = x;
  s.y2 = s.y1;
  s.y1 = y;
  return y;
}

export function isIdentityBiquad(c: BiquadCoefs): boolean {
  return c.b0 === 1 && c.b1 === 0 && c.b2 === 0 && c.a1 === 0 && c.a2 === 0;
}

function normalise(b0: number, b1: number, b2: number, a0: number, a1: number, a2: number): BiquadCoefs {
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/** RBJ low shelf. `gainDb` 0 returns the identity (no work, no phase shift). */
export function lowShelfCoefs(freq: number, gainDb: number, sampleRate = DEFAULT_SAMPLE_RATE): BiquadCoefs {
  if (Math.abs(gainDb) < 0.01) return IDENTITY_BIQUAD;
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * freq) / sampleRate;
  const cos = Math.cos(w0);
  const alpha = (Math.sin(w0) / 2) * Math.SQRT2;
  const twoSqrtAAlpha = 2 * Math.sqrt(A) * alpha;
  return normalise(
    A * (A + 1 - (A - 1) * cos + twoSqrtAAlpha),
    2 * A * (A - 1 - (A + 1) * cos),
    A * (A + 1 - (A - 1) * cos - twoSqrtAAlpha),
    A + 1 + (A - 1) * cos + twoSqrtAAlpha,
    -2 * (A - 1 + (A + 1) * cos),
    A + 1 + (A - 1) * cos - twoSqrtAAlpha,
  );
}

/** RBJ high shelf. */
export function highShelfCoefs(freq: number, gainDb: number, sampleRate = DEFAULT_SAMPLE_RATE): BiquadCoefs {
  if (Math.abs(gainDb) < 0.01) return IDENTITY_BIQUAD;
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * freq) / sampleRate;
  const cos = Math.cos(w0);
  const alpha = (Math.sin(w0) / 2) * Math.SQRT2;
  const twoSqrtAAlpha = 2 * Math.sqrt(A) * alpha;
  return normalise(
    A * (A + 1 + (A - 1) * cos + twoSqrtAAlpha),
    -2 * A * (A - 1 + (A + 1) * cos),
    A * (A + 1 + (A - 1) * cos - twoSqrtAAlpha),
    A + 1 - (A - 1) * cos + twoSqrtAAlpha,
    2 * (A - 1 - (A + 1) * cos),
    A + 1 - (A - 1) * cos - twoSqrtAAlpha,
  );
}

/** RBJ peaking EQ (the mid band). */
export function peakingCoefs(freq: number, gainDb: number, q = 0.9, sampleRate = DEFAULT_SAMPLE_RATE): BiquadCoefs {
  if (Math.abs(gainDb) < 0.01) return IDENTITY_BIQUAD;
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * freq) / sampleRate;
  const alpha = Math.sin(w0) / (2 * q);
  return normalise(1 + alpha * A, -2 * Math.cos(w0), 1 - alpha * A, 1 + alpha / A, -2 * Math.cos(w0), 1 - alpha / A);
}

/** dB -> linear gain. */
export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

export function clampEqDb(db: number): number {
  if (!Number.isFinite(db)) return 0;
  return Math.max(DECK_EQ_MIN_DB, Math.min(DECK_EQ_MAX_DB, db));
}

/**
 * Equal-power crossfader. 0 = deck A only, 1 = deck B only, 0.5 = both at
 * -3 dB (the standard constant-loudness curve, matching crossfade.ts).
 */
export function crossfaderGains(x: number): { a: number; b: number } {
  const c = Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0.5));
  return { a: Math.cos((c * Math.PI) / 2), b: Math.sin((c * Math.PI) / 2) };
}

/** Clamp a float mix to interleaved Int16, applying master gain. */
export function floatToInt16(acc: Float32Array, out: Buffer, master: number): void {
  for (let i = 0; i < acc.length; i++) {
    let v = acc[i]! * master;
    if (v > 1) v = 1;
    else if (v < -1) v = -1;
    out.writeInt16LE(Math.round(v * 32767), i * 2);
  }
}

/* ------------------------------------------------------------ ring buffer -- */

/** Append-only FIFO of PCM bytes with cheap partial reads. */
export class PcmRing {
  private chunks: Buffer[] = [];
  private offset = 0;
  private size = 0;

  get byteLength(): number {
    return this.size;
  }

  push(buf: Buffer): void {
    if (buf.length === 0) return;
    this.chunks.push(buf);
    this.size += buf.length;
  }

  /** Read up to `n` bytes. Returns fewer at a starved tail; empty when dry. */
  readUpTo(n: number): Buffer {
    if (n <= 0 || this.size === 0) return Buffer.alloc(0);
    const take = Math.min(n, this.size);
    // Fast path: one chunk covers the whole read.
    const first = this.chunks[0];
    if (first && first.length - this.offset >= take) {
      const out = first.subarray(this.offset, this.offset + take);
      this.offset += take;
      this.size -= take;
      if (this.offset >= first.length) {
        this.chunks.shift();
        this.offset = 0;
      }
      return out;
    }
    const out = Buffer.allocUnsafe(take);
    let written = 0;
    while (written < take) {
      const head = this.chunks[0];
      if (!head) break;
      const avail = head.length - this.offset;
      const chunk = Math.min(avail, take - written);
      head.copy(out, written, this.offset, this.offset + chunk);
      written += chunk;
      this.offset += chunk;
      if (this.offset >= head.length) {
        this.chunks.shift();
        this.offset = 0;
      }
    }
    this.size -= written;
    return written === take ? out : out.subarray(0, written);
  }

  clear(): void {
    this.chunks = [];
    this.offset = 0;
    this.size = 0;
  }
}

/* --------------------------------------------------------------- decoder -- */

interface SlotRuntime {
  id: DeckId;
  state: DeckSlotState;
  ring: PcmRing;
  proc: ChildProcess | null;
  procEnded: boolean;
  coefs: BiquadCoefs[];
  eqState: BiquadState[][]; // [band][channel]
  /** Gain currently applied, ramped toward the target each frame. */
  gainNow: number;
  /** Frames of fade-in remaining after a (re)start, to avoid a click. */
  fadeFrames: number;
  /** Track position the current decoder started at. */
  baseMs: number;
  /** Audio consumed from the current decoder, in frames. */
  consumedFrames: number;
}

const emptySlot = (): DeckSlotState => ({
  source: null,
  playing: false,
  ended: false,
  positionMs: 0,
  durationMs: 0,
  gain: 1,
  eq: { ...FLAT_EQ },
  tempo: 1,
  bpm: null,
});

export class DeckMixer {
  private a: SlotRuntime;
  private b: SlotRuntime;
  private crossfader = 0.5;
  private masterGain = 1;
  private timer: ReturnType<typeof setInterval> | null = null;
  private blocked = false;
  private readonly sampleRate: number;
  private readonly frameMs: number;
  private readonly framesPerTick: number;
  private readonly acc: Float32Array;
  private readonly out: Buffer;
  private readonly ffmpegPath: string;
  private readonly sink: (pcm: Buffer) => boolean;
  private readonly onState?: () => void;
  private readonly onDeckEnd?: (deck: DeckId) => void;

  constructor(opts: DeckMixerOptions) {
    this.sink = opts.sink;
    this.onState = opts.onState;
    this.onDeckEnd = opts.onDeckEnd;
    this.sampleRate = opts.sampleRate ?? DEFAULT_SAMPLE_RATE;
    this.frameMs = opts.frameMs ?? DEFAULT_FRAME_MS;
    this.framesPerTick = Math.round((this.sampleRate * this.frameMs) / 1000);
    this.acc = new Float32Array(this.framesPerTick * 2);
    this.out = Buffer.allocUnsafe(this.framesPerTick * 4);
    this.ffmpegPath = opts.ffmpegPath ?? config.ffmpegPath;
    this.a = this.newSlot('a');
    this.b = this.newSlot('b');
  }

  private newSlot(id: DeckId): SlotRuntime {
    return {
      id,
      state: emptySlot(),
      ring: new PcmRing(),
      proc: null,
      procEnded: false,
      coefs: [IDENTITY_BIQUAD, IDENTITY_BIQUAD, IDENTITY_BIQUAD],
      eqState: [newBiquadState(), newBiquadState(), newBiquadState()].map(() => [newBiquadState(), newBiquadState()]),
      gainNow: 1,
      fadeFrames: 0,
      baseMs: 0,
      consumedFrames: 0,
    };
  }

  private slot(id: DeckId): SlotRuntime {
    return id === 'a' ? this.a : this.b;
  }

  state(): DeckMixerState {
    return {
      active: this.a.state.playing || this.b.state.playing || Boolean(this.a.state.source || this.b.state.source),
      crossfader: this.crossfader,
      masterGain: this.masterGain,
      a: { ...this.a.state, eq: { ...this.a.state.eq } },
      b: { ...this.b.state, eq: { ...this.b.state.eq } },
    };
  }

  isRunning(): boolean {
    return this.timer !== null;
  }

  /* ---------------------------------------------------------- transport -- */

  /** Cue (or start) a track on a deck. `seekMs` positions the playhead. */
  load(id: DeckId, source: DeckSource, opts: { seekMs?: number; play?: boolean } = {}): void {
    const slot = this.slot(id);
    this.killDecoder(slot);
    slot.ring.clear();
    slot.state.source = { ...source, durationMs: source.durationMs || 0 };
    slot.state.durationMs = Math.max(0, Math.round(source.durationMs || 0));
    slot.state.bpm = source.bpm ?? slot.state.bpm;
    slot.state.ended = false;
    slot.state.tempo = 1;
    slot.state.gain = 1;
    slot.state.eq = { ...FLAT_EQ };
    this.rebuildCoefs(slot);
    const seekMs = Math.max(0, Math.round(opts.seekMs ?? 0));
    slot.baseMs = seekMs;
    slot.consumedFrames = 0;
    slot.state.positionMs = seekMs;
    slot.gainNow = 1;
    slot.fadeFrames = Math.round(this.sampleRate * 0.05);
    this.spawnDecoder(slot, seekMs);
    slot.state.playing = Boolean(opts.play);
    if (slot.state.playing) this.startTick();
    this.emit();
  }

  play(id?: DeckId): void {
    for (const slot of id ? [this.slot(id)] : [this.a, this.b]) {
      if (!slot.state.source || slot.state.ended) continue;
      slot.state.playing = true;
    }
    if (this.a.state.playing || this.b.state.playing) this.startTick();
    this.emit();
  }

  pause(id?: DeckId): void {
    for (const slot of id ? [this.slot(id)] : [this.a, this.b]) {
      slot.state.playing = false;
    }
    this.emit();
  }

  /** Jump a deck to a position (restarts its decoder — the audio gap is the cost
   *  of an accurate seek, and a cued deck has nothing to interrupt). */
  seek(id: DeckId, ms: number): void {
    const slot = this.slot(id);
    if (!slot.state.source) return;
    const dur = slot.state.durationMs;
    const target = Math.max(0, dur ? Math.min(ms, dur - 250) : Math.round(ms));
    slot.baseMs = target;
    slot.consumedFrames = 0;
    slot.state.positionMs = target;
    slot.state.ended = false;
    slot.ring.clear();
    this.killDecoder(slot);
    slot.fadeFrames = Math.round(this.sampleRate * 0.04);
    this.spawnDecoder(slot, target);
    this.emit();
  }

  /** Change playback rate without touching pitch (ffmpeg atempo). Restarts the
   *  decoder at the current position; intended for the cued deck. */
  setTempo(id: DeckId, ratio: number): void {
    const slot = this.slot(id);
    if (!slot.state.source) return;
    const r = Math.max(0.5, Math.min(2, Number.isFinite(ratio) ? ratio : 1));
    if (Math.abs(r - slot.state.tempo) < 0.0005) return;
    // Position is measured in wall-clock audio, so bring it up to date first.
    const pos = slot.state.positionMs;
    const oldTempo = slot.state.tempo;
    slot.state.tempo = r;
    // A stretched deck's effective BPM moves with the rate, so SYNC on the other
    // deck stays correct without re-detecting anything.
    slot.state.bpm = slot.state.bpm ? Number((slot.state.bpm * (r / oldTempo)).toFixed(2)) : null;
    slot.baseMs = pos;
    slot.consumedFrames = 0;
    slot.state.positionMs = pos;
    slot.ring.clear();
    this.killDecoder(slot);
    slot.fadeFrames = Math.round(this.sampleRate * 0.04);
    this.spawnDecoder(slot, pos);
    this.emit();
  }

  setBpm(id: DeckId, bpm: number | null): void {
    const slot = this.slot(id);
    slot.state.bpm = bpm && bpm > 0 ? Number(bpm.toFixed(2)) : null;
    if (slot.state.source) slot.state.source.bpm = slot.state.bpm;
    this.emit();
  }

  setCrossfader(x: number): void {
    this.crossfader = Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0.5));
    this.emit();
  }

  getCrossfader(): number {
    return this.crossfader;
  }

  setGain(id: DeckId, gain: number): void {
    this.slot(id).state.gain = Math.max(0, Math.min(1, Number.isFinite(gain) ? gain : 1));
    this.emit();
  }

  setMasterGain(gain: number): void {
    this.masterGain = Math.max(0, Math.min(1.2, Number.isFinite(gain) ? gain : 1));
    this.emit();
  }

  setEqBand(id: DeckId, band: keyof DeckEq, db: number): void {
    const slot = this.slot(id);
    slot.state.eq[band] = clampEqDb(db);
    this.rebuildCoefs(slot);
    this.emit();
  }

  /** Cut a band entirely (-40 dB) — the classic EQ-kill button. */
  killBand(id: DeckId, band: keyof DeckEq): void {
    const slot = this.slot(id);
    slot.state.eq[band] = slot.state.eq[band] <= DECK_EQ_MIN_DB + 0.5 ? 0 : DECK_EQ_MIN_DB;
    this.rebuildCoefs(slot);
    this.emit();
  }

  /** Force a resync of the tick loop after the sink reported backpressure. */
  resumeSink(): void {
    if (!this.blocked) return;
    this.blocked = false;
    this.startTick();
  }

  /** Stop everything and release the decoders. */
  stopAll(): void {
    for (const slot of [this.a, this.b]) {
      this.killDecoder(slot);
      slot.ring.clear();
      slot.state = emptySlot();
      slot.procEnded = false;
      slot.baseMs = 0;
      slot.consumedFrames = 0;
      slot.fadeFrames = 0;
      slot.coefs = [IDENTITY_BIQUAD, IDENTITY_BIQUAD, IDENTITY_BIQUAD];
    }
    this.crossfader = 0.5;
    this.stopTick();
    this.emit();
  }

  /* ------------------------------------------------------------ internals -- */

  private rebuildCoefs(slot: SlotRuntime): void {
    const eq = slot.state.eq;
    slot.coefs = [
      lowShelfCoefs(200, eq.low, this.sampleRate),
      peakingCoefs(1000, eq.mid, 0.9, this.sampleRate),
      highShelfCoefs(3500, eq.high, this.sampleRate),
    ];
  }

  private emit(): void {
    this.onState?.();
  }

  private spawnDecoder(slot: SlotRuntime, seekMs: number): void {
    const file = slot.state.source?.file;
    if (!file) return;
    const tempo = slot.state.tempo;
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
    // Input seek on a local file: fast and frame-accurate for audio.
    if (seekMs > 0) args.push('-ss', (seekMs / 1000).toFixed(3));
    args.push('-i', file);
    args.push('-vn', '-ac', '2', '-ar', String(this.sampleRate));
    if (Math.abs(tempo - 1) > 0.0005) {
      // atempo only accepts 0.5..2.0; chain for anything outside that band.
      const stages: number[] = [];
      let r = tempo;
      while (r > 2) {
        stages.push(2);
        r /= 2;
      }
      while (r < 0.5) {
        stages.push(0.5);
        r /= 0.5;
      }
      stages.push(r);
      args.push('-af', stages.map((s) => `atempo=${s.toFixed(4)}`).join(','));
    }
    args.push('-f', 's16le', 'pipe:1');

    let proc: ChildProcess;
    try {
      proc = spawn(this.ffmpegPath, args, { windowsHide: true });
    } catch (err) {
      console.warn(`[deck:${slot.id}] decoder spawn failed: ${err instanceof Error ? err.message : err}`);
      return;
    }
    slot.proc = proc;
    slot.procEnded = false;
    proc.stdout?.on('data', (d: Buffer) => {
      if (slot.proc !== proc) return;
      slot.ring.push(d);
      // ~2 s of buffer is plenty; pausing the pipe is cheaper than dropping audio.
      const cap = this.sampleRate * 4 * 2;
      if (slot.ring.byteLength > cap) proc.stdout?.pause();
    });
    proc.stderr?.on('data', (d: Buffer) => {
      const line = d.toString().trim();
      if (line) console.warn(`[deck:${slot.id}] ${line.slice(0, 240)}`);
    });
    proc.on('error', (err) => {
      console.warn(`[deck:${slot.id}] decoder error: ${err.message}`);
    });
    proc.on('exit', () => {
      if (slot.proc === proc) {
        slot.proc = null;
        slot.procEnded = true;
      }
    });
  }

  private killDecoder(slot: SlotRuntime): void {
    const proc = slot.proc;
    slot.proc = null;
    slot.procEnded = false;
    if (!proc) return;
    try {
      proc.stdout?.destroy();
    } catch {
      /* ignore */
    }
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
  }

  private startTick(): void {
    if (this.timer) return;
    this.blocked = false;
    this.timer = setInterval(() => this.tick(), this.frameMs);
    this.timer.unref?.();
  }

  private stopTick(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    if (this.blocked) return;
    const slots: SlotRuntime[] = [this.a, this.b];
    if (!slots.some((s) => s.state.playing)) {
      this.stopTick();
      return;
    }
    this.acc.fill(0);
    const frameBytes = this.framesPerTick * 4;

    for (const slot of slots) {
      if (slot.state.playing) {
        // Refill a decoder that was paused by the buffer cap.
        if (slot.proc?.stdout?.isPaused() && slot.ring.byteLength < this.sampleRate * 2) {
          slot.proc.stdout.resume();
        }
        const buf = slot.ring.readUpTo(frameBytes);
        if (buf.length > 0) this.renderSlot(slot, buf);
        const consumedMs = (Math.floor(buf.length / 4) / this.sampleRate) * 1000;
        if (consumedMs > 0) slot.state.positionMs += consumedMs * slot.state.tempo;
        if (slot.procEnded && slot.ring.byteLength === 0) {
          slot.state.playing = false;
          slot.state.ended = true;
          if (slot.state.durationMs > 0) slot.state.positionMs = slot.state.durationMs;
          this.onDeckEnd?.(slot.id);
          this.emit();
        }
      }
    }

    floatToInt16(this.acc, this.out, this.masterGain * MASTER_HEADROOM);
    const accepted = this.sink(this.out);
    if (!accepted) this.blocked = true;
  }

  /** Sum one deck's PCM into the shared float accumulator, with EQ + gain. */
  private renderSlot(slot: SlotRuntime, buf: Buffer): void {
    const cross = crossfaderGains(this.crossfader);
    const target = (slot.id === 'a' ? cross.a : cross.b) * slot.state.gain;
    const frames = Math.floor(buf.length / 4);
    const acc = this.acc;
    const coefs = slot.coefs;
    const [lowC, midC, highC] = coefs as [BiquadCoefs, BiquadCoefs, BiquadCoefs];
    const anyEq = !isIdentityBiquad(lowC) || !isIdentityBiquad(midC) || !isIdentityBiquad(highC);
    // Ramp gain across the frame so slider moves don't click.
    const start = slot.gainNow;
    const step = (target - start) / Math.max(1, frames);
    let gain = start;

    for (let i = 0; i < frames; i++) {
      const base = i * 4;
      let l = buf.readInt16LE(base) / 32768;
      let r = buf.readInt16LE(base + 2) / 32768;
      if (anyEq) {
        const l0 = slot.eqState[0]!;
        const l1 = slot.eqState[1]!;
        const l2 = slot.eqState[2]!;
        if (!isIdentityBiquad(lowC)) {
          l = applyBiquad(lowC, l0[0]!, l);
          r = applyBiquad(lowC, l0[1]!, r);
        }
        if (!isIdentityBiquad(midC)) {
          l = applyBiquad(midC, l1[0]!, l);
          r = applyBiquad(midC, l1[1]!, r);
        }
        if (!isIdentityBiquad(highC)) {
          l = applyBiquad(highC, l2[0]!, l);
          r = applyBiquad(highC, l2[1]!, r);
        }
      }
      gain += step;
      acc[i * 2] = acc[i * 2]! + l * gain;
      acc[i * 2 + 1] = acc[i * 2 + 1]! + r * gain;
    }
    slot.gainNow = gain;
    // Fade-in after a (re)start: multiply the first N frames by a ramp.
    if (slot.fadeFrames > 0) {
      const n = Math.min(slot.fadeFrames, frames);
      for (let i = 0; i < n; i++) {
        const k = i / slot.fadeFrames;
        acc[i * 2] = acc[i * 2]! * k;
        acc[i * 2 + 1] = acc[i * 2 + 1]! * k;
      }
      slot.fadeFrames -= n;
    }
  }
}
