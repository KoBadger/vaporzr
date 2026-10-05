import { describe, expect, it } from 'vitest';
import {
  orderByVibe,
  vibeDistance,
  keyDistance,
  SHUFFLE_MODE_LABEL,
  type ShuffleMode,
} from '../smartShuffle.js';
import type { AudioFeatures } from '@vaporzr/core/spotify';

/** Deterministic LCG so the fixtures are identical on every run. */
function rnd(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function features(over: Partial<AudioFeatures> = {}): AudioFeatures {
  return {
    energy: 0.5,
    valence: 0.5,
    tempo: 120,
    acousticness: 0.1,
    instrumentalness: 0,
    danceability: 0.5,
    liveness: 0.1,
    speechiness: 0.05,
    time_signature: 4,
    duration_ms: 200000,
    key: 0,
    mode: 1,
    ...over,
  };
}

/**
 * A single-genre playlist: features cluster tightly around the middle, which is
 * exactly the case where a too-large jitter used to swamp the real signal.
 */
function playlist(n: number, spread: number, seed = 42): Array<{ uri: string; f: AudioFeatures }> {
  const r = rnd(seed);
  const out: Array<{ uri: string; f: AudioFeatures }> = [];
  for (let i = 0; i < n; i++) {
    out.push({
      uri: `spotify:track:t${i}`,
      f: features({
        energy: 0.5 - spread / 2 + r() * spread,
        valence: 0.5 - spread / 2 + r() * spread,
        tempo: 120 + (r() - 0.5) * 2 * (spread * 60),
        acousticness: r() * 0.3,
        key: Math.floor(r() * 12),
        mode: r() > 0.5 ? 1 : 0,
      }),
    });
  }
  return out;
}

function meanAdjacent<T extends { f: AudioFeatures }>(list: T[], mode: ShuffleMode): number {
  let sum = 0;
  for (let i = 1; i < list.length; i++) sum += vibeDistance(list[i - 1].f, list[i].f, mode);
  return sum / (list.length - 1);
}

describe('smart shuffle ordering', () => {
  // The original bug: jitter was up to 0.02 while best-vs-second-best score gaps
  // averaged 0.019, so the "vibe" pick was decided by noise. Reordering still
  // happened, so a naive "did the order change" assertion passed while the
  // result felt arbitrary. These tests assert the ordering is actually MUSICAL.
  it.each(['flow', 'arc', 'key'] as const)(
    'reduces adjacent vibe distance for %s on a tight playlist',
    (mode) => {
      const pl = playlist(40, 0.25);
      const input = meanAdjacent(pl, mode);
      const { ordered } = orderByVibe(pl, pl[0].f, mode, (t) => t.f);
      const output = meanAdjacent(ordered, mode);
      // A real ordering must beat the input order by a wide margin. 0.8 (a 20%
      // improvement) is far too lenient: the old jitter-drowned code still
      // cleared it, because a greedy nearest-neighbour pass improves the mean
      // even when each individual pick is noise. The observed result is a 50%
      // reduction, so assert most of that.
      expect(output).toBeLessThan(input * 0.65);
    },
  );

  it('beats the input order even on a very tight (homogeneous) playlist', () => {
    // spread 0.10 is the worst case for signal-to-noise: everything sounds alike.
    const pl = playlist(40, 0.1);
    const input = meanAdjacent(pl, 'flow');
    const { ordered } = orderByVibe(pl, pl[0].f, 'flow', (t) => t.f);
    expect(meanAdjacent(ordered, 'flow')).toBeLessThan(input * 0.65);
  });

  it('makes each mode reach a different ordering', () => {
    const pl = playlist(40, 0.25);
    const asKey = (mode: ShuffleMode) => orderByVibe(pl, pl[0].f, mode, (t) => t.f).ordered.map((t) => t.uri).join(',');
    const flow = asKey('flow');
    const arc = asKey('arc');
    const key = asKey('key');
    // "smart"/arc/key must not be three names for one behaviour.
    expect(new Set([flow, arc, key]).size).toBe(3);
  });

  /**
   * The actual defect: jitter (0.02) exceeded the typical best-vs-second-best
   * score gap (~0.019), so the greedy pick was decided by noise. Measured as an
   * AGGREGATE the old code still looked acceptable — a nearest-neighbour walk
   * improves the mean even when every individual choice is wrong — so the
   * regression is only visible per-pick. With the anchor pinned, the first
   * choice must be the genuinely closest track, not merely a close one.
   */
  it('chooses the genuinely nearest neighbour, not a noisy one', () => {
    const pl = playlist(60, 0.25, 11);
    const anchor = features({ energy: 0.5, valence: 0.5, tempo: 120, key: 0, mode: 1 });

    // The true best: minimise vibeDistance with no randomness at all.
    let bestIdx = 0;
    let bestD = Infinity;
    pl.forEach((t, i) => {
      const d = vibeDistance(anchor, t.f, 'flow');
      if (d < bestD) { bestD = d; bestIdx = i; }
    });
    const bestUris = new Set(
      pl.map((t, i) => ({ i, d: vibeDistance(anchor, t.f, 'flow') }))
        .filter((x) => x.d - bestD < 0.005) // tolerate genuine ties
        .map((x) => pl[x.i].uri),
    );

    // With sane jitter the first pick lands on a true nearest neighbour every
    // run. With jitter at 0.02 it misses most of the time.
    let hits = 0;
    const RUNS = 25;
    for (let r = 0; r < RUNS; r++) {
      const { ordered } = orderByVibe(pl, anchor, 'flow', (t) => t.f);
      if (bestUris.has(ordered[0].uri)) hits++;
    }
    expect(hits / RUNS).toBeGreaterThan(0.7);
  });

  it('is stable across runs apart from tie-break noise', () => {
    // Jitter exists only to break ties, so repeated runs must largely agree.
    const pl = playlist(30, 0.3, 7);
    const once = orderByVibe(pl, pl[0].f, 'flow', (t) => t.f).ordered.map((t) => t.uri);
    const twice = orderByVibe(pl, pl[0].f, 'flow', (t) => t.f).ordered.map((t) => t.uri);
    let same = 0;
    for (let i = 0; i < once.length; i++) if (once[i] === twice[i]) same++;
    expect(same / once.length).toBeGreaterThan(0.6);
  });

  it('keeps featureless tracks in their original slots', () => {
    const withF = playlist(6, 0.3);
    const mixed: Array<{ uri: string; f: AudioFeatures | null }> = [
      { ...withF[0] },
      { uri: 'youtube:video:aaa', f: null },
      { ...withF[1] },
      { ...withF[2] },
      { uri: 'youtube:video:bbb', f: null },
      { ...withF[3] },
    ];
    const { ordered, withoutFeatures } = orderByVibe(mixed, null, 'flow', (t) => t.f);
    expect(withoutFeatures).toBe(2);
    // Featureless items never move — a shuffle must not drop or pile them up.
    expect(ordered[1].uri).toBe('youtube:video:aaa');
    expect(ordered[4].uri).toBe('youtube:video:bbb');
  });

  it('returns the input untouched when fewer than two items have features', () => {
    const items: Array<{ uri: string; f: AudioFeatures | null }> = [
      { uri: 'a', f: features() },
      { uri: 'b', f: null },
      { uri: 'c', f: null },
    ];
    const { ordered, withoutFeatures } = orderByVibe(items, null, 'key', (t) => t.f);
    expect(ordered.map((t) => t.uri)).toEqual(['a', 'b', 'c']);
    expect(withoutFeatures).toBe(2);
  });
});

describe('keyDistance (Camelot harmonic mixing)', () => {
  it('scores the same key as free and a relative key as near-free', () => {
    expect(keyDistance(features({ key: 0, mode: 1 }), features({ key: 0, mode: 1 }))).toBe(0);
    // 0 major and 9 minor are relative (both Camelot 8).
    expect(keyDistance(features({ key: 0, mode: 1 }), features({ key: 9, mode: 0 }))).toBeLessThan(0.1);
  });

  it('scores adjacent Camelot numbers as a clean mix', () => {
    // 0 major (8B) next to 7 major (9B).
    const d = keyDistance(features({ key: 0, mode: 1 }), features({ key: 7, mode: 1 }));
    expect(d).toBeGreaterThan(0);
    expect(d).toBeLessThan(0.25);
  });

  it('treats an unknown key as neutral rather than a blocker', () => {
    expect(keyDistance(features({ key: 99 }), features({ key: 0 }))).toBe(0.5);
  });
});

describe('SHUFFLE_MODE_LABEL', () => {
  it('describes every mode', () => {
    for (const mode of ['flow', 'arc', 'key'] as const) {
      expect(SHUFFLE_MODE_LABEL[mode]).toBeTruthy();
    }
  });
});
