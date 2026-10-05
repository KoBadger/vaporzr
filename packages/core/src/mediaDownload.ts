import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '@vaporzr/core/config';

/**
 * Download an http(s) media stream to a temp file using Node's fetch (Range
 * chunks + a browser User-Agent). ffmpeg's own HTTPS client is rejected with 403
 * on googlevideo URLs (TLS fingerprint), which is why the main playback path
 * pipes bytes through Node — this does the same for `/mix`, where ffmpeg needs
 * the media as a seekable input. Returns the temp path (caller deletes it) or
 * null on failure.
 */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

/**
 * Optional way for a caller to obtain a FRESH URL for the same media. googlevideo
 * signed URLs expire and intermittently answer 403; when this is supplied the
 * download transparently retries from byte 0 with a new URL instead of failing.
 */
export type RefreshUrl = () => Promise<string | undefined>;

/** A 403/429 that a fresh URL may fix — distinct from a genuinely bad URL. */
class RetryableUrlError extends Error {}

/** Cached undici ProxyAgents, keyed by proxy URL (mirrors VoiceManager.mediaFetch). */
const proxyAgents = new Map<string, unknown>();

/**
 * Fetch a media URL, routing googlevideo through the residential proxy when one
 * is configured. googlevideo URLs are signed against the proxy exit IP that
 * minted them, so fetching them directly returns 403 with ZERO bytes — the same
 * reason the playback path routes through a pooled ProxyAgent.
 */
async function mediaFetch(url: string, init: RequestInit): Promise<Response> {
  const proxy = config.youtubeProxy && /googlevideo\.com\//.test(url) ? config.youtubeProxy : '';
  if (!proxy) return fetch(url, init);
  try {
    let agent = proxyAgents.get(proxy);
    if (!agent) {
      const { ProxyAgent } = await import('undici');
      agent = new ProxyAgent(proxy);
      proxyAgents.set(proxy, agent);
    }
    const { fetch: uFetch } = await import('undici');
    return (await uFetch(url, { ...init, dispatcher: agent } as never)) as unknown as Response;
  } catch {
    return fetch(url, init);
  }
}

async function downloadOnce(url: string, file: string, maxBytes: number): Promise<number> {
  let handle: Awaited<ReturnType<typeof fs.promises.open>> | null = null;
  try {
    handle = await fs.promises.open(file, 'w');
    let offset = 0;
    const CHUNK = 512 * 1024;
    for (;;) {
      const res = await mediaFetch(url, {
        headers: { 'User-Agent': UA, Range: `bytes=${offset}-${offset + CHUNK - 1}` },
      });
      if (res.status === 416) break; // past EOF
      if (res.status === 403 || res.status === 429) {
        // Signed-URL throttle/expiry: signal the caller to refresh. Any bytes
        // already written are discarded by the caller before retrying.
        throw new RetryableUrlError(`HTTP ${res.status}`);
      }
      if (res.status !== 206 && res.status !== 200) throw new Error(`HTTP ${res.status}`);
      const chunk = Buffer.from(await res.arrayBuffer());
      if (!chunk.length) break;
      await handle.write(chunk);
      offset += chunk.length;
      if (offset >= maxBytes) break;
      if (chunk.length < CHUNK) break;
    }
    return offset;
  } finally {
    try {
      await handle?.close();
    } catch {
      /* ignore */
    }
  }
}

export async function downloadToTempFile(
  url: string,
  maxBytes = 80 * 1024 * 1024,
  refreshUrl?: RefreshUrl,
): Promise<string | null> {
  const file = path.join(os.tmpdir(), `vaporzr-mix-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  let current = url;
  // One original attempt plus up to two refreshed attempts, mirroring the
  // playback path's refresh-on-403 behaviour.
  const MAX_ATTEMPTS = refreshUrl ? 3 : 1;
  try {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const bytes = await downloadOnce(current, file, maxBytes);
        if (bytes === 0) {
          fs.rmSync(file, { force: true });
          return null;
        }
        return file;
      } catch (err) {
        const retryable = err instanceof RetryableUrlError;
        const canRetry = retryable && refreshUrl && attempt < MAX_ATTEMPTS - 1;
        if (!canRetry) throw err;
        fs.rmSync(file, { force: true }); // discard the partial before retrying
        const fresh = await refreshUrl!().catch(() => undefined);
        if (!fresh) throw err;
        console.warn(`[mix] stream URL rejected (${(err as Error).message}) — refreshed and retrying`);
        current = fresh;
      }
    }
    fs.rmSync(file, { force: true });
    return null;
  } catch {
    fs.rmSync(file, { force: true });
    return null;
  }
}
