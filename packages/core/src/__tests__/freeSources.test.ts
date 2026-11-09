import { describe, expect, it, vi } from 'vitest';
import { resolveSonglink } from '../songlink.js';
import { lookupCoverArt } from '../musicbrainz.js';

describe('resolveSonglink', () => {
  it('returns platform URLs', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        linksByPlatform: {
          youtube: { url: 'https://youtube.com/watch?v=x' },
          spotify: { url: 'https://open.spotify.com/track/y' },
        },
      }),
    })) as unknown as typeof fetch;
    expect(await resolveSonglink('https://open.spotify.com/track/y', fetchImpl)).toEqual({
      youtube: 'https://youtube.com/watch?v=x',
      youtubeMusic: undefined,
      spotify: 'https://open.spotify.com/track/y',
      appleMusic: undefined,
      soundcloud: undefined,
    });
  });

  it('returns null on failure or empty links', async () => {
    const empty = vi.fn(async () => ({ ok: true, json: async () => ({}) })) as unknown as typeof fetch;
    expect(await resolveSonglink('x', empty)).toBeNull();
    const boom = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await resolveSonglink('x', boom)).toBeNull();
  });
});

describe('lookupCoverArt', () => {
  it('returns a cover URL when the release and front image exist', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (new URL(url).hostname === 'musicbrainz.org') {
        return { ok: true, json: async () => ({ releases: [{ id: 'rel-1' }] }) };
      }
      return { ok: true };
    }) as unknown as typeof fetch;
    expect(await lookupCoverArt('Neon', 'DJ', fetchImpl)).toBe('https://coverartarchive.org/release/rel-1/front-500');
  });

  it('returns null when no release or no image', async () => {
    const noRelease = vi.fn(async () => ({
      ok: true,
      json: async () => ({ releases: [] }),
    })) as unknown as typeof fetch;
    expect(await lookupCoverArt('None', 'Nobody', noRelease)).toBeNull();
  });
});
