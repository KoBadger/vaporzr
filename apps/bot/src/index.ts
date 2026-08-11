import { config } from './config.js';
import { QueueManager } from './queue.js';
import { PermissionsManager } from './permissions.js';
import { startServer } from './server.js';
import { DiscordBot } from './discord.js';

async function main(): Promise<void> {
  if (!config.discordToken) {
    console.error('DISCORD_TOKEN is missing. Copy apps/bot/.env.example to apps/bot/.env and fill it in.');
    process.exit(1);
  }

  const queue = new QueueManager();
  const perms = new PermissionsManager();
  const bridge = startServer(queue, perms);
  const discord = new DiscordBot(queue, bridge.playback, perms, bridge);
  await discord.start();
}

main().catch((err) => {
  console.error('[vaporzr] fatal:', err);
  process.exit(1);
});
