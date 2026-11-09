/**
 * Podcast Index (podcastindex.org) — a free, open podcast directory.
 *
 * Requires an API key/secret pair (free at https://api.podcastindex.org).
 * Without them every call returns [] so the bot degrades to "paste a feed URL"
 * instead of failing. Auth is the documented SHA-1 of key + secret + date.
 */
import crypto from 'node:crypto';

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
  const authorization = crypto.createHash('sha1').update(`${auth.key}${auth.secret}${date}`).digest('hex');
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
