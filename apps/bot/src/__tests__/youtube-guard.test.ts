import { describe, it, expect } from 'vitest';
import { isClearlyWrongMatch } from '../youtube.js';
import type { ResolvedVideo } from '../youtube.js';

function video(overrides: Partial<ResolvedVideo>): ResolvedVideo {
  return {
    videoId: 'abc123',
    uri: 'youtube:video:abc123',
    name: 'Song Name - Artist',
    artists: ['Artist'],
    album: 'YouTube',
    durationMs: 200_000,
    source: 'youtube',
    streamUrl: 'https://example.com/stream',
    channel: 'Artist - Topic',
    ...overrides,
  };
}

describe('isClearlyWrongMatch (speed fallback guard)', () => {
  it('accepts an exact title/artist match', () => {
    const v = video({ name: 'End Of Summer - Tame Impala', channel: 'Tame Impala - Topic' });
    expect(isClearlyWrongMatch(v, 'End Of Summer', { name: 'End Of Summer', artists: ['Tame Impala'], durationMs: 432_000 })).toBe(false);
  });

  it('accepts a near-exact match (case/punctuation differences)', () => {
    const v = video({ name: 'End Of Summer (Official Audio) - Tame Impala', channel: 'Tame Impala - Topic' });
    expect(isClearlyWrongMatch(v, 'End Of Summer', { name: 'End Of Summer', artists: ['Tame Impala'], durationMs: 432_000 })).toBe(false);
  });

  it('rejects a completely unrelated video', () => {
    const v = video({ name: 'GRANT LEADS THE UNION ARMY TO VICTORY | Documentary', channel: 'History' });
    expect(isClearlyWrongMatch(v, 'Grant Fix It', { name: 'Fix It', artists: ['Grant'], durationMs: 198_000 })).toBe(true);
  });

  it('rejects a different song with the same artist', () => {
    const v = video({ name: 'Some Other Track - Grant', artists: ['Grant'], durationMs: 200_000, channel: 'Grant Official' });
    expect(isClearlyWrongMatch(v, 'Fix It', { name: 'Fix It', artists: ['Grant'], durationMs: 198_000 })).toBe(true);
  });

  it('accepts a same-title mix (right song name/artist, longer cut)', () => {
    // Duration mismatch alone isn't "obviously wrong" — EW's long-form filter
    // handles overlong cuts downstream. The guard only rejects clear mismatches.
    const v = video({ name: 'End Of Summer - Tame Impala (Full Album Mix)', artists: ['Tame Impala'], durationMs: 2400_000, channel: 'Some Channel' });
    expect(isClearlyWrongMatch(v, 'End Of Summer', { name: 'End Of Summer', artists: ['Tame Impala'], durationMs: 432_000 })).toBe(false);
  });
});