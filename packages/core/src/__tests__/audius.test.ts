import { describe, expect, it, vi } from 'vitest';
import { isAudiusUrl, resolveAudius } from '../audius.js';

describe('isAudiusUrl', () => {
  it('accepts track permalinks only', () => {
    expect(isAudiusUrl('https://audius.co/artist/track-name')).toBe(true);
    expect(isAudiusUrl('https://www.audius.co/artist/track')).toBe(true);
    expect(isAudiusUrl('https://audius.co/artist')).toBe(false);
    expect(isAudiusUrl('https://example.com/a/b')).toBe(false);
    expect(isAudiusUrl('not a url')).toBe(false);
  });
});

describe('resolveAudius', () => {
  it('maps the resolve payload to a stream track', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: {
          id: 'D7KyD',
          title: 'Neon',
          duration: 180,
          artwork: { '480x480': 'https://art' },
          user: { name: 'DJ' },
        },
      }),
    })) as unknown as typeof fetch;
    expect(await resolveAudius('https://audius.co/dj/neon', fetchImpl)).toEqual({
      id: 'D7KyD',
      title: 'Neon',
      artist: 'DJ',
      durationMs: 180_000,
      image: 'https://art',
      streamUrl: 'https://api.audius.co/v1/tracks/D7KyD/stream?app_name=Vaporzr',
      url: 'https://audius.co/dj/neon',
    });
  });

  it('throws for a non-track response', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ data: {} }) })) as unknown as typeof fetch;
    await expect(resolveAudius('https://audius.co/dj', fetchImpl)).rejects.toThrow();
  });
});
