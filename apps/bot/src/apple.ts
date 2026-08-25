import { searchAndResolveYoutube, type ResolvedVideo } from './youtube.js';
import type { ResolvedTrack } from './spotify.js';

/**
 * Apple Music link support — metadata via the free iTunes Lookup API, with
 * playback matched on YouTube (full Apple streams are subscription DRM; we
 * don't touch that). Same philosophy as the SoundCloud DRM fallback.
 */

export class AppleMusicError extends Error {}

export interface ResolvedAppleTrack extends ResolvedTrack {
  channel: string;
  thumbnail?: string;
}

const AM_URL_RE = /(^|[./])music\.apple\.com\//;

export function isAppleMusicUrl(input: string): boolean {
  return AM_URL_RE.test(input);
}

function itunesArtwork(url: string | undefined, size = 600): string | undefined {
  if (!url) return undefined;
  return url.replace(/\/\d+x\d+bb\./, `/${size}x${size}bb.`);
}

interface ItunesResult {
  wrapperType?: string;
  kind?: string;
  collectionId?: number;
  trackId?: number;
  trackName?: string;
  collectionName?: string;
  artistName?: string;
  trackTimeMillis?: number;
  artworkUrl100?: string;
}

function toTrack(r: ItunesResult): ResolvedAppleTrack | null {
  if (!r.trackName || !r.trackId) return null;
  return {
    uri: `apple:track:${r.trackId}`,
    name: r.trackName,
    artists: [r.artistName ?? 'Apple Music'],
    album: r.collectionName ?? 'Apple Music',
    durationMs: r.trackTimeMillis ?? 0,
    image: itunesArtwork(r.artworkUrl100),
    source: 'apple',
    channel: r.artistName ?? 'Apple Music',
    thumbnail: itunesArtwork(r.artworkUrl100),
  };
}

/** Resolve an Apple Music song/album/playlist URL into queuable tracks. */
export async function resolveAppleMusicUrl(input: string): Promise<ResolvedAppleTrack[]> {
  const url = input.trim().startsWith('http') ? input.trim() : `https://${input.trim()}`;
  const path = url.replace(/^https?:\/\/[^/]+\//, '');
  // music.apple.com/{storefront}/{album|song|playlist}/{slug?}/{id}?i=<songId>
  const idMatch = /[?&]i=(\d+)/.exec(url);
  const segs = path.split('/').filter(Boolean);
  const kind = segs[1] ?? '';
  const id = idMatch?.[1] ?? segs.find((s) => /^\d+$/.test(s));
  if (!id) throw new AppleMusicError('Could not find an Apple Music ID in that link.');

  const api = `https://itunes.apple.com/lookup?id=${id}&entity=song&limit=200`;
  let res: Response;
  try {
    res = await fetch(api);
  } catch (err) {
    throw new AppleMusicError(`Apple lookup failed: ${err instanceof Error ? err.message : err}`);
  }
  if (!res.ok) throw new AppleMusicError(`Apple lookup failed: HTTP ${res.status}`);
  const json = (await res.json()) as { resultCount?: number; results?: ItunesResult[] };
  const results = json.results ?? [];
  if (results.length === 0) throw new AppleMusicError('Apple Music returned nothing for that link.');

  // A specific song (either a /song/ link or ?i= on an album link).
  const song = results.find((r) => r.trackId?.toString() === id) ?? (kind === 'song' ? results.find((r) => r.trackName) : undefined);
  if (song && kind !== 'album' && kind !== 'playlist') {
    const t = toTrack(song);
    if (t) return [t];
  }

  // Album/playlist: every track, in order.
  const tracks = results.map(toTrack).filter((t): t is ResolvedAppleTrack => t !== null);
  if (tracks.length === 0) throw new AppleMusicError('That Apple Music release has no playable tracks listed.');
  return tracks;
}

/** YouTube match for an Apple track (playback path — Apple streams are DRM). */
export async function resolveApplePlayback(current: {
  name: string;
  artists?: string[];
  durationMs?: number;
}): Promise<ResolvedVideo | null> {
  const query = `${current.name} ${(current.artists ?? []).join(' ')}`.trim();
  return searchAndResolveYoutube(query, {
    name: current.name,
    artists: current.artists,
    durationMs: current.durationMs,
  });
}
