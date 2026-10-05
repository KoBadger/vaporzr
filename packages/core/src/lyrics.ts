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
  /** Per-line timestamps when the source provided synced (LRC) lyrics. */
  syncedLines?: SyncedLine[];
}

export interface SyncedLine {
  timeMs: number;
  text: string;
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
    timer.unref?.();
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

/** Parse LRC synced lyrics into timed lines (e.g. `[01:04.90] A notion…`). */
export function parseSyncedLines(lrc: string): SyncedLine[] {
  const out: SyncedLine[] = [];
  for (const raw of lrc.split('\n')) {
    const m = raw.match(/^\[(\d+):(\d{2})(?:\.(\d{1,3}))?\]\s*(.*)$/);
    if (!m) continue;
    const text = m[4].trim();
    if (!text) continue;
    const min = Number(m[1]);
    const sec = Number(m[2]);
    const frac = m[3] ? Number(`0.${m[3]}`) : 0;
    out.push({ timeMs: Math.round(min * 60_000 + sec * 1000 + frac * 1000), text });
  }
  return out;
}

/**
 * Normalize a title/artist into a loose comparable key. Handles the common
 * reasons obscure lookups miss: "(feat. X)" / "(Remix)" / "[Official Video]"
 * clutter, non-ASCII punctuation, and extra whitespace.
 */
function norm(s: string): string {
  return s
    .toLowerCase()
    // Drop everything in parentheses/brackets — "(feat. X)", "(Remix)", "[…]".
    .replace(/[([].*?[\])]/g, ' ')
    // Collapse apostrophes & curly quotes.
    .replace(/[''`]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Candidate word variants (1..n grams) so "Let It Happen" also tries shorter cores. */
function titleCores(name: string): string[] {
  const n = norm(name);
  if (!n) return [];
  const words = n.split(' ').filter((w) => w.length > 1);
  if (words.length === 0) return [n];
  // Full title first, then progressively shorter prefixes of ≥2 words.
  const cores = [n];
  for (let len = words.length - 1; len >= 2; len--) cores.push(words.slice(0, len).join(' '));
  return [...new Set(cores)];
}

/** Score a candidate against the wanted title+artist (higher = better). */
function scoreEntry(entry: LrcEntry, wantArtist: string, wantName: string): number {
  let s = 0;
  const ea = norm(entry.artistName);
  const et = norm(entry.trackName);
  const na = norm(wantArtist);
  const nt = norm(wantName);
  if (na && ea === na) s += 6;
  else if (na && (ea.includes(na) || na.includes(ea))) s += 3;
  if (nt && et === nt) s += 6;
  else if (nt && (et.includes(nt) || nt.includes(et))) s += 3;
  if (entry.plainLyrics) s += 1; // prefer plain over synced-only
  return s;
}

/** LRCLIB lookup: exact get, then fuzzier searches with normalized variants. */
async function lrcLyrics(track: { name: string; artists: string[]; album?: string; durationMs?: number }): Promise<LyricsResult | null> {
  const artists = (track.artists ?? []).map((a) => a.trim()).filter(Boolean);
  const durationSec = Math.round((track.durationMs ?? 0) / 1000);
  const name = track.name.trim();

  // 1. Exact get for the full name + each artist (album/duration narrow it).
  for (const artist of artists) {
    const q = new URLSearchParams();
    q.set('track_name', name);
    if (artist) q.set('artist_name', artist);
    if (track.album) q.set('album_name', track.album);
    if (durationSec > 0) q.set('duration', String(durationSec));
    const exact = await getJson<LrcEntry>(`${LRC_API}/get?${q.toString()}`);
    if (exact && (exact.plainLyrics || exact.syncedLyrics)) {
      return toResult(exact, artist);
    }
  }

  // 2. Fuzzy search over normalized title cores × each artist, keep best match.
  if (!name) return null;
  const wantArtist = artists[0] ?? '';
  let bestEntry: LrcEntry | null = null;
  let bestScore = -Infinity;
  const seen = new Set<string>();
  for (const core of titleCores(name)) {
    for (const artist of artists.length > 0 ? artists : ['']) {
      const query = `${core} ${artist}`.trim();
      const key = query.toLowerCase();
      if (!query || seen.has(key)) continue;
      seen.add(key);
      const hits = await getJson<LrcEntry[]>(`${LRC_API}/search?q=${encodeURIComponent(query)}`);
      if (!hits) continue;
      for (const h of hits) {
        if (!h || (!h.plainLyrics && !h.syncedLyrics)) continue;
        const s = scoreEntry(h, wantArtist, core);
        if (s > bestScore) {
          bestScore = s;
          bestEntry = h;
        }
      }
      // Good enough match — stop early to save requests.
      if (bestEntry && bestScore >= 9) return toResult(bestEntry, wantArtist);
    }
  }
  return bestEntry && bestScore >= 3 ? toResult(bestEntry, wantArtist) : null;
}

function toResult(entry: LrcEntry, wantArtist: string): LyricsResult {
  const plain = entry.plainLyrics;
  const synced = entry.syncedLyrics;
  const result: LyricsResult = {
    trackName: entry.trackName,
    artistName: entry.artistName || wantArtist,
    synced: !plain && Boolean(synced),
    lyrics: plain ?? (synced ? stripLrcTimestamps(synced) : ''),
  };
  if (synced) {
    const lines = parseSyncedLines(synced);
    if (lines.length > 0) result.syncedLines = lines;
  }
  return result;
}

/** SyncLRC free lyrics API (also keyless, aggregates LRCLIB + Musixmatch + NetEase + QQ + Kugou). */
const SYNCLRC_API = 'https://api.synclrc.dev';

async function syncLrcLyrics(track: { name: string; artists: string[] }): Promise<LyricsResult | null> {
  const name = track.name.trim();
  if (!name) return null;
  const artist = (track.artists[0] ?? '').trim();
  const q = new URLSearchParams({ track: name, artist, type: 'plain' });
  const res = await getJson<{ lyrics?: string; type?: string }>(`${SYNCLRC_API}/lyrics?${q.toString()}`);
  if (!res?.lyrics) return null;
  return { trackName: name, artistName: artist || 'Unknown', synced: false, lyrics: res.lyrics };
}

/** lyrics.ovh fallback (also keyless). Tries each artist + a cleaned title. */
async function ovhLyrics(track: { name: string; artists: string[] }): Promise<LyricsResult | null> {
  const artists = (track.artists ?? []).map((a) => a.trim()).filter(Boolean);
  const name = track.name.trim();
  if (!name) return null;
  for (const artist of artists.length > 0 ? artists : ['']) {
    const res = await getJson<{ lyrics?: string }>(
      `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(name)}`,
    );
    if (res?.lyrics) return { trackName: name, artistName: artist || 'Unknown', synced: false, lyrics: res.lyrics };
    if (artist) {
      const res2 = await getJson<{ lyrics?: string }>(
        `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(norm(name))}`,
      );
      if (res2?.lyrics) return { trackName: name, artistName: artist, synced: false, lyrics: res2.lyrics };
    }
  }
  return null;
}

/** Look up lyrics for a track. Returns null when neither source has a hit. */
export async function fetchLyrics(track: Pick<TrackInfo, 'name' | 'artists' | 'album' | 'durationMs'>): Promise<LyricsResult | null> {
  const key = `${(track.artists[0] ?? '').toLowerCase()}~${track.name.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  let result = await lrcLyrics(track);
  result ??= await ovhLyrics(track);
  result ??= await syncLrcLyrics(track);
  cache.set(key, { at: Date.now(), value: result });
  return result;
}
