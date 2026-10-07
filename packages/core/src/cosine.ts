import type { ResolvedTrack } from '@vaporzr/core/spotify';

/**
 * cosine.club — an audio-similarity search engine (Essentia `discogs-effnet`
 * embeddings). Given a track it returns the tracks that *sound* most like it,
 * each with a similarity `score` and (usually) a YouTube `video_uri`.
 *
 * The catalog is mostly electronic/underground music, so this is an additive
 * signal for the Endless Wave picker — for seeds it doesn't know it returns
 * nothing and the existing strategies carry on.
 *
 * Key-gated: without COSINE_API_KEY every call is a no-op, so the bot behaves
 * exactly as before until a key is configured.
 */

const BASE = 'https://cosine.club/api/v1';
const TIMEOUT_MS = 6_000;
const CACHE_TTL_MS = 30 * 60 * 1000;
const MAX_CACHE = 500;

export interface CosineTrack {
  id: string;
  name: string;
  artist: string;
  track: string;
  video_uri?: string;
  external_link?: string;
}

export interface CosineScored extends CosineTrack {
  score: number;
}

export function cosineEnabled(): boolean {
  return !!process.env.COSINE_API_KEY;
}

const cache = new Map<string, { at: number; data: unknown }>();

/** Clear the in-memory response cache (used by tests). */
export function clearCosineCache(): void {
  cache.clear();
}

/** GET a JSON endpoint, cached, with a short timeout. Returns null on any
 *  failure — cosine is best-effort and must never break a pick. */
async function getJson<T>(path: string): Promise<T | null> {
  const key = process.env.COSINE_API_KEY;
  if (!key) return null;

  const cached = cache.get(path);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.data as T;

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const res = await fetch(`${BASE}${path}`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const json = (await res.json()) as T;
    if (cache.size > MAX_CACHE) cache.clear();
    cache.set(path, { at: Date.now(), data: json });
    return json;
  } catch {
    return null;
  }
}

/** Find a track by artist/title. */
export async function cosineSearch(query: string, limit = 5): Promise<CosineTrack[]> {
  const json = await getJson<{ data?: CosineTrack[] }>(
    `/search?q=${encodeURIComponent(query)}&limit=${limit}`,
  );
  return json?.data ?? [];
}

/** Tracks that sound like `id`, best match first (each carries a 0..1 `score`). */
export async function cosineSimilar(id: string, limit = 30): Promise<CosineScored[]> {
  const json = await getJson<{ data?: { similar_tracks?: CosineScored[] } }>(
    `/tracks/${encodeURIComponent(id)}/similar?limit=${limit}`,
  );
  return json?.data?.similar_tracks ?? [];
}

/** Resolve a YouTube/Discogs/SoundCloud page URL to a catalog track. */
export async function cosineLookupByUrl(url: string): Promise<CosineTrack[]> {
  const json = await getJson<{ data?: CosineTrack[] }>(
    `/tracks/lookup?url=${encodeURIComponent(url)}`,
  );
  return json?.data ?? [];
}

const YT_ID_RE = /(?:youtube\.com\/(?:watch\?.*v=|shorts\/|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/;

function videoId(url?: string): string | null {
  if (!url) return null;
  const m = url.match(YT_ID_RE);
  return m ? m[1] : null;
}

/**
 * Turn the current track into scored cosine candidates. Resolves the seed by
 * exact YouTube id when we have one (precise), else by an artist+title search.
 * Returns [] when cosine is disabled, the seed isn't in the catalog, or the API
 * is unreachable.
 */
export async function cosineSimilarCandidates(
  seed: { name: string; artists?: string[]; uri?: string },
  limit = 30,
): Promise<ResolvedTrack[]> {
  if (!cosineEnabled()) return [];

  let id: string | null = null;

  const ytId = seed.uri?.match(/^youtube:video:(.+)$/)?.[1];
  if (ytId) {
    const hits = await cosineLookupByUrl(`https://www.youtube.com/watch?v=${ytId}`);
    if (hits[0]) id = hits[0].id;
  }
  if (!id) {
    const q = `${seed.artists?.[0] ?? ''} ${seed.name ?? ''}`.trim();
    if (!q) return [];
    const hits = await cosineSearch(q, 5);
    if (hits[0]) id = hits[0].id;
  }
  if (!id) return [];

  const similar = await cosineSimilar(id, limit);
  const out: ResolvedTrack[] = [];
  for (const t of similar) {
    const vid = videoId(t.video_uri);
    out.push({
      // A known video id plays the exact upload cosine points at; otherwise a
      // synthetic uri still dedups correctly and gets resolved by name later.
      uri: vid ? `youtube:video:${vid}` : `cosine:${t.id}`,
      name: t.name || t.track || '',
      artists: [t.artist || 'Unknown'],
      album: 'cosine.club',
      durationMs: 0,
      source: 'youtube',
      cosineScore: typeof t.score === 'number' ? t.score : undefined,
    });
  }
  return out;
}
