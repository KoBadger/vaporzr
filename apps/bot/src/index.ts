import { config } from '@vaporzr/core/config';
import { ffmpegLimiter } from '@vaporzr/core/processLimiter';
import { SessionManager } from './session.js';
import { PermissionsManager } from './permissions.js';
import { startServer } from './server.js';
import { DiscordBot } from './discord.js';
import { logOpusStartup } from './opusStream.js';
import net from 'node:net';

// Windows console/redirect writes can mangle non-ASCII (e.g. "Böhmer" → "B?hmer")
// because the default stream encoding is the ANSI code page, not UTF-8. Force
// UTF-8 on the byte stream so bot.log stays clean for every title/artist.
for (const stream of [process.stdout, process.stderr]) {
  const orig = stream.write.bind(stream);
  stream.write = ((chunk: unknown, ...args: unknown[]) => {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    if (typeof args[0] === 'function') return orig(buf, args[0] as (err?: Error | null) => void);
    return orig(buf);
  }) as typeof stream.write;
}

process.on('unhandledRejection', (reason) => {
  console.error('[vaporzr] unhandled rejection:', reason instanceof Error ? (reason.stack ?? reason.message) : reason);
});
// A lone unhandled 'error' (e.g. EPIPE on a socket whose peer vanished) must not
// take the whole bot down — the voice watchdog self-heals the feed afterwards.
process.on('uncaughtException', (err) => {
  console.error('[vaporzr] uncaught exception:', err instanceof Error ? (err.stack ?? err.message) : err);
});

// Memory monitoring: log warning when heap usage is high.
// Helps detect memory leaks or pressure before they cause issues.
let lastMemoryWarn = 0;
const MEMORY_WARN_THRESHOLD_MB = 500;
const MEMORY_CHECK_INTERVAL_MS = 60_000; // Check every minute

setInterval(() => {
  const used = process.memoryUsage();
  const heapUsedMB = Math.round(used.heapUsed / 1024 / 1024);
  const now = Date.now();

  // Only warn if above threshold AND at least 5 minutes since last warning
  if (heapUsedMB > MEMORY_WARN_THRESHOLD_MB && now - lastMemoryWarn > 300_000) {
    lastMemoryWarn = now;
    const metrics = ffmpegLimiter.getMetrics();
    console.warn(
      `[memory] heap at ${heapUsedMB}MB ` +
        `(ffmpeg: ${metrics.active} active, ${metrics.queued} queued, ${metrics.totalSpawned} total spawned)`,
    );
  }
}, MEMORY_CHECK_INTERVAL_MS).unref();

/** True when another process is already listening on config.port (single-instance guard). */
function isPortTaken(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    s.once('connect', () => {
      s.destroy();
      resolve(true);
    });
    s.once('error', () => resolve(false));
  });
}

async function main(): Promise<void> {
  if (!config.discordToken) {
    console.error('DISCORD_TOKEN is missing. Copy apps/bot/.env.example to apps/bot/.env and fill it in.');
    process.exit(1);
  }

  console.log(`[vaporzr] instance role: ${config.botPrimary ? 'PRIMARY' : 'SECONDARY'}`);
  // Which Opus encoder voice will use, before anyone plays anything.
  logOpusStartup();
  // Single-instance guard: only the PRIMARY instance runs by default. A second
  // login on the same token fights the primary for the gateway session (missed
  // events + duplicate replies). Set ALLOW_SECONDARY=1 to run a non-primary
  // instance intentionally (with the primary stopped).
  if (!config.botPrimary && !config.allowSecondary) {
    let detail = '';
    if (config.primaryHealthUrl) {
      try {
        const res = await fetch(config.primaryHealthUrl, { signal: AbortSignal.timeout(4000) });
        if (res.ok) detail = ` The primary is live at ${config.primaryHealthUrl}.`;
      } catch {
        /* can't reach the primary (or no network) — still refuse; this is the guard */
      }
    }
    console.warn(
      `[vaporzr] Refusing to start a SECONDARY instance.${detail}\n` +
        '          Only ONE instance may use a bot token. To run this one instead:\n' +
        '            1. stop the primary:  ssh root@46.224.80.104 "docker stop vaporzr"\n' +
        '            2. set ALLOW_SECONDARY=1 (or BOT_PRIMARY=1) in apps/bot/.env',
    );
    process.exit(0);
  }

  // Duplicate-launch guard: MUST run before startServer(), whose Bridge
  // constructor calls librespot.start() → killStale() and would kill the
  // running instance's librespot/bridge before this one even binds the port.
  if (await isPortTaken(config.port)) {
    console.warn(
      `[vaporzr] another instance already holds port ${config.port} — exiting quietly. ` +
        'Two instances sharing one token fight over the single Discord gateway session ' +
        '(missed events + duplicate replies); keep exactly ONE running.',
    );
    process.exit(0);
  }

  const sessions = new SessionManager();
  const perms = new PermissionsManager();
  const bridge = startServer(sessions, perms);
  const discord = new DiscordBot(sessions, perms, bridge);
  await discord.start();

  // Without this, a tsx restart or Ctrl+C leaves librespot running and it
  // stays registered as the Connect device — later play commands route to it
  // instead of the fresh session (wrong track / silent stall).
  const shutdown = (): void => {
    // Stop new ffmpeg spawns first: during the flush/stop/exit window a fresh
    // spawn would be killed by process.exit() anyway, and the churn can trip the
    // Windows commit limit (0xc000012d). Active streams still end by themselves.
    ffmpegLimiter.shutdown();
    // Flush debounced queue persistence first — process.exit() below discards
    // the pending timers, so a redeploy would otherwise lose the newest changes.
    try {
      sessions.flushAll();
    } catch {
      /* ignore */
    }
    try {
      bridge.librespot.stop();
    } catch {
      /* ignore */
    }
  };
  process.on('exit', shutdown);
  process.on('SIGINT', () => {
    shutdown();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    shutdown();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('[vaporzr] fatal:', err);
  process.exit(1);
});
