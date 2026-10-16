import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// getAudioFeatures resolves its cache file from config.dataDir at import time —
// point DATA_DIR at a throwaway folder before importing anything that reads it.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vaporzr-feat-'));
process.env.DATA_DIR = TMP;

// getAccessToken needs a linked account; stub the token store so the Spotify
// leg actually reaches the (stubbed) network.
vi.mock('@vaporzr/core/tokenStore', () => ({
  tokenStore: { load: () => ({ refresh_token: 'test-refresh' }) },
}));

const { getAudioFeatures, spotifyCooldownRemainingSec } = await import('@vaporzr/core/spotify');
const { config } = await import('@vaporzr/core/config');
config.dataDir = TMP;

const id = (ch: string): string => ch.repeat(22);

const jsonRes = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Mirror payload entry for one id (href is what the parser reads). */
const mirrorEntry = (trackId: string, key: number, mode = 1) => ({
  href: `https://open.spotify.com/track/${trackId}`,
  key,
  mode,
});

let spotifyFeaturesStatus = 403;
let mirrorResponder: (ids: string[]) => Response = () => jsonRes({ content: [] });
const calls: string[] = [];
const countCalls = (frag: string): number => calls.filter((u) => u.includes(frag)).length;

beforeAll(() => {
  vi.stubGlobal('fetch', async (input: unknown) => {
    const url = String(input);
    calls.push(url);
    // Match the parsed hostname — each host serves exactly one endpoint in the
    // tested path, and URL substring checks are what CodeQL flags.
    const parsed = new URL(url);
    if (parsed.hostname === 'accounts.spotify.com') {
      return jsonRes({ access_token: 'test-token', token_type: 'Bearer', expires_in: 3600 });
    }
    if (parsed.hostname === 'api.spotify.com') {
      if (spotifyFeaturesStatus === 429) {
        return new Response('', { status: 429, headers: { 'retry-after': '3600' } });
      }
      return new Response('', { status: spotifyFeaturesStatus });
    }
    if (parsed.hostname === 'api.reccobeats.com') {
      const ids = (parsed.searchParams.get('ids') ?? '').split(',').filter(Boolean);
      return mirrorResponder(ids);
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('getAudioFeatures resilience', () => {
  it('keeps cached hits and still asks the mirror when Spotify 429s', async () => {
    const A = id('A');
    const B = id('B');

    // Seed A through the 403 path (retired endpoint): the mirror answers it
    // and it lands in the cache.
    spotifyFeaturesStatus = 403;
    mirrorResponder = (ids) => jsonRes({ content: ids.filter((i) => i === A).map((i) => mirrorEntry(i, 5)) });
    let out = await getAudioFeatures([A]);
    expect(out.get(A)?.key).toBe(5);

    // Now Spotify rate-limits. The old code rethrew the 429 and lost every
    // cache hit; now A must survive and B must still come from the mirror.
    spotifyFeaturesStatus = 429;
    mirrorResponder = (ids) => jsonRes({ content: ids.map((i) => mirrorEntry(i, 9, 0)) });
    out = await getAudioFeatures([A, B]);
    expect(out.get(A)?.key).toBe(5);
    expect(out.get(B)?.key).toBe(9);
    expect(spotifyCooldownRemainingSec()).toBeGreaterThan(0);
  });

  it('skips the Spotify leg during a cooldown instead of re-hitting it', async () => {
    const C = id('C');
    expect(spotifyCooldownRemainingSec()).toBeGreaterThan(0); // from the test above

    const before = countCalls('api.spotify.com');
    spotifyFeaturesStatus = 200; // would succeed if asked — proves it is not asked
    mirrorResponder = (ids) => jsonRes({ content: ids.map((i) => mirrorEntry(i, 3)) });
    const out = await getAudioFeatures([C]);

    expect(out.get(C)?.key).toBe(3);
    expect(countCalls('api.spotify.com')).toBe(before);
  });

  it('does not remember a failed mirror chunk as a miss', async () => {
    const D = id('D');
    spotifyFeaturesStatus = 403;

    mirrorResponder = () => new Response('boom', { status: 500 });
    let out = await getAudioFeatures([D]);
    expect(out.has(D)).toBe(false);

    // Mirror recovers — the id must be asked again. The old code had cached a
    // 24h miss from the failed chunk and would never look at D again.
    mirrorResponder = (ids) => jsonRes({ content: ids.map((i) => mirrorEntry(i, 11, 0)) });
    out = await getAudioFeatures([D]);
    expect(out.get(D)?.key).toBe(11);
  });

  it('remembers an id the mirror answered but does not know', async () => {
    const E = id('E');
    spotifyFeaturesStatus = 403;
    mirrorResponder = () => jsonRes({ content: [] });

    let out = await getAudioFeatures([E]);
    expect(out.has(E)).toBe(false);

    const before = countCalls('api.reccobeats.com');
    out = await getAudioFeatures([E]);
    expect(out.has(E)).toBe(false);
    expect(countCalls('api.reccobeats.com')).toBe(before); // short-circuited by the miss cache
  });
});
