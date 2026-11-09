/**
 * Audius (audius.co) — free, legal, keyless music streaming.
 *
 * A track page is resolved through the public API, and the stream endpoint is
 * handed to the normal direct-media player (it 302s to the CDN, which the
 * guarded fetch follows).
 */

export interface AudiusTrack {
  id: string;
  title: string;
  artist: string;
  durationMs: number;
  image?: string;
  streamUrl: string;
  url: string;
}

const APP = 'Vaporzr';

export function isAudiusUrl(input: string): boolean {
  try {
    const u = new URL(input);
    if (u.hostname !== 'audius.co' && !u.hostname.endsWith('.audius.co')) return false;
    return u.pathname.split('/').filter(Boolean).length >= 2;
  } catch {
    return false;
  }
}

interface ResolveResponse {
  data?: {
    id?: string;
    title?: string;
    duration?: number;
    artwork?: { '480x480'?: string; '150x150'?: string };
    user?: { name?: string };
  };
}

/** Resolve an audius.co track permalink. Throws on a non-track/invalid link. */
export async function resolveAudius(input: string, fetchImpl: typeof fetch = fetch): Promise<AudiusTrack> {
  const res = await fetchImpl(`https://api.audius.co/v1/resolve?url=${encodeURIComponent(input)}&app_name=${APP}`, {
    headers: { 'User-Agent': 'Vaporzr/1.0' },
    signal: AbortSignal.timeout(9000),
  });
  if (!res.ok) throw new Error(`Audius returned HTTP ${res.status}`);
  const json = (await res.json()) as ResolveResponse;
  const d = json.data;
  if (!d?.id) throw new Error('That Audius link is not a track.');
  return {
    id: String(d.id),
    title: String(d.title ?? 'Audius track'),
    artist: String(d.user?.name ?? 'Audius'),
    durationMs: Math.max(0, Number(d.duration) || 0) * 1000,
    image: d.artwork?.['480x480'] ?? d.artwork?.['150x150'],
    streamUrl: `https://api.audius.co/v1/tracks/${encodeURIComponent(d.id)}/stream?app_name=${APP}`,
    url: input,
  };
}
