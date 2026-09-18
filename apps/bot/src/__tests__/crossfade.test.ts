import { describe, expect, it } from 'vitest';
import { crossfadePcm, equalPowerIn, equalPowerOut, fadeInPcm, linearIn } from '../crossfade.js';

/** Build `frames` of 48 kHz stereo Int16 PCM with a constant sample value. */
function pcm(frames: number, value = 1000): Buffer {
  const b = Buffer.allocUnsafe(frames * 4);
  for (let i = 0; i < frames; i++) {
    b.writeInt16LE(value, i * 4);
    b.writeInt16LE(value, i * 4 + 2);
  }
  return b;
}

describe('equal-power curves', () => {
  it('starts at 0 / 1 and ends at 1 / 0', () => {
    expect(equalPowerIn(0)).toBeCloseTo(0, 5);
    expect(equalPowerIn(1)).toBeCloseTo(1, 5);
    expect(equalPowerOut(0)).toBeCloseTo(1, 5);
    expect(equalPowerOut(1)).toBeCloseTo(0, 5);
  });

  it('keeps constant power across the blend (in^2 + out^2 == 1)', () => {
    for (const t of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
      const p = equalPowerIn(t) ** 2 + equalPowerOut(t) ** 2;
      expect(p).toBeCloseTo(1, 5);
    }
  });

  it('clamps out-of-range progress', () => {
    expect(equalPowerIn(-1)).toBe(0);
    expect(equalPowerIn(2)).toBeCloseTo(1, 5);
    expect(linearIn(-3)).toBe(0);
    expect(linearIn(3)).toBe(1);
  });
});

describe('fadeInPcm', () => {
  it('ramps the head from silence and leaves the tail untouched', () => {
    const out = fadeInPcm(pcm(1000, 1000), 10, 'linear'); // 10ms == 480 frames
    expect(out.readInt16LE(0)).toBe(0); // first sample silenced
    expect(out.readInt16LE(479 * 4)).toBeGreaterThan(900); // end of ramp ≈ full
    expect(out.readInt16LE(999 * 4)).toBe(1000); // tail untouched
  });

  it('does not mutate the source buffer', () => {
    const src = pcm(100, 1000);
    fadeInPcm(src, 10);
    expect(src.readInt16LE(0)).toBe(1000);
  });

  it('handles a ramp longer than the clip without overrunning', () => {
    const out = fadeInPcm(pcm(100, 1000), 5000);
    expect(out.length).toBe(400);
  });
});

describe('crossfadePcm', () => {
  it('starts on the outgoing track and ends on the incoming one', () => {
    const out = crossfadePcm(pcm(100, 1000), pcm(100, 2000), 50);
    // First frame dominated by `a`, last frame dominated by `b`.
    expect(out.readInt16LE(0)).toBeCloseTo(1000, -1);
    expect(out.readInt16LE(99 * 4)).toBeCloseTo(2000, -1);
  });

  it('keeps length = max of the two inputs', () => {
    expect(crossfadePcm(pcm(100), pcm(300), 50).length).toBe(300 * 4);
    expect(crossfadePcm(pcm(300), pcm(100), 50).length).toBe(300 * 4);
  });

  it('clamps the summed samples instead of wrapping', () => {
    const out = crossfadePcm(pcm(10, 30000), pcm(10, 30000), 10);
    for (let i = 0; i < 10; i++) {
      expect(out.readInt16LE(i * 4)).toBeLessThanOrEqual(32767);
      expect(out.readInt16LE(i * 4)).toBeGreaterThanOrEqual(-32768);
    }
  });
});
