import { config } from './config.js';
import { tokenStore } from './tokenStore.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { MediaSource } from '@vaporzr/shared';

const AUTH_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API_URL = 'https://api.spotify.com/v1';

export class SpotifyError extends Error {
  constructor(
    message: string,
    public readonly status = 0,
    /** Seconds Spotify asked us to wait (from Retry-After). */
    public readonly retryAfter?: number,
  ) {
    super(message);
  }
}

let cachedAccessToken: string | null = null;
let cachedExpiresAt = 0;
/** Shared app-token cooldown. All Spotify API paths honor the same 429 window. */
let spotifyCooldownUntil = 0;

function retryAfterSeconds(res: Response): number {
  const value = Number(res.headers.get('retry-after'));
  return Number.isFinite(value) && value > 0 ? value : 60;
}

function noteSpotifyRateLimit(res: Response): number {
  const wait = retryAfterSeconds(res);
  spotifyCooldownUntil = Math.max(spotifyCooldownUntil, Date.now() + wait * 1000);
  return wait;
}

function throwIfSpotifyCooling(): void {
  const remaining = spotifyCooldownUntil - Date.now();
  if (remaining <= 0) return;
  const wait = Math.max(1, Math.ceil(remaining / 1000));
  throw new SpotifyError(`Spotify is rate-limited — pausing requests for ${wait}s.`, 429, wait);
}

function basicAuth(): string {
  return Buffer.from(`${config.spotifyClientId}:${config.spotifyClientSecret}`).toString('base64');
}

const FETCH_TIMEOUT_MS = 10_000;

/** fetch with a hard timeout so a hung network can't stall a command forever. */
async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  timer.unref?.();
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new SpotifyError('Spotify request timed out — check your internet connection.');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const CACHE_FILE = path.join(config.dataDir, 'spotify-cache.json');
const RESOLVE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SEARCH_TTL_MS = 12 * 60 * 60 * 1000;
/** Max cache entries to prevent unbounded memory growth. */
const CACHE_MAX_ENTRIES = 5000;
/** How often to prune expired/old entries (ms). */
const CACHE_PRUNE_INTERVAL_MS = 5 * 60 * 1000;

interface CacheEntry {
  at: number;
  ttlMs: number;
  value: unknown;
}

/** Persistent (on-disk) cache so repeated lookups stop consuming the daily API quota. */
const cache = new Map<string, CacheEntry>();
let cacheLoaded = false;
let cacheWriteTimer: NodeJS.Timeout | null = null;
let cachePruneTimer: NodeJS.Timeout | null = null;

async function loadCache(): Promise<void> {
  if (cacheLoaded) return;
  cacheLoaded = true;
  try {
    const raw = await fs.readFile(CACHE_FILE, 'utf8');
    const data = JSON.parse(raw) as Record<string, CacheEntry>;
    const now = Date.now();
    for (const [key, entry] of Object.entries(data)) {
      if (entry && now - entry.at < entry.ttlMs) cache.set(key, entry);
    }
  } catch {
    // First run (or corrupt file) — start empty.
  }
  // Start periodic prune to bound memory and disk usage.
  cachePruneTimer = setInterval(() => pruneCache(), CACHE_PRUNE_INTERVAL_MS);
  cachePruneTimer.unref?.();
}

function cacheGet<T>(key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at >= entry.ttlMs) {
    cache.delete(key);
    return null;
  }
  return entry.value as T;
}

function cacheSet(key: string, value: unknown, ttlMs = RESOLVE_TTL_MS): void {
  // Enforce max entries by evicting oldest non-expired entries.
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const now = Date.now();
    let evicted = 0;
    for (const [k, entry] of cache.entries()) {
      if (now - entry.at >= entry.ttlMs) {
        cache.delete(k);
        evicted++;
      }
      if (evicted >= 50) break;
    }
    // If still full, evict oldest regardless of TTL.
    if (cache.size >= CACHE_MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest) cache.delete(oldest);
    }
  }
  cache.set(key, { at: Date.now(), ttlMs, value });
  if (cacheWriteTimer) clearTimeout(cacheWriteTimer);
  cacheWriteTimer = setTimeout(() => void persistCache(), 2000);
  cacheWriteTimer!.unref?.();
}

function pruneCache(): void {
  const now = Date.now();
  let removed = 0;
  for (const [key, entry] of cache.entries()) {
    if (now - entry.at >= entry.ttlMs) {
      cache.delete(key);
      removed++;
    }
  }
  // If still over limit, evict oldest entries.
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (!oldest) break;
    cache.delete(oldest);
    removed++;
  }
  if (removed > 0) {
    console.log(`[spotify] cache pruned: removed ${removed} entries, ${cache.size} remain`);
    void persistCache();
  }
}

async function persistCache(): Promise<void> {
  try {
    await fs.mkdir(config.dataDir, { recursive: true });
    await fs.writeFile(CACHE_FILE, JSON.stringify(Object.fromEntries(cache)), 'utf8');
  } catch {
    // Cache is best-effort; never let persistence crash a command.
  }
}

// ---------- Per-endpoint token-bucket rate limiter ----------
/**
 * Token bucket per API surface so search/album/track recommendations don't
 * cascade into a single 429 lock on the dev-mode app quota.
 */
class RateLimiter {
  private buckets: Map<string, { tokens: number; lastRefill: number }>;
  private readonly refillRate = 1; // token per second
  private readonly bucketSize = 5; // max tokens per bucket

  constructor() {
    this.buckets = new Map();
  }

  /** Get (or create) a bucket for the given endpoint key. */
  private bucket(key: string): { tokens: number; lastRefill: number } {
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.bucketSize, lastRefill: Date.now() };
      this.buckets.set(key, b);
    }
    return b;
  }

  /** Refill tokens based on elapsed time. */
  private refill(b: { tokens: number; lastRefill: number }): void {
    const now = Date.now();
    const elapsed = (now - b.lastRefill) / 1000; // seconds
    if (elapsed > 0) {
      const refillCount = Math.min(this.bucketSize - b.tokens, Math.floor(elapsed * this.refillRate));
      b.tokens = Math.min(this.bucketSize, b.tokens + refillCount);
      b.lastRefill = now;
    }
  }

  /** Wait until a token is available, then consume one. Returns waitMs (0 if immediate). */
  async wait(key: string): Promise<number> {
    const b = this.bucket(key);
    this.refill(b);
    if (b.tokens > 0) {
      b.tokens--;
      return 0;
    }
    // Calculate how long until a token refills.
    const waitSec = 1 / this.refillRate; // 1 second per token
    const waitMs = Math.ceil(waitSec * 1000);
    await new Promise((r) => setTimeout(r, waitMs));
    // Retry after waiting.
    return await this.wait(key);
  }
}

export const rateLimit = new RateLimiter();
/** Live size of the persistent resolve/search cache (for /health metrics). */
export function spotifyCacheSize(): number {
  return cache.size;
}
//
// End rate limiter.
//
export async function getAccessToken(forceRefresh = false): Promise<string> {
  if (cachedAccessToken && Date.now() / 1000 < cachedExpiresAt - 60 && !forceRefresh) {
    return cachedAccessToken;
  }

  const stored = tokenStore.load();
  if (!stored?.refresh_token) {
    const loginUrl = config.staticBaseUrl ? `${config.staticBaseUrl}/login` : 'http://localhost:' + (process.env.PORT || 4876) + '/login';
    throw new SpotifyError(`No Spotify account linked. Visit ${loginUrl} to authorize.`);
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: stored.refresh_token,
  });

  const res = await fetchWithTimeout(TOKEN_URL, {
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

  const res = await fetchWithTimeout(TOKEN_URL, {
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
  source: MediaSource;
  /** Pre-resolved stream URL (YouTube, SoundCloud, Suno). Avoids a second yt-dlp call. */
  streamUrl?: string;
  /** Estimated Spotify-style features for sources without a real analysis
   *  (e.g. Deezer). Lets the wave score off-source candidates musically. */
  estimatedFeatures?: AudioFeatures;
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
    source: 'spotify',
  };
}

/** Score a search result by how closely its name matches the query (lower = better). */
function scoreSearchResult(name: string, query: string): number {
  const n = name.toLowerCase().trim();
  if (n === query) return 0;                     // exact match
  if (n.startsWith(query)) return 1;              // starts with query
  if (n.includes(query)) return 2;                // contains query
  // Fuzzy: count how many query words appear in the name.
  const qWords = query.split(/\s+/);
  const matchCount = qWords.filter((w) => n.includes(w)).length;
  return 3 + (qWords.length - matchCount);        // fewer missing words = better
}

/** Words that mark a track as a variant (remix/edit/live/movie version…) rather
 *  than the canonical release. Mirrors the EW engine's marker list. */
const VERSION_MARKER_RE =
  /\b(remix|edit|vip|bootleg|flip|dub|radio edit|extended|club mix|sped up|slowed|reverb|nightcore|mashup|movie version|film version|motion picture|end credits|end title|closing credits|soundtrack version|soundtrack|ost|single version|album version|bonus track|deluxe|remastered|remaster|digital master|digital remaster|anniversary edition|clean|explicit|radio version|video version|live|acoustic|cover|unplugged|demo|instrumental|a cappella)\b/i;

/** Strip parenthesized/bracketed segments and trailing dash version markers so
 *  "Nightcall (Emmit Fenn Remix)" reduces to "nightcall". A leading year is
 *  tolerated: " - 2020 Digital Master" counts as a version marker too. */
function stripVersionSegments(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s*[\(\[][^\)\]]*[\)\]]\s*/g, ' ')
    .replace(/\s*[-–—]\s*(?:\d{4}\s+)?(?:digital\s+)?(?:remastered|remaster|master)\b.*$/g, ' ')
    .replace(/\s*[-–—]\s*(remix|edit|vip|bootleg|live|acoustic|cover|slowed|sped|version|mix|instrumental|a cappella|radio|extended|clean|explicit|ost|soundtrack|deluxe|demo|unplugged)\b.*$/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Rank search results for a free-text play query (lower = better).
 *  Beyond plain name matching this penalizes version variants (remixes, edits,
 *  movie versions…) when the user didn't ask for one, and boosts tracks whose
 *  artist appears in the query — so "nightcall kavinsky" returns the original,
 *  not a remix. */
function scorePlayResult(track: ResolvedTrack, query: string): number {
  const q = query.toLowerCase().trim();
  const n = track.name.toLowerCase().trim();
  let s = scoreSearchResult(n, q);
  const core = stripVersionSegments(n);
  if (core && core !== n && VERSION_MARKER_RE.test(n)) {
    if (!VERSION_MARKER_RE.test(q)) s += 6;       // variant the user didn't ask for
    else if (q.includes(core) || core.includes(q)) s -= 3; // asked for a variant of THIS song
  }
  if (track.artists.some((a) => a && q.includes(a.toLowerCase().trim()))) s -= 4;
  if (core === q || n === q) s -= 5;
  return s;
}

/** GET helper that transparently retries once on 401 after refreshing the token. */
async function apiGet<T>(path: string, token: string): Promise<T> {
  const waitMs = await rateLimit.wait(`get:${path}`);
  if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
  throwIfSpotifyCooling();
  const doGet = async (tok: string) =>
    fetchWithTimeout(`${API_URL}${path}`, { headers: { Authorization: `Bearer ${tok}` } });

  let res = await doGet(token);
  if (res.status === 401) {
    const fresh = await getAccessToken(true);
    res = await doGet(fresh);
  }
  if (res.status === 429) {
    const wait = noteSpotifyRateLimit(res);
    // Also update the per-endpoint bucket so it stays in sync.
    await rateLimit.wait(`get:${path}`);
    throw new SpotifyError(`Spotify API rate-limited — try again in about ${Math.max(1, Math.ceil(wait / 60))} min.`, 429, wait);
  }
  if (!res.ok) throw new SpotifyError(`Spotify API error (${res.status})`, res.status);
  return (await res.json()) as T;
}

const ANON_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
/** Embed pages return at most this many tracks; at this count we suspect truncation. */
const EMBED_CAP = 100;

interface EmbedTrack {
  uri: string;
  title?: string;
  subtitle?: string;
  duration?: number;
}

interface EmbedEntity {
  name?: string;
  uri?: string;
  title?: string;
  artists?: { name: string }[];
  duration?: number;
  trackList?: EmbedTrack[];
  coverArt?: { sources?: { url?: string }[] };
  visualIdentity?: { image?: { url?: string }[] };
}

/**
 * Scrape Spotify's public embed page (the same JSON the embedded player renders)
 * for a track/album/playlist/artist. Requires no auth and consumes no app quota.
 * Returns null when unavailable so callers fall back to the OAuth API.
 */
async function fetchEmbedEntity(type: 'track' | 'album' | 'playlist' | 'artist', id: string): Promise<EmbedEntity | null> {
  if (!config.spotifyUseAnonymous) return null;
  try {
    const res = await fetchWithTimeout(`https://open.spotify.com/embed/${type}/${id}`, {
      headers: { 'User-Agent': ANON_USER_AGENT },
    });
    if (!res.ok) return null;
    const html = await res.text();
    const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    if (!m) return null;
    const data = JSON.parse(m[1]) as { props?: { pageProps?: { state?: { data?: { entity?: EmbedEntity } } } } };
    return data.props?.pageProps?.state?.data?.entity ?? null;
  } catch {
    return null;
  }
}

function embedImage(entity: EmbedEntity): string | undefined {
  return entity.coverArt?.sources?.[0]?.url ?? entity.visualIdentity?.image?.[0]?.url;
}

function mapEmbedCollection(entity: EmbedEntity, albumOverride?: string): ResolvedTrack[] {
  const image = embedImage(entity);
  return (entity.trackList ?? []).map((t) => ({
    uri: t.uri,
    name: t.title ?? '',
    artists: (t.subtitle ?? '').split(', ').filter(Boolean),
    album: albumOverride ?? entity.name ?? '',
    durationMs: t.duration ?? 0,
    image,
    source: 'spotify',
  }));
}

const SERVER_TIME_URL = 'https://open.spotify.com/api/server-time';
const WEB_TOKEN_URL = 'https://open.spotify.com/api/token';
const ANON_TOKEN_URL = 'https://open.spotify.com/get_access_token?reason=transport&productType=web_player';
let cachedWebToken: { token: string; expiresAt: number } | null = null;

function webTotpSecret(): Buffer {
  const bytes = config.spotifyTotpSecret
    .split(',')
    .map((n) => Number(n.trim()))
    .filter((n) => Number.isFinite(n));
  return Buffer.from(bytes);
}

/** RFC 4226 HOTP (6 digits) — Spotify's web-player token endpoint uses this. */
function hotp6(secret: Buffer, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', secret).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin =
    ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(bin % 1_000_000).padStart(6, '0');
}

/**
 * Mint a web-player session token from the user's sp_dc cookie. This is the same
 * auth Spotify's own web player uses — it can read ANY public playlist in full
 * and consumes no dev-mode quota. Returns null when unavailable so callers fall
 * back to the embed scrape / OAuth paths.
 */
async function getWebPlayerToken(): Promise<string | null> {
  if (!config.spotifySpDc) return null;
  if (cachedWebToken && Date.now() < cachedWebToken.expiresAt - 60_000) return cachedWebToken.token;
  const headers = { 'User-Agent': ANON_USER_AGENT, Cookie: `sp_dc=${config.spotifySpDc}` };
  try {
    // 1. The plain token endpoint (works when Spotify hasn't rotated the flow).
    const simple = await fetchWithTimeout(ANON_TOKEN_URL, { headers });
    if (simple.ok) {
      const d = (await simple.json()) as { accessToken?: string; accessTokenExpirationTimestampMs?: number };
      if (d.accessToken) {
        cachedWebToken = { token: d.accessToken, expiresAt: d.accessTokenExpirationTimestampMs ?? Date.now() + 30 * 60 * 1000 };
        return cachedWebToken.token;
      }
    }
    // 2. TOTP-protected endpoint (current flow).
    const stRes = await fetchWithTimeout(SERVER_TIME_URL, { headers: { 'User-Agent': ANON_USER_AGENT } });
    if (!stRes.ok) return null;
    const { serverTime } = (await stRes.json()) as { serverTime: number };
    const nowSec = Math.floor(Date.now() / 1000);
    const code = hotp6(webTotpSecret(), Math.floor(nowSec / 30));
    const url = `${WEB_TOKEN_URL}?reason=init&productType=web-player&totp=${code}&totpServer=${code}&totpVer=${config.spotifyTotpVer}&sTime=${serverTime}&cTime=${nowSec * 1000}&buildVer=unknown&buildDate=unknown`;
    const res = await fetchWithTimeout(url, { headers });
    if (!res.ok) return null;
    const d = (await res.json()) as { accessToken?: string; accessTokenExpirationTimestampMs?: number };
    if (!d.accessToken) return null;
    cachedWebToken = { token: d.accessToken, expiresAt: d.accessTokenExpirationTimestampMs ?? Date.now() + 30 * 60 * 1000 };
    return cachedWebToken.token;
  } catch {
    return null;
  }
}

const PARTNER_API = 'https://api-partner.spotify.com/pathfinder/v1/query';

/**
 * Free-text search through the web-player token (same auth Spotify's own web
 * player uses, minted from the sp_dc cookie). Consumes no dev-mode app quota,
 * so ordinary `V@p "song name"` requests stop hitting the 429 quota lock.
 * Returns null on any failure so callers fall back to the OAuth path.
 */
async function searchTracksAnonymous(query: string, limit: number): Promise<ResolvedTrack[] | null> {
  const token = await getWebPlayerToken();
  if (!token) return null;
  const variables = JSON.stringify({
    searchTerm: query,
    offset: 0,
    limit: Math.min(limit, 50),
    numberOfTopResults: 5,
    includeAudiobooks: false,
  });
  const url = `${PARTNER_API}?operationName=searchDesktop&variables=${encodeURIComponent(variables)}`;
  try {
    const res = await fetchWithTimeout(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        'App-Platform': 'WebPlayer',
        'Content-Type': 'application/json',
      },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      data?: { searchV2?: { tracksV2?: { items?: Array<{ item?: { data?: {
        uri?: string;
        name?: string;
        artists?: { items?: Array<{ profile?: { name?: string } }> };
        albumOfTrack?: { name?: string; coverArt?: { sources?: Array<{ url?: string }> } };
        duration?: { totalMilliseconds?: number };
      } } }> } } };
    };
    const items = json.data?.searchV2?.tracksV2?.items ?? [];
    const out: ResolvedTrack[] = [];
    for (const it of items) {
      const d = it.item?.data;
      if (!d?.uri) continue;
      out.push({
        uri: d.uri,
        name: d.name ?? '',
        artists: (d.artists?.items ?? []).map((a) => a?.profile?.name).filter((n): n is string => !!n),
        album: d.albumOfTrack?.name ?? '',
        durationMs: d.duration?.totalMilliseconds ?? 0,
        image: d.albumOfTrack?.coverArt?.sources?.[0]?.url,
        source: 'spotify',
      });
    }
    return out.length ? out : null;
  } catch {
    return null;
  }
}

export async function searchTracks(query: string, limit = 10): Promise<ResolvedTrack[]> {
  await loadCache();
  const key = `search:${query.toLowerCase().trim()}:${limit}`;
  const cached = cacheGet<ResolvedTrack[]>(key);
  if (cached) return cached;

  // Quota-free web-player search first (the "long ago" workaround) — no app
  // quota consumed. The OAuth /search call below only runs if that's missing
  // or disabled via SPOTIFY_ANON_SEARCH=off.
  if (config.spotifyAnonSearch) {
    const anon = await searchTracksAnonymous(query, limit);
    if (anon) {
      cacheSet(key, anon, SEARCH_TTL_MS);
      return anon;
    }
    if (config.spotifySpDc) warnWebTokenUnavailable();
  }

  const token = await getAccessToken();
  const data = await apiGet<{ tracks: { items: SpotifyTrack[] } }>(
    `/search?q=${encodeURIComponent(query)}&type=track&limit=${limit}`,
    token,
  );
  const out = data.tracks.items.map(mapTrack);
  cacheSet(key, out, SEARCH_TTL_MS);
  return out;
}

let lastWebTokenWarnAt = 0;
/** Throttled warning when the web-player token is configured but unusable —
 *  usually a rotated/invalid sp_dc cookie or TOTP secret. */
function warnWebTokenUnavailable(): void {
  const now = Date.now();
  if (now - lastWebTokenWarnAt < 5 * 60 * 1000) return;
  lastWebTokenWarnAt = now;
  console.warn('[spotify] web-player search unavailable — refresh SPOTIFY_SP_DC (or SPOTIFY_TOTP_SECRET) to restore quota-free search');
}

function isSpotifyUrl(input: string): boolean {
  return /^(spotify:|https?:\/\/(open\.)?spotify\.com\/)/.test(input);
}

export async function resolveTracks(input: string): Promise<ResolvedTrack[]> {
  await loadCache();
  if (!isSpotifyUrl(input)) {
    const results = await searchTracks(input, 8);
    if (results.length === 0) throw new SpotifyError('No tracks found.');
    // Rank by play-intent quality: exact match > artist-confirmed title >
    // contains > fuzzy, with version variants (remixes/movie versions) penalized.
    const q = input.toLowerCase().trim();
    results.sort((a, b) => scorePlayResult(a, q) - scorePlayResult(b, q));
    return [results[0]];
  }

  const idMatch = input.match(/(?:track|album|playlist|artist)[:/]([A-Za-z0-9]+)/);
  if (!idMatch) throw new SpotifyError('Could not parse Spotify URL.');
  const id = idMatch[1];

  if (/\/track\/|^spotify:track:/.test(input)) {
    const cached = cacheGet<ResolvedTrack[]>(`track:${id}`);
    if (cached) return cached;

    const anon = await fetchEmbedEntity('track', id);
    let out: ResolvedTrack[] | null = null;
    if (anon?.uri && anon.title) {
      out = [
        {
          uri: anon.uri,
          name: anon.title,
          artists: (anon.artists ?? []).map((a) => a.name),
          album: '',
          durationMs: anon.duration ?? 0,
          image: embedImage(anon),
          source: 'spotify',
        },
      ];
    }
    if (!out) out = [mapTrack(await apiGet<SpotifyTrack>(`/tracks/${id}`, await getAccessToken()))];
    cacheSet(`track:${id}`, out);
    return out;
  }

  if (/\/album\/|^spotify:album:/.test(input)) {
    const cached = cacheGet<ResolvedTrack[]>(`album:${id}`);
    if (cached) return cached;

    // Embed scrape is free; when it hits the ~100-track cap the album may be
    // longer, so extend it via OAuth (albums still resolve fine on this app).
    const anon = await fetchEmbedEntity('album', id);
    let out = anon?.trackList?.length ? mapEmbedCollection(anon) : null;
    if (out && out.length >= EMBED_CAP && !cacheGet<boolean>(`nofull:album:${id}`)) {
      const full = await collectionViaOAuth<SpotifyTrack>(`/albums/${id}/tracks?limit=50&offset={offset}`, (item) => mapTrack(item));
      if (full) out = full;
      else cacheSet(`nofull:album:${id}`, true);
    }
    if (!out) {
      out = await paginateSpotify<SpotifyTrack>(`/albums/${id}/tracks?limit=50&offset={offset}`, (item) => mapTrack(item));
    }
    cacheSet(`album:${id}`, out);
    return out;
  }

  if (/\/playlist\/|^spotify:playlist:/.test(input)) {
    const cached = cacheGet<ResolvedTrack[]>(`playlist:${id}`);
    if (cached) return cached;

    // 1. Full resolution through the web-player session (sp_dc): works for ANY
    //    playlist (owned or not), full length, zero dev quota.
    let out = config.spotifySpDc ? await resolvePlaylistWeb(id) : null;

    // 2. Free embed scrape (up to ~100 tracks). If it hits the cap the playlist
    //    may be longer, so try OAuth /items (full length for playlists the user
    //    owns or collaborates on) and cache the negative result so we don't
    //    waste quota re-attempting non-accessible playlists.
    if (!out) {
      const anon = await fetchEmbedEntity('playlist', id);
      out = anon?.trackList?.length ? mapEmbedCollection(anon) : null;
      if (out && out.length >= EMBED_CAP && !cacheGet<boolean>(`nofull:playlist:${id}`)) {
        const full = await collectionViaOAuth<{ item?: SpotifyTrack | null; track?: SpotifyTrack | null }>(
          `/playlists/${id}/items?limit=100&offset={offset}`,
          (item) => {
            const t = item.item ?? item.track;
            if (!t) return null;
            return mapTrack(t);
          },
        );
        if (full) out = full;
        else cacheSet(`nofull:playlist:${id}`, true);
      }
    }

    // 3. OAuth fallback (full length for owned playlists).
    if (!out) {
      out = await collectionViaOAuthThrow<{ item?: SpotifyTrack | null; track?: SpotifyTrack | null }>(
        `/playlists/${id}/items?limit=100&offset={offset}`,
        (item) => {
          const t = item.item ?? item.track;
          if (!t) return null;
          return mapTrack(t);
        },
      );
    }
    cacheSet(`playlist:${id}`, out);
    return out;
  }

  if (/\/artist\/|^spotify:artist:/.test(input)) {
    const cached = cacheGet<ResolvedTrack[]>(`artist:${id}`);
    if (cached) return cached;

    const anon = await fetchEmbedEntity('artist', id);
    let out = anon?.trackList?.length ? mapEmbedCollection(anon, '') : null;
    if (!out) {
      const data = await apiGet<{ tracks: SpotifyTrack[] }>(`/artists/${id}/top-tracks?country=US`, await getAccessToken());
      out = data.tracks.map(mapTrack);
    }
    cacheSet(`artist:${id}`, out);
    return out;
  }

  throw new SpotifyError('Unsupported Spotify link type.');
}

/**
 * Walk every page of a paginated Spotify collection endpoint and map each item
 * to a track, so extremely long playlists/albums resolve in full.
 * The `{offset}` placeholder in `path` is replaced with the page offset.
 */
async function paginateRaw<T>(path: string, token: string, map: (item: T) => ResolvedTrack | null, limit = 100): Promise<ResolvedTrack[]> {
  const out: ResolvedTrack[] = [];
  let offset = 0;
  let total = Number.POSITIVE_INFINITY;
  while (offset < total && offset < 10_000) {
    const res = await fetchWithTimeout(`${API_URL}${path.replace('{offset}', String(offset))}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new SpotifyError(`Spotify API error (${res.status})`, res.status);
    const data = (await res.json()) as { items: T[]; total?: number; next?: string | null };
    if (data.total !== undefined) total = data.total;
    if (!data.items || data.items.length === 0) break;
    for (const item of data.items) {
      const t = map(item);
      if (t) out.push(t);
    }
    offset += data.items.length;
    if (data.items.length < limit) break;
  }
  if (out.length === 0) throw new SpotifyError('Nothing found in that link.');
  return out;
}

/** Paginate using the user's OAuth token (throws on 404). */
async function paginateSpotify<T>(path: string, map: (item: T) => ResolvedTrack | null, limit = 100): Promise<ResolvedTrack[]> {
  return paginateRaw(path, await getAccessToken(), map, limit);
}

/** Paginate with OAuth; returns null on failure (e.g. 404 for non-owned playlists). */
async function collectionViaOAuth<T>(path: string, map: (item: T) => ResolvedTrack | null, limit = 100): Promise<ResolvedTrack[] | null> {
  try {
    return await paginateSpotify(path, map, limit);
  } catch {
    return null;
  }
}

/** Paginate with OAuth; throws on failure. */
async function collectionViaOAuthThrow<T>(path: string, map: (item: T) => ResolvedTrack | null, limit = 100): Promise<ResolvedTrack[]> {
  return paginateSpotify(path, map, limit);
}

/** Full playlist resolution through the web-player session token (sp_dc). Null when unavailable. */
async function resolvePlaylistWeb(id: string): Promise<ResolvedTrack[] | null> {
  const token = await getWebPlayerToken();
  if (!token) return null;
  try {
    return await paginateRaw<{ item?: SpotifyTrack | null; track?: SpotifyTrack | null }>(
      `/playlists/${id}/items?limit=100&offset={offset}`,
      token,
      (item) => {
        const t = item.item ?? item.track;
        if (!t) return null;
        return mapTrack(t);
      },
    );
  } catch {
    return null;
  }
}

/** Raw Spotify Web API call for a device (uses the account token). */
async function apiRaw(method: 'GET' | 'PUT' | 'POST', path: string, body?: unknown): Promise<Response> {
  const waitMs = await rateLimit.wait(`raw:${path}`);
  if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
  throwIfSpotifyCooling();
  const token = await getAccessToken();
  const res = await fetchWithTimeout(`${API_URL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 429) noteSpotifyRateLimit(res);
  // Keep the per-endpoint bucket in sync.
  await rateLimit.wait(`raw:${path}`);
  return res;
}

/**
 * Issue a device control command. On 429 we honor Spotify's `Retry-After`
 * header: retry once only when the wait is short, otherwise fail fast with an
 * accurate estimate (the daily development-mode quota is what causes these).
 */
async function deviceCommand(method: 'GET' | 'PUT' | 'POST', path: string, body?: unknown): Promise<void> {
  let res = await apiRaw(method, path, body);
  if (res.status === 401) res = await apiRaw(method, path, body);
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('retry-after'));
    const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 60;
    if (wait <= 10) {
      await new Promise((r) => setTimeout(r, wait * 1000));
      res = await apiRaw(method, path, body);
    }
  }
  if (res.status === 404) throw new SpotifyError('Playback device is not active. Try /play again.', 404);
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('retry-after'));
    const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 60;
    const mins = Math.max(1, Math.ceil(wait / 60));
    throw new SpotifyError(
      `Spotify is rate-limited (app quota) — try again in about ${mins} min. Enable Extended Quota mode or use a new Spotify app to fix this permanently.`,
      429,
      wait,
    );
  }
  if (!res.ok && res.status !== 202) {
    const text = await res.text().catch(() => '');
    throw new SpotifyError(`Playback command failed (${res.status}): ${text.slice(0, 200)}`, res.status);
  }
}

export function spotifyPlay(deviceId: string, uris: string[]): Promise<void> {
  return deviceCommand('PUT', `/me/player/play?device_id=${encodeURIComponent(deviceId)}`, { uris });
}

export function spotifyPause(deviceId: string): Promise<void> {
  return deviceCommand('PUT', `/me/player/pause?device_id=${encodeURIComponent(deviceId)}`);
}

export function spotifyResume(deviceId: string): Promise<void> {
  return deviceCommand('PUT', `/me/player/play?device_id=${encodeURIComponent(deviceId)}`);
}

export function spotifySeek(deviceId: string, positionMs: number): Promise<void> {
  return deviceCommand('PUT', `/me/player/seek?position_ms=${Math.round(positionMs)}&device_id=${encodeURIComponent(deviceId)}`);
}

export function spotifySetVolume(deviceId: string, volumePercent: number): Promise<void> {
  return deviceCommand('PUT', `/me/player/volume?volume_percent=${Math.round(volumePercent)}&device_id=${encodeURIComponent(deviceId)}`);
}

export function spotifySetShuffle(deviceId: string, shuffle: boolean): Promise<void> {
  return deviceCommand('PUT', `/me/player/shuffle?state=${shuffle}&device_id=${encodeURIComponent(deviceId)}`);
}

/* ---------- Endless Wave: audio features + recommendations ---------- */

export interface AudioFeatures {
  danceability: number;
  energy: number;
  valence: number;
  tempo: number;
  acousticness: number;
  instrumentalness: number;
  liveness: number;
  speechiness: number;
  key: number;
  mode: number;
  time_signature: number;
  duration_ms: number;
}

/** Batch-fetch audio features for up to 100 Spotify track IDs. */
export async function getAudioFeatures(trackIds: string[]): Promise<Map<string, AudioFeatures>> {
  await loadCache();
  const out = new Map<string, AudioFeatures>();
  if (trackIds.length === 0) return out;
  const uniqueIds = [...new Set(trackIds)];
  const missing: string[] = [];
  for (const id of uniqueIds) {
    const cached = cacheGet<AudioFeatures>(`features:${id}`);
    if (cached) out.set(id, cached);
    else missing.push(id);
  }
  if (missing.length === 0) return out;
  throwIfSpotifyCooling();
  const token = await getAccessToken();
  // Spotify batches in chunks of 100.
  for (let i = 0; i < missing.length; i += 100) {
    const chunk = missing.slice(i, i + 100);
    const res = await fetchWithTimeout(
      `${API_URL}/audio-features?ids=${chunk.join(',')}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
     if (res.status === 429) {
       const wait = noteSpotifyRateLimit(res);
       throw new SpotifyError(`Spotify API rate-limited — try again in about ${Math.max(1, Math.ceil(wait / 60))} min.`, 429, wait);
     }
     if (!res.ok) break;
    const data = (await res.json()) as { audio_features: (AudioFeatures | null)[] };
    for (let j = 0; j < chunk.length; j++) {
      const af = data.audio_features?.[j];
       if (af) {
         out.set(chunk[j], af);
         cacheSet(`features:${chunk[j]}`, af, 7 * 24 * 60 * 60 * 1000);
       }
    }
  }
  return out;
}

/** Extract a Spotify track ID from a URI or URL. */
export function extractSpotifyId(input: string): string | null {
  const m = input.match(/(?:track[:/]|open\.spotify\.com\/track\/)([A-Za-z0-9]{22})/);
  return m?.[1] ?? null;
}

export interface RecommendationParams {
  seedTracks?: string[];
  seedArtists?: string[];
  seedGenres?: string[];
  targetEnergy?: number;
  targetTempo?: number;
  targetValence?: number;
  targetDanceability?: number;
  targetAcousticness?: number;
  targetInstrumentalness?: number;
  minTempo?: number;
  maxTempo?: number;
  limit?: number;
}

/** Fetch recommendations from Spotify's /recommendations endpoint.
 *  Cached by seed set (the expensive, quota-limited part) for a short window so
 *  repeated Endless Wave refills over the same context don't re-drain the app
 *  quota — which is exactly what triggers the multi-hour 429 lock. */
export async function getRecommendations(params: RecommendationParams): Promise<ResolvedTrack[]> {
  const seeds = [
    ...(params.seedTracks ?? []),
    ...(params.seedArtists ?? []),
    ...(params.seedGenres ?? []),
  ].sort().join(',');
  if (seeds) {
    const cached = cacheGet<ResolvedTrack[]>(`recs:${seeds}`);
    if (cached) return cached;
  }
  const token = await getAccessToken();
  const q = new URLSearchParams();
  if (params.seedTracks?.length) q.set('seed_tracks', params.seedTracks.slice(0, 5).join(','));
  if (params.seedArtists?.length) q.set('seed_artists', params.seedArtists.slice(0, 5).join(','));
  if (params.seedGenres?.length) q.set('seed_genres', params.seedGenres.slice(0, 5).join(','));
  if (params.targetEnergy !== undefined) q.set('target_energy', String(params.targetEnergy));
  if (params.targetTempo !== undefined) q.set('target_tempo', String(params.targetTempo));
  if (params.targetValence !== undefined) q.set('target_valence', String(params.targetValence));
  if (params.targetDanceability !== undefined) q.set('target_danceability', String(params.targetDanceability));
  if (params.targetAcousticness !== undefined) q.set('target_acousticness', String(params.targetAcousticness));
  if (params.targetInstrumentalness !== undefined) q.set('target_instrumentalness', String(params.targetInstrumentalness));
  if (params.minTempo !== undefined) q.set('min_tempo', String(params.minTempo));
  if (params.maxTempo !== undefined) q.set('max_tempo', String(params.maxTempo));
  q.set('limit', String(params.limit ?? 20));

  const data = await apiGet<{ tracks: SpotifyTrack[] }>(`/recommendations?${q}`, token);
  const out = (data.tracks ?? []).map(mapTrack);
  if (seeds) cacheSet(`recs:${seeds}`, out, 10 * 60 * 1000);
  return out;
}
