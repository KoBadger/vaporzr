import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { youtubeProxyHops } from '@vaporzr/core/youtube';

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
/** Cached egress IP per route+family (mirrors VoiceManager.routeIp). */
const routeIps = new Map<string, Promise<string>>();

/** fetch() through one specific hop ('' = direct), reusing a cached agent. */
async function fetchViaProxy(url: string, proxy: string, init: RequestInit): Promise<Response> {
  if (!proxy) return fetch(url, init);
  let agent = proxyAgents.get(proxy);
  if (!agent) {
    const { ProxyAgent } = await import('undici');
    agent = new ProxyAgent(proxy);
    proxyAgents.set(proxy, agent);
  }
  const { fetch: uFetch } = await import('undici');
  return (await uFetch(url, { ...init, dispatcher: agent } as never)) as unknown as Response;
}

/** A route's egress IP ('' = direct) for one address family, probed once. */
async function egressIp(proxy: string, family: 4 | 6): Promise<string> {
  const key = `${proxy}|${family}`;
  let pending = routeIps.get(key);
  if (!pending) {
    pending = (async () => {
      try {
        const res = await fetchViaProxy(
          family === 6 ? 'https://api64.ipify.org' : 'https://api.ipify.org',
          proxy,
          { signal: AbortSignal.timeout(6000) },
        );
        return res.ok ? (await res.text()).trim() : '';
      } catch {
        return '';
      }
    })();
    routeIps.set(key, pending);
  }
  return pending;
}

/**
 * Fetch a media URL, routing googlevideo through the hop that minted it.
 * googlevideo URLs are signed against the exit IP that minted them, so
 * fetching one from a different egress returns a redirect with ZERO bytes —
 * the same reason the playback path matches routes by the URL's `ip=`. Both
 * address families are probed: a WARP egress records an IPv6 `ip=` even when
 * the resolve forced IPv4.
 */
async function mediaFetch(url: string, init: RequestInit): Promise<Response> {
  if (!/googlevideo\.com\//.test(url)) return fetch(url, init);
  const mintedIp = decodeURIComponent(/[?&]ip=([^&]+)/.exec(url)?.[1] ?? '');
  const family: 4 | 6 = mintedIp.includes(':') ? 6 : 4;
  const hops = youtubeProxyHops();
  let route: string | null = null;
  if (mintedIp) {
    for (const candidate of [...hops, '']) {
      const ip = await egressIp(candidate, family);
      if (ip && ip === mintedIp) {
        route = candidate;
        break;
      }
    }
  }
  // No route matched (the URL names no IP, or the minting hop is gone): prefer
  // the first configured hop, else go direct. A 403 afterwards is survivable —
  // the caller refreshes the URL, which re-resolves through whatever works now.
  if (route === null) route = hops[0] ?? '';
  try {
    return await fetchViaProxy(url, route, init);
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
