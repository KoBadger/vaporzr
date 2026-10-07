import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearCosineCache,
  cosineEnabled,
  cosineSearch,
  cosineSimilarCandidates,
} from '@vaporzr/core/cosine';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('cosine.club client', () => {
  beforeEach(() => {
    process.env.COSINE_API_KEY = 'test-key';
    clearCosineCache();
  });
  afterEach(() => {
    delete process.env.COSINE_API_KEY;
    vi.unstubAllGlobals();
  });

  it('is disabled without a key', () => {
    delete process.env.COSINE_API_KEY;
    expect(cosineEnabled()).toBe(false);
  });

  it('is enabled with a key', () => {
    expect(cosineEnabled()).toBe(true);
  });

  it('parses search results', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ data: [{ id: '1', name: 'X', artist: 'A', track: 'A - X' }], success: true }),
      ),
    );
    const hits = await cosineSearch('A X');
    expect(hits).toHaveLength(1);
    expect(hits[0].id).toBe('1');
  });

  it('builds youtube:video candidates from similar tracks (via exact lookup)', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => {
        calls.push(String(url));
        if (String(url).includes('/tracks/lookup')) {
          return jsonResponse({ data: [{ id: 'seed1', name: 'Seed', artist: 'A', track: 'A - Seed' }], success: true });
        }
        if (String(url).includes('/similar')) {
          return jsonResponse({
            data: {
              source_track: {},
              similar_tracks: [
                { id: 's1', name: 'Similar One', artist: 'B', track: 'B - Similar One', video_uri: 'https://www.youtube.com/watch?v=abc123XYZ', score: 0.9 },
                { id: 's2', name: 'No Video', artist: 'C', track: 'C - No Video', score: 0.8 },
              ],
            },
            success: true,
          });
        }
        return jsonResponse({});
      }),
    );

    const out = await cosineSimilarCandidates(
      { name: 'Seed', artists: ['A'], uri: 'youtube:video:seedvid01' },
      30,
    );
    expect(calls.some((c) => c.includes('/tracks/lookup'))).toBe(true);
    expect(out).toHaveLength(2);
    expect(out[0].uri).toBe('youtube:video:abc123XYZ');
    expect(out[0].cosineScore).toBe(0.9);
    expect(out[0].source).toBe('youtube');
    // No video_uri → synthetic uri (still dedups; resolved by name later).
    expect(out[1].uri).toBe('cosine:s2');
    expect(out[1].cosineScore).toBe(0.8);
  });

  it('falls back to search when the seed has no YouTube id', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => {
        calls.push(String(url));
        if (String(url).includes('/search')) {
          return jsonResponse({ data: [{ id: 'seedX', name: 'S', artist: 'A', track: 'A - S' }], success: true });
        }
        if (String(url).includes('/similar')) {
          return jsonResponse({ data: { similar_tracks: [] }, success: true });
        }
        return jsonResponse({});
      }),
    );

    await cosineSimilarCandidates({ name: 'Seed', artists: ['A'], uri: 'spotify:track:zzz' }, 10);
    expect(calls.some((c) => c.includes('/search'))).toBe(true);
    expect(calls.some((c) => c.includes('/tracks/lookup'))).toBe(false);
  });

  it('returns [] on network failure (never throws)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('boom');
    }));
    const out = await cosineSimilarCandidates(
      { name: 'Seed', artists: ['A'], uri: 'youtube:video:seedvid01' },
      10,
    );
    expect(out).toEqual([]);
  });

  it('is a no-op without a key (no network call)', async () => {
    delete process.env.COSINE_API_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const out = await cosineSimilarCandidates(
      { name: 'Seed', artists: ['A'], uri: 'youtube:video:x' },
      10,
    );
    expect(out).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
