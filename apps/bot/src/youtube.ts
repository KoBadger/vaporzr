import { execFile } from 'node:child_process';
import { config } from './config.js';
import type { ResolvedTrack } from './spotify.js';

export class YoutubeError extends Error {}

export interface ResolvedVideo extends ResolvedTrack {
  videoId: string;
  streamUrl: string;
  channel: string;
  thumbnail?: string;
}

const YT_WATCH_RE = /(?:youtube\.com\/(?:watch\?.*v=|shorts\/|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/;
const YT_PLAYLIST_RE = /(?:youtube\.com|music\.youtube\.com)\/playlist\?(?:[^#]*&)?list=([A-Za-z0-9_-]+)/;

/**
 * Audio-first format selection: the bot only plays audio, and YouTube
 * currently serves 403s for the combined video+audio format (itag 18)
 * while audio-only formats (itag 251/140, …) download normally.
 */
const AUDIO_FORMAT = 'bestaudio[acodec!=none]/best[acodec!=none]/best';

export function isYoutubeUrl(input: string): boolean {
  return /(^|[./])youtube\.com\//.test(input) || /(^|[./])youtu\.be\//.test(input) || /(^|[./])music\.youtube\.com\//.test(input);
}

export function isYoutubePlaylistUrl(input: string): boolean {
  return YT_PLAYLIST_RE.test(input);
}

export function extractYoutubePlaylistId(input: string): string | null {
  const m = input.match(YT_PLAYLIST_RE);
  return m ? m[1] : null;
}

export function extractYoutubeId(input: string): string | null {
  const m = input.match(YT_WATCH_RE);
  return m ? m[1] : null;
}

function toTrack(v: {
  id: string;
  title: string;
  channel: string;
  durationSeconds?: number;
  thumbnail?: string;
}): ResolvedTrack {
  return {
    uri: `youtube:video:${v.id}`,
    name: v.title,
    artists: [v.channel],
    album: 'YouTube',
    durationMs: (v.durationSeconds ?? 0) * 1000,
    image: v.thumbnail,
    source: 'youtube',
  };
}

interface YtDlpMeta {
  id: string;
  title: string;
  duration: number | null;
  thumbnail: string | null;
  channel: string | null;
  url?: string;
}

function ytDlpOnce(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const noProxyEnv = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !k.toLowerCase().endsWith('_proxy')),
    );
    execFile(
      config.ytDlpPath,
      ['--no-check-certificates', '--socket-timeout', '10', '--retries', '1', ...args],
      { windowsHide: true, timeout: 45_000, maxBuffer: 4 * 1024 * 1024, env: noProxyEnv },
      (err, stdout, stderr) => {
        if (err) {
          reject(new YoutubeError(`yt-dlp failed: ${(stderr || err.message).toString().slice(0, 300)}`));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/**
 * Error fragments that indicate a transient YouTube-side hiccup (degraded
 * player response, soft throttle, momentary 403) rather than a bad input.
 * These are worth retrying — the same request typically succeeds seconds later.
 */
const TRANSIENT_YTDLP_ERRORS = [
  'Requested format is not available',
  'HTTP Error 403',
  'HTTP Error 429',
  'HTTP Error 5',
  'Unable to download',
  'Failed to extract',
  'Sign in to confirm',
  'ETIMEDOUT',
];

async function runYtDlp(args: string[], retries = 2): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await ytDlpOnce(args);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const transient = TRANSIENT_YTDLP_ERRORS.some((t) => msg.includes(t));
      if (!transient || attempt >= retries) throw err;
      await new Promise((r) => setTimeout(r, 900 * (attempt + 1)));
    }
  }
}

/** Resolve a YouTube video (id or URL) into a queuable track with a live stream URL. */
export async function resolveYoutubeVideo(input: string): Promise<ResolvedVideo> {
  const id = extractYoutubeId(input) ?? (input.trim().match(/^[A-Za-z0-9_-]{6,}$/) ? input.trim() : null);
  if (!id) throw new YoutubeError('Could not parse that YouTube link.');

  const url = `https://www.youtube.com/watch?v=${id}`;
  const raw = await runYtDlp([
    '--no-playlist',
    '--no-warnings',
    '-f',
    AUDIO_FORMAT,
    '--get-url',
    '--print',
    '%(id)s|%(title)s|%(duration)s|%(thumbnail)s|%(channel)s',
    url,
  ]);

  const lines = raw.trim().split(/\r?\n/);
  const metaLine = lines.find((l) => l.includes('|'));
  const streamUrl = lines.find((l) => l.startsWith('https://'));
  if (!metaLine || !streamUrl) throw new YoutubeError('Could not extract a playable stream.');

  const [vid, title, duration, thumbnail, channel] = metaLine.split('|');
  return {
    videoId: vid,
    uri: `youtube:video:${vid}`,
    name: title,
    artists: [channel ?? 'YouTube'],
    album: 'YouTube',
    durationMs: (Number(duration) || 0) * 1000,
    image: thumbnail || undefined,
    source: 'youtube',
    streamUrl,
    channel: channel ?? 'YouTube',
    thumbnail: thumbnail || undefined,
  };
}

const SEARCH_URL = 'https://www.googleapis.com/youtube/v3/search';

/**
 * Resolve a YouTube playlist into lightweight tracks (id + title). Extremely
 * long playlists are handled by asking yt-dlp for flat metadata only, then
 * each video's stream URL is resolved lazily when it comes up in playback.
 */
export async function resolveYoutubePlaylist(input: string): Promise<ResolvedVideo[]> {
  const playlistId = extractYoutubePlaylistId(input);
  if (!playlistId) throw new YoutubeError('Could not parse that YouTube playlist link.');

  const raw = await runYtDlp([
    '--flat-playlist',
    '--no-warnings',
    '--print',
    '%(id)s|%(title)s|%(channel)s',
    `https://www.youtube.com/playlist?list=${playlistId}`,
  ]);

  const lines = raw.trim().split(/\r?\n/).filter((l) => l.includes('|'));
  if (lines.length === 0) throw new YoutubeError('That playlist appears to be empty or unavailable.');

  const tracks: ResolvedVideo[] = [];
  for (const line of lines) {
    const [vid, title, channel] = line.split('|');
    if (!vid || !title) continue;
    tracks.push({
      videoId: vid,
      uri: `youtube:video:${vid}`,
      name: title,
      artists: [channel || 'YouTube'],
      album: 'YouTube',
      durationMs: 0,
      source: 'youtube',
      streamUrl: '',
      channel: channel || 'YouTube',
    });
  }
  return tracks;
}

/**
 * Words that usually mark unofficial variants (remixes, lives, covers…).
 * They DEPRIORITIZE a candidate — never disqualify — unless the query itself
 * asks for one ("kids with guns remix" keeps remixes in contention).
 */
const VARIANT_RE =
  /\b(remix|bootleg|live|cover|karaoke|acoustic|instrumental|nightcore|mashup|sped\s*up|slowed|reverb)\b/i;

function normText(s: string): string {
  return s
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export interface YoutubeSearchOptions {
  /** Canonical track title (used instead of the raw query for token matching). */
  name?: string;
  /** Artist names — presence in channel/title is rewarded strongly. */
  artists?: string[];
  /** Expected length; near-exact durations get a bonus, way-off ones a penalty. */
  durationMs?: number;
}

interface FlatHit {
  videoId: string;
  title: string;
  channel: string;
  durationSec: number;
}

/** Fast metadata-only YouTube search (no per-video extraction). */
async function flatSearch(query: string): Promise<FlatHit[]> {
  const raw = await runYtDlp([
    '--no-playlist',
    '--no-warnings',
    '--flat-playlist',
    '--print',
    '%(id)s|%(title)s|%(channel)s|%(duration)s',
    `ytsearch5:${query}`,
  ]);
  const hits: FlatHit[] = [];
  for (const line of raw.trim().split(/\r?\n/)) {
    const [id, title = '', channel = '', dur = ''] = line.split('|');
    if (!id || !/^[A-Za-z0-9_-]{6,}$/.test(id)) continue;
    hits.push({ videoId: id, title, channel, durationSec: Number(dur) || 0 });
  }
  return hits;
}

function scoreHit(
  hit: FlatHit,
  rank: number,
  query: string,
  opts: YoutubeSearchOptions,
): number {
  const t = normText(hit.title);
  const ch = normText(hit.channel ?? '');
  let score = 10 - rank; // earlier results win ties

  const nameTokens = normText(opts.name ?? query)
    .split(' ')
    .filter((w) => w.length > 1);
  for (const w of nameTokens) score += t.includes(w) ? 2 : -3;

  for (const artist of opts.artists ?? []) {
    const na = normText(artist);
    if (!na) continue;
    if (ch.includes(na)) score += 4;
    else if (t.includes(na)) score += 2;
    else score -= 1;
  }

  if (!VARIANT_RE.test(query) && VARIANT_RE.test(hit.title)) score -= 8;

  const wantMs = opts.durationMs ?? 0;
  if (wantMs > 0 && hit.durationSec > 0) {
    const d = Math.abs(hit.durationSec * 1000 - wantMs);
    if (d < 3000) score += 3;
    else if (d < 10000) score += 1;
    else if (d > 60000) score -= 2;
  }
  return score;
}

/**
 * Search AND resolve a stream URL. Fetches the top 5 candidates cheaply
 * (metadata only), scores them against the expected title/artists/duration —
 * pushing remixes/lives/covers below the canonical release — then fully
  * extracts the winner. Returns null if nothing matched.
  *
  * Latency strategy: a legacy fused `ytsearch1` extraction (stream URL in one
  * subprocess) races the cheap scored search. When scoring confirms #1 is the
  * best pick — the common case — the fused result is returned with zero extra
  * wall time; otherwise the higher-scored candidate gets extracted instead.
  * Successful results are LRU-cached for 10 minutes.
  */
const resolveCache = new Map<string, { at: number; video: ResolvedVideo }>();
const RESOLVE_CACHE_TTL = 10 * 60 * 1000;
const RESOLVE_CACHE_MAX = 40;

export async function searchAndResolveYoutube(
  query: string,
  opts: YoutubeSearchOptions = {},
): Promise<ResolvedVideo | null> {
  const cached = resolveCache.get(query);
  if (cached && Date.now() - cached.at < RESOLVE_CACHE_TTL) {
    return cached.video;
  }
  const t0 = Date.now();
  try {
    // Fast path: fused single-call top-result extraction (legacy behavior).
    const fusedP = runYtDlp([
      '--no-playlist',
      '--no-warnings',
      '-f',
      AUDIO_FORMAT,
      '--get-url',
      '--print',
      '%(id)s|%(title)s|%(duration)s|%(thumbnail)s|%(channel)s',
      `ytsearch1:${query}`,
    ]).catch(() => null);
    // Accuracy path: cheap metadata for the top 5.
    const hitsP = flatSearch(query).catch(() => [] as FlatHit[]);
    const [fusedRaw, hits] = await Promise.all([fusedP, hitsP]);
    if (hits.length === 0 && !fusedRaw) return null;

    let best = hits[0];
    let bestScore = -Infinity;
    hits.forEach((h, i) => {
      const s = scoreHit(h, i, query, opts);
      if (s > bestScore) {
        bestScore = s;
        best = h;
      }
    });

    let video: ResolvedVideo | null = null;
    const fusedWinner =
      fusedRaw && (hits.length === 0 || best === hits[0]);

    if (fusedWinner) {
      const lines = fusedRaw.trim().split(/\r?\n/);
      const metaLine = lines.find((l) => l.includes('|'));
      const streamUrl = lines.find((l) => l.startsWith('https://'));
      if (metaLine && streamUrl) {
        const [vid, title, duration, thumbnail, channel] = metaLine.split('|');
        video = {
          videoId: vid,
          uri: `youtube:video:${vid}`,
          name: title,
          artists: [channel ?? 'YouTube'],
          album: 'YouTube',
          durationMs: (Number(duration) || 0) * 1000,
          image: thumbnail || undefined,
          source: 'youtube',
          streamUrl,
          channel: channel ?? 'YouTube',
          thumbnail: thumbnail || undefined,
        };
      }
    }
    if (!video && best) {
      console.log(
        `[youtube] score override -> extracting #${hits.indexOf(best) + 1} "${best.title}"`,
      );
      video = await resolveYoutubeVideo(best.videoId);
    }
    if (!video) return null;

    console.log(`[youtube] resolved "${video.name}" in ${Date.now() - t0}ms (${fusedWinner ? 'fast path' : 'scored path'})`);
    resolveCache.set(query, { at: Date.now(), video });
    if (resolveCache.size > RESOLVE_CACHE_MAX) {
      const oldest = [...resolveCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) resolveCache.delete(oldest[0]);
    }
    return video;
  } catch (err: any) {
    console.error(`[youtube] searchAndResolveYoutube failed for "${query}":`, err?.message ?? err);
    return null;
  }
}

interface SearchItem {
  id?: { videoId?: string };
  snippet?: { title?: string; channelTitle?: string; thumbnails?: { high?: { url?: string }; medium?: { url?: string } } };
}

/** Search YouTube via the Data API v3 key. Returns lightweight tracks (no stream URL). */
export async function searchYoutube(query: string, limit = 5): Promise<ResolvedTrack[]> {
  if (!config.youtubeApiKey) {
    throw new YoutubeError('No YOUTUBE_API_KEY configured. Add one to apps/bot/.env to enable /yt search.');
  }
  const url = `${SEARCH_URL}?part=snippet&type=video&maxResults=${limit}&q=${encodeURIComponent(query)}&key=${config.youtubeApiKey}`;
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    throw new YoutubeError('Could not reach the YouTube API.');
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new YoutubeError(`YouTube search failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as { items?: SearchItem[] };
  const items = data.items ?? [];
  if (items.length === 0) throw new YoutubeError('No YouTube results found.');

  return items
    .map((it): ResolvedTrack | null => {
      const vid = it.id?.videoId;
      const title = it.snippet?.title;
      if (!vid || !title) return null;
      return toTrack({
        id: vid,
        title,
        channel: it.snippet?.channelTitle ?? 'YouTube',
        thumbnail: it.snippet?.thumbnails?.high?.url ?? it.snippet?.thumbnails?.medium?.url,
      });
    })
    .filter((t): t is ResolvedTrack => t !== null);
}
