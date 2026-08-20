import { execFile } from 'node:child_process';
import { config } from './config.js';
import type { ResolvedTrack } from './spotify.js';

export class SoundcloudError extends Error {}

export interface ResolvedSoundcloudTrack extends ResolvedTrack {
  videoId: string;
  streamUrl: string;
  channel: string;
  thumbnail?: string;
}

const SC_URL_RE = /(^|[./])(soundcloud\.com|snd\.sc)\//;

export function isSoundcloudUrl(input: string): boolean {
  return SC_URL_RE.test(input);
}

export function isSoundcloudSetUrl(input: string): boolean {
  return /\/sets\//.test(input);
}

/** Track URIs carry the source URL so lazy playlist entries can be resolved later. */
export function soundcloudUriToUrl(uri: string): string {
  return decodeURIComponent(uri.replace(/^soundcloud:/, ''));
}

function toSoundcloudUri(url: string): string {
  return `soundcloud:${encodeURIComponent(url)}`;
}

function runYtDlp(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      config.ytDlpPath,
      args,
      { windowsHide: true, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
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

/** Resolve a SoundCloud track URL into a queuable track with a live audio stream. */
export async function resolveSoundcloudVideo(input: string): Promise<ResolvedSoundcloudTrack> {
  const url = input.trim().startsWith('http') ? input.trim() : `https://${input.trim()}`;

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

  const [pageUrl, title, duration, thumbnail, uploader] = metaLine.split('|');
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
  if (lines.length === 0) throw new SoundcloudError('That SoundCloud set appears to be empty or unavailable.');

  return lines
    .map((line): ResolvedSoundcloudTrack | null => {
      const [entryUrl, title, uploader] = line.split('|');
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
}
