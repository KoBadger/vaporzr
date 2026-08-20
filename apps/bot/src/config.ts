import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ffmpegStatic from 'ffmpeg-static';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const config = {
  discordToken: process.env.DISCORD_TOKEN ?? '',
  spotifyClientId: process.env.SPOTIFY_CLIENT_ID ?? '',
  spotifyClientSecret: process.env.SPOTIFY_CLIENT_SECRET ?? '',
  port: Number(process.env.PORT ?? 4876),
  redirectUri: process.env.SPOTIFY_REDIRECT_URI ?? `http://localhost:${process.env.PORT ?? 4876}/callback`,
  ownerId: process.env.OWNER_ID ?? '',
  dataDir: process.env.DATA_DIR ?? path.join(__dirname, '..', 'data'),
  youtubeApiKey: process.env.YOUTUBE_API_KEY ?? '',
  ytDlpPath: process.env.YT_DLP_PATH ?? path.join(__dirname, '..', '..', '..', 'vendor', 'yt-dlp', 'yt-dlp.exe'),
  /** ffmpeg binary used for server-side streaming + PCM resampling. */
  ffmpegPath: process.env.FFMPEG_PATH ?? ffmpegStatic ?? 'ffmpeg',
  /** Path to the librespot binary (the server-side Spotify "device"). Empty = disabled. */
  librespotPath:
    process.env.LIBRESPOT_PATH ?? path.join(__dirname, '..', '..', '..', 'vendor', 'librespot', 'librespot.exe'),
  /** Name librespot registers with Spotify — used to find it as a playback device. */
  librespotDeviceName: process.env.LIBRESPOT_DEVICE_NAME ?? 'Vaporzr',
  /** Local TCP port librespot streams raw PCM to (must be space-free in the bridge command). */
  librespotBridgePort: Number(process.env.LIBRESPOT_BRIDGE_PORT ?? 4789),
  /** Bitrate librespot requests from Spotify (320 needs Premium). */
  librespotBitrate: Number(process.env.LIBRESPOT_BITRATE ?? 320),
  /** When true, `V@p` plays via YouTube instead of the Spotify device to save API quota. */
  spotifyPreferYoutube: process.env.SPOTIFY_PREFER_YOUTUBE === '1' || process.env.SPOTIFY_PREFER_YOUTUBE === 'true',
  /** Resolve public Spotify data with the anonymous web-player token (no app quota). Fallback to OAuth. */
  spotifyUseAnonymous: process.env.SPOTIFY_USE_ANONYMOUS !== '0' && process.env.SPOTIFY_USE_ANONYMOUS !== 'false',
  /** sp_dc session cookie from open.spotify.com — unlocks FULL-length resolution of any public playlist. */
  spotifySpDc: process.env.SPOTIFY_SP_DC ?? '',
  /** TOTP secret bytes (comma-separated) for the web-player token endpoint; Spotify rotates this occasionally. */
  spotifyTotpSecret:
    process.env.SPOTIFY_TOTP_SECRET ?? '',
  /** TOTP version param for the web-player token endpoint. */
  spotifyTotpVer: process.env.SPOTIFY_TOTP_VER ?? '5',
  /** Player app directory (Electron) and binary used to open the player window. */
  playerDir: process.env.PLAYER_DIR ?? path.join(__dirname, '..', '..', 'player'),
  electronPath:
    process.env.ELECTRON_PATH ?? path.join(__dirname, '..', '..', '..', 'node_modules', 'electron', 'dist', 'electron.exe'),
} as const;
