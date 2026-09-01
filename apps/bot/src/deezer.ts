import type { ResolvedTrack } from './spotify.js';

/**
 * Keyless, quota-free Deezer fallback for Endless Wave.
 *
 * Spotify's own search/recommendations can dead-end when the seed artist's
 * catalog is dominated by DJ sets / long mixes (every candidate gets rejected
 * as "long-form"), leaving the wave with nothing to play. Deezer's public API
 * needs no API key and its `artist/{id}/radio` endpoint returns *individual*
 * tracks by related artists — a reliable diversifier that keeps the wave
 * flowing without touching any Spotify app quota.
 *
 * Every call is best-effort and cached; any failure yields [] so callers fall
 * through gracefully.
 */

const API = 'https://api.deezer.com';
const TIMEOUT_MS = 8000;

interface DeezerArtist {
  id: number;
  name: string;
}
interface DeezerTrack {
  id: number;
  title: string;
  duration?: number;
  artist?: { name?: string };
  album?: { title?: string; cover_medium?: string; cover_big?: string };
}

const cache = new Map<string, { at: number; value: ResolvedTrack[] }>();
const CACHE_TTL_MS = 30 * 60 * 1000;

async function getJson<T>(path: string): Promise<T | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const res = await fetch(`${API}${path}`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

function mapTrack(t: DeezerTrack): ResolvedTrack {
  return {
    uri: `deezer:track:${t.id}`,
    name: t.title ?? '',
    artists: [t.artist?.name ?? ''].filter(Boolean),
    album: t.album?.title ?? '',
    durationMs: (t.duration ?? 0) * 1000,
    image: t.album?.cover_big ?? t.album?.cover_medium,
    source: 'youtube',
  };
}

/**
 * Individual tracks by artists related to `artistName` (Deezer radio).
 * Returns [] on any failure so callers can fall through to other strategies.
 */
export async function deezerRelatedTracks(artistName: string): Promise<ResolvedTrack[]> {
  const key = `radio:${artistName.toLowerCase().trim()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const search = await getJson<{ data?: DeezerArtist[] }>(
    `/search/artist?q=${encodeURIComponent(artistName)}&limit=1`,
  );
  const artistId = search?.data?.[0]?.id;
  if (!artistId) {
    cache.set(key, { at: Date.now(), value: [] });
    return [];
  }

  const radio = await getJson<{ data?: DeezerTrack[] }>(`/artist/${artistId}/radio`);
  const out = (radio?.data ?? [])
    .filter((t) => t && t.title && (t.duration ?? 0) > 0)
    .map(mapTrack);

  cache.set(key, { at: Date.now(), value: out });
  return out;
}
