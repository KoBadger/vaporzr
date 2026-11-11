import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { crossfadePcm, equalPowerIn, equalPowerOut, fadeInPcm } from '../crossfade.js';

/**
 * Audio-level checks for the blend, as opposed to the scheduling checks in
 * crossfade.test.ts. The blend is the part a listener judges by ear, so it gets
 * a golden hash: a deliberate change to the curve should force someone to look
 * at this file, and an accidental one should fail loudly.
 */

/** Deterministic 48 kHz stereo Int16: a left/right-differenting ramp. */
function ramp(frames: number, scale: number): Buffer {
  const b = Buffer.allocUnsafe(frames * 4);
  for (let i = 0; i < frames; i++) {
    b.writeInt16LE(((i * 37) % 2000) * scale, i * 4);
    b.writeInt16LE(((i * 53) % 2000) * scale, i * 4 + 2);
  }
  return b;
}

const sha = (b: Buffer): string => crypto.createHash('sha256').update(b).digest('hex');

describe('crossfadePcm', () => {
  it('is exactly a at t=0 and exactly b at t=1', () => {
    // Two frames, so the complementary ramps evaluate at their endpoints only.
    const a = Buffer.alloc(2 * 4);
    const b = Buffer.alloc(2 * 4);
    a.writeInt16LE(1000, 0); // frame 0 L
    a.writeInt16LE(100, 4); // frame 1 L
    b.writeInt16LE(0, 0);
    b.writeInt16LE(2000, 4);
    const out = crossfadePcm(a, b, 2);

    expect(out.readInt16LE(0)).toBe(1000); // ga=1, gb=0
    expect(out.readInt16LE(4)).toBe(2000); // ga=0, gb=1
    // The right channel is silent in both inputs.
    expect(out.readInt16LE(2)).toBe(0);
    expect(out.readInt16LE(6)).toBe(0);
  });

  it('never dips below either input while the ramps cross', () => {
    // Both sides at the same constant level: the equal-power sum runs from that
    // level (one side) to +3 dB (both), so a *dip* is what would be audible.
    const a = Buffer.alloc(480 * 4);
    const b = Buffer.alloc(480 * 4);
    for (let i = 0; i < 480; i++) {
      a.writeInt16LE(10_000, i * 4);
      a.writeInt16LE(10_000, i * 4 + 2);
      b.writeInt16LE(10_000, i * 4);
      b.writeInt16LE(10_000, i * 4 + 2);
    }
    const out = crossfadePcm(a, b, 480);
    for (let i = 0; i < 480; i++) {
      const v = out.readInt16LE(i * 4);
      expect(v).toBeGreaterThanOrEqual(10_000);
      expect(v).toBeLessThanOrEqual(Math.ceil(10_000 * Math.SQRT2) + 1);
    }
  });

  it('matches the committed golden hash for a fixed input', () => {
    const a = ramp(1000, 1);
    const b = ramp(1000, -1);
    const out = crossfadePcm(a, b, 240);
    // Captured from the reviewed implementation. Changing the curve (equal-power
    // -> linear, a different ramp placement) must change this number on purpose.
    expect(sha(out)).toBe('c4c26283b4862d819404d7bd972f683dc0436ac68eec02c714bdb7159661f3a1');
  });

  it('carries the longer source past the overlap instead of truncating it', () => {
    const a = ramp(500, 1);
    const b = ramp(900, 1);
    const out = crossfadePcm(a, b, 100);
    expect(out.length).toBe(b.length);
    // Beyond the 500 shared frames the incoming track is passed through untouched.
    expect(out.subarray(500 * 4)).toEqual(b.subarray(500 * 4));
  });
});

describe('fadeInPcm', () => {
  it('matches the committed golden hash for a fixed input', () => {
    const head = ramp(1000, 1);
    expect(sha(fadeInPcm(head, 100))).toBe('18f121c41d67feafb61c97135f26e10187c4306ead9cf92745cf483683152ab5');
  });

  it('reaches full level at the end of the ramp and never exceeds it', () => {
    const head = Buffer.alloc(4800 * 4);
    for (let i = 0; i < 4800; i++) head.writeInt16LE(16_000, i * 4);
    const out = fadeInPcm(head, 100); // 4800 frames == 100 ms
    expect(out.readInt16LE(0)).toBe(0);
    let peak = 0;
    for (let i = 0; i < 4800; i++) peak = Math.max(peak, out.readInt16LE(i * 4));
    expect(peak).toBeLessThanOrEqual(16_000);
    expect(peak).toBeGreaterThanOrEqual(15_990);
    // Past the ramp the audio is untouched.
    expect(out.readInt16LE(4799 * 4)).toBe(16_000);
  });

  it('uses the linear curve when asked', () => {
    const head = Buffer.alloc(4 * 4);
    for (let i = 0; i < 4; i++) head.writeInt16LE(10_000, i * 4);
    const out = fadeInPcm(head, 100, 'linear'); // 4-frame ramp: t = i/3
    expect(out.readInt16LE(0)).toBe(0);
    expect(out.readInt16LE(4)).toBe(3333);
    expect(out.readInt16LE(8)).toBe(6667);
    expect(out.readInt16LE(12)).toBe(10_000);
  });

  it('agrees with the curve helpers at the endpoints', () => {
    expect(equalPowerIn(0)).toBe(0);
    expect(equalPowerIn(1)).toBeCloseTo(1, 12);
    expect(equalPowerOut(0)).toBeCloseTo(1, 12);
    expect(equalPowerOut(1)).toBeCloseTo(0, 12);
  });
});
