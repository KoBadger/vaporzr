/**
 * MusicBrainz + Cover Art Archive — free metadata/artwork, no key.
 *
 * Used only as a last resort for artwork: a direct/generic track sometimes has
 * no thumbnail, and the release cover is better than an empty card. Requests
 * are cached and throttled by a single-flight map so a queue full of misses
 * does not hammer MusicBrainz (its usage policy asks for ~1 req/s).
 */

const MB = 'https://musicbrainz.org/ws/2/release/';
const CAA = 'https://coverartarchive.org/release/';
const UA = 'Vaporzr/1.0 (https://github.com/KoBadger/vaporzr)';

interface ReleaseResponse {
  releases?: Array<{ id?: string; score?: number }>;
}

const cache = new Map<string, { at: number; value: string | null }>();
const CACHE_MS = 24 * 60 * 60 * 1000;
const inFlight = new Map<string, Promise<string | null>>();

function escapeLucene(value: string): string {
  return value.replace(/[\\"]/g, '\\$&').replace(/\s+/g, ' ').trim();
}

/** Best-effort front cover URL for a title/artist pair. Never throws. */
export async function lookupCoverArt(
  title: string,
  artist: string,
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<string | null> {
  const key = `${title}\u0000${artist}`.toLowerCase();
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_MS) return hit.value;
  const pending = inFlight.get(key);
  if (pending) return pending;

  const task = (async (): Promise<string | null> => {
    try {
      const q = `release:"${escapeLucene(title)}"`;
      const a = artist ? ` AND artist:"${escapeLucene(artist)}"` : '';
      const res = await fetchImpl(`${MB}?query=${encodeURIComponent(q + a)}&fmt=json&limit=1`, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return null;
      const json = (await res.json()) as ReleaseResponse;
      const id = json.releases?.[0]?.id;
      if (!id) return null;
      const front = `${CAA}${encodeURIComponent(id)}/front-500`;
      const img = await fetchImpl(front, {
        method: 'HEAD',
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(6000),
      });
      return img.ok ? front : null;
    } catch {
      return null;
    } finally {
      cache.set(key, { at: Date.now(), value: cache.get(key)?.value ?? null });
    }
  })();

  inFlight.set(key, task);
  try {
    const value = await task;
    cache.set(key, { at: Date.now(), value });
    return value;
  } finally {
    inFlight.delete(key);
  }
}
