import { onsetEnvelope, bestTempo } from '@vaporzr/core/tempo';
import type { AudioFeatures } from '@vaporzr/core/spotify';

/**
 * Local audio-feature estimation.
 *
 * WHY THIS EXISTS
 * `V@shuffle smart`, `arc` and `key` order the queue by how tracks SOUND —
 * loudness/intensity, tempo and musical key. Spotify retired `/audio-features`
 * in November 2024, and the free mirror the bot falls back to (ReccoBeats) only
 * knows part of a catalogue, so those three modes had nothing to sort roughly
 * half of a queue by and simply left those tracks where they were.
 *
 * The bot already decodes every track it plays, so this measures the three
 * fields that actually drive those modes straight from the live audio — free,
 * for every track, and with no third party involved.
 *
 * WHAT IT DOES *NOT* DO
 * danceability, valence, acousticness and the rest need trained models. They are
 * left at neutral defaults, and the ordering code treats those fields as
 * uninformative — guessing them would misplace tracks worse than not ranking
 * them at all.
 */

/** The voice layer feeds stereo s16le at 48 kHz (see analyzer.feedPcm). */
const SOURCE_RATE = 48_000;
/** Analysis rate — matches tempo.ts so its envelope/autocorrelation are reused. */
const TARGET_RATE = 8_000;
const DECIMATE = SOURCE_RATE / TARGET_RATE; // 6
const HOP = 80; // 10 ms frames at 8 kHz, as in tempo.ts
/** Collect at most this much; plenty for a stable tempo and key read. */
const MAX_SECONDS = 45;
const MAX_SAMPLES = TARGET_RATE * MAX_SECONDS;
/** Chroma is averaged over this many windows spread across the collected audio. */
const CHROMA_WINDOWS = 40;
const CHROMA_WINDOW = 4096; // 0.5 s at 8 kHz → ~2 Hz bins

/** Krumhansl-Schmuckler key profiles (the classic major/minor templates). */
const KS_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KS_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

export interface LocalFeatures {
  /** 0..1 perceptual-ish loudness (RMS on a dB curve). */
  energy: number;
  /** BPM, or 0 when it could not be detected. */
  tempo: number;
  /** Pitch class 0..11 (C = 0), or -1 when unknown. */
  key: number;
  /** 1 major, 0 minor. */
  mode: number;
}

/**
 * Spread a local measurement into the full Spotify-shaped object the consumers
 * expect. energy, tempo, key and mode are MEASURED; the rest are the same
 * neutral placeholders the Deezer estimator uses, and the ordering code treats
 * them as uninformative rather than as real data.
 */
export function toAudioFeatures(est: LocalFeatures, durationMs = 0): AudioFeatures {
  return {
    energy: est.energy,
    tempo: est.tempo > 0 ? est.tempo : 120,
    key: est.key >= 0 ? est.key : -1, // -1 = undetected; keyDistance treats it as neutral
    mode: est.mode,
    valence: 0.5,
    danceability: 0.5,
    acousticness: 0.3,
    instrumentalness: 0.2,
    liveness: 0.12,
    speechiness: 0.06,
    time_signature: 4,
    duration_ms: durationMs,
  };
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * Loudness as a rough "energy" proxy: Spotify's energy is perceptual intensity,
 * and RMS on a dB curve tracks it well enough to order a set by. Typical music
 * sits around -20..-8 dBFS, so -30 dB maps to 0 and -5 dB to 1.
 */
export function estimateEnergy(mono: Buffer): number {
  const n = Math.floor(mono.length / 2);
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = mono.readInt16LE(i * 2) / 32768;
    sum += s * s;
  }
  const rms = Math.sqrt(sum / n);
  if (rms <= 0) return 0;
  const db = 20 * Math.log10(rms);
  return clamp01((db + 30) / 25);
}

/** Goertzel magnitude of `freq` over one window. */
function goertzel(samples: Float32Array, freq: number, rate: number): number {
  const w = (2 * Math.PI * freq) / rate;
  const c = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const s0 = samples[i] + c * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const mag = s1 * s1 + s2 * s2 - c * s1 * s2;
  return Math.sqrt(Math.max(0, mag)) / samples.length;
}

/**
 * Musical key by chroma + Krumhansl-Schmuckler correlation.
 *
 * A chroma vector is the energy at each of the 12 pitch classes regardless of
 * octave; correlating it against the major/minor templates picks the best
 * rotation, which IS the key. Chroma is averaged over windows spread through the
 * clip rather than one long transform — a 45 s window is so frequency-selective
 * that it misses real notes, which are neither perfectly tuned nor steady.
 */
export function estimateKey(mono: Buffer): { key: number; mode: number } {
  const n = Math.floor(mono.length / 2);
  if (n < CHROMA_WINDOW) return { key: -1, mode: 1 };
  const all = new Float32Array(n);
  for (let i = 0; i < n; i++) all[i] = mono.readInt16LE(i * 2) / 32768;

  const chroma = new Float64Array(12);
  const windows = Math.min(CHROMA_WINDOWS, Math.floor(n / CHROMA_WINDOW));
  const stride = windows > 1 ? Math.floor((n - CHROMA_WINDOW) / (windows - 1)) : 0;
  const win = new Float32Array(CHROMA_WINDOW);
  for (let w = 0; w < windows; w++) {
    const off = w * stride;
    win.set(all.subarray(off, off + CHROMA_WINDOW));
    for (let p = 0; p < 12; p++) {
      let mag = 0;
      // Four octaves from ~65 Hz to ~1 kHz covers the range that carries pitch.
      for (let o = 0; o < 4; o++) {
        const midi = 36 + p + 12 * o; // C2 upward
        const freq = 440 * Math.pow(2, (midi - 69) / 12);
        if (freq > TARGET_RATE / 2.5) break;
        mag += goertzel(win, freq, TARGET_RATE);
      }
      chroma[p] += mag;
    }
  }
  let total = 0;
  for (const v of chroma) total += v;
  if (total <= 0) return { key: -1, mode: 1 };
  for (let p = 0; p < 12; p++) chroma[p] /= total;

  /** Best rotation of a key template against the chroma, with its correlation. */
  const bestFit = (profile: number[]): { key: number; r: number } => {
    let meanP = 0;
    for (const v of profile) meanP += v;
    meanP /= 12;
    let best = -Infinity;
    let bestKey = -1;
    for (let rot = 0; rot < 12; rot++) {
      let num = 0;
      let denA = 0;
      let denB = 0;
      for (let i = 0; i < 12; i++) {
        // Chroma sums to 1, so its mean is 1/12 — centre both sides before
        // correlating so a loudness tilt cannot masquerade as key fit.
        const c = chroma[(i + rot) % 12] - 1 / 12;
        const p = profile[i] - meanP;
        num += c * p;
        denA += c * c;
        denB += p * p;
      }
      const r = denA > 0 && denB > 0 ? num / Math.sqrt(denA * denB) : -Infinity;
      if (r > best) {
        best = r;
        bestKey = rot;
      }
    }
    return { key: bestKey, r: best };
  };

  const major = bestFit(KS_MAJOR);
  const minor = bestFit(KS_MINOR);
  return major.r >= minor.r ? { key: major.key, mode: 1 } : { key: minor.key, mode: 0 };
}

/**
 * Streaming collector. Feed it the same PCM the visualizer gets; it downsamples
 * to 8 kHz mono in memory and measures the track once enough has played.
 */
export class LocalFeatureCollector {
  private buf: Buffer = Buffer.alloc(MAX_SAMPLES * 2);
  private len = 0;
  /** Source frames seen, so decimation stays in phase across uneven buffers. */
  private frames = 0;
  private carry: Buffer | null = null;

  reset(): void {
    this.len = 0;
    this.frames = 0;
    this.carry = null;
  }

  /** Feed stereo s16le at 48 kHz (the voice PCM format). */
  feed(pcm: Buffer): void {
    if (pcm.length === 0) return;
    let data = pcm;
    if (this.carry) {
      data = Buffer.concat([this.carry, pcm]);
      this.carry = null;
    }
    const frames = Math.floor(data.length / 4);
    for (let f = 0; f < frames; f++) {
      if ((this.frames + f) % DECIMATE !== 0) continue;
      if (this.len >= MAX_SAMPLES) break;
      const i = f * 4;
      const mono = (data.readInt16LE(i) + data.readInt16LE(i + 2)) / 2;
      this.buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(mono))), this.len * 2);
      this.len++;
    }
    this.frames += frames;
    const rest = data.length - frames * 4;
    // Keep the tail so the next buffer starts on a frame boundary.
    if (rest > 0) this.carry = Buffer.from(data.subarray(data.length - rest));
  }

  /** Seconds of audio collected so far. */
  seconds(): number {
    return this.len / TARGET_RATE;
  }

  /** Enough audio for a reliable read? */
  ready(minSeconds = 20): boolean {
    return this.seconds() >= minSeconds;
  }

  /** Measure the collected audio, or null when there is too little. */
  estimate(): LocalFeatures | null {
    if (!this.ready(8)) return null;
    const mono = this.buf.subarray(0, this.len * 2);
    const tempo = bestTempo(onsetEnvelope(mono, HOP)) ?? 0;
    const { key, mode } = estimateKey(mono);
    return { energy: estimateEnergy(mono), tempo, key, mode };
  }
}
