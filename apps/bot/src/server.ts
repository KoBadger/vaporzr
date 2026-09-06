import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { buildAuthorizeUrl, exchangeCode, getAccessToken, SpotifyError, spotifyCacheSize } from './spotify.js';
import { tokenStore } from './tokenStore.js';
import { Bridge } from './bridge.js';
import { SessionManager } from './session.js';
import { PermissionsManager } from './permissions.js';
import { vizTunnel } from './tunnel.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

    void handleRoute(req, url, res);
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

  return bridge;
}

/** True when the request carries the shared key (cookie or ?key= param). */
export function hasShareAccess(req: http.IncomingMessage, url: URL): boolean {
  if (!config.shareKey) return true;
  const cookie = req.headers.cookie ?? '';
  const m = /(?:^|;\s*)vz_key=([^;]+)/.exec(cookie);
  if (m && m[1] === config.shareKey) return true;
  return url.searchParams.get('key') === config.shareKey;
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

async function handleRoute(req: http.IncomingMessage, url: URL, res: http.ServerResponse): Promise<void> {
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
    if (gated && config.shareKey && url.searchParams.get('key') === config.shareKey) {
      res.setHeader('Set-Cookie', `vz_key=${config.shareKey}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`);
    }
    // Brand assets.
    if (url.pathname === '/favicon.png' || url.pathname === '/logo.png') {
      try {
        const file = fs.readFileSync(path.join(__dirname, '..', 'public', url.pathname.slice(1)));
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
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
    // Static vendor bundles for the web visualizer (butterchurn etc.).
    if (url.pathname.startsWith('/vendor/')) {
      const rel = url.pathname.slice('/vendor/'.length);
      if (/^[\w.-]+\.js$/.test(rel)) {
        const file = fs.readFileSync(path.join(__dirname, '..', 'public', 'vendor', rel));
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'public, max-age=86400',
        });
        res.end(file);
        return;
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
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
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
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html(`<h1 style="font-family:sans-serif">✓ Linked! You can close this tab.</h1>`));
        break;
      }

      case '/api/token': {
        // The Spotify OAuth access token is sensitive — only expose it to key
        // holders (the same gate that protects /panel). Without this, anyone
        // who learns the public tunnel URL could GET the operator's token.
        if (config.shareKey && !hasShareAccess(req, url)) {
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
          const file = fs
            .readFileSync(path.join(__dirname, '..', 'public', 'panel.html'), 'utf8')
            .replace(/\{\{ORIGIN\}\}/g, origin);
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
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
          const file = fs
            .readFileSync(path.join(__dirname, '..', 'public', 'viz.html'), 'utf8')
            .replace(/\{\{ORIGIN\}\}/g, origin);
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
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
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
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
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(file);
        } catch {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Terms of service not found.');
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
