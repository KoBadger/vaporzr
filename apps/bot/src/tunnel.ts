import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import readline from 'node:readline';
import { config } from './config.js';

/**
 * Ephemeral Cloudflare quick tunnel ("Try Cloudflare") that exposes the local
 * control server behind a real TLS hostname (https://<id>.trycloudflare.com)
 * so /viz and /panel links are trusted by browsers instead of flagged
 * "Not secure". No account, no config — cloudflared picks a random subdomain
 * each run. WSS proxies through the same hostname automatically.
 */

// Never route the tunnel through a local/system proxy.
const CLEAN_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.toLowerCase().endsWith('_proxy')),
);

const MAX_RESTARTS = 5;

let child: ChildProcess | null = null;
let publicUrl: string | null = null;
let restarts = 0;
let stopped = false;

function scanLine(line: string): void {
  const quick = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/i.exec(line);
  if (quick && quick[0] !== publicUrl) {
    publicUrl = quick[0];
    restarts = 0;
    console.log(`[tunnel] secure URL live: ${publicUrl}`);
    return;
  }
  // Named tunnels log "Registered tunnel connection ... url=https://viz.example.com"
  const named = /url=(https:\/\/[a-z0-9.-]+\.[a-z]{2,})/i.exec(line);
  if (named && named[1] !== publicUrl) {
    publicUrl = named[1];
    restarts = 0;
    console.log(`[tunnel] secure URL live: ${publicUrl}`);
  }
}

function launch(): void {
  if (!fs.existsSync(config.cloudflaredPath)) {
    console.log('[tunnel] cloudflared not found — secure URLs disabled (LAN links only)');
    stopped = true;
    return;
  }
  // Two modes:
  //  - TUNNEL_TOKEN set  -> named tunnel (your own domain, e.g. viz.vaporzr.app)
  //  - otherwise         -> ephemeral quick tunnel (random *.trycloudflare.com)
  const args = config.tunnelToken
    ? ['tunnel', '--no-autoupdate', 'run', '--token', config.tunnelToken]
    : [
        'tunnel',
        '--url', `http://127.0.0.1:${config.port}`,
        '--no-autoupdate',
        '--edge-ip-version', '4',
        '--protocol', 'http2',
      ];
  console.log(`[tunnel] starting cloudflared (${config.tunnelToken ? 'named' : 'quick'}) tunnel...`);
  try {
    child = spawn(config.cloudflaredPath, args, {
      env: CLEAN_ENV,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    console.error('[tunnel] failed to spawn cloudflared:', err instanceof Error ? err.message : err);
    stopped = true;
    return;
  }

  readline.createInterface({ input: child.stdout!, crlfDelay: Infinity }).on('line', scanLine);
  readline.createInterface({ input: child.stderr!, crlfDelay: Infinity }).on('line', scanLine);

  child.on('exit', (code) => {
    child = null;
    if (publicUrl) console.log('[tunnel] connection lost — clearing secure URL');
    publicUrl = null;
    if (stopped) return;
    restarts++;
    if (restarts > MAX_RESTARTS) {
      console.error('[tunnel] giving up after repeated exits (LAN links still work)');
      return;
    }
    const delay = Math.min(30000, 2000 * restarts);
    console.log(`[tunnel] exited (code ${code}) — restarting in ${delay / 1000}s`);
    setTimeout(launch, delay).unref?.();
  });

  child.on('error', (err) => {
    console.error('[tunnel] cloudflared error:', err.message);
  });
}

function base(): { url: string; secure: boolean } {
  if (config.staticBaseUrl) return { url: config.staticBaseUrl.replace(/\/+$/, ''), secure: true };
  if (publicUrl) return { url: publicUrl, secure: true };
  return { url: '', secure: false };
}

export const vizTunnel = {
  start(): void {
    // A configured static base URL (Tailscale Funnel / custom domain) makes the
    // ephemeral quick tunnel redundant — don't even spawn cloudflared.
    if (config.staticBaseUrl) return;
    if (stopped || child || !config.vizTunnel) return;
    launch();
  },
  stop(): void {
    stopped = true;
    child?.kill();
    child = null;
    publicUrl = null;
  },
  /** Current https://xxx.trycloudflare.com base URL, or null when offline. */
  url(): string | null {
    return publicUrl;
  },
  /** Full /viz URL (secure when available), plus whether it's the secure one. */
  vizLink(): { url: string; secure: boolean } {
    const b = base();
    if (b.secure) return { url: `${b.url}/viz`, secure: true };
    return { url: `http://${lanOrPublic()}:${config.port}/viz`, secure: false };
  },
  /** Full /panel URL (secure when available), plus whether it's the secure one. */
  panelLink(): { url: string; secure: boolean } {
    const b = base();
    if (b.secure) return { url: `${b.url}/panel`, secure: true };
    return { url: `http://${lanOrPublic()}:${config.port}/panel`, secure: false };
  },
};

function lanOrPublic(): string {
  if (config.publicHost) return config.publicHost;
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return 'localhost';
}
