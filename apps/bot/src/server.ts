import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, domainToASCII } from 'node:url';
import { config } from '@vaporzr/core/config';
import {
  buildAuthorizeUrl,
  exchangeCode,
  getAccessToken,
  SpotifyError,
  spotifyCacheSize,
  spotifyCooldownRemainingSec,
} from '@vaporzr/core/spotify';
import { tokenStore } from '@vaporzr/core/tokenStore';
import { Bridge } from './bridge.js';
import { SessionManager } from './session.js';
import { PermissionsManager } from './permissions.js';
import { vizTunnel } from './tunnel.js';
import { secretEquals, keyFromCookieHeader, masterPasswordEquals } from './secretCompare.js';
import { handleVideoProxy } from './videoProxy.js';
import { renderJamCardPng } from './jamCardArt.js';
import { resolveJamCode } from './jamLinks.js';
import {
  SESSION_COOKIE,
  INVITE_TTL_MS,
  OWNER_LINK_TTL_MS,
  consumeInvite,
  mintInvite,
  mintSession,
  noteAuthFailure,
  authThrottle,
  clearAuthFailures,
  resolveSession,
  revokeInvite,
  revokeSession,
  revokeSessionByToken,
  listAccess,
  scopeSatisfies,
  webAccessAllowed,
  tokenFromCookieHeader,
  type AccessScope,
} from './access.js';
import { statsStore } from '@vaporzr/core/stats';

/** Pre-gzipped vendor assets — preset chunks are tens of MB of JS. */
const vendorCache = new Map<string, { body: Buffer; gzip: boolean }>();

/**
 * Track artwork, relayed through this origin.
 *
 * A Discord Activity runs under a CSP that Discord injects, and its img-src does
 * not include the artwork CDNs — so a bare `https://i.scdn.co/...` in an <img>
 * fails INSIDE the Activity while working perfectly in a browser. The visualizer
 * then shows a broken-image icon even though the URL is valid. Serving the image
 * from our own origin sidesteps the policy entirely, since the page's own origin
 * is always allowed.
 *
 * Host-locked on purpose: this must never become an open image proxy.
 */
const ART_HOSTS = new Set(
  [
    'i.scdn.co',
    'image-cdn-fa.spotifycdn.com',
    'image-cdn-ak.spotifycdn.com',
    'image-cdn-origin.spotifycdn.com',
    'mosaic.scdn.co',
    'i.ytimg.com',
    'img.youtube.com',
    'yt3.ggpht.com',
    'lh3.googleusercontent.com',
  ].map((h) => h.toLowerCase()),
);
const artCache = new Map<string, { body: Buffer; type: string; at: number }>();
const ART_TTL_MS = 6 * 60 * 60 * 1000;
const ART_MAX_BYTES = 6 * 1024 * 1024;
/** Total artwork bytes held in memory. 200 entries × 6 MB would be ~1.2 GB, so
 *  the cache is bounded by bytes as well as by count. */
const ART_CACHE_BYTES = 64 * 1024 * 1024;
let artCacheBytes = 0;

/** Evict oldest-first until both the entry and byte budgets fit. */
function trimArtCache(): void {
  while (artCache.size > 200 || (artCacheBytes > ART_CACHE_BYTES && artCache.size > 0)) {
    const oldest = artCache.keys().next();
    if (oldest.done) break;
    const evicted = artCache.get(oldest.value);
    if (evicted) artCacheBytes -= evicted.body.length;
    artCache.delete(oldest.value);
  }
}

async function serveArtwork(url: URL, res: http.ServerResponse): Promise<void> {
  const raw = url.searchParams.get('u') ?? '';
  // Only ever fetch http(s) from the allowlist. Parsing with URL (not a string
  // test) is what makes a lookalike host like i.scdn.co.evil.com fail.
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad artwork URL.');
    return;
  }
  const normalizedHost = domainToASCII(target.hostname).toLowerCase();
  if (target.protocol !== 'https:' || !normalizedHost || !ART_HOSTS.has(normalizedHost)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Artwork host not allowed.');
    return;
  }
  // Rebuild from validated components so the fetched origin is server-controlled.
  // Assigning pathname/search (instead of resolving a relative URL) is what keeps
  // a "//host" path from being read as a fresh origin.
  const safeTarget = new URL(`https://${normalizedHost}`);
  safeTarget.pathname = target.pathname;
  safeTarget.search = target.search;
  const key = safeTarget.toString();
  const hit = artCache.get(key);
  if (hit && Date.now() - hit.at < ART_TTL_MS) {
    res.writeHead(200, {
      'Content-Type': hit.type,
      'Cache-Control': 'public, max-age=86400',
      'X-Art-Cache': 'hit',
    });
    res.end(hit.body);
    return;
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    let fetchUrl = safeTarget.toString();
    let upstream = await fetch(fetchUrl, { signal: ctrl.signal, redirect: 'manual' });
    if (upstream.status >= 300 && upstream.status < 400) {
      const location = upstream.headers.get('location');
      if (!location) {
        clearTimeout(timer);
        res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Artwork unavailable.');
        return;
      }
      const redirected = new URL(location, fetchUrl);
      const redirectHost = domainToASCII(redirected.hostname).toLowerCase();
      if (redirected.protocol !== 'https:' || !redirectHost || !ART_HOSTS.has(redirectHost)) {
        clearTimeout(timer);
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Artwork host not allowed.');
        return;
      }
      // Same rebuild as above: the hop's origin comes from the allowlisted host.
      const hop = new URL(`https://${redirectHost}`);
      hop.pathname = redirected.pathname;
      hop.search = redirected.search;
      fetchUrl = hop.toString();
      upstream = await fetch(fetchUrl, { signal: ctrl.signal, redirect: 'error' });
    }
    clearTimeout(timer);
    if (!upstream.ok) {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Artwork unavailable.');
      return;
    }
    const type = upstream.headers.get('content-type') ?? 'image/jpeg';
    if (!type.startsWith('image/')) {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Artwork was not an image.');
      return;
    }
    // Refuse an oversized body from its declared length BEFORE buffering it —
    // arrayBuffer() would otherwise materialise the whole thing first.
    const declared = Number(upstream.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > ART_MAX_BYTES) {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Artwork too large.');
      return;
    }
    const body = Buffer.from(await upstream.arrayBuffer());
    if (body.length === 0 || body.length > ART_MAX_BYTES) {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Artwork too large.');
      return;
    }
    const previous = artCache.get(key);
    if (previous) artCacheBytes -= previous.body.length;
    artCache.set(key, { body, type, at: Date.now() });
    artCacheBytes += body.length;
    trimArtCache();
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': 'public, max-age=86400',
      'X-Art-Cache': 'miss',
    });
    res.end(body);
  } catch {
    res.writeHead(504, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Artwork fetch timed out.');
  }
}
import { playlistStore } from '@vaporzr/core/playlists';
import { cookieAgeDays, probeYtDlpVersion, probeYoutube, ytDlpVersion, youtubeHealth } from '@vaporzr/core/youtube';
import { addPushSubscription, pushPublicKey, pushSubscriptionCount, removePushSubscription } from './push.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Cached health of the bgutil YouTube PO-token provider (host loopback :4416).
 * Without it YouTube extraction silently degrades, so surface it in /health.
 * "unknown" until the first probe lands.
 */
let poTokenStatus: 'up' | 'down' | 'unknown' = 'unknown';
let poTokenVersion = 'unknown';
function probePoTokenProvider(): void {
  const req = http.get({ host: '127.0.0.1', port: 4416, path: '/ping', timeout: 1500 }, (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      body += chunk;
    });
    res.on('end', () => {
      poTokenStatus = res.statusCode === 200 ? 'up' : 'down';
      // /ping answers {"server_uptime":…,"version":…} — keep the version so
      // /health shows when the provider image has gone stale.
      try {
        const v = (JSON.parse(body) as { version?: unknown }).version;
        if (typeof v === 'string' && v) poTokenVersion = v;
      } catch {
        /* non-JSON ping — version stays unknown */
      }
    });
  });
  req.on('timeout', () => {
    poTokenStatus = 'down';
    req.destroy();
  });
  req.on('error', () => {
    poTokenStatus = 'down';
  });
}

export function startServer(sessions: SessionManager, perms: PermissionsManager): Bridge {
  // Declared here so the request handler (which runs later) can read live
  // guild data from the bridge once it exists.
  let bridge: Bridge | null = null;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${config.port}`);
    // HTML routes are dev-iterated constantly — never let browsers serve stale
    // copies (the /vendor route below overrides this with long caching).
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Open health check — minimal metadata for uptime monitors.
    if (url.pathname === '/health') {
      const guilds = bridge?.guildCount ?? 0;
      const all = sessions.all();
      const bridgeInstance: Bridge | null = bridge;
      const librespotStatus = bridgeInstance?.librespot.isRunning() ? 'running' : 'stopped';
      // Live Spotify cooldown so an active rate-limit is visible from outside
      // instead of only surfacing per-command hours later.
      const spotifyCooldownSec = spotifyCooldownRemainingSec();
      const spotifyApiStatus = spotifyCooldownSec > 0 ? 'rate-limited' : 'healthy';
      const body = JSON.stringify({
        ok: true,
        uptimeSec: Math.round(process.uptime()),
        guilds,
        playing: all.filter((s) => s.queue.getState().playing).length,
        sessions: all.length,
        librespot: librespotStatus,
        spotifyApi: spotifyApiStatus,
        spotifyCooldownSec,
        poToken: poTokenStatus,
        poTokenVersion,
        youtube: youtubeHealth().status,
        ytdlp: ytDlpVersion(),
        build: (process.env.VAPORZR_BUILD ?? 'dev').slice(0, 7),
        // The origin every generated link is built from. One field makes a
        // half-finished domain migration obvious instead of a mystery in QR codes.
        publicBase: config.staticBaseUrl || null,
        cookieAgeDays: cookieAgeDays(),
        push: pushSubscriptionCount(),
        memory: {
          heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
          heapTotalMb: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
          rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
        },
        cache: {
          entries: spotifyCacheSize(),
        },
      });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(body);
      return;
    }

    void handleRoute(req, url, res, () => bridge);
  });

  bridge = new Bridge(sessions, perms, server);

  // Bind the port BEFORE starting librespot (whose killStale() would otherwise
  // kill a running instance's processes while this one races to bind). If the
  // port is taken we exit quietly — the running bot is left untouched.
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`[vaporzr] port ${config.port} is already in use by another instance — exiting.`);
      process.exit(0);
    }
    console.error(`[vaporzr] server error: ${err.message}`);
  });
  server.listen(config.port, config.bindAddress, () => {
    console.log(`[vaporzr] control server on http://${config.bindAddress}:${config.port}`);
    vizTunnel.start();
    bridge?.startLibrespot();
  });

  // Watch the PO-token provider so /health reflects it (see poTokenStatus).
  probePoTokenProvider();
  const poTimer = setInterval(probePoTokenProvider, 30_000);
  poTimer.unref?.();

  // One-shot: the yt-dlp version only changes when the image does.
  void probeYtDlpVersion();

  // YouTube canary: catch expired cookies / dead solver / dead proxy up front.
  const cookieAge = cookieAgeDays();
  if (cookieAge === null) {
    console.warn('[vaporzr] no YouTube cookies file found — YouTube may hit the bot check. Set YOUTUBE_COOKIES_PATH.');
  } else if (cookieAge > 21) {
    console.warn(
      `[vaporzr] YouTube cookies are ~${cookieAge} days old — they expire soon; refresh /opt/vaporzr/cookies.txt.`,
    );
  }
  // Delay the first probe. Right after boot the PO-token HTTP server is still
  // coming up, and a transient failure here is reported as `proxy` — which,
  // with the 15-min interval, is two consecutive probes and therefore a real
  // owner alert (it fired once while the bridge was actually healthy).
  const ytBoot = setTimeout(() => void probeYoutube(), 90_000);
  ytBoot.unref?.();
  const ytTimer = setInterval(() => void probeYoutube(), 15 * 60 * 1000);
  ytTimer.unref?.();

  // Prune stale uploads at boot and daily.
  pruneUploads();
  const upTimer = setInterval(() => pruneUploads(), 24 * 60 * 60 * 1000);
  upTimer.unref?.();

  // Optional external dead-man's-switch: ping it so a stopped process is noticed.
  if (config.healthcheckPingUrl) {
    const ping = (): void => {
      void fetch(config.healthcheckPingUrl, { signal: AbortSignal.timeout(10_000) }).catch(() => {});
    };
    ping();
    const hcTimer = setInterval(ping, 5 * 60 * 1000);
    hcTimer.unref?.();
  }

  return bridge;
}

/**
 * Which credential a page needs. Everything that can hear or change playback is
 * gated now: `/` (portal), `/panel` (control), `/viz` (visuals + PCM), `/listen`
 * (raw audio). `/activity` stays open because Discord's iframe cannot carry a
 * cookie; it connects as a guest and receives bars, never PCM. `/request` keeps
 * its separate lower-privilege request key.
 */
/**
 * True for a request that is not a browser navigation: Discord's Embedded App
 * Proxy fetches our pages server-side (no Sec-Fetch headers) and proxies them
 * into the Activity iframe, which cannot carry our session cookie. Those
 * requests get the Activity page - a guest surface that grants nothing until
 * the owner approves a pairing code - instead of the key screen. Real browsers
 * always send Sec-Fetch-Mode, so the gate still applies to them.
 */
function isActivityFetch(req: http.IncomingMessage): boolean {
  // Discord launches the Activity into an iframe at the mapped root with an
  // instance token. That token is the reliable signal: the proxy sometimes
  // sends fetch metadata that does not say "iframe", and older clients send
  // none at all. Treating *missing* metadata as Activity used to hand the
  // visualizer to curl (and to any crawler hitting /panel) while a real
  // Activity with `Sec-Fetch-Dest: document` fell through to the key gate.
  if (req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'iframe') return true;
  try {
    return new URL(req.url ?? '/', 'http://localhost').searchParams.has('instance_id');
  } catch {
    return false;
  }
}

function accessNeedFor(pathname: string): AccessScope | null {
  // DJ links open the same panel, but the socket only gets the playback
  // command allowlist (enforced in bridge.ts).
  if (pathname === '/panel' || pathname === '/panel.html') return 'dj';
  // Decks change what the whole voice channel hears — same gate as the panel.
  if (pathname === '/deck' || pathname === '/deck.html' || pathname === '/decks') return 'control';
  // `/` is the public portal. The old status page moved to /status.
  if (pathname === '/status') return 'view';
  if (pathname === '/viz' || pathname === '/viz.html') return 'view';
  if (pathname === '/listen' || pathname === '/listen.html') return 'view';
  return null;
}

/** The owner's human-memorable recovery password, accepted anywhere SHARE_KEY
 *  is. Empty when unset. */
export function isMasterPassword(value: string | undefined | null): boolean {
  return masterPasswordEquals(value, config.masterPassword);
}

/** True when the request carries a session (or the master key/password) for `need`. */
export function hasShareAccess(req: http.IncomingMessage, url: URL, need: AccessScope = 'control'): boolean {
  const key = config.shareKey;
  // A configured master password keeps the gate on even if SHARE_KEY is empty.
  if (!key && !config.masterPassword) return true;
  const cookie = req.headers.cookie ?? '';
  const session = resolveSession(tokenFromCookieHeader(cookie));
  if (session && scopeSatisfies(session.scope, need)) return true;
  // Legacy devices from before sessions hold the raw-key cookie: still valid,
  // and grantPageAccess upgrades them to a real session on the next page hit.
  const cookieKey = keyFromCookieHeader(cookie);
  const urlKey = url.searchParams.get('key');
  if (key && (secretEquals(cookieKey, key) || secretEquals(urlKey, key))) return true;
  return isMasterPassword(cookieKey) || isMasterPassword(urlKey);
}

/** True when a control credential is configured at all.
 *
 *  `hasShareAccess` treats MASTER_PASSWORD as a live gate (an owner who only set
 *  the human-memorable password still expects the panel locked). Guards written
 *  as `if (config.shareKey && …)` skipped authentication entirely in that
 *  deployment, so they must all ask the same question the gate asks. */
function controlAuthRequired(): boolean {
  return Boolean(config.shareKey || config.masterPassword);
}

/**
 * CSP + framing policy for the hand-written pages. Scripts stay inline (the
 * pages are single-file by design), but everything else is pinned to this
 * origin: no third-party script hosts, no external frames, form posts only here.
 */
function htmlSecurityHeaders(res: http.ServerResponse, activity = false): void {
  if (res.hasHeader('Content-Security-Policy')) return;
  const frame = activity
    ? 'frame-ancestors https://discord.com https://*.discordsays.com https://*.discordapp.com'
    : "frame-ancestors 'none'";
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: blob: https:; media-src 'self' blob:; " +
      "script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "connect-src 'self' ws: wss:; font-src 'self' data: https://fonts.gstatic.com; " +
      "base-uri 'none'; form-action 'self'; " +
      frame,
  );
  if (!activity) res.setHeader('X-Frame-Options', 'DENY');
}

function sessionCookie(token: string, expiresAt: number, req: http.IncomingMessage): string {
  const proto = String(req.headers['x-forwarded-proto'] ?? '')
    .split(',')[0]
    .trim();
  const secure = proto === 'https' || /^https:/i.test(config.staticBaseUrl || '') ? '; Secure' : '';
  const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`;
}

function redirectStrippingCredentials(res: http.ServerResponse, pathname: string): void {
  res.writeHead(303, { Location: pathname, 'Cache-Control': 'no-store' });
  res.end();
}

/** decodeURIComponent that reports a malformed escape as null instead of
 *  throwing a URIError out of the request handler (which becomes a 500). */
function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function tooManyAttempts(res: http.ServerResponse, retryAfterMs: number): void {
  const secs = Math.max(1, Math.ceil(retryAfterMs / 1000));
  res.writeHead(429, { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': String(secs) });
  res.end(`Too many attempts. Try again in ${secs}s.`);
}

/**
 * Page gate. Returns true when the request may be served. Credentials arrive as
 *   - `vz_sess` cookie (normal case),
 *   - `vz_key` cookie or `?key=<master>` (owner recovery / legacy devices),
 *   - `?invite=<token>` (single-use link minted by /key give).
 * Query credentials are exchanged for a session cookie and redirected away so
 * the secret never stays in the address bar, history or a shared screenshot.
 */
function grantPageAccess(req: http.IncomingMessage, url: URL, res: http.ServerResponse, need: AccessScope): boolean {
  const key = config.shareKey;
  if (!key && !config.masterPassword) return true;
  const cookie = req.headers.cookie ?? '';
  const ip = req.socket.remoteAddress ?? 'unknown';

  const session = resolveSession(tokenFromCookieHeader(cookie), Date.now(), {
    userAgent: String(req.headers['user-agent'] ?? ''),
    ip,
  });
  if (session && scopeSatisfies(session.scope, need)) {
    clearAuthFailures(ip);
    return true;
  }

  const throttle = authThrottle(ip);
  if (!throttle.allowed) {
    tooManyAttempts(res, throttle.retryAfterMs);
    return false;
  }

  // Legacy raw-key cookie: upgrade silently to a session (control).
  const cookieKey = keyFromCookieHeader(cookie);
  if ((key && secretEquals(cookieKey, key)) || isMasterPassword(cookieKey)) {
    const { token, session: minted } = mintSession('control', 'remembered device', undefined, Date.now(), true);
    // Drop the raw key from the device now that it holds an opaque session.
    res.setHeader('Set-Cookie', [
      sessionCookie(token, minted.expiresAt, req),
      'vz_key=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax',
    ]);
    clearAuthFailures(ip);
    return true;
  }

  const qKey = url.searchParams.get('key');
  if (qKey && ((key && secretEquals(qKey, key)) || isMasterPassword(qKey))) {
    const { token, session: minted } = mintSession('control', 'owner link', undefined, Date.now(), true);
    res.setHeader('Set-Cookie', [
      sessionCookie(token, minted.expiresAt, req),
      'vz_key=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax',
    ]);
    clearAuthFailures(ip);
    redirectStrippingCredentials(res, url.pathname);
    return false;
  }

  // Invites are single-use; accept them in `invite=` (and `key=` for old links).
  const inviteToken =
    url.searchParams.get('invite') ??
    (qKey && !(key && secretEquals(qKey, key)) && !isMasterPassword(qKey) ? qKey : null);
  if (inviteToken) {
    const used = consumeInvite(inviteToken);
    if (used) {
      res.setHeader('Set-Cookie', sessionCookie(used.token, used.session.expiresAt, req));
      clearAuthFailures(ip);
      redirectStrippingCredentials(res, url.pathname);
      return false;
    }
    noteAuthFailure(ip);
    keyPrompt(res, 'That key or invite is not valid, or it has already been used.');
    return false;
  }

  if (qKey || url.searchParams.get('invite')) noteAuthFailure(ip);
  keyPrompt(res);
  return false;
}

/** Gate for the public /request page: its own lower-privilege key. */
/**
 * Song requests: the jam card now hands out a reusable, expiring "request"
 * invite instead of the static REQUEST_KEY. Sessions with request scope or
 * higher work too, and the legacy request key / vz_req cookie keep working.
 */
function hasRequestAccess(req: http.IncomingMessage, url: URL): boolean {
  if (!config.shareKey && !config.requestKey && !config.masterPassword) return true; // open LAN-only setup
  const cookie = req.headers.cookie ?? '';
  const sess = resolveSession(tokenFromCookieHeader(cookie));
  if (sess && scopeSatisfies(sess.scope, 'request')) return true;
  // The owner password opens every surface, including the jam/request page.
  const rawReq = /(?:^|;\s*)vz_req=([^;]+)/.exec(cookie)?.[1];
  if (isMasterPassword(rawReq) || isMasterPassword(url.searchParams.get('key'))) return true;
  if (config.requestKey) {
    const m = /(?:^|;\s*)vz_req=([^;]+)/.exec(cookie);
    if (m) {
      let value = m[1];
      try {
        value = decodeURIComponent(value);
      } catch {
        /* compare raw */
      }
      if (secretEquals(value, config.requestKey)) return true;
    }
    if (secretEquals(url.searchParams.get('key'), config.requestKey)) return true;
  }
  const inviteToken = url.searchParams.get('invite');
  if (inviteToken) {
    const used = consumeInvite(inviteToken);
    if (used && scopeSatisfies(used.session.scope, 'request')) return true;
  }
  return false;
}

/** Page version of the request gate: exchanges an invite for a session cookie. */
/** The tiny HTML a short jam link (/j/<code>) serves. Crawlers read the meta
 *  tags and unfurl an invite card wherever the link is pasted; humans' browsers
 *  jump straight to /jam with a script, and the meta refresh + noscript link
 *  cover everyone else. Null target = the code is unknown or expired. */
function jamHandoffHtml(target: string | null, kind: 'request' | 'crowd' = 'request'): string {
  const esc = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  if (!target) {
    return (
      `<!doctype html><meta charset="utf-8"><title>Vaporzr</title>` +
      `<meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<meta name="theme-color" content="#6a5cff">` +
      `<body style="font-family:system-ui;background:#0b1026;color:#c9c4ff;display:grid;place-items:center;min-height:100vh">` +
      `<p>This jam invite is no longer active — ask for a fresh one.</p></body>`
    );
  }
  const jump = JSON.stringify(target).replace(/</g, '\\u003c');
  const origin = config.staticBaseUrl || config.jamPublicBase;
  const image = origin ? `${origin}/ew-bg.jpg` : '/ew-bg.jpg';
  const crowd = kind === 'crowd';
  const title = crowd ? 'Vaporzr — crowd view' : "Vaporzr — you're invited to the jam";
  const description = crowd
    ? 'Now playing, the queue and lyrics for this room. Read-only — your host keeps the controls.'
    : "Pick a song, add your name — it lands in everyone's queue. No app, no account.";
  return (
    `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="theme-color" content="#6a5cff">` +
    `<meta name="description" content="${description}">` +
    `<meta property="og:type" content="website">` +
    `<meta property="og:site_name" content="Vaporzr">` +
    `<meta property="og:title" content="${title}">` +
    `<meta property="og:description" content="${description}">` +
    `<meta property="og:image" content="${esc(image)}">` +
    `<meta property="og:image:width" content="1280">` +
    `<meta property="og:image:height" content="720">` +
    `<meta name="twitter:card" content="summary_large_image">` +
    `<meta name="twitter:title" content="${title}">` +
    `<meta name="twitter:description" content="${description}">` +
    `<meta name="twitter:image" content="${esc(image)}">` +
    `<meta http-equiv="refresh" content="0;url=${esc(target)}">` +
    `<script>location.replace(${jump});</script>` +
    `<noscript><a href="${esc(target)}">${crowd ? 'Open the crowd view' : 'Open the jam'} →</a></noscript>`
  );
}

function grantRequestPage(req: http.IncomingMessage, url: URL, res: http.ServerResponse): boolean {
  const cookie = req.headers.cookie ?? '';
  const sess = resolveSession(tokenFromCookieHeader(cookie), Date.now(), {
    userAgent: String(req.headers['user-agent'] ?? ''),
    ip: req.socket.remoteAddress,
  });
  if (sess && scopeSatisfies(sess.scope, 'request')) return true;

  // Legacy REQUEST_KEY: cookie, or ?key= which also remembers this device.
  if (config.requestKey) {
    const m = /(?:^|;\s*)vz_req=([^;]+)/.exec(cookie);
    if (m) {
      let value = m[1];
      try {
        value = decodeURIComponent(value);
      } catch {
        /* compare raw */
      }
      if (secretEquals(value, config.requestKey)) return true;
    }
    if (secretEquals(url.searchParams.get('key'), config.requestKey)) {
      res.setHeader(
        'Set-Cookie',
        `vz_req=${encodeURIComponent(config.requestKey)}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`,
      );
      return true;
    }
  }

  // Invites: consume once, then keep the session in a cookie (never both burn
  // and serve without storing the credential - that locked people out).
  const inviteToken = url.searchParams.get('invite');
  if (inviteToken) {
    const used = consumeInvite(inviteToken);
    if (used && scopeSatisfies(used.session.scope, 'request')) {
      res.setHeader('Set-Cookie', sessionCookie(used.token, used.session.expiresAt, req));
      redirectStrippingCredentials(res, url.pathname);
      return false;
    }
  }

  res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<h1 style="font-family:system-ui">Requests are disabled or keyed. Ask the operator for a link.</h1>');
  return false;
}

/**
 * Discord Activity pairing. The Activity iframe cannot carry our session
 * cookie, so it shows a 6-character code that an authenticated panel approves;
 * the approval mints a short-lived, reusable view invite which the Activity's
 * socket presents once.
 */
const activityPairs = new Map<string, { createdAt: number; invite?: string }>();
/** Rendered jam cards, keyed by join URL (bounded; an hour each). */
const jamCardCache = new Map<string, { at: number; png: Buffer }>();
/** Short-lived search results so type-ahead keystrokes don't hit Spotify each time. */
const searchCache = new Map<string, { at: number; items: unknown[] }>();
const ACTIVITY_PAIR_TTL_MS = 5 * 60 * 1000;
const ACTIVITY_INVITE_TTL_MS = 20 * 60 * 1000;
const activityPairTries = new Map<string, { count: number; windowStart: number }>();

function activityPairAllowed(ip: string): boolean {
  const now = Date.now();
  // Bound the map: every distinct client address would otherwise stay forever.
  if (activityPairTries.size > 2000) activityPairTries.clear();
  const entry = activityPairTries.get(ip);
  if (!entry || now - entry.windowStart > 60_000) {
    activityPairTries.set(ip, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= 6) return false;
  entry.count += 1;
  return true;
}

function newPairCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let attempt = 0; attempt < 20; attempt++) {
    let code = '';
    for (let i = 0; i < 6; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
    if (!activityPairs.has(code)) return code;
  }
  return '';
}

/** Global throttle for the public request endpoint (8 requests / minute). */
let requestWindowStart = 0;
let requestCount = 0;
function requestGate(): boolean {
  const now = Date.now();
  if (now - requestWindowStart > 60_000) {
    requestWindowStart = now;
    requestCount = 0;
  }
  if (requestCount >= 8) return false;
  requestCount++;
  return true;
}

async function readJsonBody(req: http.IncomingMessage, limit = 64 * 1024): Promise<unknown> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > limit) {
        req.destroy();
        resolve(null);
      }
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

/** Binary request body with a hard cap, for small audio uploads. */
function readBinaryBody(req: http.IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (v: Buffer | null): void => {
      if (done) return;
      done = true;
      resolve(v);
    };
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        finish(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish(Buffer.concat(chunks)));
    req.on('error', () => finish(null));
  });
}

/** Accept only a plain audio filename: no paths, no tricks, known extension. */
function safeAudioName(raw: string): string | null {
  const base = raw
    .replace(/^.*[\\/]/, '')
    .trim()
    .replace(/[^A-Za-z0-9._ ()-]/g, '-');
  if (!base || base.length > 80) return null;
  if (!/\.(wav|mp3|ogg|flac|m4a|opus)$/i.test(base)) return null;
  return base;
}

/** Delete uploaded files older than `maxAgeDays` so data/uploads can't grow forever. */
function pruneUploads(maxAgeDays = 30): void {
  try {
    const dir = path.join(config.dataDir, 'uploads');
    const cutoff = Date.now() - maxAgeDays * 86_400_000;
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      try {
        if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true });
      } catch {
        /* skip */
      }
    }
  } catch {
    /* no uploads dir */
  }
}

function keyPrompt(res: http.ServerResponse, message?: string): void {
  res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Vaporzr - Access</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="This Vaporzr page is keyed. Ask the operator for a panel, visualizer or jam link.">
<meta property="og:title" content="Vaporzr - Access">
<meta property="og:description" content="This Vaporzr page is keyed. Ask the operator for a panel, visualizer or jam link.">
<meta property="og:image" content="${config.staticBaseUrl || config.jamPublicBase}/ew-bg.jpg">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" type="image/png" href="/favicon.png">
<style>
  :root{color-scheme:dark}
  body{font-family:ui-sans-serif,system-ui,"Segoe UI",Roboto,sans-serif;background:radial-gradient(1000px 480px at 50% -10%,#151d2a 0%,#0a0c11 62%);
       color:#e9edf6;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:20px}
  form{background:#10131b;border:1px solid #222835;padding:28px 26px;border-radius:16px;text-align:center;width:min(360px,100%);
       box-shadow:0 24px 80px rgba(0,0,0,.45)}
  h1{font-size:15px;letter-spacing:.22em;margin:0 0 4px;color:#e9edf6}
  h1 span{color:#7ee0c2}
  p{color:#8b97ad;font-size:12.5px;margin:6px 0 0}
  input{display:block;margin:16px auto 12px;padding:11px 12px;border-radius:9px;border:1px solid #222835;background:#0d1016;color:#e9edf6;
        font-size:14px;width:100%;box-sizing:border-box;text-align:center;letter-spacing:.04em}
  input:focus{outline:none;border-color:#2c5a50}
  button{width:100%;padding:11px 14px;border-radius:9px;border:1px solid #2c5a50;background:linear-gradient(180deg,#1b3733,#132520);
         color:#d9fff4;font-weight:600;cursor:pointer}
  .err{color:#f2777a;font-size:12.5px;margin-top:10px}
  .fine{color:#5f6b80;font-size:11.5px;margin-top:14px;line-height:1.45}
</style>
</head><body>
<form method="GET">
  <h1>VAPORZR <span>/ access</span></h1>
  <p>Enter the share key, or an invite link's code</p>
  <input name="key" placeholder="key or invite" autofocus autocomplete="off" spellcheck="false">
  <button>Enter</button>
  ${message ? `<div class="err">${message}</div>` : ''}
  <div class="fine">Invites from <b>/key give</b> work once and expire on their own.<br>The owner key is in your bot's .env (SHARE_KEY).</div>
</form>
</body></html>`);
}
/**
 * The Discord Activity page: the visualizer with the Embedded App SDK handshake
 * prepended. Discord launches it with ?instance_id=…, and the SDK `ready()` call
 * is what tells the client the app loaded (wrapped in a timeout so a plain
 * browser visit renders the visualizer anyway).
 *
 * Asset paths stay root-absolute: the portal URL mapping uses the "/" prefix, so
 * the whole origin is proxied and /vendor/*, /ws, /ew-bg.mp4 all resolve as-is.
 */
function activityHtml(origin: string): string | null {
  try {
    const build = (process.env.VAPORZR_BUILD ?? 'dev').slice(0, 7);
    const appId = Buffer.from(config.discordToken.split('.')[0] ?? '', 'base64').toString('ascii');
    // Discord replaces the Activity's CSP with its own. On mobile its script-src
    // is `'self'` rather than a literal origin, and under a sandboxed opaque
    // origin `'self'` matches nothing — which refuses a cross-origin <script
    // type="module"> load while every fetch/XHR keeps working. That failure mode
    // is iOS-only and looks like anything but CSP, so the SDK load is retried
    // with a cache-busting query and the result is reported onto window for the
    // page (and remote debugging) to see, rather than failing silently.
    const handshake =
      `<script>window.__VZ_ACTIVITY__=1;window.__VZ_STATE__=window.__VZ_STATE__||{};window.__VZ_STATE__.origin='${origin}';window.__VZ_SDK_STATE__='pending';</script>` +
      `<script type="module">` +
      `window.__VZ_SDK_STATE__='loading';` +
      `let DiscordSDK;` +
      `try{` +
      `({DiscordSDK}=await import('/vendor/embedded-app-sdk.mjs'));` +
      `}catch(e1){` +
      // Retry once: a transient CSP/proxy race is recoverable, a hard block is not.
      `try{({DiscordSDK}=await import('/vendor/embedded-app-sdk.mjs?r=1'));}` +
      `catch(e2){window.__VZ_SDK_STATE__='failed';}` +
      `}` +
      `if(DiscordSDK){` +
      `window.__VZ_SDK_STATE__='ready';` +
      `try{` +
      `const sdk=new DiscordSDK('${appId}');` +
      `window.__VZ_SDK__=sdk;` +
      `await Promise.race([sdk.ready(),new Promise(r=>setTimeout(r,4000))]);` +
      // Landscape suits a 16:9 visualizer; PIP/grid tiles follow it so the scene
      // is not letterboxed into a portrait sliver on a phone.
      `try{` +
      `const C=(await import('/vendor/embedded-app-sdk.mjs')).Common||{};` +
      `const LS=(C.OrientationLockStateTypeObject||{});` +
      `if(sdk.commands&&sdk.commands.setOrientationLockState&&LS.LANDSCAPE!==undefined){` +
      `await sdk.commands.setOrientationLockState({` +
      `lock_state:LS.LANDSCAPE,` +
      `picture_in_picture_lock_state:LS.LANDSCAPE,` +
      `grid_lock_state:LS.LANDSCAPE` +
      `});}` +
      `}catch(e){}` +
      // Thermal throttling: a MilkDrop visualizer will cook a phone. Publish the
      // state so the renderer can shed work before the OS throttles it for us.
      `try{` +
      `if(sdk.subscribe){` +
      `sdk.subscribe('THERMAL_STATE_UPDATE',(u)=>{window.__VZ_THERMAL__=u&&u.thermal_state;});` +
      `sdk.subscribe('ORIENTATION_UPDATE',()=>{window.dispatchEvent(new Event('resize'));});` +
      `}` +
      `}catch(e){}` +
      `}catch(e){window.__VZ_SDK_STATE__='ready-nosdk';}` +
      `}` +
      `</script>` +
      `<script src="/activity-connect.js?v=${build}" defer></script>`;
    return (
      fs
        .readFileSync(path.join(__dirname, '..', 'public', 'viz.html'), 'utf8')
        .replace(/\{\{ORIGIN\}\}/g, origin)
        .replace(/\{\{BUILD\}\}/g, build)
        // Assets and the socket keep their normal root-absolute paths. That is the
        // whole point of mapping the Activity's root at the bare origin: there is
        // no path rewriting to reason about, and the same URLs work in a browser.
        .replace(/<head([^>]*)>/i, (m) => `${m}<meta name="vz-build" content="${build}">${handshake}`)
    );
  } catch {
    return null;
  }
}

/** Public marketing/portal page at the root. Everything sensitive stays behind
 *  /panel, /deck, /viz, /listen and /status. */
function homeHtml(origin: string): string | null {
  try {
    const build = (process.env.VAPORZR_BUILD ?? 'dev').slice(0, 7);
    const appId = Buffer.from(config.discordToken.split('.')[0] ?? '', 'base64').toString('ascii');
    return fs
      .readFileSync(path.join(__dirname, '..', 'public', 'home.html'), 'utf8')
      .replace(/\{\{ORIGIN\}\}/g, origin)
      .replace(/\{\{APP_ID\}\}/g, encodeURIComponent(appId))
      .replace(/\{\{BUILD\}\}/g, build);
  } catch {
    return null;
  }
}

/** OAuth states issued by /login ΓåÆ expiry timestamp; verified once by /callback. */
const oauthStates = new Map<string, number>();

async function handleRoute(
  req: http.IncomingMessage,
  url: URL,
  res: http.ServerResponse,
  bridgeRef: () => Bridge | null,
): Promise<void> {
  // Host is attacker-controlled on raw HTTP connections and gets substituted
  // into served HTML ({{ORIGIN}}); accept only plausible host[:port] shapes.
  const rawHost = req.headers.host ?? '';
  const host = /^[a-z0-9.-]+(:\d{1,5})?$/i.test(rawHost) ? rawHost : `localhost:${config.port}`;
  const origin = `https://${host}`;
  try {
    // Set when this response body is the Activity page (framing rules differ).
    let activityResponse = url.pathname.startsWith('/activity');
    // Baseline headers for every response, including gate pages.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

    // Tailnet-only mode: a public host is refused before any credential work.
    if (!webAccessAllowed(req.headers.host)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Vaporzr is reachable from the tailnet only (WEB_ACCESS=tailnet).');
      return;
    }

    const proto = String(req.headers['x-forwarded-proto'] ?? '')
      .split(',')[0]
      .trim()
      .toLowerCase();
    const forceHttps = /^https:/i.test(config.staticBaseUrl || '');
    const localHost = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(req.headers.host ?? '');
    if (forceHttps && !localHost && proto && proto !== 'https') {
      // Use the validated host (line ~930), never the raw header: a spoofed Host
      // otherwise turns this into an open redirect.
      res.writeHead(308, { Location: `https://${host}${req.url ?? '/'}` });
      res.end();
      return;
    }
    if (proto === 'https' || forceHttps) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }

    // CSRF: state-changing requests must come from this origin. The Activity
    // pair call is exempt on purpose: it is unauthenticated, rate-limited and
    // creates nothing but a 6-character code. Inside Discord its Origin is the
    // discordsays proxy, which by design differs from our host.
    const pairEndpoint = url.pathname === '/api/activity/pair';
    if (!pairEndpoint && req.method && req.method !== 'GET' && req.method !== 'HEAD') {
      const originHeader = req.headers.origin;
      if (originHeader) {
        let oh = '';
        try {
          oh = new URL(originHeader).host;
        } catch {
          oh = '';
        }
        if (oh !== (req.headers.host ?? '')) {
          res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Cross-origin request refused.');
          return;
        }
      }
    }

    // Attach the CSP automatically to every HTML response (pages, key screen).
    const writeHead = res.writeHead.bind(res);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (res as any).writeHead = (status: number, headers?: any) => {
      const ct = headers && typeof headers === 'object' ? (headers['Content-Type'] ?? headers['content-type']) : '';
      if (typeof ct === 'string' && ct.startsWith('text/html')) {
        htmlSecurityHeaders(res, activityResponse);
      }
      return writeHead(status, headers);
    };
    // Access gate: the portal, panel, visualizer and listener all need a
    // session now. Static assets stay open (they hold no audio or state).
    const need = accessNeedFor(url.pathname);
    if (need && controlAuthRequired()) {
      if (isActivityFetch(req)) {
        // Discord's proxy asked for this path on behalf of the Activity iframe:
        // answer with the Activity page (open, frameable, guest socket).
        const page = activityHtml(origin);
        if (page) {
          activityResponse = true;
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(page);
          return;
        }
      }
      if (!grantPageAccess(req, url, res, need)) return;
    }

    // Brand assets.
    const BRAND_ASSETS: Record<string, string> = {
      '/favicon.png': 'image/png',
      '/logo.png': 'image/png',
      '/logo.gif': 'image/gif',
      '/icon-192.png': 'image/png',
      '/icon-512.png': 'image/png',
      '/icon-maskable.png': 'image/png',
      '/apple-touch-icon.png': 'image/png',
    };
    const brandType = BRAND_ASSETS[url.pathname];
    if (brandType) {
      try {
        const file = fs.readFileSync(path.join(__dirname, '..', 'public', url.pathname.slice(1)));
        res.writeHead(200, { 'Content-Type': brandType, 'Cache-Control': 'public, max-age=86400' });
        res.end(file);
        return;
      } catch {
        res.writeHead(404);
        res.end();
        return;
      }
    }
    // Generated ambient loops under public/media/loops. Same streaming rules
    // as /ew-bg.mp4 below: Range matters for a looping <video>, and the names
    // stay stable, so pages bust the cache with ?v=<build> instead.
    if (url.pathname.startsWith('/media/loops/')) {
      const rel = url.pathname.slice('/media/loops/'.length);
      const LOOP_TYPES: Record<string, string> = {
        mp4: 'video/mp4',
        webm: 'video/webm',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        webp: 'image/webp',
        json: 'application/json; charset=utf-8',
      };
      const ext = (path.extname(rel).slice(1) || '').toLowerCase();
      if (/^[\w-]+\.(mp4|webm|jpe?g|webp|json)$/i.test(rel) && LOOP_TYPES[ext]) {
        const filePath = path.join(__dirname, '..', 'public', 'media', 'loops', rel);
        try {
          const stat = fs.statSync(filePath);
          const headers: Record<string, string> = {
            'Content-Type': LOOP_TYPES[ext],
            'Cache-Control': 'public, max-age=31536000, immutable',
          };
          if (ext !== 'mp4' && ext !== 'webm') {
            res.writeHead(200, { ...headers, 'Content-Length': stat.size });
            res.end(fs.readFileSync(filePath));
            return;
          }
          headers['Accept-Ranges'] = 'bytes';
          const m = req.headers.range ? /bytes=(\d*)-(\d*)/.exec(req.headers.range) : null;
          if (m) {
            const start = m[1] ? parseInt(m[1], 10) : 0;
            const end = Math.min(m[2] ? parseInt(m[2], 10) : stat.size - 1, stat.size - 1);
            res.writeHead(206, {
              ...headers,
              'Content-Length': end - start + 1,
              'Content-Range': `bytes ${start}-${end}/${stat.size}`,
            });
            const stream = fs.createReadStream(filePath, { start, end });
            stream.on('error', () => {
              try {
                res.end();
              } catch {
                /* client went away */
              }
            });
            stream.pipe(res);
            return;
          }
          res.writeHead(200, { ...headers, 'Content-Length': stat.size });
          const stream = fs.createReadStream(filePath);
          stream.on('error', () => {
            try {
              res.end();
            } catch {
              /* client went away */
            }
          });
          stream.pipe(res);
          return;
        } catch {
          res.writeHead(404);
          res.end();
          return;
        }
      }
    }
    // Endless Wave wallpaper loop (real VISUALDON video) + poster. Open like
    // /viz. Range support is required for browsers to stream/loop <video>.
    if (url.pathname === '/ew-bg.mp4') {
      try {
        const filePath = path.join(__dirname, '..', 'public', 'ew-bg.mp4');
        const stat = fs.statSync(filePath);
        const range = req.headers.range;
        const m = range ? /bytes=(\d*)-(\d*)/.exec(range) : null;
        if (m) {
          const start = m[1] ? parseInt(m[1], 10) : 0;
          const end = Math.min(m[2] ? parseInt(m[2], 10) : stat.size - 1, stat.size - 1);
          res.writeHead(206, {
            'Content-Type': 'video/mp4',
            'Content-Length': end - start + 1,
            'Content-Range': `bytes ${start}-${end}/${stat.size}`,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'public, max-age=31536000, immutable',
          });
          const stream = fs.createReadStream(filePath, { start, end });
          stream.on('error', () => {
            try {
              res.end();
            } catch {
              /* client went away */
            }
          });
          stream.pipe(res);
        } else {
          res.writeHead(200, {
            'Content-Type': 'video/mp4',
            'Content-Length': stat.size,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'public, max-age=31536000, immutable',
          });
          const stream = fs.createReadStream(filePath);
          stream.on('error', () => {
            try {
              res.end();
            } catch {
              /* client went away */
            }
          });
          stream.pipe(res);
        }
        return;
      } catch {
        res.writeHead(404);
        res.end();
        return;
      }
    }
    if (url.pathname === '/ew-bg.jpg') {
      try {
        const file = fs.readFileSync(path.join(__dirname, '..', 'public', 'ew-bg.jpg'));
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable' });
        res.end(file);
        return;
      } catch {
        res.writeHead(404);
        res.end();
        return;
      }
    }
    // Artwork relay — see serveArtwork() for why the image is not loaded direct.
    if (url.pathname === '/art') {
      await serveArtwork(url, res);
      return;
    }

    // Static vendor bundles for the web visualizer (butterchurn etc.) plus the
    // lazily-loaded preset library under presets/.
    if (url.pathname.startsWith('/vendor/')) {
      const rel = url.pathname.slice('/vendor/'.length);
      if (/^[\w.-]+\.(m?js|json)$/.test(rel) || /^presets\/[\w.-]+\.(m?js|json)$/.test(rel)) {
        try {
          let target = path.join(__dirname, '..', 'public', 'vendor', rel);
          // Preset files may be overridden by the persistent data volume — e.g. a
          // newer cream-of-the-crop library dropped at $DATA_DIR/presets survives
          // deploys (unlike the image). Prefer that copy when it exists.
          if (rel.startsWith('presets/') && process.env.DATA_DIR) {
            const override = path.join(process.env.DATA_DIR, 'presets', rel.slice('presets/'.length));
            if (fs.existsSync(override)) target = override;
          }
          const isJson = rel.endsWith('.json');
          const type = isJson ? 'application/json' : 'application/javascript';
          const headers: Record<string, string> = {
            'Content-Type': `${type}; charset=utf-8`,
            'Cache-Control': 'public, max-age=86400',
            Vary: 'Accept-Encoding',
          };
          let entry = vendorCache.get(target);
          if (!entry) {
            const raw = fs.readFileSync(target);
            // Preset chunks are tens of MB of JSON-ish JS and compress ~12:1.
            // Gzip once, then serve the cached copy, so the visualizer pulls a
            // couple of MB instead of tens — and never re-compresses per request.
            const gz = raw.length > 4096 ? zlib.gzipSync(raw, { level: 6 }) : null;
            entry = { body: gz ?? raw, gzip: !!gz };
            if (vendorCache.size > 12) vendorCache.clear();
            vendorCache.set(target, entry);
          }
          if (entry.gzip) headers['Content-Encoding'] = 'gzip';
          headers['Content-Length'] = String(entry.body.length);
          res.writeHead(200, headers);
          res.end(entry.body);
          return;
        } catch {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Not found.');
          return;
        }
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found.');
      return;
    }

    // Activity-scoped copies of the visualizer's assets: the /activity page
    // requests them under its own prefix so it works with an 'activity'-only
    // URL mapping, and equally with a root mapping.
    if (url.pathname.startsWith('/activity/')) {
      const rel = url.pathname.slice('/activity/'.length);
      if (!rel.includes('..') && /^[\w./-]+\.(m?js|json|png|jpe?g|gif|mp4|webp|css|woff2?)$/i.test(rel)) {
        try {
          const raw = fs.readFileSync(path.join(__dirname, '..', 'public', rel));
          const ext = (path.extname(rel).slice(1) || '').toLowerCase();
          const types: Record<string, string> = {
            js: 'text/javascript',
            mjs: 'text/javascript',
            json: 'application/json',
            png: 'image/png',
            jpg: 'image/jpeg',
            jpeg: 'image/jpeg',
            gif: 'image/gif',
            mp4: 'video/mp4',
            webp: 'image/webp',
            css: 'text/css',
            woff2: 'font/woff2',
          };
          const headers: Record<string, string> = {
            'Content-Type': `${types[ext] ?? 'application/octet-stream'}; charset=utf-8`,
            'Cache-Control': 'public, max-age=86400',
            Vary: 'Accept-Encoding',
          };
          // Preset chunks are tens of MB; compress once and cache like /vendor.
          let entry = vendorCache.get(`activity:${rel}`);
          if (!entry) {
            const gz =
              raw.length > 4096 && /json|javascript/.test(types[ext] ?? '') ? zlib.gzipSync(raw, { level: 6 }) : null;
            entry = { body: gz ?? raw, gzip: !!gz };
            if (vendorCache.size > 24) vendorCache.clear();
            vendorCache.set(`activity:${rel}`, entry);
          }
          if (entry.gzip) headers['Content-Encoding'] = 'gzip';
          headers['Content-Length'] = String(entry.body.length);
          res.writeHead(200, headers);
          res.end(entry.body);
          return;
        } catch {
          /* fall through to 404 */
        }
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found.');
      return;
    }

    // Activity pairing poll: /api/activity/pair/<CODE> (no credential - the
    // code is the credential, and it only ever yields a view invite).
    if (url.pathname.startsWith('/api/activity/pair/')) {
      const raw = safeDecode(url.pathname.slice('/api/activity/pair/'.length));
      if (raw === null) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ status: 'expired' }));
        return;
      }
      const code = raw.toUpperCase();
      const pair = activityPairs.get(code);
      if (!pair || Date.now() - pair.createdAt > ACTIVITY_PAIR_TTL_MS) {
        // Drop it instead of leaving a dead entry in a public-facing map.
        activityPairs.delete(code);
        res.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ status: 'expired' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(pair.invite ? { status: 'approved', invite: pair.invite } : { status: 'pending' }));
      return;
    }

    // Official-video proxy: downloads on demand, then serves a seekable MP4.
    if (url.pathname.startsWith('/api/video/')) {
      const id = safeDecode(url.pathname.slice('/api/video/'.length));
      if (id === null) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'failed' }));
        return;
      }
      handleVideoProxy(req, res, id, url);
      return;
    }

    // Jam invite card as an image, for the embed. Rendering it here (instead of
    // attaching a file to the Discord post) avoids the undici FormData instance
    // mismatch that made Discord refuse the jam card, and the URL can be cached.
    if (url.pathname === '/jam-card.png') {
      const raw = (url.searchParams.get('u') ?? '').slice(0, 500);
      let target: URL;
      try {
        target = new URL(raw);
      } catch {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Invalid card URL.');
        return;
      }
      const loopback = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(target.hostname);
      if (target.protocol !== 'https:' && !(target.protocol === 'http:' && loopback)) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Card URL must be https.');
        return;
      }
      const key = target.toString();
      const hit = jamCardCache.get(key);
      let png: Buffer;
      if (hit && Date.now() - hit.at < 60 * 60 * 1000) {
        png = hit.png;
      } else {
        try {
          png = renderJamCardPng(key);
        } catch {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Could not render the card.');
          return;
        }
        if (jamCardCache.size > 100) jamCardCache.clear();
        jamCardCache.set(key, { at: Date.now(), png });
      }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' });
      res.end(png);
      return;
    }

    // Short jam links (/j/<CODE> from the QR cards): serve a tiny handoff page
    // that instantly walks the browser to /jam with the invite. Public on
    // purpose — the code IS the credential, so with no match there is nothing
    // here but a friendly 404.
    if (url.pathname.startsWith('/j/')) {
      const token = resolveJamCode(url.pathname.slice(3));
      // A shared vibe link keeps the vibe name across the invite exchange:
      // /j/<code>?vibe=Name → /jam?invite=<token>&vibe=Name.
      const vibe = (url.searchParams.get('vibe') ?? '').slice(0, 80);
      const target = token
        ? `/jam?invite=${encodeURIComponent(token)}${vibe ? `&vibe=${encodeURIComponent(vibe)}` : ''}`
        : null;
      res.writeHead(token ? 200 : 404, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(jamHandoffHtml(target));
      return;
    }

    // The same short code, but for the read-only crowd panel: the request
    // invite keeps the socket at guest scope, so nothing here can change
    // playback — it just shows the full panel with the jam art.
    if (url.pathname.startsWith('/c/')) {
      const token = resolveJamCode(url.pathname.slice(3));
      if (!token) {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(jamHandoffHtml(null));
        return;
      }
      // Same handoff page as /j so the link unfurls with an accurate title,
      // description and preview instead of a bare 302.
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(jamHandoffHtml(`/crowd?invite=${encodeURIComponent(token)}`, 'crowd'));
      return;
    }

    switch (url.pathname) {
      case '/':
      case '/index.html': {
        // A Discord Activity launch arrives at the mapped root with ?instance_id=…
        // Serve the visualizer for that; the public portal for everyone else.
        //
        // `activityResponse` MUST be set before writeHead: the CSP/X-Frame-Options
        // for this response are computed there, and an Activity page sent with the
        // default `frame-ancestors 'none'` + `X-Frame-Options: DENY` is refused by
        // Discord's iframe — which is exactly what "the Activity is a blank white
        // screen" looked like. /activity sets the flag up front; this launch path
        // is the one that did not.
        if (url.searchParams.has('instance_id')) {
          const page = activityHtml(origin);
          if (page) {
            activityResponse = true;
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end(page);
            return;
          }
        }
        const portal = homeHtml(origin);
        if (portal) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
          res.end(portal);
          break;
        }
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Portal page is missing from the image.');
        break;
      }

      case '/status': {
        // The old gated status page: operator links, Spotify link and player
        // health. Kept behind the view gate; the public root is /.
        // Bot tokens are base64(appId).signature — decode for the invite link.
        const appId = Buffer.from(config.discordToken.split('.')[0], 'base64').toString('ascii');
        const perms = (1n << 11n) | (1n << 14n) | (1n << 15n) | (1n << 20n) | (1n << 31n) | (1n << 52n);
        const inviteUrl = `https://discord.com/oauth2/authorize?client_id=${appId}&permissions=${perms}&scope=bot+applications.commands`;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(
          html(`
          <img src="/logo.png" alt="Vaporzr" style="width:96px;height:96px;border-radius:22px;box-shadow:0 8px 30px rgba(106,92,255,.45);margin-bottom:1rem">
          <h1>Vaporzr Status</h1>
          <p><a href="${inviteUrl}" style="border-color:#6a5cff;background:rgba(106,92,255,.18);font-weight:600">➕ Add to your server</a></p>
          <p>${tokenStore.load() ? 'Spotify account linked.' : 'Spotify not linked.'}</p>
          <p><a href="/login">Link Spotify account</a></p>
          <p>Player status: <span id="s">checking…</span></p>
          <p><a href="/">← Public portal</a></p>
          <p><a href="/panel">Open the control panel →</a> <a href="/deck">Live decks →</a> <a href="/viz">Visualizer →</a></p>
          <script>
            try {
              fetch('/api/token').then(r => r.json()).then(d => {
                document.getElementById('s').textContent = d.error ? 'not authorized' : 'authorized ✓';
              });
            } catch (e) { document.getElementById('s').textContent = 'error'; }
          </script>
        `),
        );
        break;
      }

      case '/login': {
        // Linking writes tokens.json, so only share-key holders may start it.
        if (!hasShareAccess(req, url)) {
          keyPrompt(res);
          return;
        }
        const state = crypto.randomBytes(16).toString('hex');
        // Remember the state so /callback can prove the redirect belongs to a
        // flow we started (CSRF / token-overwrite guard). 10-minute TTL.
        oauthStates.set(state, Date.now() + 10 * 60_000);
        for (const [k, exp] of oauthStates) if (exp < Date.now()) oauthStates.delete(k);
        res.writeHead(302, { Location: buildAuthorizeUrl(state) });
        res.end();
        break;
      }

      case '/callback': {
        const code = url.searchParams.get('code');
        const err = url.searchParams.get('error');
        const state = url.searchParams.get('state') ?? '';
        const stateExp = oauthStates.get(state);
        if (state) oauthStates.delete(state);
        console.log(
          `[vaporzr] oauth callback: code=${code ? 'present' : 'MISSING'} error=${err ?? 'none'} state=${state ? (stateExp ? 'valid' : 'unknown') : 'MISSING'}`,
        );
        if (!stateExp || stateExp < Date.now()) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(
            html(
              `<h1 style="font-family:sans-serif">This sign-in link is invalid or expired. Open the panel and start the Spotify link again.</h1>`,
            ),
          );
          return;
        }
        if (err) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(
            html(
              `<h1 style="font-family:sans-serif">Authorization failed (${esc(err)}). Close this tab and try /login again.</h1>`,
            ),
          );
          return;
        }
        if (!code) throw new SpotifyError('Missing code.');
        await exchangeCode(code);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(html(`<h1 style="font-family:sans-serif">✓ Linked! You can close this tab.</h1>`));
        break;
      }

      case '/api/token': {
        // The Spotify OAuth access token is sensitive — only expose it to key
        // holders (the same gate that protects /panel). Without this, anyone
        // who learns the public tunnel URL could GET the operator's token.
        if (!config.shareKey || !hasShareAccess(req, url)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
        if (!tokenStore.load()) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'not_authorized' }));
          return;
        }
        const token = await getAccessToken();
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ token }));
        break;
      }

      case '/now':
      case '/now.html': {
        // A link that unfurls into the actual track playing right now. Public
        // like the jam page: it exposes title/artist/artwork, nothing internal.
        const e = (s: string): string =>
          s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        const q = bridgeRef()?.jamQueue() ?? null;
        const t = q?.playing ?? null;
        const base = config.staticBaseUrl || config.jamPublicBase || '';
        const art = t?.image && /^https:\/\//i.test(t.image) ? t.image : `${base}/ew-bg.jpg`;
        const title = t ? `▶ ${t.name}${t.artists ? ` — ${t.artists}` : ''}` : 'Vaporzr — nothing playing';
        const desc = t
          ? `Now playing on Vaporzr${q && q.queueTotal > 1 ? ` · ${q.queueTotal} in the queue` : ''}. Join the jam and pick the next track.`
          : 'The decks are idle. Join the jam and pick the next track.';
        const body = t
          ? `<img src="${e(art)}" alt="" />
             <div class="badge">${q?.playingNow ? 'NOW PLAYING' : 'UP NEXT'}</div>
             <h1>${e(t.name)}</h1>
             <p>${e(t.artists || t.album || 'Vaporzr')}</p>
             <small>${q?.queueTotal ?? 0} track${(q?.queueTotal ?? 0) === 1 ? '' : 's'} in the room queue</small>`
          : `<h1>Nothing playing</h1><p>The decks are idle.</p>`;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(
          `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${e(title)}</title>
<meta name="description" content="${e(desc)}">
<meta property="og:type" content="music.song">
<meta property="og:site_name" content="Vaporzr">
<meta property="og:title" content="${e(title)}">
<meta property="og:description" content="${e(desc)}">
<meta property="og:image" content="${e(art)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${e(title)}">
<meta name="twitter:description" content="${e(desc)}">
<meta name="twitter:image" content="${e(art)}">
<meta name="theme-color" content="#070912">
<style>
:root{color-scheme:dark}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(800px 460px at 50% -10%,#1b1638,#070912 65%);color:#e9edf6;font:15px/1.5 system-ui,sans-serif;padding:24px}
main{width:min(430px,100%);padding:22px;border:1px solid rgba(140,160,255,.22);border-radius:20px;background:rgba(13,17,35,.86);box-shadow:0 24px 80px rgba(0,0,0,.5);text-align:center}
img{width:100%;aspect-ratio:1;object-fit:cover;border-radius:14px;background:#11162b;margin-bottom:14px}
.badge{font-size:10px;letter-spacing:.18em;color:#22d3ee;margin-bottom:6px}
h1{font-size:21px;line-height:1.25;margin:0 0 4px}
p{color:#9fb0ff;margin:0 0 6px}
small{color:#64748b}
nav{display:flex;gap:8px;margin-top:18px}
a{flex:1;text-decoration:none;color:#fff;background:linear-gradient(135deg,#6a5cff,#22d3ee);padding:11px;border-radius:10px;font-weight:600;font-size:13px}
a.ghost{background:rgba(148,163,184,.1);border:1px solid rgba(140,160,255,.22);color:#cbd5e1}
</style></head><body><main>${body}
<nav><a href="/jam">Join the jam</a><a class="ghost" href="/crowd">Crowd view</a></nav>
</main></body></html>`,
        );
        break;
      }

      case '/activity': {
        // Direct visit / alias for the Activity page (also what the portal maps).
        const page = activityHtml(origin);
        if (!page) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Activity page not found.');
          break;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(page);
        break;
      }

      case '/crowd': {
        // Guest-facing copy of the panel: a request invite logs the socket in
        // at guest scope, which is exactly what panel.html's guest mode wants.
        if (!grantRequestPage(req, url, res)) return;
        try {
          const build = (process.env.VAPORZR_BUILD ?? 'dev').slice(0, 7);
          const file = fs
            .readFileSync(path.join(__dirname, '..', 'public', 'panel.html'), 'utf8')
            .replace(/\{\{ORIGIN\}\}/g, origin)
            .replace(/\{\{BUILD\}\}/g, build);
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(file);
        } catch {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Crowd view not found.');
        }
        break;
      }

      case '/panel':
      case '/panel.html': {
        try {
          const build = (process.env.VAPORZR_BUILD ?? 'dev').slice(0, 7);
          const file = fs
            .readFileSync(path.join(__dirname, '..', 'public', 'panel.html'), 'utf8')
            .replace(/\{\{ORIGIN\}\}/g, origin)
            .replace(/\{\{BUILD\}\}/g, build);
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(file);
        } catch {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Panel not found.');
        }
        break;
      }

      case '/deck':
      case '/deck.html':
      case '/decks': {
        try {
          const build = (process.env.VAPORZR_BUILD ?? 'dev').slice(0, 7);
          const file = fs
            .readFileSync(path.join(__dirname, '..', 'public', 'deck.html'), 'utf8')
            .replace(/\{\{ORIGIN\}\}/g, origin)
            .replace(/\{\{BUILD\}\}/g, build);
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(file);
        } catch {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Deck page not found.');
        }
        break;
      }

      case '/viz':
      case '/viz.html': {
        try {
          const build = (process.env.VAPORZR_BUILD ?? 'dev').slice(0, 7);
          const file = fs
            .readFileSync(path.join(__dirname, '..', 'public', 'viz.html'), 'utf8')
            .replace(/\{\{ORIGIN\}\}/g, origin)
            .replace(/\{\{BUILD\}\}/g, build);
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(file);
        } catch {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Visualizer not found.');
        }
        break;
      }

      case '/listen':
      case '/listen.html': {
        try {
          const build = (process.env.VAPORZR_BUILD ?? 'dev').slice(0, 7);
          const file = fs
            .readFileSync(path.join(__dirname, '..', 'public', 'listen.html'), 'utf8')
            .replace(/\{\{ORIGIN\}\}/g, origin)
            .replace(/\{\{BUILD\}\}/g, build);
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(file);
        } catch {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Listener not found.');
        }
        break;
      }

      case '/privacy':
      case '/privacy.html': {
        try {
          const file = fs.readFileSync(path.join(__dirname, '..', 'public', 'privacy.html'), 'utf8');
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(file);
        } catch {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Privacy policy not found.');
        }
        break;
      }

      case '/tos':
      case '/terms':
      case '/terms.html':
      case '/tos.html': {
        try {
          const file = fs.readFileSync(path.join(__dirname, '..', 'public', 'tos.html'), 'utf8');
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(file);
        } catch {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Terms of service not found.');
        }
        break;
      }

      case '/api/stats': {
        // Same key gate as /api/token when a shared key is configured.
        if (controlAuthRequired() && !hasShareAccess(req, url)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
        const gid = url.searchParams.get('guildId') || (bridgeRef()?.getPrimaryGuildId() ?? '');
        const body = JSON.stringify({
          guildId: gid,
          totalQueued: gid ? statsStore.totalQueued(gid) : 0,
          users: gid ? statsStore.topUsers(gid, 10) : [],
          artists: gid ? statsStore.topArtists(gid, 10) : [],
          history: gid ? statsStore.history(gid, 30) : [],
        });
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(body);
        break;
      }

      case '/api/vibes': {
        // Crowd/request sessions may read the saved-vibe names: the jam page
        // offers them as shareable links. They cannot save or load by control.
        if (controlAuthRequired() && !hasShareAccess(req, url) && !hasRequestAccess(req, url)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
        const gid = url.searchParams.get('guildId') || (bridgeRef()?.getPrimaryGuildId() ?? '');
        const vibes = gid
          ? playlistStore.list(gid).map((p) => ({
              name: p.name,
              tracks: p.tracks.length,
              updatedAt: p.updatedAt,
              crossfadeMs: p.crossfadeMs ?? null,
            }))
          : [];
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ vibes }));
        break;
      }

      case '/api/activity/pair': {
        if (req.method !== 'POST') {
          res.writeHead(405);
          res.end();
          return;
        }
        const ip = req.socket.remoteAddress ?? 'unknown';
        if (!activityPairAllowed(ip)) {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Too many attempts - try again in a minute.' }));
          return;
        }
        const code = newPairCode();
        if (!code) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Could not allocate a code.' }));
          return;
        }
        // Drop expired codes: pairing is public, so the map must not be able to
        // grow from repeated attempts.
        if (activityPairs.size > 200) {
          const now = Date.now();
          for (const [existing, pair] of activityPairs) {
            if (now - pair.createdAt > ACTIVITY_PAIR_TTL_MS) activityPairs.delete(existing);
          }
        }
        activityPairs.set(code, { createdAt: Date.now() });
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ code, expiresInMs: ACTIVITY_PAIR_TTL_MS }));
        break;
      }

      case '/api/activity/approve': {
        if (req.method !== 'POST') {
          res.writeHead(405);
          res.end();
          return;
        }
        if (!config.shareKey || !hasShareAccess(req, url, 'control')) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Sign in to the panel first.' }));
          return;
        }
        const body = (await readJsonBody(req)) as { code?: string } | null;
        const code = String(body?.code ?? '')
          .trim()
          .toUpperCase();
        const pair = activityPairs.get(code);
        if (!pair || Date.now() - pair.createdAt > ACTIVITY_PAIR_TTL_MS) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'That code is expired - open the Activity and try again.' }));
          return;
        }
        // Reusable within a short window so the Activity can reconnect after a
        // network blip; view scope only, so it can never touch playback.
        const minted = mintInvite('view', 'discord activity', ACTIVITY_INVITE_TTL_MS, Date.now(), 0);
        pair.invite = minted.token;
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: true, expiresInMs: ACTIVITY_INVITE_TTL_MS }));
        break;
      }

      case '/api/logout': {
        if (req.method !== 'POST') {
          res.writeHead(405);
          res.end();
          return;
        }
        const cleared = revokeSessionByToken(tokenFromCookieHeader(req.headers.cookie));
        res.setHeader('Set-Cookie', 'vz_sess=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: true, cleared }));
        break;
      }

      case '/api/access': {
        // Owner sessions may read the master key back (device recovery).
        // Everyone else gets single-use invite links - never the secret itself.
        if ((!config.shareKey && !config.masterPassword) || !hasShareAccess(req, url, 'control')) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
        const cookie = req.headers.cookie ?? '';
        const sess = resolveSession(tokenFromCookieHeader(cookie));
        const cookieKey = keyFromCookieHeader(cookie);
        const queryKey = url.searchParams.get('key');
        const owner =
          Boolean(sess?.owner) ||
          (Boolean(config.shareKey) &&
            (secretEquals(cookieKey, config.shareKey) || secretEquals(queryKey, config.shareKey))) ||
          isMasterPassword(cookieKey) ||
          isMasterPassword(queryKey);
        const pl = vizTunnel.panelLink();
        const vl = vizTunnel.vizLink();
        const ll = vizTunnel.listenLink();
        // The deck link is a long-lived control invite minted by the bridge.
        // Make it absolute so the panel shows and copies one URL like the rest.
        const deckRaw = bridgeRef()?.deckLink() ?? '';
        const deckUrl = deckRaw
          ? /^https?:/i.test(deckRaw)
            ? deckRaw
            : `${origin}${deckRaw.startsWith('/') ? '' : '/'}${deckRaw}`
          : '';
        const inviteLink = (base: { url: string; secure: boolean }, scope: AccessScope, ttl: number, label: string) => {
          if (!owner || !base.secure) return ''; // minting invites is owner-only
          const { token } = mintInvite(scope, label, ttl);
          return `${base.url}?invite=${encodeURIComponent(token)}`;
        };
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(
          JSON.stringify({
            key: owner ? config.shareKey || config.masterPassword : undefined,
            owner,
            panelUrl: inviteLink(pl, 'control', OWNER_LINK_TTL_MS, 'panel link'),
            vizUrl: inviteLink(vl, 'view', INVITE_TTL_MS, 'visualizer link'),
            listenUrl: inviteLink(ll, 'view', INVITE_TTL_MS, 'listener link'),
            deckUrl: owner ? deckUrl : '',
            secure: Boolean(pl.secure && vl.secure && ll.secure),
          }),
        );
        break;
      }

      case '/api/dj': {
        // Per-person playback access. Only an existing control session may mint
        // or list these; a DJ session can never mint another DJ.
        if (!hasShareAccess(req, url, 'control')) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
        if (req.method === 'POST') {
          const body = (await readJsonBody(req)) as { label?: string } | null;
          const label =
            String(body?.label ?? '')
              .replace(/[\u0000-\u001f\u007f]/g, '')
              .trim()
              .slice(0, 40) || 'DJ';
          const { token, invite } = mintInvite('dj', label, 7 * 24 * 60 * 60 * 1000, Date.now(), 1);
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          res.end(
            JSON.stringify({
              url: `${origin}/panel?invite=${encodeURIComponent(token)}`,
              id: invite.id,
              label,
              expiresAt: invite.expiresAt,
            }),
          );
          return;
        }
        const data = listAccess();
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(
          JSON.stringify({
            sessions: data.sessions
              .filter((s) => s.scope === 'dj')
              .map((s) => ({ id: s.id, label: s.label, expiresAt: s.expiresAt, lastSeenAt: s.lastSeenAt })),
            invites: data.invites
              .filter((i) => i.scope === 'dj')
              .map((i) => ({
                id: i.id,
                label: i.label,
                expiresAt: i.expiresAt,
                uses: i.uses,
                maxUses: i.maxUses,
              })),
          }),
        );
        break;
      }

      case '/api/dj/revoke': {
        if (req.method !== 'POST') {
          res.writeHead(405);
          res.end();
          return;
        }
        if (!hasShareAccess(req, url, 'control')) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
        const body = (await readJsonBody(req)) as { type?: string; id?: string } | null;
        const id = String(body?.id ?? '');
        const ok = body?.type === 'invite' ? revokeInvite(id) : revokeSession(id);
        res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok }));
        break;
      }

      case '/api/push/key': {
        if (controlAuthRequired() && !hasShareAccess(req, url)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ key: pushPublicKey() }));
        break;
      }

      case '/api/push/subscribe': {
        if (req.method !== 'POST') {
          res.writeHead(405);
          res.end();
          return;
        }
        if (controlAuthRequired() && !hasShareAccess(req, url)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
        const body = (await readJsonBody(req)) as {
          endpoint?: string;
          keys?: { p256dh?: string; auth?: string };
        } | null;
        if (body?.endpoint && body.keys?.p256dh && body.keys.auth) {
          addPushSubscription({ endpoint: body.endpoint, keys: { p256dh: body.keys.p256dh, auth: body.keys.auth } });
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'bad subscription' }));
        }
        break;
      }

      case '/api/push/unsubscribe': {
        if (req.method !== 'POST') {
          res.writeHead(405);
          res.end();
          return;
        }
        if (controlAuthRequired() && !hasShareAccess(req, url)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
        const body = (await readJsonBody(req)) as { endpoint?: string } | null;
        if (body?.endpoint) removePushSubscription(body.endpoint);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: true }));
        break;
      }

      /* ---- deck uploads (drag & drop on /deck) ---- */
      case '/api/deck/sample': {
        if (req.method !== 'POST') {
          res.writeHead(405);
          res.end();
          return;
        }
        if (!hasShareAccess(req, url, 'control')) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'forbidden' }));
          return;
        }
        const bot = bridgeRef();
        if (!bot?.onSampleUpload) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'bot offline' }));
          return;
        }
        const name = safeAudioName(url.searchParams.get('name') ?? '');
        if (!name) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'name must end in .wav .mp3 .ogg .flac .m4a or .opus' }));
          return;
        }
        const data = await readBinaryBody(req, 12 * 1024 * 1024);
        if (!data || data.length < 64) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'empty upload (max 12 MB)' }));
          return;
        }
        const out = await bot.onSampleUpload(name, data);
        res.writeHead(out.ok ? 200 : 500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(out));
        break;
      }

      case '/api/deck/samples': {
        const bot = bridgeRef();
        if (!bot?.onSampleBank) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'bot offline' }));
          return;
        }
        const method = req.method ?? 'GET';
        if (!['GET', 'POST', 'PUT', 'DELETE'].includes(method)) {
          res.writeHead(405);
          res.end();
          return;
        }
        if (!hasShareAccess(req, url, method === 'GET' ? 'view' : 'control')) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'forbidden' }));
          return;
        }
        const action =
          method === 'GET'
            ? 'list'
            : (url.searchParams.get('op') ?? '') === 'reset'
              ? 'reset'
              : (url.searchParams.get('op') ?? '') === 'fill'
                ? 'fill'
                : method === 'POST'
                  ? 'save'
                  : method === 'PUT'
                    ? 'apply'
                    : 'delete';
        const name = url.searchParams.get('name') ?? '';
        const out = bot.onSampleBank(action, name);
        res.writeHead(out.ok ? 200 : 400, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(out));
        break;
      }

      case '/api/deck/recordings': {
        if (!hasShareAccess(req, url, 'control')) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'forbidden' }));
          return;
        }
        const dir = path.join(config.dataDir, 'decks');
        const items: Array<{ name: string; sizeBytes: number; at: number }> = [];
        try {
          for (const name of fs.readdirSync(dir)) {
            if (!/^set-[\w.-]+\.mp3$/i.test(name)) continue;
            try {
              const st = fs.statSync(path.join(dir, name));
              items.push({ name, sizeBytes: st.size, at: st.mtimeMs });
            } catch {
              /* vanished between readdir and stat */
            }
          }
        } catch {
          /* no recordings yet */
        }
        items.sort((a, b) => b.at - a.at);
        // Retention: keep the newest 10 forever-ish, drop anything older than
        // 30 days beyond that. Listing is the natural place to prune.
        const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
        const now = Date.now();
        const kept = items.filter((it, i) => {
          const stale = i >= 10 && now - it.at > RETENTION_MS;
          if (stale) {
            try {
              fs.rmSync(path.join(dir, it.name), { force: true });
            } catch {
              /* keep serving the listing even if a delete fails */
            }
          }
          return !stale;
        });
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ items: kept.slice(0, 50) }));
        break;
      }

      case '/api/deck/recording': {
        if (!hasShareAccess(req, url, 'control')) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'forbidden' }));
          return;
        }
        const name = url.searchParams.get('name') ?? '';
        // Only the files this server wrote; the name is never trusted as a path.
        if (!/^set-[\w.-]+\.mp3$/i.test(name)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid recording name' }));
          return;
        }
        const dir = path.join(config.dataDir, 'decks');
        const file = path.join(dir, name);
        if (!file.startsWith(dir + path.sep) || !fs.existsSync(file)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'not found' }));
          return;
        }
        if (req.method === 'DELETE') {
          try {
            fs.rmSync(file, { force: true });
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({ ok: true }));
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'delete failed' }));
          }
          return;
        }
        if (req.method !== 'GET') {
          res.writeHead(405);
          res.end();
          return;
        }
        const size = fs.statSync(file).size;
        res.writeHead(200, {
          'Content-Type': 'audio/mpeg',
          'Content-Disposition': `attachment; filename="${name}"`,
          'Content-Length': String(size),
          'Cache-Control': 'no-store',
        });
        const fileStream = fs.createReadStream(file);
        fileStream.on('error', () => {
          // The file vanished between stat and read (or the disk stalled): end
          // the response instead of leaving it hanging until the socket dies.
          try {
            res.end();
          } catch {
            /* client already gone */
          }
        });
        fileStream.pipe(res);
        break;
      }

      case '/api/deck/track': {
        if (req.method !== 'POST') {
          res.writeHead(405);
          res.end();
          return;
        }
        if (!hasShareAccess(req, url, 'control')) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'forbidden' }));
          return;
        }
        const bot = bridgeRef();
        if (!bot?.onDeckFileUpload) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'bot offline' }));
          return;
        }
        const deck = url.searchParams.get('deck') === 'b' ? 'b' : 'a';
        const name = safeAudioName(url.searchParams.get('name') ?? '');
        if (!name) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'name must end in .wav .mp3 .ogg .flac .m4a or .opus' }));
          return;
        }
        const data = await readBinaryBody(req, 64 * 1024 * 1024);
        if (!data || data.length < 512) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'empty upload (max 64 MB)' }));
          return;
        }
        const dir = path.join(config.dataDir, 'uploads');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `${Date.now()}-${Math.round(Math.random() * 1e6)}-${name}`);
        fs.writeFileSync(file, data);
        const out = await bot.onDeckFileUpload(
          url.searchParams.get('guildId') ?? undefined,
          deck,
          file,
          name.replace(/\.[^.]+$/, ''),
        );
        res.writeHead(out.ok ? 200 : 400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(out));
        break;
      }

      case '/api/search': {
        if (req.method !== 'GET') {
          res.writeHead(405);
          res.end();
          return;
        }
        if (!hasRequestAccess(req, url) && !hasShareAccess(req, url, 'view')) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'forbidden' }));
          return;
        }
        const bot = bridgeRef();
        if (!bot?.onSearch) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'bot offline' }));
          return;
        }
        const q = (url.searchParams.get('q') ?? '').trim().slice(0, 120);
        const limit = Math.max(1, Math.min(10, Number(url.searchParams.get('limit')) || 6));
        if (q.length < 2) {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ ok: true, items: [] }));
          return;
        }
        // Every keystroke would otherwise become a Spotify + YouTube call.
        const cacheKey = `${limit}:${q.toLowerCase()}`;
        const cached = searchCache.get(cacheKey);
        if (cached && Date.now() - cached.at < 30_000) {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ ok: true, items: cached.items }));
          return;
        }
        try {
          const items = await bot.onSearch(q, limit);
          if (searchCache.size > 200) searchCache.clear();
          searchCache.set(cacheKey, { at: Date.now(), items });
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ ok: true, items }));
        } catch {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ ok: false, items: [] }));
        }
        break;
      }

      case '/api/queue': {
        if (!hasRequestAccess(req, url)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'forbidden' }));
          return;
        }
        const bot = bridgeRef();
        if (!bot) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'bot offline' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(bot.jamQueue()));
        break;
      }

      case '/api/jam/policy': {
        if (req.method === 'GET') {
          if (!hasRequestAccess(req, url)) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'forbidden' }));
            return;
          }
          const p = bridgeRef()?.jamPolicy(bridgeRef()?.getPrimaryGuildId() ?? undefined);
          const owner = hasShareAccess(req, url, 'control');
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          res.end(
            JSON.stringify(
              p
                ? {
                    locked: p.locked,
                    approval: p.approval,
                    maxPerGuest: p.maxPerGuest,
                    cooldownSec: p.cooldownSec,
                    mute: owner ? p.mute : undefined,
                  }
                : { locked: false, approval: false, maxPerGuest: 0, cooldownSec: 0 },
            ),
          );
          return;
        }
        if (req.method !== 'POST') {
          res.writeHead(405);
          res.end();
          return;
        }
        if (!hasShareAccess(req, url, 'control')) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
        const body = (await readJsonBody(req)) as Partial<{
          locked: boolean;
          approval: boolean;
          maxPerGuest: number;
          cooldownSec: number;
          mute: string[];
        }> | null;
        const bot = bridgeRef();
        const next = bot?.setJamPolicy(bot.getPrimaryGuildId() ?? undefined, body ?? {});
        res.writeHead(next ? 200 : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(next ?? { error: 'bot offline' }));
        break;
      }

      case '/api/jam/vote': {
        if (req.method !== 'POST') {
          res.writeHead(405);
          res.end();
          return;
        }
        if (!hasRequestAccess(req, url)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'forbidden' }));
          return;
        }
        if (!requestGate()) {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Too many votes — try again shortly.' }));
          return;
        }
        const body = (await readJsonBody(req)) as { uri?: string; name?: string } | null;
        const result = bridgeRef()?.voteTrack(String(body?.uri ?? ''), body?.name);
        res.writeHead(result?.ok ? 200 : 400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(result ?? { error: 'bot offline' }));
        break;
      }

      case '/api/jam/requests': {
        if (!hasShareAccess(req, url, 'control')) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
        const bot = bridgeRef();
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        const gid = bot?.getPrimaryGuildId() ?? undefined;
        res.end(
          JSON.stringify({
            requests: bot?.jamPending(gid) ?? [],
            guests: bot?.jamGuests(gid) ?? [],
          }),
        );
        break;
      }

      case '/api/jam/approve':
      case '/api/jam/deny': {
        if (req.method !== 'POST') {
          res.writeHead(405);
          res.end();
          return;
        }
        if (!hasShareAccess(req, url, 'control')) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
        const body = (await readJsonBody(req)) as { id?: string } | null;
        const bot = bridgeRef();
        const id = String(body?.id ?? '');
        const result =
          url.pathname === '/api/jam/approve'
            ? await bot?.approveJamRequest(id)
            : { ok: bot?.denyJamRequest(id) ?? false };
        res.writeHead(result?.ok ? 200 : 400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(result ?? { error: 'bot offline' }));
        break;
      }

      case '/api/vibes/crossfade': {
        if (req.method !== 'POST') {
          res.writeHead(405);
          res.end();
          return;
        }
        if (!hasShareAccess(req, url, 'control')) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
        const body = (await readJsonBody(req)) as { name?: string; ms?: number } | null;
        const gid = bridgeRef()?.getPrimaryGuildId() ?? '';
        const ok = gid ? playlistStore.setCrossfade(gid, String(body?.name ?? ''), Number(body?.ms ?? 0)) : false;
        res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok }));
        break;
      }

      case '/api/vibe': {
        if (!hasRequestAccess(req, url)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'forbidden' }));
          return;
        }
        const bot = bridgeRef();
        const vibe = bot?.jamVibe(String(url.searchParams.get('name') ?? ''));
        res.writeHead(vibe?.ok ? 200 : 404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(vibe ?? { ok: false, error: 'bot offline' }));
        break;
      }

      case '/api/request/vibe': {
        if (req.method !== 'POST') {
          res.writeHead(405);
          res.end();
          return;
        }
        if (!hasRequestAccess(req, url)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'forbidden' }));
          return;
        }
        if (!requestGate()) {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Too many requests — try again shortly.' }));
          return;
        }
        const body = (await readJsonBody(req)) as { name?: string; who?: string } | null;
        const bot = bridgeRef();
        if (!bot) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'bot offline' }));
          return;
        }
        const result = await bot.requestVibe(String(body?.name ?? ''), body?.who);
        res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(result));
        break;
      }

      case '/api/request': {
        if (req.method !== 'POST') {
          res.writeHead(405);
          res.end();
          return;
        }
        if (!hasRequestAccess(req, url)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'forbidden' }));
          return;
        }
        const bot = bridgeRef();
        if (!bot) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'bot offline' }));
          return;
        }
        if (!requestGate()) {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Too many requests — try again shortly.' }));
          return;
        }
        const body = (await readJsonBody(req)) as { query?: string; name?: string } | null;
        const result = await bot.requestTrack(String(body?.query ?? ''), body?.name);
        res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(result));
        break;
      }

      case '/request':
      case '/request.html':
      case '/jam': {
        if (!grantRequestPage(req, url, res)) return;
        if (config.requestKey && secretEquals(url.searchParams.get('key'), config.requestKey)) {
          res.setHeader(
            'Set-Cookie',
            `vz_req=${encodeURIComponent(config.requestKey)}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`,
          );
        }
        try {
          const build = (process.env.VAPORZR_BUILD ?? 'dev').slice(0, 7);
          const file = fs
            .readFileSync(path.join(__dirname, '..', 'public', 'request.html'), 'utf8')
            .replace(/\{\{BUILD\}\}/g, build);
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(file);
        } catch {
          res.writeHead(404);
          res.end('Request page not found.');
        }
        break;
      }

      case '/activity-connect.js': {
        try {
          const body = fs.readFileSync(path.join(__dirname, '..', 'public', 'activity-connect.js'), 'utf8');
          res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(body);
        } catch {
          res.writeHead(404);
          res.end();
        }
        break;
      }

      case '/manifest.webmanifest': {
        try {
          const file = fs.readFileSync(path.join(__dirname, '..', 'public', 'manifest.webmanifest'));
          res.writeHead(200, { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'public, max-age=3600' });
          res.end(file);
        } catch {
          res.writeHead(404);
          res.end();
        }
        break;
      }

      case '/sw.js': {
        try {
          const build = (process.env.VAPORZR_BUILD ?? 'dev').slice(0, 7);
          const raw = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');
          const file = `/* build: ${build} */\n${raw}`;
          res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(file);
        } catch {
          res.writeHead(404);
          res.end();
        }
        break;
      }

      default:
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not_found' }));
    }
  } catch (err) {
    // Keep the detail server-side: this handler is reachable from the public
    // request page, and an exception message can carry paths, SQL or upstream
    // URLs that only help an attacker (CodeQL js/stack-trace-exposure).
    console.error('[vaporzr] request failed:', err);
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Internal server error.');
  }
}

/** Escape text interpolated into the small html() pages below. */
function esc(s: string): string {
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return s.replace(/[&<>"']/g, (c) => map[c] ?? c);
}

function html(body: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Vaporzr</title>
    <style>body{font-family:system-ui,sans-serif;background:#0b1026;color:#c7d2fe;max-width:600px;margin:4rem auto;padding:0 1rem}
    a{color:#7dd3fc;text-decoration:none;border:1px solid #334155;padding:.4rem .8rem;border-radius:8px;display:inline-block;margin-top:1rem}
    h1{background:linear-gradient(90deg,#60a5fa,#a78bfa);-webkit-background-clip:text;background-clip:text;color:transparent}</style>
    </head><body>${body}</body></html>`;
}
