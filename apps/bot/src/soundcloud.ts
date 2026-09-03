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

function ytDlpOnce(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const noProxyEnv = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !k.toLowerCase().endsWith('_proxy')),
    );
    const flags = ['--no-check-certificates'];
    if (config.youtubeCookiesPath) flags.push('--cookies', config.youtubeCookiesPath);
    execFile(
      config.ytDlpPath,
      [...flags, ...args],
      { windowsHide: true, timeout: 60_000, maxBuffer: 4 * 1024 * 1024, env: noProxyEnv },
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

/** Resolve a SoundCloud set/playlist into lightweight tracks (stream resolved lazily on play). */
export async function resolveSoundcloudSet(input: string): Promise<ResolvedSoundcloudTrack[]> {
  const url = input.trim().startsWith('http') ? input.trim() : `https://${input.trim()}`;

  // Full extraction (not --flat-playlist): SoundCloud flat entries only report
  // "NA" titles. Each entry's page URL is stored so the stream is resolved
  // lazily on play (full extraction's `url` field is only a 30s preview).
  const raw = await runYtDlp([
    '--no-warnings',
    '--print',
    '%(webpage_url)s|%(title)s|%(uploader)s',
    url,
  ]);

  const lines = raw.trim().split(/\r?\n/).filter((l) => l.includes('|'));

  const tracks = lines
    .map((line): ResolvedSoundcloudTrack | null => {
      // Pipe-safe: exactly 2 separators — titles may contain '|'.
      const m = line.match(/^([^|]*)\|([^|]*)\|(.*)$/s);
      const entryUrl = m?.[1] ?? '';
      const title = m?.[2] ?? '';
      const uploader = m?.[3] ?? '';
      if (!entryUrl || !title) return null;
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
  if (tracks.length === 0) {
    throw new SoundcloudError('That SoundCloud set appears to be empty or unavailable.');
  }
  return tracks;
}
