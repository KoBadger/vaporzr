import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { buildAuthorizeUrl, exchangeCode, getAccessToken, SpotifyError, spotifyCacheSize } from './spotify.js';
import { tokenStore } from './tokenStore.js';
import { Bridge } from './bridge.js';
import { SessionManager } from './session.js';
import { PermissionsManager } from './permissions.js';
import { vizTunnel } from './tunnel.js';
import { secretEquals } from './secretCompare.js';
import { statsStore } from './stats.js';

/** Pre-gzipped vendor assets — preset chunks are tens of MB of JS. */
const vendorCache = new Map<string, { body: Buffer; gzip: boolean }>();
import { playlistStore } from './playlists.js';
import { probeYoutube, youtubeHealth } from './youtube.js';
import { addPushSubscription, pushPublicKey, pushSubscriptionCount, removePushSubscription } from './push.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Cached health of the bgutil YouTube PO-token provider (host loopback :4416).
 * Without it YouTube extraction silently degrades, so surface it in /health.
 * "unknown" until the first probe lands.
 */
let poTokenStatus: 'up' | 'down' | 'unknown' = 'unknown';
function probePoTokenProvider(): void {
  const req = http.get({ host: '127.0.0.1', port: 4416, path: '/ping', timeout: 1500 }, (res) => {
    res.resume();
    poTokenStatus = res.statusCode === 200 ? 'up' : 'down';
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
      // spotifyCooldownUntil is not exported; report healthy (failures surface
      // per-command). Kept as a string so probes can key off it later.
      const spotifyApiStatus = 'healthy';
      const body = JSON.stringify({
        ok: true,
        uptimeSec: Math.round(process.uptime()),
        guilds,
        playing: all.filter((s) => s.queue.getState().playing).length,
        sessions: all.length,
        librespot: librespotStatus,
        spotifyApi: spotifyApiStatus,
        poToken: poTokenStatus,
        youtube: youtubeHealth().status,
        cookiesAgeDays: cookiesAgeDays(),
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

  // YouTube canary: catch expired cookies / dead solver / dead proxy up front.
  const cookieAge = cookiesAgeDays();
  if (cookieAge === null) {
    console.warn('[vaporzr] no YouTube cookies file found — YouTube may hit the bot check. Set YOUTUBE_COOKIES_PATH.');
  } else if (cookieAge > 21) {
    console.warn(`[vaporzr] YouTube cookies are ~${cookieAge} days old — they expire soon; refresh /opt/vaporzr/cookies.txt.`);
  }
  void probeYoutube();
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

/** True when the request carries the shared key (cookie or ?key= param). */
export function hasShareAccess(req: http.IncomingMessage, url: URL): boolean {
  const key = config.shareKey;
  if (!key) return true;
  const cookie = req.headers.cookie ?? '';
  const m = /(?:^|;\s*)vz_key=([^;]+)/.exec(cookie);
  if (m) {
    let value = m[1];
    try {
      value = decodeURIComponent(value);
    } catch {
      /* malformed encoding — compare raw */
    }
    if (secretEquals(value, key)) return true;
  }
  return secretEquals(url.searchParams.get('key'), key);
}

/** Gate for the public /request page: its own lower-privilege key. */
function hasRequestAccess(req: http.IncomingMessage, url: URL): boolean {
  if (config.requestKey) {
    const cookie = req.headers.cookie ?? '';
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
    return secretEquals(url.searchParams.get('key'), config.requestKey);
  }
  // No dedicated request key: only allow on an otherwise-open (LAN-only) setup.
  return !config.shareKey;
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

/** Age of the YouTube cookies file in days (null if unset/missing). */
function cookiesAgeDays(): number | null {
  try {
    const p = config.youtubeCookiesPath;
    if (!p) return null;
    const st = fs.statSync(p);
    return Math.max(0, Math.round((Date.now() - st.mtimeMs) / 86_400_000));
  } catch {
    return null;
  }
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

function keyPrompt(res: http.ServerResponse): void {
  res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Vaporzr — Access</title>
<link rel="icon" type="image/png" href="/favicon.png">
<style>body{font-family:system-ui,sans-serif;background:#0b1026;color:#c7d2fe;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
form{background:rgba(16,22,46,.8);border:1px solid rgba(140,160,255,.25);padding:2rem;border-radius:16px;text-align:center}
h1{font-size:15px;letter-spacing:3px;background:linear-gradient(90deg,#00f0ff,#6a5cff);-webkit-background-clip:text;background-clip:text;color:transparent}
input{display:block;margin:1rem auto;padding:.6rem .9rem;border-radius:9px;border:1px solid rgba(140,160,255,.3);background:rgba(10,14,32,.7);color:#e2e8f0;font-size:14px;width:220px}
button{padding:.6rem 1.4rem;border-radius:9px;border:none;background:linear-gradient(135deg,#6a5cff,#00f0ff);color:#0b1026;font-weight:700;cursor:pointer}</style>
</head><body><form method="GET"><h1>VAPORZR</h1><p style="color:#94a3b8;font-size:12px">Enter the share key to continue</p>
<input name="key" placeholder="share key" autofocus><button>Enter</button></form></body></html>`);
}

async function handleRoute(
  req: http.IncomingMessage,
  url: URL,
  res: http.ServerResponse,
  bridgeRef: () => Bridge | null,
): Promise<void> {
  const host = req.headers.host ?? `localhost:${config.port}`;
  const origin = `https://${host}`;
  try {
    // Share-key gate: only the CONTROL panel requires the key. The visualizer
    // and its vendor bundles are open — viewing is free, controlling is not.
    const gated = url.pathname.startsWith('/panel');
    if (gated && !hasShareAccess(req, url)) {
      keyPrompt(res);
      return;
    }
    if (gated && config.shareKey && secretEquals(url.searchParams.get('key'), config.shareKey)) {
      // Persist the key so later loads don't need ?key=. Add Secure when the
      // request arrived through an HTTPS tunnel so the cookie never travels in
      // clear over the last hop.
      const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim();
      const secure = proto === 'https' ? '; Secure' : '';
      res.setHeader(
        'Set-Cookie',
        `vz_key=${encodeURIComponent(config.shareKey)}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${secure}`,
      );
    }
    // Brand assets.
    const BRAND_ASSETS: Record<string, string> = {
      '/favicon.png': 'image/png',
      '/logo.png': 'image/png',
      '/logo.gif': 'image/gif',
      '/icon-192.png': 'image/png',
      '/icon-512.png': 'image/png',
      '/icon-maskable.png': 'image/png',
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
            'Cache-Control': 'public, max-age=86400',
          });
          const stream = fs.createReadStream(filePath, { start, end });
          stream.on('error', () => {
            try { res.end(); } catch { /* client went away */ }
          });
          stream.pipe(res);
        } else {
          res.writeHead(200, {
            'Content-Type': 'video/mp4',
            'Content-Length': stat.size,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'public, max-age=86400',
          });
          const stream = fs.createReadStream(filePath);
          stream.on('error', () => {
            try { res.end(); } catch { /* client went away */ }
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
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' });
        res.end(file);
        return;
      } catch {
        res.writeHead(404);
        res.end();
        return;
      }
    }
    // Static vendor bundles for the web visualizer (butterchurn etc.) plus the
    // lazily-loaded preset library under presets/.
    if (url.pathname.startsWith('/vendor/')) {
      const rel = url.pathname.slice('/vendor/'.length);
      if (/^[\w.-]+\.(js|json)$/.test(rel) || /^presets\/[\w.-]+\.(js|json)$/.test(rel)) {
        try {
          const target = path.join(__dirname, '..', 'public', 'vendor', rel);
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

    switch (url.pathname) {
      case '/':
      case '/index.html': {
        // Bot tokens are base64(appId).signature — decode for the invite link.
        const appId = Buffer.from(config.discordToken.split('.')[0], 'base64').toString('ascii');
        const perms = (1n << 11n) | (1n << 14n) | (1n << 15n) | (1n << 20n) | (1n << 31n) | (1n << 52n);
        const inviteUrl = `https://discord.com/oauth2/authorize?client_id=${appId}&permissions=${perms}&scope=bot+applications.commands`;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(html(`
          <img src="/logo.png" alt="Vaporzr" style="width:96px;height:96px;border-radius:22px;box-shadow:0 8px 30px rgba(106,92,255,.45);margin-bottom:1rem">
          <h1>Vaporzr Bot</h1>
          <p><a href="${inviteUrl}" style="border-color:#6a5cff;background:rgba(106,92,255,.18);font-weight:600">➕ Add to your server</a></p>
          <p>${tokenStore.load() ? 'Spotify account linked.' : 'Spotify not linked.'}</p>
          <p><a href="/login">Link Spotify account</a></p>
          <p>Player status: <span id="s">checking…</span></p>
          <p><a href="/panel">Open the control panel →</a> <a href="/viz">Visualizer →</a></p>
          <script>
            try {
              fetch('/api/token').then(r => r.json()).then(d => {
                document.getElementById('s').textContent = d.error ? 'not authorized' : 'authorized ✓';
              });
            } catch (e) { document.getElementById('s').textContent = 'error'; }
          </script>
        `));
        break;
      }

      case '/login': {
        const state = crypto.randomBytes(16).toString('hex');
        res.writeHead(302, { Location: buildAuthorizeUrl(state) });
        res.end();
        break;
      }

      case '/callback': {
        const code = url.searchParams.get('code');
        const err = url.searchParams.get('error');
        console.log(`[vaporzr] oauth callback: code=${code ? 'present' : 'MISSING'} error=${err ?? 'none'} state=${url.searchParams.get('state') ?? 'none'}`);
        if (err) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html(`<h1 style="font-family:sans-serif">Authorization failed (${err}). Close this tab and try /login again.</h1>`));
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
        if (config.shareKey && !hasShareAccess(req, url)) {
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
        if (config.shareKey && !hasShareAccess(req, url)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
        const gid = url.searchParams.get('guildId') || (bridgeRef()?.getPrimaryGuildId() ?? '');
        const vibes = gid
          ? playlistStore.list(gid).map((p) => ({ name: p.name, tracks: p.tracks.length, updatedAt: p.updatedAt }))
          : [];
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ vibes }));
        break;
      }

      case '/api/push/key': {
        if (config.shareKey && !hasShareAccess(req, url)) {
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
        if (config.shareKey && !hasShareAccess(req, url)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
        const body = (await readJsonBody(req)) as
          | { endpoint?: string; keys?: { p256dh?: string; auth?: string } }
          | null;
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
        if (config.shareKey && !hasShareAccess(req, url)) {
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
        const body = (await readJsonBody(req)) as { query?: string } | null;
        const result = await bot.requestTrack(String(body?.query ?? ''));
        res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(result));
        break;
      }

      case '/request':
      case '/request.html': {
        if (!hasRequestAccess(req, url)) {
          res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h1 style="font-family:system-ui">Requests are disabled or keyed. Ask the operator for a link.</h1>');
          return;
        }
        if (config.requestKey && secretEquals(url.searchParams.get('key'), config.requestKey)) {
          res.setHeader(
            'Set-Cookie',
            `vz_req=${encodeURIComponent(config.requestKey)}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`,
          );
        }
        try {
          const file = fs.readFileSync(path.join(__dirname, '..', 'public', 'request.html'), 'utf8');
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(file);
        } catch {
          res.writeHead(404);
          res.end('Request page not found.');
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
          const file = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'));
          res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
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
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(err instanceof Error ? err.message : String(err));
  }
}

function html(body: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Vaporzr</title>
    <style>body{font-family:system-ui,sans-serif;background:#0b1026;color:#c7d2fe;max-width:600px;margin:4rem auto;padding:0 1rem}
    a{color:#7dd3fc;text-decoration:none;border:1px solid #334155;padding:.4rem .8rem;border-radius:8px;display:inline-block;margin-top:1rem}
    h1{background:linear-gradient(90deg,#60a5fa,#a78bfa);-webkit-background-clip:text;background-clip:text;color:transparent}</style>
    </head><body>${body}</body></html>`;
}
