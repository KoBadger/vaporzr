import { spawn } from 'node:child_process';
import { config } from '@vaporzr/core/config';

/**
 * Rough tempo (BPM) detected from the audio itself.
 *
 * Spotify retired `/audio-features`, and the ReccoBeats backfill only covers
 * part of the catalogue — so a mashup frequently had NO tempo for one side and
 * the two tracks were layered with no time alignment (they drift apart). This
 * derives a usable tempo straight from the waveform: decode to low-rate mono,
 * build an onset-strength envelope, and autocorrelate it.
 *
 * Deliberately simple (energy-based, 4/4-friendly): good enough to drive a
 * rubberband stretch, not a transcription.
 */

const RATE = 8000;
const HOP = 80; // 10 ms frames at 8 kHz

/** Decode a file to mono s16le PCM at `rate` Hz via ffmpeg. */
function decodeMono(file: string, rate: number, timeoutMs: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: Buffer | null): void => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    const p = spawn(
      config.ffmpegPath,
      ['-hide_banner', '-loglevel', 'error', '-i', file, '-ac', '1', '-ar', String(rate), '-f', 's16le', 'pipe:1'],
      { windowsHide: true },
    );
    const chunks: Buffer[] = [];
    p.stdout?.on('data', (d: Buffer) => chunks.push(d));
    p.on('error', () => done(null));
    p.on('exit', (code) => done(code === 0 ? Buffer.concat(chunks) : null));
    const t = setTimeout(() => {
      p.kill('SIGKILL');
      done(null);
    }, timeoutMs);
    t.unref?.();
  });
}

/** Half-wave-rectified energy difference per 10 ms frame (onset strength). */
export function onsetEnvelope(pcm: Buffer, hop: number): Float64Array {
  const frames = Math.floor(pcm.length / 2 / hop);
  const rms = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const base = f * hop * 2;
    for (let i = 0; i < hop; i++) {
      const s = pcm.readInt16LE(base + i * 2) / 32768;
      sum += s * s;
    }
    rms[f] = Math.sqrt(sum / hop);
  }
  const env = new Float64Array(frames);
  for (let f = 1; f < frames; f++) env[f] = Math.max(0, rms[f] - rms[f - 1]);
  return env;
}

/** Best tempo in 60–200 BPM by autocorrelating the onset envelope. */
export function bestTempo(env: Float64Array): number | null {
  const n = env.length;
  if (n < 300) return null;
  // Normalise so the correlation is scale-free.
  let mean = 0;
  for (let i = 0; i < n; i++) mean += env[i];
  mean /= n;
  let energy = 0;
  for (let i = 0; i < n; i++) {
    env[i] -= mean;
    energy += env[i] * env[i];
  }
  if (energy <= 0) return null;

  const minLag = Math.floor(60 / 200 / 0.01); // 200 BPM
  const maxLag = Math.ceil(60 / 60 / 0.01); // 60 BPM
  let bestLag = -1;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag && lag < n; lag++) {
    let sum = 0;
    for (let i = lag; i < n; i++) sum += env[i] * env[i - lag];
    sum /= n - lag;
    // Log-normal prior centred on 120 BPM damps octave errors (60/240).
    const bpm = 6000 / lag;
    const w = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.9, 2));
    const score = sum * w;
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  if (bestLag < 0) return null;
  const bpm = 6000 / bestLag;
  return bpm >= 55 && bpm <= 210 ? Math.round(bpm * 10) / 10 : null;
}

/** Estimate the tempo (BPM) of an audio file, or null when it can't be read. */
export async function estimateTempo(file: string, timeoutMs = 30_000): Promise<number | null> {
  try {
    const pcm = await decodeMono(file, RATE, timeoutMs);
    if (!pcm || pcm.length < RATE * 2 * 8) return null; // need ~8 s of audio
    return bestTempo(onsetEnvelope(pcm, HOP));
  } catch {
    return null;
  }
}
