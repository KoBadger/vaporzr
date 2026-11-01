import { describe, expect, it } from 'vitest';
import { normalizeCapturePcm } from '../capture.js';

/** Build a mono 48 kHz Int16 buffer at a fixed peak amplitude. */
function tone(peak: number, samples = 960): Buffer {
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(i % 2 === 0 ? peak : -peak, i * 2);
  }
  return buf;
}

describe('normalizeCapturePcm', () => {
  it('boosts a quiet mic capture toward full scale', () => {
    const quiet = tone(1200);
    const { pcm, peak, gain } = normalizeCapturePcm(quiet);
    expect(peak).toBe(1200);
    expect(gain).toBeGreaterThan(1);
    expect(Math.abs(pcm.readInt16LE(0))).toBeGreaterThan(1200);
    expect(pcm.length).toBe(quiet.length);
  });

  it('caps the gain at 4x so noise is not blown up', () => {
    const { gain, pcm } = normalizeCapturePcm(tone(100));
    expect(gain).toBe(4);
    expect(Math.abs(pcm.readInt16LE(0))).toBe(400);
  });

  it('leaves an already-loud clip untouched', () => {
    const loud = tone(20000);
    const { pcm, peak, gain } = normalizeCapturePcm(loud);
    expect(peak).toBe(20000);
    expect(gain).toBe(1);
    expect(pcm).toBe(loud);
  });

  it('never clips past Int16 range', () => {
    const { pcm } = normalizeCapturePcm(tone(7999));
    for (let i = 0; i < pcm.length / 2; i++) {
      expect(pcm.readInt16LE(i * 2)).toBeGreaterThanOrEqual(-32768);
      expect(pcm.readInt16LE(i * 2)).toBeLessThanOrEqual(32767);
    }
  });

  it('handles silence and empty buffers safely', () => {
    expect(normalizeCapturePcm(tone(0))).toMatchObject({ peak: 0, gain: 1 });
    expect(normalizeCapturePcm(Buffer.alloc(0))).toMatchObject({ peak: 0, gain: 1 });
  });
});
