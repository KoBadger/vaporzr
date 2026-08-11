import { config } from './config.js';
import { tokenStore } from './tokenStore.js';

const AUTH_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API_URL = 'https://api.spotify.com/v1';

export class SpotifyError extends Error {
  constructor(
    message: string,
    public readonly status = 0,
  ) {
    super(message);
  }
}

let cachedAccessToken: string | null = null;
let cachedExpiresAt = 0;

function basicAuth(): string {
  return Buffer.from(`${config.spotifyClientId}:${config.spotifyClientSecret}`).toString('base64');
}

export async function getAccessToken(forceRefresh = false): Promise<string> {
  if (cachedAccessToken && Date.now() / 1000 < cachedExpiresAt - 60 && !forceRefresh) {
    return cachedAccessToken;
  }

  const stored = tokenStore.load();
  if (!stored?.refresh_token) {
    throw new SpotifyError('No Spotify account linked. Visit http://localhost:PORT/login to authorize.');
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: stored.refresh_token,
  });

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { Authorization: `Basic ${basicAuth()}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new SpotifyError(`Token refresh failed (${res.status}): ${text}`, res.status);
  }

  const data = (await res.json()) as { access_token: string; expires_in: number; refresh_token?: string };
  cachedAccessToken = data.access_token;
  cachedExpiresAt = Date.now() / 1000 + data.expires_in;

  tokenStore.save({
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? stored.refresh_token,
    expires_at: cachedExpiresAt * 1000,
  });

  return cachedAccessToken;
}

export function buildAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: config.spotifyClientId,
    response_type: 'code',
    redirect_uri: config.redirectUri,
    scope: [
      'streaming',
      'user-read-email',
      'user-read-private',
      'user-read-playback-state',
      'user-modify-playback-state',
      'user-read-currently-playing',
      'playlist-read-private',
    ].join(' '),
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

export async function exchangeCode(code: string): Promise<void> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.redirectUri,
  });

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { Authorization: `Basic ${basicAuth()}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new SpotifyError(`Code exchange failed (${res.status}): ${text}`, res.status);
  }

  const data = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number };
  cachedAccessToken = data.access_token;
  cachedExpiresAt = Date.now() / 1000 + data.expires_in;

  tokenStore.save({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: cachedExpiresAt * 1000,
  });
}

export interface ResolvedTrack {
  uri: string;
  name: string;
  artists: string[];
  album: string;
  durationMs: number;
  image?: string;
}

interface SpotifyTrack {
  uri: string;
  name: string;
  artists: { name: string }[];
  album: { name: string; images?: { url: string }[] };
  duration_ms: number;
}

function mapTrack(t: SpotifyTrack): ResolvedTrack {
  return {
    uri: t.uri,
    name: t.name,
    artists: t.artists.map((a) => a.name),
    album: t.album?.name ?? '',
    durationMs: t.duration_ms ?? 0,
    image: t.album?.images?.[0]?.url,
  };
}

/** GET helper that transparently retries once on 401 after refreshing the token. */
async function apiGet<T>(path: string, token: string): Promise<T> {
  const doGet = async (tok: string) =>
    fetch(`${API_URL}${path}`, { headers: { Authorization: `Bearer ${tok}` } });

  let res = await doGet(token);
  if (res.status === 401) {
    const fresh = await getAccessToken(true);
    res = await doGet(fresh);
  }
  if (!res.ok) throw new SpotifyError(`Spotify API error (${res.status})`, res.status);
  return (await res.json()) as T;
}

export async function searchTracks(query: string, limit = 10): Promise<ResolvedTrack[]> {
  const token = await getAccessToken();
  const data = await apiGet<{ tracks: { items: SpotifyTrack[] } }>(
    `/search?q=${encodeURIComponent(query)}&type=track&limit=${limit}`,
    token,
  );
  return data.tracks.items.map(mapTrack);
}

function isSpotifyUrl(input: string): boolean {
  return /^(spotify:|https?:\/\/(open\.)?spotify\.com\/)/.test(input);
}

export async function resolveTracks(input: string): Promise<ResolvedTrack[]> {
  if (!isSpotifyUrl(input)) {
    const results = await searchTracks(input, 1);
    if (results.length === 0) throw new SpotifyError('No tracks found.');
    return results;
  }

  const token = await getAccessToken();
  const idMatch = input.match(/(?:track|album|playlist|artist)[:/]([A-Za-z0-9]+)/);
  if (!idMatch) throw new SpotifyError('Could not parse Spotify URL.');
  const id = idMatch[1];

  if (/\/track\/|^spotify:track:/.test(input)) {
    const t = await apiGet<SpotifyTrack>(`/tracks/${id}`, token);
    return [mapTrack(t)];
  }

  let uris: string[] = [];
  if (/\/album\/|^spotify:album:/.test(input)) {
    const data = await apiGet<{ items: SpotifyTrack[] }>(`/albums/${id}/tracks?limit=50`, token);
    uris = data.items.map((t) => t.uri);
  } else if (/\/playlist\/|^spotify:playlist:/.test(input)) {
    const data = await apiGet<{ items: { track: SpotifyTrack | null }[] }>(
      `/playlists/${id}/tracks?limit=100`,
      token,
    );
    uris = data.items.filter((i) => i.track).map((i) => i.track!.uri);
  } else if (/\/artist\/|^spotify:artist:/.test(input)) {
    const data = await apiGet<{ tracks: SpotifyTrack[] }>(`/artists/${id}/top-tracks?country=US`, token);
    uris = data.tracks.map((t) => t.uri);
  } else {
    throw new SpotifyError('Unsupported Spotify link type.');
  }

  if (uris.length === 0) throw new SpotifyError('Nothing found in that link.');
  const tracks: ResolvedTrack[] = [];
  for (const trackUri of uris.slice(0, 50)) {
    const trackId = trackUri.split(':')[2];
    try {
      tracks.push(mapTrack(await apiGet<SpotifyTrack>(`/tracks/${trackId}`, token)));
    } catch {
      /* skip broken track */
    }
  }
  return tracks;
}
