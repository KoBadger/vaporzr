import type { ResolvedTrack } from './spotify.js';
import type { AudioFeatures } from './spotify.js';

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
  /** Deezer's tempo readout (BPM) — used to estimate audio features. */
  bpm?: number;
  /** Deezer's popularity 0..1-ish — used to approximate energy/valence. */
  rank?: number;
  artist?: { name?: string };
  album?: { title?: string; cover_medium?: string; cover_big?: string };
}

const cache = new Map<string, { at: number; value: ResolvedTrack[] }>();
const CACHE_TTL_MS = 30 * 60 * 1000;

async function getJson<T>(path: string): Promise<T | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    timer.unref?.();
    const res = await fetch(`${API}${path}`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/**
 * Approximate Spotify-style AudioFeatures from the metadata Deezer exposes
 * (BPM, rank, duration). Deezer tracks otherwise score with midline defaults,
 * which makes them musically blind; estimating lets a Deezer-only run still
 * steer toward the evolving energy/tempo/valence target.
 */
export function estimateFeatures(t: DeezerTrack): AudioFeatures {
  let tempo = t.bpm && t.bpm > 0 ? t.bpm : 120;
  tempo = Math.max(60, Math.min(200, tempo));
  // Faster tracks read as more energetic; rank (popularity) loosely gates
  // energy too. Valence is unknown so keep it neutral.
  const energy =
    t.rank != null && t.rank >= 0
      ? Math.min(1, Math.max(0, 0.3 + (t.rank / 1_000_000) + (tempo - 120) / 250))
      : Math.min(1, Math.max(0, 0.4 + (tempo - 120) / 220));
  return {
    tempo,
    energy,
    valence: 0.5,
    danceability: 0.5,
    acousticness: 0.3,
    instrumentalness: 0.2,
    liveness: 0.12,
    speechiness: 0.06,
    mode: 1,
    key: 6,
    time_signature: 4,
    duration_ms: (t.duration ?? 0) * 1000,
  };
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
    // Feature estimate rides along so the wave can score Deezer tracks musically.
    ...(t.bpm != null || t.rank != null ? { estimatedFeatures: estimateFeatures(t) } : {}),
  };
}

function toTracks(list?: unknown): ResolvedTrack[] {
  const arr = (list as { data?: DeezerTrack[] } | undefined)?.data ?? [];
  return arr
    .filter((t): t is DeezerTrack => !!t && !!t.title && (t.duration ?? 0) > 0)
    .map(mapTrack);
}

/**
 * Individual tracks by artists related to `artistName` (Deezer radio).
 * Falls back to a plain `search/track` on the artist name when the radio
 * returns nothing (e.g. an artist with no related-radio feed). Returns []
 * on any failure so callers can fall through to other strategies.
 */
export async function deezerRelatedTracks(artistName: string): Promise<ResolvedTrack[]> {
  const key = `radio:${artistName.toLowerCase().trim()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const search = await getJson<{ data?: DeezerArtist[] }>(
    `/search/artist?q=${encodeURIComponent(artistName)}&limit=1`,
  );
  // A failed/latency-aborted request returns null — do NOT cache that as an
  // empty result, or a transient Deezer hiccup blacklists the artist for the
  // whole TTL. Only cache a definitive "no such artist".
  if (search === null) return [];
  const artistId = search.data?.[0]?.id;
  if (!artistId) {
    cache.set(key, { at: Date.now(), value: [] });
    return [];
  }

  const radio = await getJson<{ data?: DeezerTrack[] }>(`/artist/${artistId}/radio`);
  let out = radio === null ? [] : toTracks(radio);
  // Radio feed empty? Diversify via a keyword search on the artist — returns
  // the artist's own individual tracks, still breaking a Spotify-only dead-end.
  if (out.length === 0) {
    const trackSearch = await getJson<{ data?: DeezerTrack[] }>(
      `/search/track?q=${encodeURIComponent(artistName)}&limit=20`,
    );
    out = trackSearch === null ? [] : toTracks(trackSearch);
  }

  cache.set(key, { at: Date.now(), value: out });
  return out;
}
