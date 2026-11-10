import { describe, it, expect } from 'vitest';
import { clampSeekMs } from '@vaporzr/core/playback';

/**
 * A seek arrives from the panel, the bridge or a Discord command, so the value
 * is whatever a remote caller sent. It used to be forwarded unchecked into
 * ffmpeg's `-ss` and into setTimeout, where NaN fires immediately — the track
 * appeared to skip itself.
 */
describe('clampSeekMs', () => {
  it('passes an ordinary position through, rounded', () => {
    expect(clampSeekMs(61_500, 240_000)).toBe(61_500);
    expect(clampSeekMs(61_500.6, 240_000)).toBe(61_501);
  });

  it('rejects values that would poison ffmpeg or setTimeout', () => {
    expect(clampSeekMs(Number.NaN, 240_000)).toBeNull();
    expect(clampSeekMs(Number.POSITIVE_INFINITY, 240_000)).toBeNull();
    expect(clampSeekMs(undefined as unknown as number, 240_000)).toBeNull();
    expect(clampSeekMs('not a number' as unknown as number, 240_000)).toBeNull();
  });

  it('accepts a numeric string (JSON round-trip from the panel)', () => {
    expect(clampSeekMs('42000' as unknown as number, 240_000)).toBe(42_000);
  });

  it('clamps negatives to the start', () => {
    expect(clampSeekMs(-5_000, 240_000)).toBe(0);
  });

  it('keeps the 250ms tail margin so the end is never scheduled in the past', () => {
    expect(clampSeekMs(240_000, 240_000)).toBe(239_750);
    expect(clampSeekMs(9e9, 240_000)).toBe(239_750);
  });

  it('leaves the position alone when the duration is unknown (live stream)', () => {
    expect(clampSeekMs(120_000, 0)).toBe(120_000);
  });
});
