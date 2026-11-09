import { describe, expect, it, vi } from 'vitest';
import { clearSkipCache, fetchSkipSegments, parseSkipSegments } from '../sponsorblock.js';

describe('parseSkipSegments', () => {
  it('converts seconds to ms, drops malformed rows and sorts', () => {
    expect(
      parseSkipSegments([
        { segment: [120, 150], category: 'sponsor' },
        { segment: [10, 20], category: 'intro' },
        { segment: [20, 10], category: 'bad' },
        { segment: ['x', 3], category: 'bad' },
        { nope: true },
      ]),
    ).toEqual([
      { startMs: 10_000, endMs: 20_000, category: 'intro' },
      { startMs: 120_000, endMs: 150_000, category: 'sponsor' },
    ]);
  });

  it('returns [] for a non-array payload', () => {
    expect(parseSkipSegments(null)).toEqual([]);
    expect(parseSkipSegments({})).toEqual([]);
  });
});

describe('fetchSkipSegments', () => {
  it('caches a successful lookup', async () => {
    clearSkipCache();
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => [{ segment: [5, 9], category: 'sponsor' }],
    })) as unknown as typeof fetch;
    const first = await fetchSkipSegments('abcdef12345', fetchImpl);
    const second = await fetchSkipSegments('abcdef12345', fetchImpl);
    expect(first).toEqual([{ startMs: 5000, endMs: 9000, category: 'sponsor' }]);
    expect(second).toEqual(first);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('treats 404 as an empty list and never throws on network failure', async () => {
    clearSkipCache();
    const notFound = vi.fn(async () => ({ ok: false, status: 404 })) as unknown as typeof fetch;
    expect(await fetchSkipSegments('zzzzzz12', notFound)).toEqual([]);
    const boom = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await fetchSkipSegments('yyyyyy12', boom)).toEqual([]);
  });
});
