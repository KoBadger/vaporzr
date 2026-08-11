import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const config = {
  discordToken: process.env.DISCORD_TOKEN ?? '',
  spotifyClientId: process.env.SPOTIFY_CLIENT_ID ?? '',
  spotifyClientSecret: process.env.SPOTIFY_CLIENT_SECRET ?? '',
  port: Number(process.env.PORT ?? 4876),
  redirectUri: process.env.SPOTIFY_REDIRECT_URI ?? `http://localhost:${process.env.PORT ?? 4876}/callback`,
  ownerId: process.env.OWNER_ID ?? '',
  dataDir: process.env.DATA_DIR ?? path.join(__dirname, '..', 'data'),
} as const;

export const spotifyScopes = [
  'streaming',
  'user-read-email',
  'user-read-private',
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'playlist-read-private',
  'app-remote-control',
].join(' ');
