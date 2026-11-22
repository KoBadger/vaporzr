/**
 * Entry point for the Telegram front end.
 *
 * Boot order matters: learn who we are (getMe) before routing anything, because
 * privacy routing keys off our own username; register the command menu while we
 * are still the only thing happening; then start polling. The Vaporzr socket
 * connects in parallel — the bot answers reads over HTTP even if it has not
 * finished negotiating the WebSocket.
 */

import { loadConfig } from './config.js';
import { Store } from './store.js';
import { TelegramApi, TelegramError } from './telegram.js';
import { VaporzrClient } from './vaporzr.js';
import { TelegramBot } from './bot.js';

const COMMANDS = [
  { command: 'play', description: 'Queue a song or a link' },
  { command: 'queue', description: 'What is up next' },
  { command: 'now', description: 'Show the now-playing card' },
  { command: 'skip', description: 'Skip the current track' },
  { command: 'pause', description: 'Pause playback' },
  { command: 'resume', description: 'Resume playback' },
  { command: 'help', description: 'How this bot works' },
];

async function main(): Promise<void> {
  const config = loadConfig();
  const api = new TelegramApi(config.token);
  const client = new VaporzrClient(config.vaporzrUrl, config.vaporzrKey);
  const store = new Store(config.statePath);
  await store.load();

  const me = await api.getMe();
  const username = me.username ?? '';
  console.log(`[telegram] @${username} (id ${me.id}) → ${config.vaporzrUrl}`);

  const build = await client.buildId();
  console.log(`[telegram] music bot build: ${build}`);

  const bot = new TelegramBot({ api, client, store, config, username, log: (line) => console.log(line) });

  // The command menu is idempotent and cheap; failing it must not stop the bot.
  await api.setMyCommands(COMMANDS).catch((err: unknown) => {
    console.warn(`[telegram] could not set the command menu: ${err instanceof Error ? err.message : err}`);
  });
  // A Web App menu button only works over HTTPS; anything else would be a dead
  // button, so it is skipped rather than registered and failing on tap.
  if (/^https:\/\//i.test(config.panelUrl)) {
    await api
      .setChatMenuButton({
        type: 'web_app',
        text: 'Panel',
        web_app: { url: config.panelUrl },
      })
      .catch((err: unknown) => {
        console.warn(`[telegram] could not set the menu button: ${err instanceof Error ? err.message : err}`);
      });
  }

  client.onNotice((notice) => {
    void bot.onNotice(notice).catch(() => {});
  });
  client.connect();

  const controller = new AbortController();
  const shutdown = (signal: string): void => {
    console.log(`[telegram] ${signal} — shutting down`);
    controller.abort();
    client.stop();
    void store.flush().finally(() => process.exit(0));
    // Do not hang forever on a long poll that refuses to settle.
    const force = setTimeout(() => process.exit(0), 5000);
    force.unref?.();
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  // A single unhandled rejection would otherwise take down polling for a
  // recoverable Telegram hiccup.
  process.on('unhandledRejection', (reason) => {
    console.warn(`[telegram] unhandled rejection: ${reason instanceof Error ? reason.message : reason}`);
  });

  await bot.run(controller.signal);
}

main().catch((err: unknown) => {
  if (err instanceof TelegramError && (err.code === 401 || err.code === 404)) {
    console.error('[telegram] the bot token was rejected — check TELEGRAM_BOT_TOKEN');
  } else {
    console.error(`[telegram] fatal: ${err instanceof Error ? (err.stack ?? err.message) : err}`);
  }
  process.exit(1);
});
