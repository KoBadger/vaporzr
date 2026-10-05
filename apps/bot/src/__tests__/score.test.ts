import { afterEach, describe, expect, it, vi } from 'vitest';
import { scoreBreakdown, scoreCandidate } from '@vaporzr/core/endlesswave';
import type { AudioFeatures, ResolvedTrack } from '@vaporzr/core/spotify';

const track = (over: Partial<ResolvedTrack> = {}): ResolvedTrack => ({
  uri: 'spotify:track:abcdefghijklmnopqrstuv',
  name: 'Test',
  artists: ['A'],
  album: '',
  durationMs: 200_000,
  source: 'spotify',
  ...over,
});

const features = (over: Partial<AudioFeatures> = {}): AudioFeatures => ({
  danceability: 0.5,
  energy: 0.5,
  valence: 0.5,
  tempo: 120,
  acousticness: 0.3,
  instrumentalness: 0.1,
  liveness: 0.1,
  speechiness: 0.05,
  key: 0,
  mode: 1,
  time_signature: 4,
  duration_ms: 200_000,
  ...over,
});

const targets = {
  targetEnergy: 0.5,
  targetValence: 0.5,
  targetDanceability: 0.5,
  targetAcousticness: 0.3,
  targetInstrumentalness: 0.1,
  targetTempo: 120,
  targetKey: 0,
  targetMode: 1,
};

describe('scoreBreakdown (game-facing scoring)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('its terms always sum to the reported total', () => {
    const b = scoreBreakdown(track(), targets, [], features());
    expect(b.terms.reduce((n, t) => n + t.points, 0)).toBeCloseTo(b.total);
  });

  it('drops the two heaviest terms when a track has no features (the old unfairness)', () => {
    const b = scoreBreakdown(track({ uri: 'youtube:video:xyz' }), targets, [], undefined);
    expect(b.terms.some((t) => t.id === 'features')).toBe(false);
    expect(b.terms.some((t) => t.id === 'key')).toBe(false);
  });

  it('with jitter off it is fully deterministic and reports no jitter term', () => {
    const a = scoreBreakdown(track(), targets, [], features(), undefined, { jitter: false });
    const b = scoreBreakdown(track(), targets, [], features(), undefined, { jitter: false });
    expect(a.total).toBe(b.total);
    expect(a.terms.some((t) => t.id === 'jitter')).toBe(false);
  });

  it('with jitter on it adds a 0-2 random term', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const b = scoreBreakdown(track(), targets, [], features());
    const j = b.terms.find((t) => t.id === 'jitter');
    expect(j?.points).toBeCloseTo(1);
  });

  it('scoreCandidate still equals the breakdown total (EW picking unchanged)', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.25);
    const t = track();
    expect(scoreCandidate(t, targets, [], features())).toBeCloseTo(
      scoreBreakdown(t, targets, [], features()).total,
    );
  });

  it('labels an artist that just played as a penalty', () => {
    const hot = scoreBreakdown(track({ artists: ['Bonobo'] }), targets, ['Bonobo'], features(), undefined, { jitter: false });
    const fresh = scoreBreakdown(track({ artists: ['Nils Frahm'] }), targets, ['Bonobo'], features(), undefined, { jitter: false });
    expect(hot.terms.find((t) => t.id === 'artist')?.points).toBe(20);
    expect(hot.total).toBeGreaterThan(fresh.total);
  });

  it('a song matching the room scores better than a mismatched one', () => {
    const onVibe = scoreBreakdown(track(), targets, [], features({ energy: 0.5, valence: 0.5 }), undefined, { jitter: false });
    const offVibe = scoreBreakdown(track(), targets, [], features({ energy: 0.98, valence: 0.02 }), undefined, { jitter: false });
    expect(onVibe.total).toBeLessThan(offVibe.total);
  });
});
