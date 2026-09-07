import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

/** Monotonic id so concurrent yt-dlp calls never share a temp cookie file. */
let cookieCopySeq = 0;

/**
 * Copy the cookie jar to a per-call temp file. yt-dlp always DUMPS the jar
 * back to the --cookies path on exit; on a read-only mount (the VPS ships
 * cookies.txt :ro) that write fails, the process exits non-zero, and the
 * caller would treat an otherwise-successful search as failed. A writable
 * throwaway copy sidesteps the dump — and keeps concurrent calls from
 * racing on the same file. Returns null when cookies are unavailable.
 */
function stageCookieCopy(): string | null {
  if (!config.youtubeCookiesPath) return null;
  try {
    const file = path.join(
      os.tmpdir(),
      `vz-cookies-${process.pid}-${++cookieCopySeq}.txt`,
    );
    fs.copyFileSync(config.youtubeCookiesPath, file);
    return file;
  } catch {
    return null;
  }
}

function ytDlpOnce(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const noProxyEnv = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !k.toLowerCase().endsWith('_proxy')),
    );
    const flags = ['--no-check-certificates', '--socket-timeout', '10', '--retries', '1'];
    // yt-dlp's signature/n-challenge solver needs a JS runtime (extraction is
    // deprecated without one). Node ships with the bot everywhere we run
    // (dev machine + container), so point yt-dlp at it explicitly.
    flags.push('--js-runtimes', 'node');
    // Residential proxy for YouTube: datacenter IPs are SABR-flagged (no
    // direct stream URLs). The proxy's exit IP resolves the URL AND downloads
    // it (ffmpeg uses the same proxy — googlevideo URLs are IP-bound).
    if (config.youtubeProxy) flags.push('--proxy', config.youtubeProxy);
    const cookieCopy = stageCookieCopy();
    if (cookieCopy) flags.push('--cookies', cookieCopy);
    execFile(
      config.ytDlpPath,
      [...flags, ...args],
      { windowsHide: true, timeout: 45_000, maxBuffer: 4 * 1024 * 1024, env: noProxyEnv },
      (err, stdout, stderr) => {
        if (cookieCopy) {
          try {
            fs.rmSync(cookieCopy, { force: true });
          } catch {
            /* best effort */
          }
        }
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
  // YouTube occasionally serves a degraded player response ("The page needs
  // to be reloaded") — the same request typically succeeds on a retry.
  'page needs to be reloaded',
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
  // Tab-delimited so titles/channels containing '|' don't shift fields.
  const META_SEP = '\t';
  const raw = await runYtDlp([
    '--no-playlist',
    '--no-warnings',
    '-f',
    AUDIO_FORMAT,
    '--get-url',
    '--print',
    `%(id)s${META_SEP}%(title)s${META_SEP}%(duration)s${META_SEP}%(thumbnail)s${META_SEP}%(channel)s`,
    url,
  ]);

  const lines = raw.trim().split(/\r?\n/);
  const metaLine = lines.find((l) => l.includes(META_SEP));
  const streamUrl = lines.find((l) => l.startsWith('https://'));
  if (!metaLine || !streamUrl) throw new YoutubeError('Could not extract a playable stream.');

  const [vid, title, duration, thumbnail, channel] = metaLine.split(META_SEP);
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

  const SEP = '\t';
  const raw = await runYtDlp([
    '--flat-playlist',
    '--no-warnings',
    '--print',
    `%(id)s${SEP}%(title)s${SEP}%(channel)s`,
    `https://www.youtube.com/playlist?list=${playlistId}`,
  ]);

  const lines = raw.trim().split(/\r?\n/).filter((l) => l.includes(SEP));
  if (lines.length === 0) throw new YoutubeError('That playlist appears to be empty or unavailable.');

  const tracks: ResolvedVideo[] = [];
  for (const line of lines) {
    const [vid, title, channel] = line.split(SEP);
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
  /\b(remix|bootleg|live|cover|karaoke|acoustic|instrumental|nightcore|mashup|sped\s*up|slowed|reverb|version|tribute|minor\s*key|fan\s*made|8d\s*audio|bass\s*boosted)\b/i;

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
  const SEP = '\t';
  const raw = await runYtDlp([
    '--no-playlist',
    '--no-warnings',
    '--flat-playlist',
    '--print',
    `%(id)s${SEP}%(title)s${SEP}%(channel)s${SEP}%(duration)s`,
    `ytsearch5:${query}`,
  ]);
  const hits: FlatHit[] = [];
  for (const line of raw.trim().split(/\r?\n/)) {
    const [id, title = '', channel = '', dur = ''] = line.split(SEP);
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
  let missing = 0;
  for (const w of nameTokens) {
    if (t.includes(w)) score += 2;
    else { score -= 4; missing++; }
  }
  // Over half the title words absent = this is almost certainly the wrong song.
  if (nameTokens.length > 0 && missing > nameTokens.length / 2) score -= 10;

  for (const artist of opts.artists ?? []) {
    const na = normText(artist);
    if (!na) continue;
    // "Artist - Topic" channels are YouTube's auto-generated official audio.
    if (ch === `${na} topic` || ch.endsWith(' topic') && ch.includes(na)) score += 6;
    else if (ch.includes(na)) score += 4;
    else if (t.includes(na)) score += 2;
    else score -= 1;
  }

  if (!VARIANT_RE.test(query) && !VARIANT_RE.test(opts.name ?? '') && VARIANT_RE.test(hit.title)) score -= 8;

  const wantMs = opts.durationMs ?? 0;
  if (wantMs > 0 && hit.durationSec > 0) {
    const d = Math.abs(hit.durationSec * 1000 - wantMs);
    if (d < 2000) score += 4;
    else if (d < 8000) score += 2;
    else if (d > 45000) score -= 6;
    else if (d > 15000) score -= 2;
  }
return score;
}

/**
 * Quick "is this obviously NOT the song we asked for" check for the speed
 * fallback. Three independent reject reasons:
 *  1. Phrase check — when we have a canonical name, the full name (punctuation-
 *     insensitive) must appear in the title. A same-artist lookalike with a
 *     different song name ("Untitled Forever" when we asked for "Fix It") is
 *     rejected even though the artist matches. (Skipped for raw search queries,
 *     which often have extra words that legitimately won't all be in the title.)
 *  2. Length cap — an egregiously longer cut (album-length mix vs a single) is
 *     a miss even when the name matches.
 *  3. Score floor — the accuracy-path score must clear a bar (wrong artist,
 *     missing most words, variant).
 * Better to skip the track than play an obvious mismatch just because it
 * resolved fast.
 */
export function isClearlyWrongMatch(video: ResolvedVideo, query: string, opts: YoutubeSearchOptions): boolean {
  const t = normText(video.name);
  // 1. Phrase check (canonical names only).
  const canonical = opts.name ? normText(opts.name) : '';
  if (canonical.length > 1 && !t.includes(canonical)) return true;
  // 2. Egregious length mismatch.
  const wantMs = opts.durationMs ?? 0;
  if (wantMs > 0 && video.durationMs > 0 && video.durationMs > wantMs * 4 && video.durationMs - wantMs > 10 * 60_000) {
    return true;
  }
  // 3. Score floor.
  const hit: FlatHit = {
    videoId: video.videoId,
    title: video.name,
    channel: video.channel ?? video.artists[0] ?? 'YouTube',
    durationSec: Math.round((video.durationMs ?? 0) / 1000),
  };
  return scoreHit(hit, 0, query, opts) < FUSED_MIN_ACCEPT_SCORE;
}

/** Floor for accepting the fused fast-path fallback (see isClearlyWrongMatch). */
const FUSED_MIN_ACCEPT_SCORE = 6;

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
/** Concurrent resolves for the same track share one subprocess instead of duplicating. */
const inflightResolves = new Map<string, Promise<ResolvedVideo | null>>();
const RESOLVE_CACHE_TTL = 45 * 60 * 1000;
const RESOLVE_CACHE_MAX = 60;
/** Hard cap on the accuracy (scored) resolve path — after this the already-
 *  playable fused fast-path result is used so playback never stalls for tens
 *  of seconds on sequential candidate extraction. */
const RESOLVE_BUDGET_MS = 10_000;

/** Canonical cache key: collapses phrasing differences between callers
 *  ("Bar Breaker" vs "Artist - Bar Breaker" vs case/spacing variants). */
function resolveKey(query: string, opts: YoutubeSearchOptions): string {
  const name = normText(opts.name ?? query);
  const artists = (opts.artists ?? []).map(normText).filter(Boolean).join(' ');
  return `${name}~${artists || normText(query)}`;
}

export async function searchAndResolveYoutube(
  query: string,
  opts: YoutubeSearchOptions = {},
): Promise<ResolvedVideo | null> {
  const key = resolveKey(query, opts);
  const cached = resolveCache.get(key);
  if (cached && Date.now() - cached.at < RESOLVE_CACHE_TTL) {
    return cached.video;
  }
  const running = inflightResolves.get(key);
  if (running) return running;
  const p = doSearchAndResolve(query, opts, key).finally(() => inflightResolves.delete(key));
  inflightResolves.set(key, p);
  return p;
}

async function doSearchAndResolve(
  query: string,
  opts: YoutubeSearchOptions,
  key: string,
): Promise<ResolvedVideo | null> {
  const t0 = Date.now();
  try {
    // Fast path: fused single-call top-result extraction (legacy behavior).
    // Tab-delimited so titles/channels containing '|' don't shift fields.
    const META_SEP = '\t';
    const fusedP = runYtDlp([
      '--no-playlist',
      '--no-warnings',
      '-f',
      AUDIO_FORMAT,
      '--get-url',
      '--print',
      `%(id)s${META_SEP}%(title)s${META_SEP}%(duration)s${META_SEP}%(thumbnail)s${META_SEP}%(channel)s`,
      `ytsearch1:${query}`,
    ]).catch(() => null);
    // Accuracy path: cheap metadata for the top 5.
    const hitsP = flatSearch(query).catch(() => [] as FlatHit[]);

    // Ship the fused result immediately when it's playable and an obvious match
    // — don't wait for the metadata subprocess that (in the common case) only
    // confirms what the #1 search hit already told us. This cuts first-`/play`
    // latency whenever the fused pass wins the race. A poor match falls through
    // to the scored path below, so correctness is preserved.
    const fusedRaw = await fusedP;
    const fusedVideo = parseFused(fusedRaw, META_SEP);
    if (fusedVideo && !isClearlyWrongMatch(fusedVideo, query, opts)) {
      console.log(`[youtube] resolved "${fusedVideo.name}" in ${Date.now() - t0}ms (fast path)`);
      resolveCache.set(key, { at: Date.now(), video: fusedVideo });
      if (resolveCache.size > RESOLVE_CACHE_MAX) {
        const oldest = [...resolveCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (oldest) resolveCache.delete(oldest[0]);
      }
      return fusedVideo;
    }

    const hits = await hitsP;
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

    // Parse the fused (playable) result up-front so it can double as the
    // speed fallback when the accuracy path can't beat it within budget.
    const fusedWinner = fusedRaw && (hits.length === 0 || best === hits[0]);
    let video: ResolvedVideo | null = fusedWinner ? fusedVideo : null;

    if (!video && hits.length > 0) {
      // Extract in score order and keep going when a candidate is unplayable
      // ("This video is not available", age-gated, region-locked…) — a single
      // dead top pick must not fail the whole search. A hard budget keeps the
      // accuracy path from stalling playback for tens of seconds.
      const ranked = hits
        .map((h, i) => ({ h, s: scoreHit(h, i, query, opts) }))
        .sort((a, b) => b.s - a.s)
        .slice(0, 3);
      const deadline = Date.now() + RESOLVE_BUDGET_MS;
      for (const cand of ranked) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        try {
          if (cand.h !== best) {
            console.log(`[youtube] score override -> extracting #${hits.indexOf(cand.h) + 1} "${cand.h.title}"`);
          }
          video = await withTimeout(resolveYoutubeVideo(cand.h.videoId), remaining);
          if (video) break;
        } catch (err) {
          console.warn(
            `[youtube] "${cand.h.title}" unresolvable (${err instanceof Error ? err.message : err}) — trying next candidate`,
          );
        }
      }
    }
    // Budget hit (or every accurate candidate failed) but the fast path gave
    // us a playable stream — use it rather than returning nothing. Playing
    // something immediately beats stalling, but only when it's plausibly the
    // right song — never settle for an obvious mismatch.
    if (!video && fusedVideo) {
      if (isClearlyWrongMatch(fusedVideo, query, opts)) {
        console.log(`[youtube] fast-path result "${fusedVideo.name}" is a poor match for "${query}" — not settling; skipping`);
      } else {
        console.log(`[youtube] resolve budget hit — using fast-path result "${fusedVideo.name}"`);
        video = fusedVideo;
      }
    }
    if (!video) return null;

    console.log(`[youtube] resolved "${video.name}" in ${Date.now() - t0}ms (${fusedWinner ? 'fast path' : 'scored path'})`);
    resolveCache.set(key, { at: Date.now(), video });
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

/** Resolve a single fused ytsearch1 result into a playable ResolvedVideo. */
function parseFused(raw: string | null, sep: string): ResolvedVideo | null {
  if (!raw) return null;
  const lines = raw.trim().split(/\r?\n/);
  const metaLine = lines.find((l) => l.includes(sep));
  const streamUrl = lines.find((l) => l.startsWith('https://'));
  if (!metaLine || !streamUrl) return null;
  const [vid, title, duration, thumbnail, channel] = metaLine.split(sep);
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

/** Race a promise against a deadline so a slow subprocess can't stall playback. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  if (ms <= 0) return Promise.resolve(null);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    timer.unref?.();
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      () => { clearTimeout(timer); resolve(null); },
    );
  });
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

/**
 * Refresh the YouTube cookie jar by extracting cookies from a browser and
 * writing them to the configured YOUTUBE_COOKIES_PATH. Uses yt-dlp's
 * --cookies-from-browser so the exported jar stays in the Netscape format
 * the rest of the code expects.
 *
 * Browser options, in order of preference: chrome, chromium, edge, firefox.
 * Returns { ok: true, path, lines } on success, { ok: false, error } on failure.
 */
export async function refreshYoutubeCookies(
  browser: 'chrome' | 'chromium' | 'edge' | 'firefox' = 'chrome',
): Promise<{ ok: true; path: string; lines: number } | { ok: false; error: string }> {
  const target = config.youtubeCookiesPath || path.join(config.dataDir, 'youtube-cookies.txt');
  const browsers = [browser, 'chrome', 'chromium', 'edge', 'firefox'];
  for (const b of [...new Set(browsers)]) {
    try {
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await new Promise<void>((resolve, reject) => {
        execFile(
          config.ytDlpPath,
          ['--cookies-from-browser', b, '--cookies', target, '--skip-download', '--no-warnings', 'ytsearch1:test'],
          { windowsHide: true, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
          (err) => (err ? reject(new YoutubeError(`yt-dlp cookie export from "${b}" failed: ${(err as Error).message.slice(0, 200)}`)) : resolve()),
        );
      });
      const raw = await fs.promises.readFile(target, 'utf8');
      const lines = raw.split('\n').filter((l) => l && !l.startsWith('#')).length;
      return { ok: true, path: target, lines };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (b === browsers[browsers.length - 1]) return { ok: false, error: msg };
      continue;
    }
  }
  return { ok: false, error: 'No browser cookie export succeeded.' };
}
