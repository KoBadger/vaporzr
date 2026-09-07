import { config } from './config.js';
import { SessionManager } from './session.js';
import { PermissionsManager } from './permissions.js';
import { startServer } from './server.js';
import { DiscordBot } from './discord.js';
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
  console.error('[vaporzr] unhandled rejection:', reason instanceof Error ? reason.stack ?? reason.message : reason);
});
// A lone unhandled 'error' (e.g. EPIPE on a socket whose peer vanished) must not
// take the whole bot down — the voice watchdog self-heals the feed afterwards.
process.on('uncaughtException', (err) => {
  console.error('[vaporzr] uncaught exception:', err instanceof Error ? err.stack ?? err.message : err);
});

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

  // Duplicate-launch guard: MUST run before startServer(), whose Bridge
  // constructor calls librespot.start() → killStale() and would kill the
  // running instance's librespot/bridge before this one even binds the port.
  if (await isPortTaken(config.port)) {
    console.log(`[vaporzr] another instance already holds port ${config.port} — exiting quietly.`);
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
