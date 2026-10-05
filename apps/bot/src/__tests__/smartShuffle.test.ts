import { describe, expect, it, vi } from 'vitest';
import { keyDistance, orderByVibe, vibeDistance } from '../smartShuffle.js';
import type { AudioFeatures } from '@vaporzr/core/spotify';

/** Minimal AudioFeatures with sane defaults. */
function feat(over: Partial<AudioFeatures> = {}): AudioFeatures {
  return {
    danceability: 0.6,
    energy: 0.5,
    valence: 0.5,
    tempo: 120,
    acousticness: 0.1,
    instrumentalness: 0.1,
    liveness: 0.1,
    speechiness: 0.05,
    key: 0, // C
    mode: 1, // major → 8B
    time_signature: 4,
    duration_ms: 200_000,
    ...over,
  };
}

/** A track-shaped tile pairing a name with its features. */
interface Tile {
  name: string;
  f: AudioFeatures | null;
}

const featOf = (t: Tile): AudioFeatures | null => t.f;

describe('keyDistance (Camelot)', () => {
  it('is zero for the same key and tiny for its relative', () => {
    expect(keyDistance(feat({ key: 0, mode: 1 }), feat({ key: 0, mode: 1 }))).toBe(0); // C major = 8B
    // A minor = 8A is the relative of C major (8B).
    expect(keyDistance(feat({ key: 0, mode: 1 }), feat({ key: 9, mode: 0 }))).toBeLessThan(0.1);
  });

  it('rewards an adjacent same-mode key and punishes a distant one', () => {
    const cMajor = feat({ key: 0, mode: 1 }); // 8B
    const gMajor = feat({ key: 7, mode: 1 }); // 9B — adjacent, clean boost
    const fSharp = feat({ key: 6, mode: 0 }); // 11A — far
    expect(keyDistance(cMajor, gMajor)).toBeLessThan(0.2);
    expect(keyDistance(cMajor, fSharp)).toBeGreaterThan(0.4);
  });
});

describe('vibeDistance', () => {
  it('scores a near-identical track closer than a wildly different one', () => {
    const a = feat({ energy: 0.5, valence: 0.5, tempo: 120 });
    const near = feat({ energy: 0.55, valence: 0.52, tempo: 122 });
    const far = feat({ energy: 0.95, valence: 0.1, tempo: 175, key: 6, mode: 0 });
    expect(vibeDistance(a, near)).toBeLessThan(vibeDistance(a, far));
  });
});

describe('orderByVibe — flow', () => {
  it('never puts two wildly different energies next to each other', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const tiles: Tile[] = [
      { name: 'a', f: feat({ energy: 0.1, tempo: 90 }) },
      { name: 'b', f: feat({ energy: 0.9, tempo: 175 }) },
      { name: 'c', f: feat({ energy: 0.15, tempo: 95 }) },
      { name: 'd', f: feat({ energy: 0.85, tempo: 170 }) },
      { name: 'e', f: feat({ energy: 0.5, tempo: 130 }) },
    ];
    const { ordered, withoutFeatures } = orderByVibe(tiles, tiles[0].f, 'flow', featOf);
    expect(withoutFeatures).toBe(0);
    expect(ordered).toHaveLength(5);
    // Every consecutive step should be a modest jump, not a cliff.
    for (let i = 1; i < ordered.length; i++) {
      expect(vibeDistance(ordered[i - 1].f!, ordered[i].f!, 'flow')).toBeLessThan(0.35);
    }
    vi.restoreAllMocks();
  });

  it('keeps featureless tracks in their original positions', () => {
    const tiles: Tile[] = [
      { name: 'a', f: feat({ energy: 0.1 }) },
      { name: 'no-features', f: null },
      { name: 'b', f: feat({ energy: 0.9 }) },
      { name: 'c', f: feat({ energy: 0.2 }) },
    ];
    const { ordered, withoutFeatures } = orderByVibe(tiles, null, 'flow', featOf);
    expect(withoutFeatures).toBe(1);
    expect(ordered[1].name).toBe('no-features');
    expect(ordered).toHaveLength(4);
  });
});

describe('orderByVibe — arc', () => {
  it('builds a curve that peaks rather than starting at full energy', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const energies = [0.2, 0.3, 0.45, 0.6, 0.75, 0.9, 0.95, 0.1];
    const tiles: Tile[] = energies.map((e, i) => ({ name: `t${i}`, f: feat({ energy: e }) }));
    const { ordered } = orderByVibe(tiles, null, 'arc', featOf);
    const first = ordered[0].f!.energy;
    const last = ordered[ordered.length - 1].f!.energy;
    const peak = Math.max(...ordered.map((t) => t.f!.energy));
    expect(peak).toBeGreaterThan(first);
    expect(peak).toBeGreaterThan(last);
    // The opener should be gentle, not the loudest track in the set.
    expect(first).toBeLessThan(0.6);
    vi.restoreAllMocks();
  });
});

describe('orderByVibe — key', () => {
  it('keeps adjacent tracks harmonically compatible', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    // A real harmonic chain: C major (8B) → A minor (8A, relative) →
    // G major (9B) → D major (10B) → A major (11B).
    const tiles: Tile[] = [
      { name: 'c-major', f: feat({ key: 0, mode: 1 }) },
      { name: 'a-minor', f: feat({ key: 9, mode: 0 }) },
      { name: 'g-major', f: feat({ key: 7, mode: 1 }) },
      { name: 'd-major', f: feat({ key: 2, mode: 1 }) },
      { name: 'a-major', f: feat({ key: 9, mode: 1 }) },
    ];
    const { ordered } = orderByVibe(tiles, tiles[0].f, 'key', featOf);
    for (let i = 1; i < ordered.length; i++) {
      expect(keyDistance(ordered[i - 1].f!, ordered[i].f!)).toBeLessThan(0.35);
    }
    vi.restoreAllMocks();
  });
});
