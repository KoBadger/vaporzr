import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { buildAuthorizeUrl, exchangeCode, getAccessToken, SpotifyError } from './spotify.js';
import { tokenStore } from './tokenStore.js';
import { Bridge } from './bridge.js';
import { SessionManager } from './session.js';
import { PermissionsManager } from './permissions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function startServer(sessions: SessionManager, perms: PermissionsManager): Bridge {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${config.port}`);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    void handleRoute(url, res);
  });

  const bridge = new Bridge(sessions, perms, server);

  server.listen(config.port, '0.0.0.0', () => {
    console.log(`[vaporzr] control server on http://0.0.0.0:${config.port}`);
  });

  return bridge;
}

async function handleRoute(url: URL, res: http.ServerResponse): Promise<void> {
  try {
    switch (url.pathname) {
      case '/':
      case '/index.html': {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html(`
          <h1>Vaporzr Bot</h1>
          <p>${tokenStore.load() ? 'Spotify account linked.' : 'Spotify not linked.'}</p>
          <p><a href="/login">Link Spotify account</a></p>
          <p>Player status: <span id="s">checking…</span></p>
          <p><a href="/panel">Open the control panel →</a></p>
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
        if (!tokenStore.load()) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'not_authorized' }));
          return;
        }
        const token = await getAccessToken();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ token }));
        break;
      }

      case '/panel':
      case '/panel.html': {
        try {
          const file = fs.readFileSync(path.join(__dirname, '..', 'public', 'panel.html'), 'utf8');
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
          const file = fs.readFileSync(path.join(__dirname, '..', 'public', 'viz.html'), 'utf8');
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
