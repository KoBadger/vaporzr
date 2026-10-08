import { describe, it, expect } from 'vitest';
import { onsetEnvelope, bestTempo, alignLagFrames } from '@vaporzr/core/tempo';

const RATE = 8000;
const HOP = 80; // 10 ms

/** s16le mono PCM with a short burst every `beatFrames` frames (a click track). */
function clicks(bpm: number, seconds: number): Buffer {
  const frames = Math.floor((seconds * RATE) / HOP);
  const beatFrames = Math.round(60 / bpm / 0.01);
  const buf = Buffer.alloc(frames * HOP * 2);
  for (let f = 0; f < frames; f++) {
    if (f % beatFrames !== 0) continue;
    const base = f * HOP * 2;
    for (let i = 0; i < HOP; i++) buf.writeInt16LE(Math.round(30000 * Math.sin((i / HOP) * Math.PI)), base + i * 2);
  }
  return buf;
}

describe('tempo estimation', () => {
  it('recovers 120 BPM from a click track', () => {
    const env = onsetEnvelope(clicks(120, 20), HOP);
    expect(bestTempo(env)).toBeCloseTo(120, 0);
  });

  it('recovers 128 BPM (house tempo)', () => {
    const env = onsetEnvelope(clicks(128, 20), HOP);
    const bpm = bestTempo(env)!;
    expect(Math.min(Math.abs(bpm - 128), Math.abs(bpm - 64), Math.abs(bpm - 256))).toBeLessThan(3);
  });

  it('returns null for a flat/silent signal', () => {
    const silence = Buffer.alloc(RATE * 2 * 10);
    expect(bestTempo(onsetEnvelope(silence, HOP))).toBeNull();
  });
});

describe('beat-phase alignment', () => {
  const pulses = (n: number, period: number, phase = 0): Float64Array => {
    const a = new Float64Array(n);
    for (let i = phase; i < n; i += period) a[i] = 1;
    return a;
  };

  it('finds no shift for identical envelopes', () => {
    expect(alignLagFrames(pulses(400, 50), pulses(400, 50), 40)).toBe(0);
  });

  it('reports the shift when one envelope arrives later', () => {
    // b's beats are 7 frames after a's → negative lag (delay a to line up).
    expect(alignLagFrames(pulses(400, 50), pulses(400, 50, 7), 40)).toBe(-7);
  });

  it('resolves periodic ties to the smallest correction', () => {
    // A 20-frame period ties at 0, ±20, ±40 within the window; 0 must win.
    expect(alignLagFrames(pulses(400, 20), pulses(400, 20), 40)).toBe(0);
  });
});
