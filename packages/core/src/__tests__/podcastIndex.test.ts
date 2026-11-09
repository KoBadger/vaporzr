import { describe, expect, it, vi } from 'vitest';
import { latestPodcastEpisode, searchPodcastFeeds, sha1Hex } from '../podcastIndex.js';

describe('sha1Hex', () => {
  it('matches the standard vectors Podcast Index expects', () => {
    expect(sha1Hex('abc')).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
    expect(sha1Hex('')).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709');
    expect(sha1Hex('The quick brown fox jumps over the lazy dog')).toBe('2fd4e1c67a2d28fced849ee1bb76e7391b93eb12');
  });
});

const auth = { key: 'k', secret: 's' };

describe('searchPodcastFeeds', () => {
  it('returns [] without credentials', async () => {
    expect(await searchPodcastFeeds('daily', null)).toEqual([]);
  });

  it('maps feeds and signs the request', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(String(_url)).toContain('/search/byterm?q=daily');
      expect((init?.headers as Record<string, string>)['X-Auth-Key']).toBe('k');
      expect((init?.headers as Record<string, string>).Authorization).toMatch(/^[0-9a-f]{40}$/);
      return {
        ok: true,
        json: async () => ({
          feeds: [{ id: 42, title: 'The Daily', author: 'NYT', url: 'https://feed', image: 'https://img' }],
        }),
      };
    }) as unknown as typeof fetch;
    const feeds = await searchPodcastFeeds('daily', auth, fetchImpl);
    expect(feeds).toEqual([
      { id: 42, title: 'The Daily', author: 'NYT', url: 'https://feed', image: 'https://img', description: undefined },
    ]);
  });

  it('swallows network failures', async () => {
    const boom = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await searchPodcastFeeds('daily', auth, boom)).toEqual([]);
  });
});

describe('latestPodcastEpisode', () => {
  it('returns the first enclosure', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ items: [{ title: 'Ep 1', enclosureUrl: 'https://cdn/ep1.mp3', duration: 1800 }] }),
    })) as unknown as typeof fetch;
    expect(await latestPodcastEpisode(42, auth, fetchImpl)).toEqual({
      title: 'Ep 1',
      enclosureUrl: 'https://cdn/ep1.mp3',
      durationSec: 1800,
      image: undefined,
      datePublished: undefined,
    });
  });

  it('returns null for an empty feed or missing credentials', async () => {
    const empty = vi.fn(async () => ({ ok: true, json: async () => ({ items: [] }) })) as unknown as typeof fetch;
    expect(await latestPodcastEpisode(42, auth, empty)).toBeNull();
    expect(await latestPodcastEpisode(42, null)).toBeNull();
  });
});
