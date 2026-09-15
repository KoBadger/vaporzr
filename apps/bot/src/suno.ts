import { spawn } from 'node:child_process';
import { config } from './config.js';
import type { ResolvedVideo } from './youtube.js';

export class SunoError extends Error {}

const SUNO_RE = /(^|[./])(suno\.com|suno\.ai)\/(?:s\/[A-Za-z0-9_-]+|song\/|embed\/|clip\/|playlist\/)/;
const SUNO_CDN_RE = /(^|[./])cdn1\.suno\.ai\//;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const BARE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/** Only treat input as Suno when it's a Suno link, its CDN, or a bare UUID —
 *  a UUID appearing anywhere in an unrelated URL must not hijack other sources. */
export function isSunoUrl(input: string): boolean {
  const t = input.trim();
  return SUNO_RE.test(t) || SUNO_CDN_RE.test(t) || BARE_UUID_RE.test(t);
}

function extractUuid(input: string, html: string): string | null {
  const canonical = html.match(/<link rel="canonical" href="https:\/\/suno\.com\/song\/([0-9a-f-]{36})"/);
  if (canonical) return canonical[1];
  // Next.js RSC payload: \"id\":\"<uuid>\",\"entity_type\":\"song_schema\"
  const rsc = html.match(/\\"id\\":\\"([0-9a-f-]{36})\\",\\"entity_type\\":\\"song_schema\\"/);
  if (rsc) return rsc[1];
  const direct = input.match(UUID_RE);
  return direct ? direct[0] : null;
}

/** fetch() that routes through the Suno proxy when one is configured. Optional
 *  escape hatch — the current Suno clip API + CloudFront media work direct. */
async function proxyFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const proxy = config.sunoProxy;
  if (!proxy) return fetch(url, init);
  try {
    const { ProxyAgent, fetch: uFetch } = await import('undici');
    const dispatcher = new ProxyAgent(proxy);
    const res = await uFetch(url, { ...(init as Record<string, unknown>), dispatcher } as never);
    return res as unknown as Response;
  } catch (err) {
    console.warn(`[suno] proxy fetch failed, retrying direct: ${err instanceof Error ? err.message : err}`);
    return fetch(url, init);
  }
}

/** Probe a remote audio URL's duration via ffmpeg (reads headers only). */
export function probeDuration(url: string, proxy = ''): Promise<number | null> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.toLowerCase().endsWith('_proxy')),
  );
  if (proxy) env.http_proxy = proxy;
  return new Promise((resolve) => {
    const proc = spawn(config.ffmpegPath, ['-hide_banner', '-i', url], { windowsHide: true, env });
    let stderr = '';
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
    }, 15000);
    timer.unref?.();
    proc.on('exit', () => {
      clearTimeout(timer);
      const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
      if (!m) return resolve(null);
      resolve((Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000);
    });
    proc.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

interface SunoClip {
  title?: string;
  duration?: number;
  image_url?: string;
  image_large_url?: string;
  handle?: string;
  display_name?: string;
  audio_url?: string;
  media_urls?: Array<{ url?: string; content_type?: string; delivery?: string }>;
  metadata?: { duration?: number; tags?: string; display_name?: string };
}

const SUNO_CLIP_API = 'https://studio-api.prod.suno.com/api/clip';

/**
 * Resolve a Suno song (suno.com/song/<uuid>, /s/<slug>, /embed/<uuid>, or a bare
 * uuid). Suno's CDN now uses signed URLs, so the bare cdn1.suno.ai mp3 is dead —
 * instead we read the public clip API, which returns the real playable media URL
 * (a CloudFront m4a) plus title/duration/artwork. No auth or proxy required.
 */
export async function resolveSuno(input: string): Promise<ResolvedVideo> {
  const trimmed = input.trim();
  const uuidOnly = !/^https?:/i.test(trimmed) && UUID_RE.test(trimmed);
  const url = uuidOnly ? `https://suno.com/song/${trimmed}` : trimmed.startsWith('http') ? trimmed : `https://${trimmed}`;
  if (!/(^|[./])suno\.(com|ai)\//.test(url) && !UUID_RE.test(url)) {
    throw new SunoError('That does not look like a Suno link.');
  }

  // Song id straight from the URL when possible, else scrape the page.
  let uuid = url.match(/\/song\/([0-9a-f-]{36})/i)?.[1] ?? trimmed.match(UUID_RE)?.[0] ?? null;
  if (!uuid) {
    let html = '';
    try {
      const res = await proxyFetch(url, {
        redirect: 'follow',
        headers: { 'user-agent': UA, accept: 'text/html' },
      });
      if (res.ok) html = await res.text();
    } catch {
      /* fall through to the error below */
    }
    uuid = extractUuid(url, html);
    if (!uuid) throw new SunoError('Could not find the track id in that Suno page.');
  }

  // Public clip API → real media URL + metadata.
  let clip: SunoClip | null = null;
  try {
    const res = await proxyFetch(`${SUNO_CLIP_API}/${uuid}/`, {
      headers: { 'user-agent': UA, accept: 'application/json' },
    });
    if (res.ok) clip = (await res.json()) as SunoClip;
  } catch (err) {
    console.warn(`[suno] clip API failed: ${err instanceof Error ? err.message : err}`);
  }

  const media = clip?.media_urls ?? [];
  const pick = media.find((m) => /progressive/i.test(m.delivery ?? '')) ?? media[0];
  let streamUrl = pick?.url ?? '';
  if (!streamUrl && clip?.audio_url && !/\/forbidden/.test(clip.audio_url)) streamUrl = clip.audio_url;
  if (!streamUrl) streamUrl = `https://cdn1.suno.ai/${uuid}.mp3`; // legacy fallback

  const name = clip?.title?.trim() || 'Suno track';
  const artist = clip?.handle || clip?.display_name || 'Suno';
  const image = clip?.image_large_url || clip?.image_url;
  const durationMs = Math.round((Number(clip?.metadata?.duration ?? clip?.duration) || 0) * 1000);

  return {
    videoId: uuid,
    uri: `suno:${uuid}`,
    name,
    artists: [artist],
    album: 'Suno',
    durationMs,
    image,
    source: 'suno',
    streamUrl,
    channel: artist,
    thumbnail: image,
  };
}
