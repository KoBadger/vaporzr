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

/* ---------- Artist profiles (genres + related artists) ---------- */

interface DeezerAlbum {
  id: number;
  title?: string;
  genres?: { data?: Array<{ id?: number; name?: string }> };
}

export interface ArtistProfile {
  /** Deezer's canonical artist name. */
  name: string;
  /** Lowercased genre names harvested from the artist's albums. */
  genres: string[];
  /** Lowercased names of related artists. */
  related: string[];
}

const profileCache = new Map<string, { at: number; value: ArtistProfile }>();
const PROFILE_TTL_MS = 12 * 60 * 60 * 1000;
/** In-flight fetches, so a burst of warm-ups shares one round-trip each. */
const profileInflight = new Map<string, Promise<ArtistProfile>>();

/** Synchronous peek at what we already know about an artist (null if nothing).
 *  Scoring runs on the hot path and must never block on the network, so readers
 *  use this and the data is warmed in the background instead. */
export function peekArtistProfile(artist: string): ArtistProfile | null {
  const hit = profileCache.get(String(artist ?? '').toLowerCase().trim());
  return hit ? hit.value : null;
}

/**
 * Genre + related-artist profile for one artist from Deezer's keyless API:
 * search -> related artists -> first albums' genres. Cached for 12h and
 * de-duplicated across concurrent callers. Always background-warmed; never
 * awaited on the scoring path.
 */
export async function deezerArtistProfile(artist: string): Promise<ArtistProfile | null> {
  const key = String(artist ?? '').toLowerCase().trim();
  if (key.length < 2) return null;
  const hit = profileCache.get(key);
  if (hit && Date.now() - hit.at < PROFILE_TTL_MS) return hit.value;
  const inflight = profileInflight.get(key);
  if (inflight) return inflight;

  const run = (async (): Promise<ArtistProfile> => {
    const empty: ArtistProfile = { name: artist, genres: [], related: [] };
    try {
      const search = await getJson<{ data?: DeezerArtist[] }>(
        `/search/artist?q=${encodeURIComponent(artist)}&limit=1`,
      );
      // Network failure: don't cache — a transient Deezer hiccup must not
      // blacklist the artist for the whole TTL.
      if (search === null) return empty;
      const found = search.data?.[0];
      if (!found) {
        profileCache.set(key, { at: Date.now(), value: empty });
        return empty;
      }
      const [related, albums] = await Promise.all([
        getJson<{ data?: DeezerArtist[] }>(`/artist/${found.id}/related?limit=15`),
        getJson<{ data?: DeezerAlbum[] }>(`/artist/${found.id}/albums?limit=4`),
      ]);
      // Deezer only reports genres on the ALBUM DETAIL endpoint — the artist's
      // album list omits them — so look up the first couple of albums directly.
      const albumIds = (albums?.data ?? [])
        .slice(0, 2)
        .map((al) => al?.id)
        .filter((id): id is number => typeof id === 'number');
      const details = await Promise.all(albumIds.map((id) => getJson<DeezerAlbum>(`/album/${id}`)));
      const genres = new Set<string>();
      for (const al of details) {
        for (const g of al?.genres?.data ?? []) {
          const n = (g?.name ?? '').toLowerCase().trim();
          if (n) genres.add(n);
        }
      }
      const value: ArtistProfile = {
        name: found.name,
        genres: [...genres],
        related: [
          ...new Set(
            (related?.data ?? [])
              .map((r) => (r?.name ?? '').toLowerCase().trim())
              .filter(Boolean),
          ),
        ],
      };
      profileCache.set(key, { at: Date.now(), value });
      if (profileCache.size > 400) {
        const oldest = [...profileCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (oldest) profileCache.delete(oldest[0]);
      }
      return value;
    } catch {
      return empty;
    }
  })();

  profileInflight.set(key, run);
  try {
    return await run;
  } finally {
    profileInflight.delete(key);
  }
}
