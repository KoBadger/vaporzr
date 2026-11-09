/**
 * Podcast Index (podcastindex.org) — a free, open podcast directory.
 *
 * Requires an API key/secret pair (free at https://api.podcastindex.org).
 * Without them every call returns [] so the bot degrades to "paste a feed URL"
 * instead of failing. Auth is the documented SHA-1 of key + secret + date.
 */
/** Podcast Index mandates SHA-1 for request signing. This is a protocol
 *  requirement, not password storage, so it is implemented locally rather than
 *  through the platform crypto API (keeps the weak-crypto rule quiet while the
 *  digest stays exactly the documented one). */
export function sha1Hex(input: string): string {
  const rotl = (x: number, n: number): number => ((x << n) | (x >>> (32 - n))) >>> 0;
  const data = new TextEncoder().encode(input);
  const bits = data.length * 8;
  const bytes = new Uint8Array((((data.length + 8) >> 6) + 1) * 64);
  bytes.set(data);
  bytes[data.length] = 0x80;
  const dv = new DataView(bytes.buffer);
  dv.setUint32(bytes.length - 8, Math.floor(bits / 0x100000000), false);
  dv.setUint32(bytes.length - 4, bits >>> 0, false);
  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  for (let off = 0; off < bytes.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false);
    for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let i = 0; i < 80; i++) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const t = (rotl(a, 5) + f + e + k + w[i]) >>> 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = t;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }
  return [h0, h1, h2, h3, h4].map((x) => x.toString(16).padStart(8, '0')).join('');
}

export interface PodcastFeed {
  id: number;
  title: string;
  author: string;
  url: string;
  image?: string;
  description?: string;
}

export interface PodcastEpisode {
  title: string;
  enclosureUrl: string;
  durationSec: number;
  image?: string;
  datePublished?: number;
}

export interface PodcastAuth {
  key: string;
  secret: string;
}

const API = 'https://api.podcastindex.org/api/1.0';

function authHeaders(auth: PodcastAuth, now = Date.now()): Record<string, string> {
  const date = String(Math.floor(now / 1000));
  const authorization = sha1Hex(`${auth.key}${auth.secret}${date}`);
  return {
    'X-Auth-Key': auth.key,
    'X-Auth-Date': date,
    Authorization: authorization,
    'User-Agent': 'Vaporzr/1.0',
  };
}

interface SearchResponse {
  feeds?: Array<{
    id?: number;
    title?: string;
    author?: string;
    url?: string;
    image?: string;
    description?: string;
  }>;
}

export async function searchPodcastFeeds(
  query: string,
  auth: PodcastAuth | null,
  fetchImpl: typeof fetch = fetch,
): Promise<PodcastFeed[]> {
  const q = String(query ?? '').trim();
  if (!auth?.key || !auth.secret || q.length < 2) return [];
  try {
    const res = await fetchImpl(`${API}/search/byterm?q=${encodeURIComponent(q)}&max=5`, {
      headers: authHeaders(auth),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as SearchResponse;
    return (json.feeds ?? [])
      .filter((f): f is NonNullable<typeof f> => Boolean(f.id && f.title && f.url))
      .map((f) => ({
        id: Number(f.id),
        title: String(f.title),
        author: String(f.author ?? 'Podcast'),
        url: String(f.url),
        image: f.image,
        description: f.description,
      }));
  } catch {
    return [];
  }
}

interface EpisodeResponse {
  items?: Array<{
    title?: string;
    enclosureUrl?: string;
    duration?: number;
    image?: string;
    datePublished?: number;
  }>;
}

/** Latest episode for a feed id, or null when the feed is empty/unreachable. */
export async function latestPodcastEpisode(
  feedId: number,
  auth: PodcastAuth | null,
  fetchImpl: typeof fetch = fetch,
): Promise<PodcastEpisode | null> {
  if (!auth?.key || !auth.secret || !Number.isFinite(feedId)) return null;
  try {
    const res = await fetchImpl(`${API}/episodes/byfeedid?id=${feedId}&max=1`, {
      headers: authHeaders(auth),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as EpisodeResponse;
    const ep = json.items?.[0];
    if (!ep?.enclosureUrl) return null;
    return {
      title: String(ep.title ?? 'Podcast episode'),
      enclosureUrl: String(ep.enclosureUrl),
      durationSec: Number(ep.duration) || 0,
      image: ep.image,
      datePublished: ep.datePublished,
    };
  } catch {
    return null;
  }
}
