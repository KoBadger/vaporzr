import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '@vaporzr/core/config';
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

/** Titles that are plainly not the song: esports/sports highlights, gameplay,
 *  podcasts, reactions, vlogs, news. These match a song name by accident (e.g.
 *  "liquid game" → a Team Liquid esports highlight reel) and their non-music
 *  segments (sponsor reads, commentary) sound like an ad break mid-stream. */
const NON_MUSIC_RE =
  /\b(plays? of the week|highlights?|full game|gameplay|walkthrough|playthrough|let'?s play|esports|e-?sports|tournament|grand final|press conference|post[- ]?game|pre[- ]?game|match recap|reaction|reacts? to|podcast|interview|episode \d+|vlog|unboxing|trailer|teaser|behind the scenes|documentary|breaking news|news|weather|sportscenter|espn|top \d+ plays|tier list|countdown|ranked)\b/i;
/** If one of these is present the video is (probably) music despite the above. */
const MUSIC_HINT_RE =
  /\b(official audio|official video|lyric video|lyrics?|audio|topic|visuali[sz]er|music video|remix|instrumental|acoustic|cover|live at|session)\b/i;

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

/** Writable cookie jar in the data volume. When present it overrides the
 *  (usually read-only) mounted YOUTUBE_COOKIES_PATH, so cookies can be refreshed
 *  or uploaded from Discord without remounting anything. */
export function liveCookiesPath(): string {
  return path.join(config.dataDir, 'youtube-cookies.txt');
}

/** The cookie jar actually in effect: the uploaded/live one if it exists, else
 *  the configured (mounted) path. Null when neither is available. */
function activeCookiesPath(): string | null {
  try {
    const live = liveCookiesPath();
    if (fs.existsSync(live)) return live;
  } catch {
    /* fall through to the configured path */
  }
  return config.youtubeCookiesPath || null;
}

/**
 * Copy the cookie jar to a per-call temp file. yt-dlp always DUMPS the jar
 * back to the --cookies path on exit; on a read-only mount (the VPS ships
 * cookies.txt :ro) that write fails, the process exits non-zero, and the
 * caller would treat an otherwise-successful search as failed. A writable
 * throwaway copy sidesteps the dump — and keeps concurrent calls from
 * racing on the same file. Returns null when cookies are unavailable.
 */
function stageCookieCopy(): string | null {
  const src = activeCookiesPath();
  if (!src) return null;
  try {
    const file = path.join(
      os.tmpdir(),
      `vz-cookies-${process.pid}-${++cookieCopySeq}.txt`,
    );
    fs.copyFileSync(src, file);
    return file;
  } catch {
    return null;
  }
}

function ytDlpOnce(args: string[], useProxy = true): Promise<string> {
  return new Promise((resolve, reject) => {
    const noProxyEnv = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !k.toLowerCase().endsWith('_proxy')),
    );
    const flags = ['--no-check-certificates', '--socket-timeout', '10', '--retries', '1'];
    // The proxy hands out dual-stack exits; resolving over IPv6 produced URLs
    // whose ip= could never match the IPv4 stream fetch. Keep everything IPv4.
    flags.push('--force-ipv4');
    // yt-dlp's signature/n-sig solver needs a JS runtime; Deno is its default and
    // is baked into the bot image (node is not accepted as the EJS runtime). It
    // also refuses to fetch the remote solver script unless explicitly allowed.
    flags.push('--remote-components', 'ejs:github');
    // Residential proxy for YouTube: datacenter IPs are SABR-flagged (no
    // direct stream URLs). The proxy's exit IP resolves the URL AND downloads
    // it (ffmpeg uses the same proxy — googlevideo URLs are IP-bound).
    if (config.youtubeProxy && useProxy) flags.push('--proxy', config.youtubeProxy);
    const cookieCopy = stageCookieCopy();
    if (cookieCopy) flags.push('--cookies', cookieCopy);
    execFile(
      config.ytDlpPath,
      [...flags, ...args],
      { windowsHide: true, timeout: 20_000, maxBuffer: 4 * 1024 * 1024, env: noProxyEnv },
      (err, stdout, stderr) => {
        if (cookieCopy) {
          try {
            fs.rmSync(cookieCopy, { force: true });
          } catch {
            /* best effort */
          }
        }
        if (err) {
          const detail = (stderr || err.message).toString();
          // The anti-bot wall is NOT proof of expired cookies — see describeBotWall().
          if (isBotWall(detail)) {
            reject(new YoutubeError(describeBotWall()));
            return;
          }
          reject(new YoutubeError(`yt-dlp failed: ${detail.slice(0, 300)}`));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/** YouTube's anti-bot / sign-in wall. It appears when the cookies are stale,
 *  when YouTube has flagged the bot's IP, OR when the PO token is missing —
 *  knowing which is what makes it actionable. */
export function isBotWall(msg: string): boolean {
  return /Sign in to confirm|not a bot/i.test(msg);
}

/** A proxy-side failure (dead credentials, unreachable tunnel, 407). */
export function isProxyError(msg: string): boolean {
  return !isBotWall(msg) && /proxy|tunnel|407|econnrefused/i.test(msg);
}

/** Age of the YouTube cookies file in days (null when unset or missing). */export function cookieAgeDays(): number | null {
  try {
    const src = activeCookiesPath();
    if (!src) return null;
    const st = fs.statSync(src);
    return Math.max(0, Math.round((Date.now() - st.mtimeMs) / 86_400_000));
  } catch {
    return null;
  }
}

/**
 * Rotate the residential proxy's sticky session so the next requests land on a
 * different exit IP. DataImpulse picks the sticky exit with a `sessid` param in
 * the username and its sticky ports hold one IP for `sessttl` minutes — so a
 * flagged exit otherwise sticks around for up to an hour. Returns the new proxy
 * URL (also updating config); returns the current one unchanged when no proxy is
 * set or it can't be parsed.
 */
export function rotateYoutubeProxy(): string {
  const cur = config.youtubeProxy;
  if (!cur) return '';
  const sess = Math.random().toString(36).slice(2, 10);
  // The username carries the session tag (DataImpulse: `acct__sessid.X;sessttl.N`).
  // A URL round-trip would drop the `;sessttl` param, so rewrite the raw string.
  let out: string;
  if (/sessid\./i.test(cur)) {
    out = cur.replace(/sessid\.[^;:@]*/i, `sessid.${sess}`);
  } else {
    out = cur.replace(/^(https?:\/\/)([^:@/]+)/i, (_m, scheme: string, user: string) => `${scheme}${user};sessid.${sess}`);
  }
  config.youtubeProxy = out;
  return out;
}

/** Actionable text for the anti-bot wall. It deliberately does NOT claim the
 *  cookies have expired: the same wall appears when YouTube has flagged the
 *  bot's datacenter IP (what the residential proxy exists for) or when the PO
 *  token is missing. Blaming the cookies sent an admin to re-export a perfectly
 *  good cookie file while the real cause was the IP. */
export function describeBotWall(): string {
  const age = cookieAgeDays();
  const ageText = age === null ? '`missing`' : `${age} day${age === 1 ? '' : 's'} old`;
  return config.youtubeProxy
    ? `YouTube refused the request (anti-bot wall). Cookies are ${ageText} and a residential proxy IS configured — so either the proxy's exit IP is flagged too, the cookies are stale, or the PO token is missing. Retrying usually lands on a clean exit; if it keeps happening, refresh the cookies with \`/cookie-upload\`.`
    : `YouTube refused the request (anti-bot wall) and NO residential proxy is set. Cookies are ${ageText}. A flagged datacenter IP is the usual cause — refreshing cookies alone will not fix that; set YOUTUBE_PROXY in /opt/vaporzr/.env.`;
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
  'ETIMEDOUT',
  // NOTE: 'Sign in to confirm you're not a bot' is deliberately NOT here — it is
  // an expired-cookie wall that retrying never fixes, and retrying made every
  // start hang for ~45s before failing.
  // YouTube occasionally serves a degraded player response ("The page needs
  // to be reloaded") — the same request typically succeeds on a retry.
  'page needs to be reloaded',
];

/**
 * Whether a failed yt-dlp attempt is worth repeating.
 *
 * With a residential proxy configured, a wall usually means the rotating exit
 * IP is flagged rather than the cookies being dead — another attempt lands on a
 * different exit and normally succeeds. Retrying DIRECT cannot help when the
 * datacenter IP is itself what YouTube objects to, which is why the direct
 * fallback only applies when no proxy is configured.
 */
export function shouldRetryYtDlp(
  msg: string,
  opts: { attempt: number; maxAttempts: number; hasProxy: boolean },
): boolean {
  if (opts.attempt >= opts.maxAttempts) return false;
  if (TRANSIENT_YTDLP_ERRORS.some((t) => msg.includes(t))) return true;
  if (!opts.hasProxy) return false;
  // A wall is usually a dirty exit from the rotating pool — another go picks a
  // different IP and normally succeeds.
  if (isBotWall(msg)) return true;
  // A proxy-side failure gets ONE retry (the next exit may be healthy) before
  // falling back to a direct connection, so a genuinely dead proxy fails fast
  // instead of burning the request timeout.
  if (isProxyError(msg)) return opts.attempt === 0;
  return false;
}

/** Run yt-dlp with retries. `route` pins the network path: `false` forces a
 *  direct connection with no proxy fallback, so the health canary can tell a
 *  proxy failure apart from a YouTube-side block. Undefined keeps the normal
 *  proxy-first behaviour. */
async function runYtDlp(args: string[], retries = 2, route?: boolean): Promise<string> {
  const hasProxy = !!config.youtubeProxy && route !== false;
  // A rotating residential pool needs a couple more goes to find a clean exit.
  const maxAttempts = hasProxy ? Math.max(retries, 3) : retries;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    try {
      return await ytDlpOnce(args, route ?? true);
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (!shouldRetryYtDlp(msg, { attempt, maxAttempts, hasProxy })) break;
      await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
    }
  }
  // With a residential proxy the exits rotate, so a wall is usually one dirty
  // IP: retry on the proxy first. Then try direct ONCE regardless — YouTube's
  // IP flagging is dynamic (we have seen direct work and then wall again), and
  // a dead or exhausted proxy must not take YouTube down when direct does work.
  if (route !== false && config.youtubeProxy) {
    try {
      return await ytDlpOnce(args, false);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

/**
 * YouTube health canary. Resolves a known video through the real path (cookies,
 * JS runtime, PO-token provider) so failures — expired cookies, a dead solver, a
 * broken proxy — are caught by a probe instead of the next song.
 */
export type YoutubeHealth = 'ok' | 'auth' | 'blocked' | 'proxy' | 'down' | 'unknown';
const CANARY_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
let ytHealth: YoutubeHealth = 'unknown';
let ytHealthAt = 0;
/** Alert bookkeeping for the confirmation rule in decidePublish(). */
let ytAlert: YoutubeAlertState = { published: 'unknown', pending: null };
let ytHealthListener: ((status: YoutubeHealth) => void) | null = null;

export function youtubeHealth(): { status: YoutubeHealth; checkedAt: number } {
  return { status: ytHealth, checkedAt: ytHealthAt };
}

/** Register a callback fired only when the status actually changes. */
export function setYoutubeHealthListener(cb: ((status: YoutubeHealth) => void) | null): void {
  ytHealthListener = cb;
}

/** Alert bookkeeping: what was last announced, plus a failure awaiting confirmation. */
export interface YoutubeAlertState {
  published: YoutubeHealth;
  pending: YoutubeHealth | null;
}

/**
 * Decides whether a probe result should be announced to the alert listener.
 *
 * One bad probe is common — a rotating residential exit is occasionally flagged
 * and walls are sometimes momentary — so announcing every blip paged someone
 * about a "proxy failure" that had already cleared. A failure is therefore
 * announced only once a second probe agrees; an ongoing failure is not repeated;
 * and the recovery is announced only if a failure was announced first.
 */
export function decidePublish(
  status: YoutubeHealth,
  state: YoutubeAlertState,
): { publish: YoutubeHealth | null; state: YoutubeAlertState } {
  if (status === 'ok') {
    const publish = state.published !== 'ok' && state.published !== 'unknown' ? 'ok' : null;
    return { publish, state: { published: 'ok', pending: null } };
  }
  // This exact failure is already being announced — stay quiet.
  if (state.published === status) return { publish: null, state: { ...state, pending: null } };
  // First sighting: wait for the next probe to confirm it.
  if (state.pending !== status) return { publish: null, state: { ...state, pending: status } };
  // Seen twice in a row: announce it.
  return { publish: status, state: { published: status, pending: null } };
}

export async function probeYoutube(): Promise<YoutubeHealth> {
  const args = ['--no-playlist', '--get-url', '-f', AUDIO_FORMAT, CANARY_URL];
  const attempt = async (useProxy: boolean): Promise<string> => {
    try {
      await runYtDlp(args, 0, useProxy);
      return 'ok';
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };

  let status: YoutubeHealth;
  if (config.youtubeProxy) {
    const proxied = await attempt(true);
    if (proxied === 'ok') {
      status = 'ok';
    } else {
      // Two routes, four causes: a successful direct attempt means the proxy is
      // the problem; a wall on either route means YouTube is refusing us.
      const direct = await attempt(false);
      if (direct === 'ok') status = 'proxy';
      else if (isBotWall(proxied) || isBotWall(direct)) status = 'auth';
      else if (isProxyError(proxied)) status = 'proxy';
      else status = 'down';
    }
  } else {
    // Without a proxy there is nothing to compare against — but the honest
    // reading of a wall here is "the IP is blocked", not "the cookies expired".
    const direct = await attempt(false);
    status = direct === 'ok' ? 'ok' : isBotWall(direct) ? 'blocked' : 'down';
  }

  ytHealth = status;
  ytHealthAt = Date.now();
  const decided = decidePublish(status, ytAlert);
  ytAlert = decided.state;
  if (decided.publish && ytHealthListener) {
    try {
      ytHealthListener(decided.publish);
    } catch {
      /* listener errors must not break the probe */
    }
  }
  return status;
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

/** Non-YouTube audio hosts yt-dlp can resolve directly. */
const GENERIC_MEDIA_HOST_RE =
  /(^|[./])(bandcamp\.com|deezer\.com|tidal\.com|mixcloud\.com|audiomack\.com|jamendo\.com|qobuz\.com|napster\.com)\//i;

export function isGenericMediaUrl(input: string): boolean {
  const t = input.trim();
  return /^https?:\/\//i.test(t) && GENERIC_MEDIA_HOST_RE.test(t);
}

/** Resolve any yt-dlp-supported URL (Bandcamp, Deezer, Tidal, Mixcloud, …)
 *  into a single queuable track with a live stream URL. */
export async function resolveGenericMediaUrl(input: string): Promise<ResolvedVideo> {
  const url = input.trim();
  const META_SEP = '\t';
  const raw = await runYtDlp([
    '--no-playlist',
    '--no-warnings',
    '-f',
    AUDIO_FORMAT,
    '--get-url',
    '--print',
    `%(id)s${META_SEP}%(title)s${META_SEP}%(duration)s${META_SEP}%(thumbnail)s${META_SEP}%(uploader)s`,
    url,
  ]);
  const lines = raw.trim().split(/\r?\n/);
  const metaLine = lines.find((l) => l.includes(META_SEP));
  const streamUrl = lines.find((l) => /^https?:\/\//.test(l));
  if (!metaLine || !streamUrl) throw new YoutubeError('Could not extract a playable stream from that link.');
  const [id, title, duration, thumbnail, uploader] = metaLine.split(META_SEP);
  return {
    videoId: id,
    uri: `direct:${url}`,
    name: title || 'Unknown',
    artists: [uploader || 'Web'],
    album: '',
    durationMs: (Number(duration) || 0) * 1000,
    image: thumbnail || undefined,
    source: 'direct',
    streamUrl,
    channel: uploader || 'Web',
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
  /\b(remix|bootleg|live|cover|karaoke|acoustic|instrumental|nightcore|mashup|sped\s*up|slowed|reverb|version|tribute|minor\s*key|fan\s*made|8d\s*audio|bass\s*boosted|unplugged|concert|festival|tiny\s*desk|kexp|radio\s*1|on\s*the\s*radio|bbc)\b/i;

/** Live-performance markers — the strongest signal that a hit is not the studio
 *  release a plain "play <song>" is after. */
const LIVE_RE = /\b(live|unplugged|concert|festival|tiny\s*desk|kexp|radio\s*1|on\s*the\s*radio|bbc)\b/i;

/** Edition/quality noise that must not affect whether a title is the song. */
const TITLE_NOISE = new Set([
  'version', 'single', 'audio', 'hq', 'hd', 'official', 'video', 'lyric', 'lyrics',
  'the', 'a', 'an', 'feat', 'ft', 'featuring', 'remaster', 'remastered', 'edit', 'mix',
  'original', 'album', 'radio', 'extended', 'mv', 'topic', 'visualizer', 'visualiser',
]);

/** The song-name words that actually matter, edition noise removed. */
function significantTokens(s: string): string[] {
  return normText(s).split(' ').filter((w) => w.length > 1 && !TITLE_NOISE.has(w));
}

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

export function scoreHit(
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

  // A live/remix/cover cut is almost never what "play <song>" means, so sink it.
  // Live cuts are the worst offenders — a plain song search surfaces them above
  // the studio release — so they take an extra hit.
  if (!VARIANT_RE.test(query) && !VARIANT_RE.test(opts.name ?? '')) {
    if (VARIANT_RE.test(hit.title)) score -= 8;
    if (LIVE_RE.test(hit.title)) score -= 8;
  }

  // Prefer the clean song over theatrical music videos, which carry long
  // intros/interludes/outros. "Artist - Topic" uploads are already boosted
  // above; here we penalise video cuts and nudge up audio/lyric uploads.
  const raw = hit.title.toLowerCase();
  if (/\b(official\s+)?(music\s+video|video\s+clip|videoclip|m\/v|mv|pv)\b/.test(raw)) score -= 8;
  else if (/\bofficial\s+video\b/.test(raw)) score -= 5;
  if (/\b(audio|topic|lyric|visuali[sz]er)\b/.test(raw)) score += 3;

  const wantMs = opts.durationMs ?? 0;
  if (wantMs > 0 && hit.durationSec > 0) {
    const d = Math.abs(hit.durationSec * 1000 - wantMs);
    if (d < 2000) score += 4;
    else if (d < 8000) score += 2;
    else if (d > 45000) score -= 6;
    else if (d > 15000) score -= 2;
  }

  // A video that is plainly something else (esports clip, podcast, vlog…) can
  // win on a partial word match — "liquid game" scored a Team Liquid highlight
  // reel over the actual song. Sink it below anything musical.
  if (NON_MUSIC_RE.test(raw) && !MUSIC_HINT_RE.test(raw)) score -= 40;

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
  return looksWrong(
    video.name,
    video.durationMs ?? 0,
    video.channel ?? video.artists?.[0] ?? 'YouTube',
    query,
    opts,
  );
}

/** The hard, safe-to-enforce checks: a video that isn't music at all, or is a
 *  wildly different length. These never reject the real song. */
export function looksUnplayable(name: string, durationMs: number, opts: YoutubeSearchOptions): boolean {
  const rawTitle = (name ?? '').toLowerCase();
  if (NON_MUSIC_RE.test(rawTitle) && !MUSIC_HINT_RE.test(rawTitle)) return true;
  const wantMs = opts.durationMs ?? 0;
  if (wantMs > 0 && durationMs > 0) {
    if (durationMs > wantMs + 5 * 60_000 && durationMs > wantMs * 2.5) return true;
    // A sub-minute upload is a snippet/preview, not the song.
    if (wantMs > 180_000 && durationMs < 60_000) return true;
    // A MUCH shorter upload (less than half the track) is a preview, a radio
    // edit, or simply the wrong take — playing it makes the song stop well
    // before its real end. Symmetric to the egregiously-long guard above; the
    // margin keeps a legitimately shorter YouTube cut from being rejected.
    if (wantMs > 120_000 && durationMs < wantMs * 0.5 - 30_000) return true;
  }
  return false;
}

/** Shared guard so the scored path can judge a candidate before extracting it. */
export function looksWrong(
  name: string,
  durationMs: number,
  channel: string,
  query: string,
  opts: YoutubeSearchOptions,
): boolean {
  const t = normText(name);
  // 1. Phrase check: the song name's significant words must be present. Word
  //    based (not a substring) and with edition noise removed — otherwise an
  //    upload that words the version differently ("All Night Long (All Night)
  //    [Single Version] [Audio HQ]" vs Spotify's "… - Single Version") gets
  //    rejected even though it is exactly the right song.
  const want = opts.name ? significantTokens(opts.name) : [];
  if (want.length > 0) {
    const have = new Set(t.split(' '));
    const missing = want.filter((w) => !have.has(w));
    if (missing.length > want.length / 2) return true;
  }
  // 2 + 3. Not music at all, or a wildly different length.
  if (looksUnplayable(name, durationMs, opts)) return true;
  // 4. A live/festival cut when the caller did not ask for one. A plain song
  //    search surfaces festival sets above the studio release, and a two-hour
  //    set is never what "play <song>" means. Skipped when the query itself
  //    asks for a live performance, and the caller still falls back to these
  //    when nothing else exists (see the ranked/fallback split).
  const wantsLive = /\b(live|unplugged|concert|festival|dj\s*set|tiny\s*desk|kexp|bbc|radio\s*1)\b/i.test(query);
  if (!wantsLive && LIVE_RE.test(name)) return true;
  // 4. Score floor.
  const hit: FlatHit = {
    videoId: '',
    title: name,
    channel: channel || 'YouTube',
    durationSec: Math.round(durationMs / 1000),
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
// Stream URLs are bound to the proxy exit that minted them, and a residential
// session rotates (typically well under an hour). A long cache therefore hands
// playback a URL whose IP no longer matches — which is exactly a 403 mid-track.
// Prefetch-to-play gaps are seconds, so a short TTL costs almost nothing.
const RESOLVE_CACHE_TTL = 5 * 60 * 1000;
/** Concurrent resolves for the same track share one subprocess instead of duplicating. */
const inflightResolves = new Map<string, Promise<ResolvedVideo | null>>();
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
    // If the top hit is a live/remix/cover we didn't ask for, skip the fast path
    // and let the scored path look for the studio release instead.
    const queryWantsVariant = VARIANT_RE.test(query) || VARIANT_RE.test(opts.name ?? '');
    // The fused hit sometimes reports no duration (yt-dlp prints "NA"); when we
    // know how long the song should be, prefer the scored path whose metadata
    // can verify length. A duration-less hit is how a 44s upload of an 8-minute
    // track slipped through as a "fast path" match.
    const fusedUnknownLength = fusedVideo ? fusedVideo.durationMs <= 0 && (opts.durationMs ?? 0) > 0 : false;
    if (
      fusedVideo &&
      !fusedUnknownLength &&
      !isClearlyWrongMatch(fusedVideo, query, opts) &&
      (queryWantsVariant || !VARIANT_RE.test(fusedVideo.name))
    ) {
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

    // The fused result only reaches here when it was missing OR already judged a
    // poor match (the fast path above returns every good one), so it is not a
    // usable fallback.
    let video: ResolvedVideo | null = null;

    if (!video && hits.length > 0) {
      // Extract in score order and keep going when a candidate is unplayable
      // ("This video is not available", age-gated, region-locked…) — a single
      // dead top pick must not fail the whole search. A hard budget keeps the
      // accuracy path from stalling playback for tens of seconds.
      const byScore = hits
        .map((h, i) => ({ h, s: scoreHit(h, i, query, opts) }))
        .sort((a, b) => b.s - a.s);
      // Prefer candidates that pass the full guard. If none do, fall back to the
      // best one that is at least real music of roughly the right length —
      // skipping a real song is worse than a slightly imperfect match.
      let ranked = byScore.filter((cand) => {
        const wrong = looksWrong(cand.h.title, cand.h.durationSec * 1000, cand.h.channel, query, opts);
        if (wrong) console.log(`[youtube] skipping poor match "${cand.h.title}" for "${query}"`);
        return !wrong;
      });
      if (ranked.length === 0) {
        ranked = byScore.filter((cand) => !looksUnplayable(cand.h.title, cand.h.durationSec * 1000, opts));
        if (ranked.length > 0) {
          console.log(`[youtube] no clean match for "${query}" — using best playable candidate "${ranked[0].h.title}"`);
        }
      }
      const shortlist = ranked.slice(0, 3);
      const deadline = Date.now() + RESOLVE_BUDGET_MS;
      for (const cand of shortlist) {
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

    console.log(`[youtube] resolved "${video.name}" in ${Date.now() - t0}ms (scored path)`);
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
 * Validate and store a Netscape-format cookie jar (e.g. one uploaded from a
 * browser). Written to the writable live path, which then overrides the
 * read-only mount. Returns the number of cookie lines stored.
 */
export async function saveYoutubeCookies(
  text: string,
): Promise<{ ok: true; path: string; lines: number } | { ok: false; error: string }> {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return { ok: false, error: 'The uploaded file was empty.' };
  const hasHeader = /#\s*(Netscape|HTTP Cookie File)/i.test(trimmed);
  const hasYt = /(^|\t)youtube\.com\t|\t\.youtube\.com\t/i.test(trimmed) || /youtube\.com/i.test(trimmed);
  if (!hasHeader && !hasYt) {
    return {
      ok: false,
      error:
        'That does not look like a Netscape cookies.txt export — no youtube.com cookie lines found. Export with a "Get cookies.txt LOCALLY"-style extension.',
    };
  }
  const lines = trimmed.split('\n').filter((l) => l && !l.startsWith('#')).length;
  if (lines < 3) {
    return { ok: false, error: `Only ${lines} cookie line(s) found — export a fresh youtube.com jar.` };
  }
  try {
    const target = liveCookiesPath();
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, trimmed.endsWith('\n') ? trimmed : `${trimmed}\n`, 'utf8');
    return { ok: true, path: target, lines };
  } catch (err) {
    return { ok: false, error: `Could not write cookies: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Refresh the YouTube cookie jar by extracting cookies from a browser and
 * writing them to the writable live path. Uses yt-dlp's --cookies-from-browser
 * so the exported jar stays in the Netscape format the rest of the code expects.
 *
 * This only works on a machine that HAS a browser profile. The bot runs in a
 * container with none, so on the VPS every browser probe fails — in that case
 * the error says so plainly instead of leaking a confusing yt-dlp message, and
 * points at `/cookie-upload`.
 */
export async function refreshYoutubeCookies(
  browser: 'chrome' | 'chromium' | 'edge' | 'firefox' = 'chrome',
): Promise<{ ok: true; path: string; lines: number } | { ok: false; error: string }> {
  const target = liveCookiesPath();
  const browsers = [browser, 'chrome', 'chromium', 'edge', 'firefox'];
  let lastErr = '';
  let sawNoBrowser = false;
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
      lastErr = err instanceof Error ? err.message : String(err);
      // yt-dlp's "could not find <browser> cookies database" — no browser here.
      if (/could not find|no such file|cookies database|unsupported browser|not found/i.test(lastErr)) {
        sawNoBrowser = true;
      }
      continue;
    }
  }
  return {
    ok: false,
    error: sawNoBrowser
      ? 'No browser is available in this environment (the bot runs in a container), so cookies cannot be exported here. ' +
        'Export cookies.txt on a machine with a browser and either upload it with `/cookie-upload` or replace /opt/vaporzr/cookies.txt on the host.'
      : lastErr || 'No browser cookie export succeeded.',
  };
}
