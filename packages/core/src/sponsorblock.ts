/**
 * SponsorBlock: skip sponsor/intro/outro segments in YouTube audio.
 *
 * The API is free and needs no key. A segment list is fetched once per video
 * and cached; playback skips a segment the first time the playhead enters it.
 * Failures are silent — a missing skip list must never stop a track.
 */

export interface SkipSegment {
  startMs: number;
  endMs: number;
  category: string;
}

const API = 'https://sponsor.ajay.app/api/skipSegments';
/** Categories worth cutting from a music/podcast stream. `music_offtopic`
 *  is deliberately excluded: on a music video it would delete the song. */
export const DEFAULT_CATEGORIES = ['sponsor', 'selfpromo', 'interaction', 'intro', 'outro', 'preview'];

interface RawSegment {
  segment?: [number, number];
  category?: string;
}

/** Parse the API's `[{segment:[start,end],category}]` shape. Pure, testable. */
export function parseSkipSegments(raw: unknown): SkipSegment[] {
  if (!Array.isArray(raw)) return [];
  const out: SkipSegment[] = [];
  for (const item of raw as RawSegment[]) {
    const seg = item?.segment;
    if (!Array.isArray(seg) || seg.length < 2) continue;
    const start = Number(seg[0]);
    const end = Number(seg[1]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    out.push({
      startMs: Math.max(0, Math.round(start * 1000)),
      endMs: Math.round(end * 1000),
      category: String(item.category ?? 'sponsor'),
    });
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

const cache = new Map<string, { at: number; segments: SkipSegment[] }>();
const CACHE_MS = 6 * 60 * 60 * 1000;

/** Fetch (and cache) skip segments for a YouTube video id. Never throws. */
export async function fetchSkipSegments(
  videoId: string,
  fetchImpl: typeof fetch = fetch,
  categories: string[] = DEFAULT_CATEGORIES,
  now = Date.now(),
): Promise<SkipSegment[]> {
  if (!/^[A-Za-z0-9_-]{6,}$/.test(videoId)) return [];
  const hit = cache.get(videoId);
  if (hit && now - hit.at < CACHE_MS) return hit.segments;
  try {
    const url =
      `${API}?videoID=${encodeURIComponent(videoId)}` + `&categories=${encodeURIComponent(JSON.stringify(categories))}`;
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) {
      // 404 means "no segments for this video" — cache that too.
      if (res.status === 404) {
        cache.set(videoId, { at: now, segments: [] });
        return [];
      }
      return hit?.segments ?? [];
    }
    const segments = parseSkipSegments(await res.json());
    cache.set(videoId, { at: now, segments });
    return segments;
  } catch {
    return hit?.segments ?? [];
  }
}

/** Test/ops helper. */
export function clearSkipCache(): void {
  cache.clear();
}
