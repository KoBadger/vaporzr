import { describe, expect, it } from 'vitest';
import { streamCacheEntryIsFresh } from '@vaporzr/core/playback';

describe('streamCacheEntryIsFresh (the next-track preload gate)', () => {
  const now = 1_700_000_000_000;

  it('accepts a URL resolved inside the freshness window', () => {
    expect(streamCacheEntryIsFresh(now - 1_000, now)).toBe(true);
    expect(streamCacheEntryIsFresh(now - 60_000, now)).toBe(true);
    expect(streamCacheEntryIsFresh(now - 3 * 60_000, now)).toBe(true);
  });

  it('rejects a URL that has aged out', () => {
    // Regression: the next track is warmed at the START of the current one, so
    // on a long track that URL can be minutes old by the handoff. It is bound
    // to the proxy exit that minted it, so a stale one 403s mid-play. Anything
    // past the window must be re-resolved rather than handed over.
    expect(streamCacheEntryIsFresh(now - 4 * 60_000, now)).toBe(false);
    expect(streamCacheEntryIsFresh(now - 30 * 60_000, now)).toBe(false);
  });

  it('treats a missing resolve time as stale', () => {
    expect(streamCacheEntryIsFresh(undefined, now)).toBe(false);
    expect(streamCacheEntryIsFresh(0, now)).toBe(false);
  });
});
