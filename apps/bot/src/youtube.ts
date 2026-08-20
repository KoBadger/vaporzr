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

function runYtDlp(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      config.ytDlpPath,
      args,
      { windowsHide: true, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
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

/** Resolve a YouTube video (id or URL) into a queuable track with a live stream URL. */
export async function resolveYoutubeVideo(input: string): Promise<ResolvedVideo> {
  const id = extractYoutubeId(input) ?? (input.trim().match(/^[A-Za-z0-9_-]{6,}$/) ? input.trim() : null);
  if (!id) throw new YoutubeError('Could not parse that YouTube link.');

  const url = `https://www.youtube.com/watch?v=${id}`;
  const raw = await runYtDlp([
    '--no-playlist',
    '--no-warnings',
    '-f',
    'best[height<=720][acodec!=none]/best[acodec!=none]/best',
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
 * Search AND resolve a stream URL in a single yt-dlp subprocess call using
 * `ytsearch1:`. Returns a fully resolved ResolvedVideo with streamUrl ready,
 * or null if nothing matched. This avoids the two-step YouTube API + yt-dlp
 * dance that `searchYoutube` + `resolveYoutubeVideo` would require.
 */
export async function searchAndResolveYoutube(query: string): Promise<ResolvedVideo | null> {
  try {
    const raw = await runYtDlp([
      '--no-playlist',
      '--no-warnings',
      '-f',
      'best[height<=720][acodec!=none]/best[acodec!=none]/best',
      '--get-url',
      '--print',
      '%(id)s|%(title)s|%(duration)s|%(thumbnail)s|%(channel)s',
      `ytsearch1:${query}`,
    ]);
    const lines = raw.trim().split(/\r?\n/);
    const metaLine = lines.find((l) => l.includes('|'));
    const streamUrl = lines.find((l) => l.startsWith('https://'));
    if (!metaLine || !streamUrl) return null;
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
  } catch {
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
