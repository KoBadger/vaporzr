import { execFile } from 'node:child_process';
import { config } from './config.js';
import { searchAndResolveYoutube } from './youtube.js';
import type { ResolvedTrack } from './spotify.js';

export class SoundcloudError extends Error {}

export interface ResolvedSoundcloudTrack extends ResolvedTrack {
  videoId: string;
  streamUrl: string;
  channel: string;
  thumbnail?: string;
}

const SC_URL_RE = /(^|[./])(soundcloud\.com|snd\.sc)\//;
const SC_SET_PATH_RE = /\/sets\//;

export function isSoundcloudUrl(input: string): boolean {
  return SC_URL_RE.test(input);
}

export function isSoundcloudSetUrl(input: string): boolean {
  try {
    const pathname = new URL(input.startsWith('http') ? input : `https://${input}`).pathname;
    return SC_SET_PATH_RE.test(pathname);
  } catch {
    return SC_SET_PATH_RE.test(input);
  }
}

/** Track URIs carry the source URL so lazy playlist entries can be resolved later. */
export function soundcloudUriToUrl(uri: string): string {
  return decodeURIComponent(uri.replace(/^soundcloud:/, ''));
}

function toSoundcloudUri(url: string): string {
  return `soundcloud:${encodeURIComponent(url)}`;
}

interface YtDlpOpts {
  timeoutMs?: number;
  maxBufferBytes?: number;
}

function ytDlpOnce(args: string[], opts: YtDlpOpts = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const noProxyEnv = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !k.toLowerCase().endsWith('_proxy')),
    );
    const flags = ['--no-check-certificates'];
    // SoundCloud-specific cookies (YouTube cookies don't authenticate SC).
    if (config.soundcloudCookiesPath) flags.push('--cookies', config.soundcloudCookiesPath);
    execFile(
      config.ytDlpPath,
      [...flags, ...args],
      {
        windowsHide: true,
        timeout: opts.timeoutMs ?? 60_000,
        maxBuffer: opts.maxBufferBytes ?? 4 * 1024 * 1024,
        env: noProxyEnv,
      },
      (err, stdout, stderr) => {
        if (err) {
          reject(new SoundcloudError(`yt-dlp failed: ${(stderr || err.message).toString().slice(0, 300)}`));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/** Error fragments that indicate a transient hiccup worth retrying. */
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

async function runYtDlp(args: string[], retries = 2, opts: YtDlpOpts = {}): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await ytDlpOnce(args, opts);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const transient = TRANSIENT_YTDLP_ERRORS.some((t) => msg.includes(t));
      if (!transient || attempt >= retries) throw err;
      await new Promise((r) => setTimeout(r, 900 * (attempt + 1)));
    }
  }
}

/** Best-effort title from a SoundCloud URL slug (flat listings report "NA"). */
function slugFromUrl(entryUrl: string): string {
  try {
    const path = new URL(entryUrl).pathname.split('/').filter(Boolean).pop() ?? '';
    const t = decodeURIComponent(path).replace(/[-_]+/g, ' ').trim();
    return t || 'SoundCloud track';
  } catch {
    return 'SoundCloud track';
  }
}

/** Resolve a SoundCloud track URL into a queuable track with a live audio stream.
 *  DRM-protected tracks (major-label catalog) automatically fall back to the
 *  best YouTube match of the same song, so playback "just works". */
export async function resolveSoundcloudVideo(input: string): Promise<ResolvedSoundcloudTrack> {
  const url = input.trim().startsWith('http') ? input.trim() : `https://${input.trim()}`;

  try {
    return await resolveSoundcloudVideoInner(url);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/DRM/i.test(msg)) throw err;
    console.warn(`[soundcloud] DRM-protected track (${url}) — falling back to YouTube match`);
    // Best-effort query: real title if extractable, else the URL slug.
    let query = decodeURIComponent(url.split('/').pop()?.split('?')[0] ?? '').replace(/[-_]+/g, ' ').trim();
    try {
      const meta = await runYtDlp(['--no-warnings', '--print', '%(title)s', url]);
      const title = meta.trim().split(/\r?\n/)[0];
      if (title && !/^ERROR/i.test(title)) query = title;
    } catch {
      /* slug query is fine */
    }
    const yt = await searchAndResolveYoutube(query);
    if (!yt) {
      throw new SoundcloudError(
        `That SoundCloud track is DRM-protected and no YouTube match was found for "${query}".`,
      );
    }
    console.log(`[soundcloud] DRM fallback -> YouTube: "${yt.name}"`);
    return yt as ResolvedSoundcloudTrack;
  }
}

async function resolveSoundcloudVideoInner(url: string): Promise<ResolvedSoundcloudTrack> {
  const raw = await runYtDlp([
    '--no-warnings',
    '-f',
    'bestaudio/best',
    '--get-url',
    '--print',
    '%(webpage_url)s|%(title)s|%(duration)s|%(thumbnail)s|%(uploader)s',
    url,
  ]);

  const lines = raw.trim().split(/\r?\n/);
  const metaLine = lines.find((l) => l.includes('|'));
  const streamUrl = lines.find((l) => l.startsWith('http') && !l.includes('|'));
  if (!metaLine || !streamUrl) throw new SoundcloudError('Could not extract a playable SoundCloud stream.');

  // Pipe-safe: exactly 4 separators — the title/uploader may themselves contain '|'.
  const m = metaLine.match(/^([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|(.*)$/s);
  const pageUrl = m?.[1] ?? url;
  const title = m?.[2] ?? 'Unknown';
  const duration = m?.[3] ?? '';
  const thumbnail = m?.[4] ?? '';
  const uploader = m?.[5] ?? '';
  return {
    videoId: pageUrl || url,
    uri: toSoundcloudUri(pageUrl || url),
    name: title,
    artists: [uploader || 'SoundCloud'],
    album: 'SoundCloud',
    durationMs: (Number(duration) || 0) * 1000,
    image: thumbnail || undefined,
    source: 'soundcloud',
    streamUrl,
    channel: uploader || 'SoundCloud',
    thumbnail: thumbnail || undefined,
  };
}

/** Resolve a SoundCloud set/playlist into lightweight tracks (stream resolved lazily on play).
 *  Handles large DJ sets: full extraction with generous limits, a fast flat-listing
 *  fallback, and a whole-set YouTube fallback for DRM/unavailable sets. */
export async function resolveSoundcloudSet(input: string): Promise<ResolvedSoundcloudTrack[]> {
  const url = input.trim().startsWith('http') ? input.trim() : `https://${input.trim()}`;

  // 1) Full extraction — real titles, but slow/heavy for large DJ sets. Generous
  //    limits so a 100+ track set doesn't blow the 60s/4MB defaults.
  let lines: string[] = [];
  try {
    const raw = await runYtDlp(
      ['--no-warnings', '--print', '%(webpage_url)s|%(title)s|%(uploader)s', url],
      1,
      { timeoutMs: 180_000, maxBufferBytes: 16 * 1024 * 1024 },
    );
    lines = raw.trim().split(/\r?\n/).filter((l) => l.includes('|'));
  } catch (err) {
    console.warn(
      `[soundcloud] full set extraction failed — trying flat listing: ${err instanceof Error ? err.message : err}`,
    );
  }

  // 2) Fast flat listing fallback — titles are often "NA"; derive them from the slug.
  if (lines.length === 0) {
    try {
      const raw = await runYtDlp(
        ['--no-warnings', '--flat-playlist', '--print', '%(webpage_url)s|%(title)s|%(uploader)s', url],
        1,
        { timeoutMs: 90_000, maxBufferBytes: 8 * 1024 * 1024 },
      );
      lines = raw.trim().split(/\r?\n/).filter((l) => l.includes('|'));
    } catch (err) {
      console.warn(`[soundcloud] flat set listing failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  const tracks = lines
    .map((line): ResolvedSoundcloudTrack | null => {
      // Pipe-safe: exactly 2 separators — titles may contain '|'.
      const m = line.match(/^([^|]*)\|([^|]*)\|(.*)$/s);
      const entryUrl = m?.[1] ?? '';
      const rawTitle = m?.[2] ?? '';
      const uploader = m?.[3] ?? '';
      if (!entryUrl) return null;
      const title =
        !rawTitle || /^(na|none|null)$/i.test(rawTitle.trim()) ? slugFromUrl(entryUrl) : rawTitle;
      return {
        videoId: entryUrl,
        uri: toSoundcloudUri(entryUrl),
        name: title,
        artists: [uploader || 'SoundCloud'],
        album: 'SoundCloud',
        durationMs: 0,
        source: 'soundcloud' as const,
        streamUrl: '',
        channel: uploader || 'SoundCloud',
      };
    })
    .filter((t): t is ResolvedSoundcloudTrack => t !== null);
  if (tracks.length > 0) return tracks;

  // 3) Whole-set fallback: treat it as one long mix — search YouTube for the set
  //    title (covers DRM-only/unavailable sets and single long uploads).
  const slug = slugFromUrl(url);
  if (slug && slug !== 'SoundCloud track') {
    const yt = await searchAndResolveYoutube(slug);
    if (yt) {
      console.log(`[soundcloud] set unavailable — falling back to YouTube: "${yt.name}"`);
      return [yt as ResolvedSoundcloudTrack];
    }
  }
  throw new SoundcloudError('That SoundCloud set appears to be empty or unavailable.');
}
