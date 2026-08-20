import { config } from './config.js';
import { SessionManager } from './session.js';
import { PermissionsManager } from './permissions.js';
import { startServer } from './server.js';
import { DiscordBot } from './discord.js';

process.on('unhandledRejection', (reason) => {
  console.error('[vaporzr] unhandled rejection:', reason instanceof Error ? reason.stack ?? reason.message : reason);
});
// A lone unhandled 'error' (e.g. EPIPE on a socket whose peer vanished) must not
// take the whole bot down — the voice watchdog self-heals the feed afterwards.
process.on('uncaughtException', (err) => {
  console.error('[vaporzr] uncaught exception:', err instanceof Error ? err.stack ?? err.message : err);
});

async function main(): Promise<void> {
  if (!config.discordToken) {
    console.error('DISCORD_TOKEN is missing. Copy apps/bot/.env.example to apps/bot/.env and fill it in.');
    process.exit(1);
  }

  const sessions = new SessionManager();
  const perms = new PermissionsManager();
  const bridge = startServer(sessions, perms);
  const discord = new DiscordBot(sessions, perms, bridge);
  await discord.start();

  // Without this, a tsx restart or Ctrl+C leaves librespot.exe running and it
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
