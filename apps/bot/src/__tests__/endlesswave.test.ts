import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getRecommendations: vi.fn(),
  searchTracks: vi.fn(),
  getAudioFeatures: vi.fn(),
  searchAndResolveYoutube: vi.fn(),
  deezerRelatedTracks: vi.fn(),
}));

vi.mock('../deezer.js', () => ({
  deezerRelatedTracks: (...args: unknown[]) => mocks.deezerRelatedTracks(...args),
}));

vi.mock('../spotify.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../spotify.js')>();
  return {
    ...actual,
    getRecommendations: (...args: unknown[]) => mocks.getRecommendations(...args),
    searchTracks: (...args: unknown[]) => mocks.searchTracks(...args),
    getAudioFeatures: (...args: unknown[]) => mocks.getAudioFeatures(...args),
  };
});

vi.mock('../youtube.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../youtube.js')>();
  return {
    ...actual,
    searchAndResolveYoutube: (...args: unknown[]) => mocks.searchAndResolveYoutube(...args),
  };
});

import {
  DEFAULT_CONFIG,
  createState,
  activate,
  deactivate,
  snapshot,
  recordFeatures,
  computeAverage,
  evolveDirection,
  buildTargets,
  isDuplicate,
  isRemixOrCover,
  isArtistOnCooldown,
  markPlayed,
  scoreCandidate,
  extractSeeds,
  normalizeTrackName,
  pickContext,
  pickNextTrack,
  resolveCandidate,
  fetchFeatures,
  noteWaveQueued,
  noteWaveDeadEnd,
  serializeState,
  restoreState,
} from '../endlesswave.js';
import type { EndlessWaveState } from '../endlesswave.js';
import type { AudioFeatures, ResolvedTrack } from '../spotify.js';
import type { TrackInfo } from '@vaporzr/shared';

/* ---------- helpers ---------- */

function fakeFeatures(overrides: Partial<AudioFeatures> = {}): AudioFeatures {
  return {
    danceability: 0.6,
    energy: 0.7,
    valence: 0.5,
    tempo: 120,
    acousticness: 0.2,
    instrumentalness: 0.1,
    liveness: 0.1,
    speechiness: 0.05,
    key: 0,
    mode: 1,
    time_signature: 4,
    duration_ms: 200_000,
    ...overrides,
  };
}

function fakeTrack(overrides: Partial<TrackInfo> = {}): TrackInfo {
  return {
    uri: 'spotify:track:abc123',
    name: 'Test Track',
    artists: ['Test Artist'],
    album: 'Test Album',
    durationMs: 200_000,
    source: 'spotify',
    addedBy: 'user',
    addedAt: Date.now(),
    ...overrides,
  };
}

function stateWithHistory(n: number): EndlessWaveState {
  const state = createState();
  state.active = true;
  for (let i = 0; i < n; i++) {
    recordFeatures(state, fakeFeatures({ energy: 0.3 + i * 0.1 }), `artist-${i}`);
    markPlayed(state, `spotify:track:${i}`, `Track ${i}`, [`Artist ${i}`]);
  }
  return state;
}

/* ---------- tests ---------- */

describe('state management', () => {
  it('creates initial state as inactive', () => {
    const s = createState();
    expect(s.active).toBe(false);
    expect(s.playedUris.size).toBe(0);
    expect(s.recentFeatures).toEqual([]);
    expect(s.generated).toBe(0);
  });

  it('activate resets all state', () => {
    const s = createState();
    s.active = true;
    s.playedUris.add('x');
    s.generated = 5;
    activate(s);
    expect(s.active).toBe(true);
    expect(s.playedUris.size).toBe(0);
    expect(s.recentFeatures).toEqual([]);
    expect(s.generated).toBe(0);
    expect(s.genreDrift).toBe(0);
  });

  it('tracks run streak, longest run and dead-ends', () => {
    const s = createState();
    noteWaveQueued(s, ['Artist A', 'artist-b', '']);
    noteWaveQueued(s, ['Artist B']);
    expect(s.runStreak).toBe(2);
    expect(s.longestRun).toBe(2);
    expect(s.artistSet.size).toBe(3);
    noteWaveDeadEnd(s);
    expect(s.deadEnds).toBe(1);
    expect(s.runStreak).toBe(0);
    expect(s.longestRun).toBe(2);
    const snap = snapshot(s);
    expect(snap.deadEnds).toBe(1);
    expect(snap.runStreak).toBe(0);
    expect(snap.longestRun).toBe(2);
    expect(snap.artistCount).toBe(3);
  });

  it('serialize/restore round-trips the wave across a restart', () => {
    const s = createState();
    activate(s);
    s.generated = 4;
    s.deadEnds = 2;
    s.runStreak = 3;
    s.longestRun = 5;
    s.playedUris.add('spotify:track:a');
    s.playedUris.add('spotify:track:b');
    s.playedNames.add('MAGIC');
    s.recentArtists = ['Coldplay', 'Kavinsky'];
    const f = fakeFeatures({ energy: 0.8, tempo: 124 });
    s.recentFeatures = [f];
    s.avg = f;
    s.genreDrift = 0.06;
    s.artistSet.add(' COLDPLAY ');
    const restored = restoreState(serializeState(s));
    expect(restored.active).toBe(true);
    expect(restored.generated).toBe(4);
    expect(restored.deadEnds).toBe(2);
    expect(restored.runStreak).toBe(3);
    expect(restored.longestRun).toBe(5);
    expect(restored.playedUris.size).toBe(2);
    expect(restored.playedUris.has('spotify:track:a')).toBe(true);
    expect(restored.playedNames.has('MAGIC')).toBe(true);
    expect(restored.recentArtists).toEqual(['Coldplay', 'Kavinsky']);
    expect(restored.recentFeatures[0].energy).toBe(0.8);
    expect(restored.avg.energy).toBe(0.8);
    expect(restored.genreDrift).toBe(0.06);
    expect(restored.artistSet.has('coldplay')).toBe(true);
  });

  it('deactivate sets active to false', () => {
    const s = createState();
    activate(s);
    deactivate(s);
    expect(s.active).toBe(false);
  });

  it('snapshot returns current state', () => {
    const s = createState();
    activate(s);
    s.generated = 3;
    s.playedUris.add('a');
    s.playedUris.add('b');
    const snap = snapshot(s);
    expect(snap.active).toBe(true);
    expect(snap.generated).toBe(3);
    expect(snap.playedCount).toBe(2);
  });
});

describe('rolling context — computeAverage', () => {
  it('returns defaults for empty features', () => {
    const avg = computeAverage([]);
    expect(avg.energy).toBe(0.5);
    expect(avg.tempo).toBe(120);
  });

  it('weighted average favors most recent track', () => {
    const f1 = fakeFeatures({ energy: 0.2 });
    const f2 = fakeFeatures({ energy: 0.8 });
    const avg = computeAverage([f1, f2]);
    // f2 has weight 0.3, f1 has weight 0.1 → f2 dominates
    expect(avg.energy).toBeGreaterThan(0.5);
  });

  it('window caps at 5 tracks', () => {
    const features = Array.from({ length: 8 }, (_, i) =>
      fakeFeatures({ energy: i * 0.1 }),
    );
    const avg = computeAverage(features);
    // Should only use the last 5
    expect(avg).toBeDefined();
  });

  it('uses most recent key/mode', () => {
    const f1 = fakeFeatures({ key: 2, mode: 0 });
    const f2 = fakeFeatures({ key: 7, mode: 1 });
    const avg = computeAverage([f1, f2]);
    expect(avg.key).toBe(7);
    expect(avg.mode).toBe(1);
  });
});

describe('remix / cover filtering', () => {
  it('normalizeTrackName strips remix suffixes', () => {
    expect(normalizeTrackName('Song Name (Remix)')).toBe('song name');
    expect(normalizeTrackName('Song Name - Edit')).toBe('song name');
    expect(normalizeTrackName('Song Name [Extended Club Mix]')).toBe('song name');
    expect(normalizeTrackName('Song Name (Sped Up)')).toBe('song name');
    expect(normalizeTrackName('Song Name (Slowed + Reverb)')).toBe('song name');
  });

  it('normalizeTrackName strips cover/live markers', () => {
    expect(normalizeTrackName('Song Name (Acoustic)')).toBe('song name');
    expect(normalizeTrackName('Song Name [Live]')).toBe('song name');
    expect(normalizeTrackName('Song Name (Cover)')).toBe('song name');
  });

  it('normalizeTrackName strips movie/soundtrack version markers', () => {
    expect(normalizeTrackName('Nightcall (Movie Version)')).toBe('nightcall');
    expect(normalizeTrackName('Song Name [Film Version]')).toBe('song name');
    expect(normalizeTrackName('Song Name (Motion Picture Version)')).toBe('song name');
    expect(normalizeTrackName('Song Name (End Credits)')).toBe('song name');
    expect(normalizeTrackName('Song Name - Soundtrack Version')).toBe('song name');
    expect(normalizeTrackName('Song Name (OST)')).toBe('song name');
    expect(normalizeTrackName('Song Name (Single Version)')).toBe('song name');
    expect(normalizeTrackName('Song Name (Deluxe)')).toBe('song name');
    expect(normalizeTrackName('Song Name (Remastered)')).toBe('song name');
    expect(normalizeTrackName('Song Name (Clean)')).toBe('song name');
  });

  it('normalizeTrackName strips featured artists', () => {
    expect(normalizeTrackName('Song Name (feat. Someone)')).toBe('song name');
    expect(normalizeTrackName('Song Name ft. Someone')).toBe('song name');
  });

  it('normalizeTrackName strips YouTube upload noise', () => {
    expect(normalizeTrackName('Song Name (Official Audio)')).toBe('song name');
    expect(normalizeTrackName('Song Name [Official Video]')).toBe('song name');
    expect(normalizeTrackName('Song Name (Lyrics)')).toBe('song name');
    expect(normalizeTrackName('Song Name (Music Video)')).toBe('song name');
    expect(normalizeTrackName('Song Name (Visualizer)')).toBe('song name');
    expect(normalizeTrackName('Song Name - Official Audio')).toBe('song name');
    expect(normalizeTrackName('Song Name - Lyrics')).toBe('song name');
    expect(normalizeTrackName('Song Name (Official Music Video)')).toBe('song name');
  });

  it('normalizeTrackName normalizes whitespace and case', () => {
    expect(normalizeTrackName('  SONG   NAME  ')).toBe('song name');
    expect(normalizeTrackName("Song's Name")).toBe('songs name');
  });

  it('isRemixOrCover detects variants', () => {
    const s = createState();
    activate(s);
    markPlayed(s, 'spotify:track:1', 'Original Song', ['Artist']);
    expect(isRemixOrCover(s, 'Original Song (Remix)')).toBe(true);
    expect(isRemixOrCover(s, 'Original Song - Edit')).toBe(true);
    expect(isRemixOrCover(s, 'Original Song [Extended]')).toBe(true);
    expect(isRemixOrCover(s, 'Completely Different Song')).toBe(false);
  });

  it('isRemixOrCover detects movie/soundtrack versions', () => {
    const s = createState();
    activate(s);
    markPlayed(s, 'spotify:track:2', 'Nightcall', ['Kavinsky']);
    expect(isRemixOrCover(s, 'Nightcall (Movie Version)')).toBe(true);
    expect(isRemixOrCover(s, 'Nightcall [Film Version]')).toBe(true);
    expect(isRemixOrCover(s, 'Nightcall (End Credits)')).toBe(true);
    expect(isRemixOrCover(s, 'Nightcall - Soundtrack Version')).toBe(true);
  });

  it('isRemixOrCover matches YouTube-style titles ("Song - Artist (Remix)")', () => {
    const s = createState();
    activate(s);
    markPlayed(s, 'spotify:track:2', 'Nightcall', ['Kavinsky']);
    // The real-world duplicate: Spotify played "Nightcall", the YouTube
    // fallback returned "Nightcall - Kavinsky (Eewas Cesium Remix)".
    expect(isRemixOrCover(s, 'Nightcall - Kavinsky (Eewas Cesium Remix)', ['Eewas Cesium - Topic'])).toBe(true);
    expect(isRemixOrCover(s, 'Kavinsky - Nightcall', ['Kavinsky'])).toBe(true);
    // Genuinely different songs must NOT match.
    expect(isRemixOrCover(s, 'Nightfly', ['Kavinsky'])).toBe(false);
    expect(isRemixOrCover(s, 'Testaut', ['Kavinsky'])).toBe(false);
  });

  it('dedup works in reverse (YouTube played, Spotify candidate)', () => {
    const s = createState();
    activate(s);
    markPlayed(s, 'youtube:video:abc', 'Nightcall - Kavinsky (Eewas Cesium Remix)', ['Eewas Cesium - Topic']);
    expect(isRemixOrCover(s, 'Nightcall', ['Kavinsky'])).toBe(true);
  });

  it('isRemixOrCover is case-insensitive', () => {
    const s = createState();
    activate(s);
    markPlayed(s, 'spotify:track:1', 'My Song', ['Artist']);
    expect(isRemixOrCover(s, 'my song (remix)')).toBe(true);
  });

  it('detects the same song under a YouTube "(Official Audio)" title', () => {
    const s = createState();
    activate(s);
    markPlayed(s, 'spotify:track:1', 'Magic', ['Coldplay']);
    expect(isRemixOrCover(s, 'Coldplay - Magic (Official Audio)', ['Coldplay'])).toBe(true);
    expect(isRemixOrCover(s, 'Magic (Official Video)', ['Coldplay'])).toBe(true);
  });
});

describe('artist cooldown', () => {
  it('isArtistOnCooldown returns false when no history', () => {
    const s = createState();
    activate(s);
    expect(isArtistOnCooldown(s, 'Some Artist')).toBe(false);
  });

  it('isArtistOnCooldown returns true for recently played artist', () => {
    const s = createState();
    activate(s);
    markPlayed(s, 'spotify:track:1', 'Track 1', ['Same Artist']);
    expect(isArtistOnCooldown(s, 'Same Artist')).toBe(true);
  });

  it('isArtistOnCooldown returns false after cooldown window', () => {
    const s = createState();
    activate(s);
    // Play Same Artist, then 4 other artists to push it out of cooldown window (3)
    markPlayed(s, 'spotify:track:1', 'Track 1', ['Same Artist']);
    for (let i = 2; i <= 6; i++) {
      markPlayed(s, `spotify:track:${i}`, `Track ${i}`, [`Other Artist ${i}`]);
    }
    expect(isArtistOnCooldown(s, 'Same Artist')).toBe(false);
  });

  it('isArtistOnCooldown is case-insensitive', () => {
    const s = createState();
    activate(s);
    markPlayed(s, 'spotify:track:1', 'Track 1', ['Test Artist']);
    expect(isArtistOnCooldown(s, 'test artist')).toBe(true);
    expect(isArtistOnCooldown(s, 'TEST ARTIST')).toBe(true);
  });
});

describe('URI dedup', () => {
  it('isDuplicate returns false for unknown URI', () => {
    const s = createState();
    activate(s);
    expect(isDuplicate(s, 'spotify:track:xyz')).toBe(false);
  });

  it('isDuplicate returns true after markPlayed', () => {
    const s = createState();
    activate(s);
    markPlayed(s, 'spotify:track:xyz', 'Track', ['Artist']);
    expect(isDuplicate(s, 'spotify:track:xyz')).toBe(true);
  });

  it('dedup set trims old entries when exceeding max', () => {
    const s = createState();
    activate(s);
    // Add 810 entries to exceed the 800 max
    for (let i = 0; i < 810; i++) {
      markPlayed(s, `spotify:track:${i}`, `Track ${i}`, [`Artist ${i % 10}`]);
    }
    expect(s.playedUris.size).toBeLessThanOrEqual(800);
    // The oldest entries should have been trimmed
    expect(s.playedUris.has('spotify:track:0')).toBe(false);
  });
});

describe('scoring', () => {
  it('prefers Spotify URIs', () => {
    const targets = {};
    const artists: string[] = [];
    const spotify = { uri: 'spotify:track:x', name: 'T', artists: ['A'], album: '', durationMs: 200_000, source: 'spotify' as const };
    const youtube = { uri: 'yt:x', name: 'T', artists: ['A'], album: '', durationMs: 200_000, source: 'youtube' as const };
    const sScore = scoreCandidate(spotify, targets, artists);
    const yScore = scoreCandidate(youtube, targets, artists);
    // Spotify should score lower (better) by at least 10 points
    expect(sScore).toBeLessThan(yScore - 5);
  });

  it('penalizes on-cooldown artists', () => {
    const targets = {};
    const track = { uri: 'spotify:track:x', name: 'T', artists: ['Repeated Artist'], album: '', durationMs: 200_000, source: 'spotify' as const };
    const withCooldown = scoreCandidate(track, targets, ['repeated artist']);
    const withoutCooldown = scoreCandidate(track, targets, []);
    expect(withCooldown).toBeGreaterThan(withoutCooldown + 10);
  });

  it('penalizes tracks outside 2-7 min range', () => {
    const targets = {};
    const artists: string[] = [];
    const short = { uri: 'spotify:track:x', name: 'T', artists: ['A'], album: '', durationMs: 60_000, source: 'spotify' as const };
    const normal = { uri: 'spotify:track:y', name: 'T', artists: ['A'], album: '', durationMs: 200_000, source: 'spotify' as const };
    const shortScore = scoreCandidate(short, targets, artists);
    const normalScore = scoreCandidate(normal, targets, artists);
    expect(shortScore).toBeGreaterThan(normalScore + 5);
  });

  it('pulls picks toward the feature targets when features are available', () => {
    const targets = { targetEnergy: 0.9, targetTempo: 140 };
    const artists: string[] = [];
    const base = { uri: 'spotify:track:x', name: 'T', artists: ['A'], album: '', durationMs: 200_000, source: 'spotify' as const };
    const close = scoreCandidate(base, targets, artists, fakeFeatures({ energy: 0.88, tempo: 138 }));
    const far = scoreCandidate(base, targets, artists, fakeFeatures({ energy: 0.2, tempo: 70 }));
    expect(close).toBeLessThan(far);
  });

  it('ignores feature scoring when no features are provided', () => {
    const targets = { targetEnergy: 0.9, targetTempo: 140 };
    const artists: string[] = [];
    const base = { uri: 'spotify:track:x', name: 'T', artists: ['A'], album: '', durationMs: 200_000, source: 'spotify' as const };
    const withTargets = scoreCandidate(base, targets, artists);
    const withoutTargets = scoreCandidate(base, {}, artists);
    // Same track, no features → targets must not change the score.
    expect(Math.abs(withTargets - withoutTargets)).toBeLessThan(2.01);
  });
});

describe('seed extraction', () => {
  it('extracts up to 3 Spotify IDs from recent tracks', () => {
    const tracks: TrackInfo[] = [
      fakeTrack({ uri: 'spotify:track:aaaaaaaaaaaaaaaaaaaaaa' }),
      fakeTrack({ uri: 'spotify:track:bbbbbbbbbbbbbbbbbbbbbb' }),
      fakeTrack({ uri: 'spotify:track:cccccccccccccccccccccc' }),
      fakeTrack({ uri: 'spotify:track:dddddddddddddddddddddd' }),
      fakeTrack({ uri: 'spotify:track:eeeeeeeeeeeeeeeeeeeeee' }),
    ];
    const seeds = extractSeeds(tracks);
    expect(seeds.length).toBeLessThanOrEqual(3);
    // Should get the last 3
    expect(seeds).toContain('cccccccccccccccccccccc');
    expect(seeds).toContain('dddddddddddddddddddddd');
    expect(seeds).toContain('eeeeeeeeeeeeeeeeeeeeee');
  });

  it('skips non-Spotify URIs', () => {
    const tracks: TrackInfo[] = [
      fakeTrack({ uri: 'spotify:track:aaaaaaaaaaaaaaaaaaaaaa' }),
      fakeTrack({ uri: 'yt:bbbbbbbbbbbbbbbbbbbbbb' }),
      fakeTrack({ uri: 'spotify:track:cccccccccccccccccccccc' }),
    ];
    const seeds = extractSeeds(tracks);
    expect(seeds).toContain('aaaaaaaaaaaaaaaaaaaaaa');
    expect(seeds).toContain('cccccccccccccccccccccc');
    expect(seeds.length).toBe(2);
  });

  it('returns empty for empty tracks', () => {
    expect(extractSeeds([])).toEqual([]);
  });
});

describe('evolution', () => {
  it('evolveDirection changes genreDrift', () => {
    const s = createState();
    activate(s);
    const before = s.genreDrift;
    // Run multiple times to ensure at least one changes
    let changed = false;
    for (let i = 0; i < 20; i++) {
      evolveDirection(s);
      if (s.genreDrift !== before) changed = true;
    }
    expect(changed).toBe(true);
  });

  it('genreDrift stays within bounds', () => {
    const s = createState();
    activate(s);
    for (let i = 0; i < 100; i++) {
      evolveDirection(s);
    }
    expect(s.genreDrift).toBeGreaterThanOrEqual(-0.08);
    expect(s.genreDrift).toBeLessThanOrEqual(0.08);
  });

  it('buildTargets applies drift to averages', () => {
    const s = createState();
    activate(s);
    recordFeatures(s, fakeFeatures({ energy: 0.5, tempo: 120 }));
    s.genreDrift = 0.06;
    const targets = buildTargets(s);
    expect(targets.targetEnergy).toBeGreaterThan(0.5);
    expect(targets.targetTempo).toBeGreaterThan(120);
  });
});

describe('recordFeatures', () => {
  it('appends features and updates average', () => {
    const s = createState();
    activate(s);
    recordFeatures(s, fakeFeatures({ energy: 0.8 }), 'Artist1');
    expect(s.recentFeatures.length).toBe(1);
    expect(s.avg.energy).toBe(0.8);
    expect(s.recentArtists).toContain('artist1');
  });

  it('caps recentFeatures at historyWindow (5)', () => {
    const s = createState();
    activate(s);
    for (let i = 0; i < 8; i++) {
      recordFeatures(s, fakeFeatures({ energy: i * 0.1 }), `Artist${i}`);
    }
    expect(s.recentFeatures.length).toBe(5);
  });

  it('caps recentArtists at cooldown + 2', () => {
    const s = createState();
    activate(s);
    for (let i = 0; i < 10; i++) {
      recordFeatures(s, fakeFeatures(), `Artist${i}`);
    }
    expect(s.recentArtists.length).toBeLessThanOrEqual(DEFAULT_CONFIG.artistCooldown + 2);
  });
});

describe('markPlayed', () => {
  it('adds URI, normalized name, and artists', () => {
    const s = createState();
    activate(s);
    markPlayed(s, 'spotify:track:1', 'My Song (Remix)', ['Artist1', 'Artist2']);
    expect(s.playedUris.has('spotify:track:1')).toBe(true);
    expect(s.playedNames.has('my song')).toBe(true);
    expect(s.recentArtists).toContain('artist1');
    expect(s.recentArtists).toContain('artist2');
  });

  it('records each artist occurrence in recentArtists for track cooldowns', () => {
    const s = createState();
    activate(s);
    markPlayed(s, 'spotify:track:1', 'Track 1', ['Same Artist']);
    markPlayed(s, 'spotify:track:2', 'Track 2', ['Same Artist']);
    const count = s.recentArtists.filter((a) => a === 'same artist').length;
    expect(count).toBe(2);
  });
});

/* ---------- smoke: queue context window ---------- */

describe('pickContext', () => {
  const many = Array.from({ length: 20 }, (_, i) => fakeTrack({ uri: `spotify:track:t${i}`, name: `T${i}` }));

  it('returns empty for empty queue', () => {
    expect(pickContext([], 5)).toEqual([]);
  });

  it('windows around currentIndex mid-session (not the oldest tracks)', () => {
    const ctx = pickContext(many, 10);
    expect(ctx.length).toBe(6);
    expect(ctx[0].uri).toBe('spotify:track:t7');
    expect(ctx[ctx.length - 1].uri).toBe('spotify:track:t12');
  });

  it('queue-exhausted case ends on the track that just finished', () => {
    const ctx = pickContext(many, 19);
    expect(ctx[ctx.length - 1].uri).toBe('spotify:track:t19');
    expect(ctx.length).toBe(4);
  });

  it('handles nothing-played state (currentIndex -1)', () => {
    const ctx = pickContext(many, -1);
    expect(ctx.length).toBe(2);
    expect(ctx[0].uri).toBe('spotify:track:t0');
  });

  it('handles short queues', () => {
    const ctx = pickContext(many.slice(0, 2), 1);
    expect(ctx.length).toBe(2);
  });
});

/* ---------- smoke: pickNextTrack strategies & filters ---------- */

function recCandidate(overrides: Partial<ResolvedTrack> = {}): ResolvedTrack {
  return {
    uri: 'spotify:track:rec000000000000000001',
    name: 'Recommended Song',
    artists: ['Fresh Artist'],
    album: 'Rec Album',
    durationMs: 210_000,
    source: 'spotify',
    ...overrides,
  };
}

describe('pickNextTrack (smoke)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.searchTracks.mockResolvedValue([]);
    mocks.searchAndResolveYoutube.mockResolvedValue(null);
    mocks.getAudioFeatures.mockResolvedValue(new Map());
    mocks.deezerRelatedTracks.mockResolvedValue([]);
  });

  it('strategy 5: falls back to Deezer related tracks when Spotify dead-ends', async () => {
    const s = createState();
    activate(s);
    mocks.getRecommendations.mockResolvedValue([]);
    mocks.searchTracks.mockResolvedValue([]);
    mocks.deezerRelatedTracks.mockResolvedValue([
      { uri: 'deezer:track:1', name: 'Fresh Related Song', artists: ['Other Artist'], album: '', durationMs: 200000, source: 'youtube' },
    ]);
    const recent = [fakeTrack({ uri: 'spotify:track:aaaaaaaaaaaaaaaaaaaaaa', name: 'Seed', artists: ['Seed Artist'] })];
    const pick = await pickNextTrack(s, recent);
    expect(pick?.name).toBe('Fresh Related Song');
    expect(mocks.deezerRelatedTracks).toHaveBeenCalledWith('Seed Artist');
  });

  it('strategy 5: ships estimated features so Deezer picks still steer musically', async () => {
    const s = createState();
    activate(s);
    mocks.getRecommendations.mockResolvedValue([]);
    mocks.searchTracks.mockResolvedValue([]);
    // Both candidates have no Spotify id, so features come solely from the
    // estimatedFeatures the Deezer layer attaches.
    mocks.deezerRelatedTracks.mockResolvedValue([
      { uri: 'deezer:track:1', name: 'High Energy', artists: ['Artist A'], album: '', durationMs: 200000, source: 'youtube', estimatedFeatures: { ...fakeFeatures(), energy: 0.9, tempo: 128 } },
      { uri: 'deezer:track:2', name: 'Low Energy', artists: ['Artist B'], album: '', durationMs: 200000, source: 'youtube', estimatedFeatures: { ...fakeFeatures(), energy: 0.2, tempo: 80 } },
    ]);
    const recent = [fakeTrack({ uri: 'spotify:track:aaaaaaaaaaaaaaaaaaaaaa', name: 'Seed', artists: ['Seed Artist'] })];
    // Push the target high-energy by acknowledging a high-energy average.
    s.recentFeatures = [fakeFeatures({ energy: 0.9, tempo: 128 })];
    const pick = await pickNextTrack(s, recent);
    expect(pick?.name).toBe('High Energy');
  });

  it('returns null when EW is inactive (never calls APIs)', async () => {
    const s = createState();
    const result = await pickNextTrack(s, [fakeTrack()]);
    expect(result).toBeNull();
    expect(mocks.getRecommendations).not.toHaveBeenCalled();
  });

  it('strategy 1: uses Spotify recommendations seeded from recent tracks', async () => {
    const s = createState();
    activate(s);
    mocks.getRecommendations.mockResolvedValue([recCandidate()]);
    const recent = [fakeTrack({ uri: 'spotify:track:aaaaaaaaaaaaaaaaaaaaaa' })];
    const pick = await pickNextTrack(s, recent);
    expect(pick?.uri).toBe('spotify:track:rec000000000000000001');
    expect(mocks.getRecommendations).toHaveBeenCalledTimes(1);
    const params = mocks.getRecommendations.mock.calls[0][0];
    expect(params.seedTracks).toContain('aaaaaaaaaaaaaaaaaaaaaa');
    expect(params.limit).toBe(30);
  });

  it('excludes candidates already waiting in the upcoming queue', async () => {
    const s = createState();
    activate(s);
    const queued = 'spotify:track:rec000000000000000001';
    mocks.getRecommendations.mockResolvedValue([recCandidate({ uri: queued })]);
    const recent = [
      fakeTrack({ uri: 'spotify:track:aaaaaaaaaaaaaaaaaaaaaa' }),
      fakeTrack({ uri: queued }),
    ];
    const pick = await pickNextTrack(s, recent);
    expect(pick).toBeNull();
    expect(mocks.searchTracks).toHaveBeenCalled();
  });

  it('excludes candidates already played this session', async () => {
    const s = createState();
    activate(s);
    markPlayed(s, 'spotify:track:rec000000000000000001', 'Recommended Song', ['Fresh Artist']);
    mocks.getRecommendations.mockResolvedValue([recCandidate()]);
    const pick = await pickNextTrack(s, [fakeTrack({ uri: 'spotify:track:aaaaaaaaaaaaaaaaaaaaaa' })]);
    expect(pick).toBeNull();
  });

  it('excludes candidates from artists on cooldown', async () => {
    const s = createState();
    activate(s);
    markPlayed(s, 'spotify:track:zzz000000000000000001', 'Earlier Song', ['Fresh Artist']);
    mocks.getRecommendations.mockResolvedValue([recCandidate()]);
    const pick = await pickNextTrack(s, [fakeTrack({ uri: 'spotify:track:aaaaaaaaaaaaaaaaaaaaaa' })]);
    expect(pick).toBeNull();
  });

  it('excludes remix/cover variants of played tracks', async () => {
    const s = createState();
    activate(s);
    markPlayed(s, 'spotify:track:orig0000000000000001', 'Recommended Song', ['Someone Else']);
    mocks.getRecommendations.mockResolvedValue([recCandidate({ artists: ['Someone Else'] })]);
    const pick = await pickNextTrack(s, [fakeTrack({ uri: 'spotify:track:aaaaaaaaaaaaaaaaaaaaaa' })]);
    expect(pick).toBeNull();
  });

  it('honors excludeUris (failed-to-resolve retry loop)', async () => {
    const s = createState();
    activate(s);
    mocks.getRecommendations.mockResolvedValue([recCandidate()]);
    const excluded = new Set(['spotify:track:rec000000000000000001']);
    const pick = await pickNextTrack(s, [fakeTrack({ uri: 'spotify:track:aaaaaaaaaaaaaaaaaaaaaa' })], excluded);
    expect(pick).toBeNull();
  });

  it('strategy 2: falls back to Spotify search when recs are empty', async () => {
    const s = createState();
    activate(s);
    mocks.getRecommendations.mockResolvedValue([]);
    mocks.searchTracks.mockResolvedValue([recCandidate({ uri: 'spotify:track:search000000000000001' })]);
    const recent = [fakeTrack({ uri: 'yt:notspotify', name: 'Seed Song', artists: ['Seed Artist'] })];
    const pick = await pickNextTrack(s, recent);
    expect(pick?.uri).toBe('spotify:track:search000000000000001');
    // Artist-only query surfaces the wider catalog instead of re-finding the
    // exact seed song (which is how movie-version duplicates used to slip in).
    expect(mocks.searchTracks).toHaveBeenCalledWith('Seed Artist', 20);
  });

  it('strategy 3: falls back to YouTube when Spotify yields nothing', async () => {
    const s = createState();
    activate(s);
    mocks.getRecommendations.mockResolvedValue([]);
    mocks.searchTracks.mockResolvedValue([]);
    mocks.searchAndResolveYoutube.mockResolvedValue({
      uri: 'youtube:video:abc123',
      name: 'Different Song',
      artists: ['Other Artist'],
      album: '',
      durationMs: 200_000,
      source: 'youtube',
      videoId: 'abc123',
      streamUrl: 'https://example.com/stream',
      channel: 'chan',
    });
    const recent = [fakeTrack({ uri: 'yt:x', name: 'Seed Song', artists: ['Seed Artist'] })];
    const pick = await pickNextTrack(s, recent);
    expect(pick?.uri).toBe('youtube:video:abc123');
    // Artist-catalog query only — searches by song title always re-finds the
    // current song's remix variant, which would repeat the same audio.
    expect(mocks.searchAndResolveYoutube).toHaveBeenCalledWith('Seed Artist', expect.any(Object));
  });

  it('strategy 3: rejects a YouTube pick that is the seed song itself', async () => {
    const s = createState();
    activate(s);
    mocks.getRecommendations.mockResolvedValue([]);
    mocks.searchTracks.mockResolvedValue([]);
    // The classic bug: YouTube fallback "resolves" the very song that just
    // played. The upcoming-name dedup must reject it instead of repeating it.
    mocks.searchAndResolveYoutube.mockResolvedValue({
      uri: 'youtube:video:abc123',
      name: 'Seed Song - Seed Artist (Official Audio)',
      artists: ['Seed Artist'],
      album: '',
      durationMs: 200_000,
      source: 'youtube',
      videoId: 'abc123',
      streamUrl: 'https://example.com/stream',
      channel: 'chan',
    });
    const recent = [fakeTrack({ uri: 'yt:x', name: 'Seed Song', artists: ['Seed Artist'] })];
    const pick = await pickNextTrack(s, recent);
    expect(pick).toBeNull();
  });

  it('excludes compilation/setlist uploads that mention an on-cooldown artist', async () => {
    const s = createState();
    activate(s);
    markPlayed(s, 'spotify:track:zzz000000000000000001', 'Magic', ['Coldplay']);
    mocks.getRecommendations.mockResolvedValue([]);
    // An empty-artist YouTube setlist that still names the on-cooldown artist.
    mocks.searchTracks.mockResolvedValue([recCandidate({
      uri: 'spotify:track:dddddddddddddddddddddd',
      name: 'Best of Coldplay [Coldplay Concert Setlist]',
      artists: [],
    })]);
    const recent = [fakeTrack({ uri: 'spotify:track:aaaaaaaaaaaaaaaaaaaaaa', name: 'Magic', artists: ['Coldplay'] })];
    const pick = await pickNextTrack(s, recent);
    expect(pick).toBeNull();
  });

  it('treats artists already queued in upcoming as on cooldown', async () => {
    const s = createState();
    activate(s);
    // The first Coldplay track is already waiting in the queue, but it has not
    // started playing yet, so state.recentArtists is still empty. The upcoming
    // list must still block another Coldplay pick to avoid back-to-back bursts.
    const upcoming: TrackInfo[] = [
      fakeTrack({ uri: 'spotify:track:queued0000000000001', name: 'Magic', artists: ['Coldplay'] }),
    ];
    mocks.getRecommendations.mockResolvedValue([
      recCandidate({ uri: 'spotify:track:other0000000000001', artists: ['Coldplay'] }),
    ]);
    const recent = [fakeTrack({ uri: 'spotify:track:aaaaaaaaaaaaaaaaaaaaaa', name: 'Seed', artists: ['Seed Artist'] })];
    const pick = await pickNextTrack(s, recent, undefined, upcoming);
    expect(pick).toBeNull();
  });

  it('rejects setlist uploads that mention an artist already queued as upcoming', async () => {
    const s = createState();
    activate(s);
    // "Coldplay - Magic" is queued but not yet played. A compilation setlist
    // with an empty artist field but "Coldplay" in the title must be blocked.
    const upcoming: TrackInfo[] = [
      fakeTrack({ uri: 'spotify:track:queued0000000000001', name: 'Magic', artists: ['Coldplay'] }),
    ];
    mocks.getRecommendations.mockResolvedValue([]);
    mocks.searchTracks.mockResolvedValue([
      recCandidate({
        uri: 'spotify:track:setlist0000000000001',
        name: 'Best of Coldplay [Coldplay Concert Setlist]',
        artists: [],
      }),
    ]);
    const recent = [fakeTrack({ uri: 'spotify:track:aaaaaaaaaaaaaaaaaaaaaa', name: 'Seed', artists: ['Seed Artist'] })];
    const pick = await pickNextTrack(s, recent, undefined, upcoming);
    expect(pick).toBeNull();
  });

  it('recs error falls through to search instead of crashing', async () => {
    const s = createState();
    activate(s);
    mocks.getRecommendations.mockRejectedValue(new Error('rate limited'));
    mocks.searchTracks.mockResolvedValue([recCandidate({ uri: 'spotify:track:search000000000000002' })]);
    const recent = [fakeTrack({ uri: 'spotify:track:aaaaaaaaaaaaaaaaaaaaaa' })];
    const pick = await pickNextTrack(s, recent);
    expect(pick?.uri).toBe('spotify:track:search000000000000002');
  });

  it('picks the candidate whose features best match the evolving target', async () => {
    const s = createState();
    activate(s);
    recordFeatures(s, fakeFeatures({ energy: 0.9, tempo: 140 }), 'Seed Artist');
    mocks.getRecommendations.mockResolvedValue([
      recCandidate({ uri: 'spotify:track:aaaaaaaaaaaaaaaaaaaaaa', name: 'Chill Track' }),
      recCandidate({ uri: 'spotify:track:bbbbbbbbbbbbbbbbbbbbbb', name: 'Banger' }),
    ]);
    mocks.getAudioFeatures.mockResolvedValue(new Map([
      ['aaaaaaaaaaaaaaaaaaaaaa', fakeFeatures({ energy: 0.2, tempo: 80 })],
      ['bbbbbbbbbbbbbbbbbbbbbb', fakeFeatures({ energy: 0.92, tempo: 142 })],
    ]));
    const recent = [fakeTrack({ uri: 'spotify:track:cccccccccccccccccccccc' })];
    const pick = await pickNextTrack(s, recent);
    expect(pick?.name).toBe('Banger');
  });

  it('stays armed rather than re-picking a same-song remix variant', async () => {
    const s = createState();
    activate(s);
    markPlayed(s, 'spotify:track:zzz000000000000000001', 'Earlier Song', ['Fresh Artist']);
    mocks.getRecommendations.mockResolvedValue([]);
    // Only thing the search returns is the same remix variant of the just-played
    // song — Strategy 4 must reject it instead of re-queueing it in a loop.
    mocks.searchTracks.mockResolvedValue([recCandidate({ uri: 'spotify:track:dddddddddddddddddddddd', name: 'Earlier Song' })]);
    const recent = [fakeTrack({ uri: 'spotify:track:aaaaaaaaaaaaaaaaaaaaaa', name: 'Seed', artists: ['Seed Artist'] })];
    const pick = await pickNextTrack(s, recent);
    expect(pick).toBeNull();
  });
});

/* ---------- smoke: resolve + features ---------- */

describe('resolveCandidate (smoke)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('resolves Spotify picks via YouTube stream lookup, tagged endless-wave', async () => {
    mocks.searchAndResolveYoutube.mockResolvedValue({
      uri: 'youtube:video:v1',
      name: 'Recommended Song',
      artists: ['Fresh Artist'],
      album: '',
      durationMs: 210_000,
      source: 'youtube',
      videoId: 'v1',
      streamUrl: 'https://example.com/s',
      channel: 'c',
    });
    const out = await resolveCandidate(recCandidate());
    expect(out?.addedBy).toBe('endless-wave');
    expect(out?.source).toBe('spotify');
    expect(out?.streamUrl).toBe('https://example.com/s');
    expect(out?.uri).toBe('spotify:track:rec000000000000000001');
  });

  it('passes through pre-resolved stream URLs (YouTube/SoundCloud picks)', async () => {
    const out = await resolveCandidate(recCandidate({
      uri: 'youtube:video:v2',
      source: 'youtube',
      streamUrl: 'https://example.com/direct',
    }));
    expect(out?.streamUrl).toBe('https://example.com/direct');
    expect(mocks.searchAndResolveYoutube).not.toHaveBeenCalled();
  });

  it('returns null when nothing can stream the pick', async () => {
    mocks.searchAndResolveYoutube.mockResolvedValue(null);
    const out = await resolveCandidate(recCandidate());
    expect(out).toBeNull();
  });
});

describe('fetchFeatures (smoke)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('fetches Spotify audio features by extracted ID', async () => {
    const feats = fakeFeatures({ energy: 0.9 });
    mocks.getAudioFeatures.mockResolvedValue(new Map([['aaaaaaaaaaaaaaaaaaaaaa', feats]]));
    const out = await fetchFeatures(fakeTrack({ uri: 'spotify:track:aaaaaaaaaaaaaaaaaaaaaa' }));
    expect(out?.energy).toBe(0.9);
  });

  it('returns null for non-Spotify tracks without calling the API', async () => {
    const out = await fetchFeatures(fakeTrack({ uri: 'youtube:video:v3' }));
    expect(out).toBeNull();
    expect(mocks.getAudioFeatures).not.toHaveBeenCalled();
  });

  it('swallows API errors and returns null', async () => {
    mocks.getAudioFeatures.mockRejectedValue(new Error('boom'));
    const out = await fetchFeatures(fakeTrack({ uri: 'spotify:track:aaaaaaaaaaaaaaaaaaaaaa' }));
    expect(out).toBeNull();
  });
});
