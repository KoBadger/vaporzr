import type { TrackInfo } from '@vaporzr/shared';

/**
 * Keyless, quota-free lyrics lookup.
 *
 * Primary source: LRCLIB (lrclib.net) — an open lyrics database with no API
 * key and no quota. Requested title/artist (+ optional album/duration) are
 * matched once. Falls back to lyrics.ovh (also keyless) when LRCLIB has no
 * hit. Either source returning [] yields the ever-popular "copy link" style
 * fallback framing a search box so callers can respond gracefully.
 */

const LRC_API = 'https://lrclib.net/api';
const TIMEOUT_MS = 8000;
const cache = new Map<string, { at: number; value: LyricsResult | null }>();
const CACHE_TTL_MS = 30 * 60 * 1000;

export interface LyricsResult {
  trackName: string;
  artistName: string;
  synced: boolean;
  lyrics: string;
}

interface LrcEntry {
  trackName: string;
  artistName: string;
  plainLyrics: string | null;
  syncedLyrics: string | null;
}

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** Strip LRC timestamps like `[mm:ss.xx]` leaving plain lines. */
function stripLrcTimestamps(lrc: string): string {
  return lrc
    .split('\n')
    .map((line) => line.replace(/^\[[0-9]+:[0-9]+(\.[0-9]+)?\]\s*/, '').trim())
    .filter(Boolean)
    .join('\n');
}

/** LRCLIB exact + fuzzy lookup. */
async function lrcLyrics(track: { name: string; artists: string[]; album?: string; durationMs?: number }): Promise<LyricsResult | null> {
  const artist = (track.artists[0] ?? '').toLowerCase().trim();
  const name = track.name.toLowerCase().trim();
  const album = (track.album ?? '').toLowerCase().trim();
  const durationSec = Math.round((track.durationMs ?? 0) / 1000);

  // Exact-ish match: artist+title (+album/duration narrows it further).
  const q = new URLSearchParams();
  if (artist) q.set('artist_name', artist);
  q.set('track_name', name);
  if (album) q.set('album_name', album);
  if (durationSec > 0) q.set('duration', String(durationSec));
  const exact = await getJson<LrcEntry>(`${LRC_API}/get?${q.toString()}`);
  if (exact && (exact.plainLyrics || exact.syncedLyrics)) {
    return toResult(exact, artist);
  }

  // Fuzzy fallback: search candidates, prefer artist+title match.
  if (!artist || !name) return null;
  const s = new URLSearchParams({ q: `${name} ${artist}` });
  const hits = await getJson<LrcEntry[]>(`${LRC_API}/search?${s.toString()}`);
  if (!hits || hits.length === 0) return null;
  const ranked = hits
    .filter((h) => h && (h.plainLyrics || h.syncedLyrics))
    .sort((a, b) => Number(Boolean(b)) - Number(Boolean(a)));
  for (const h of ranked) {
    const normArtist = h.artistName.toLowerCase();
    const normName = h.trackName.toLowerCase();
    if (normArtist.includes(artist) && normName.includes(name)) return toResult(h, artist);
  }
  return ranked[0] ? toResult(ranked[0], artist) : null;
}

function toResult(entry: LrcEntry, wantArtist: string): LyricsResult {
  const plain = entry.plainLyrics;
  const synced = entry.syncedLyrics;
  return {
    trackName: entry.trackName,
    artistName: entry.artistName || wantArtist,
    synced: !plain && Boolean(synced),
    lyrics: plain ?? (synced ? stripLrcTimestamps(synced) : ''),
  };
}

/** lyrics.ovh fallback (also keyless). */
async function ovhLyrics(track: { name: string; artists: string[] }): Promise<LyricsResult | null> {
  const artist = (track.artists[0] ?? '').trim();
  const name = track.name.trim();
  if (!artist || !name) return null;
  const res = await getJson<{ lyrics?: string }>(
    `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(name)}`,
  );
  if (!res?.lyrics) return null;
  return { trackName: name, artistName: artist, synced: false, lyrics: res.lyrics };
}

/** Look up lyrics for a track. Returns null when neither source has a hit. */
export async function fetchLyrics(track: Pick<TrackInfo, 'name' | 'artists' | 'album' | 'durationMs'>): Promise<LyricsResult | null> {
  const key = `${(track.artists[0] ?? '').toLowerCase()}~${track.name.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  let result = await lrcLyrics(track);
  result ??= await ovhLyrics(track);
  cache.set(key, { at: Date.now(), value: result });
  return result;
}
