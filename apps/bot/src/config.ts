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
  /**
   * Interface the control server + WS bridge bind to. Home LAN setups use
   * 0.0.0.0. On a cloud host set BIND_ADDRESS=127.0.0.1 and SSH-tunnel the
   * port so /panel+/viz stay off the public interface (see DEPLOY.md).
   */
  bindAddress: process.env.BIND_ADDRESS ?? '0.0.0.0',
  redirectUri: process.env.SPOTIFY_REDIRECT_URI ?? `http://localhost:${process.env.PORT ?? 4876}/callback`,
  ownerId: process.env.OWNER_ID ?? '',
  dataDir: process.env.DATA_DIR ?? path.join(__dirname, '..', 'data'),
  youtubeApiKey: process.env.YOUTUBE_API_KEY ?? '',
ytDlpPath: process.env.YT_DLP_PATH ?? path.join(__dirname, '..', '..', '..', 'vendor', 'yt-dlp', 'yt-dlp'),
   /** Path to a Netscape-format cookies.txt for YouTube. Authenticated requests
    *  avoid most 403s and throttling that cause mid-track stream cuts. */
   youtubeCookiesPath: process.env.YOUTUBE_COOKIES_PATH ?? '',
   /**
    * HTTP proxy for YouTube traffic (yt-dlp resolve + the googlevideo stream
    * fetch). Datacenter IPs get SABR-flagged by YouTube (no direct stream
    * URLs regardless of cookies/PO tokens); routing just YouTube through a
    * residential proxy restores resolution AND playback. Format:
    * http://[user:pass@]host:port — empty = direct.
    */
   youtubeProxy: process.env.YOUTUBE_PROXY ?? '',
   /**
    * HTTP proxy for Suno (the suno.com page fetch + the cdn1.suno.ai audio
    * stream). Suno's CDN blocks datacenter IPs with 403, so routing just Suno
    * through a residential proxy restores playback. Format:
    * http://[user:pass@]host:port — empty = direct.
    */
   sunoProxy: process.env.SUNO_PROXY ?? '',
   /** Optional Netscape-format cookies.txt for SoundCloud (authenticated / Go+ sets). */
   soundcloudCookiesPath: process.env.SOUNDCLOUD_COOKIES_PATH ?? '',
   /** Optional lat/lon so `V@vibe` can pick a set by current weather (open-meteo). */
   vibeLat: process.env.VIBE_LAT ?? '',
   vibeLon: process.env.VIBE_LON ?? '',
   /** ffmpeg binary used for server-side streaming + PCM resampling. */
   ffmpegPath: process.env.FFMPEG_PATH ?? ffmpegStatic ?? 'ffmpeg',
   /** Path to the librespot binary (the server-side Spotify "device"). Empty = disabled. */
   librespotPath:
     process.env.LIBRESPOT_PATH ?? path.join(__dirname, '..', '..', '..', 'vendor', 'librespot', 'librespot'),
  /** Name librespot registers with Spotify — used to find it as a playback device. */
  librespotDeviceName: process.env.LIBRESPOT_DEVICE_NAME ?? 'Vaporzr',
   /** Local TCP port librespot streams raw PCM to (must be space-free in the bridge command). */
   librespotBridgePort: Number(process.env.LIBRESPOT_BRIDGE_PORT ?? 4789),
   /**
    * Spotify playback backend:
    *  - 'librespot' (default): librespot-org, PCM via the TCP bridge.
    *  - 'soloist': go-librespot, remote OAuth login, PCM captured from a
    *    PulseAudio null-sink via parec.
    *  - 'auto': prefer soloist, fall back to librespot.
    */
   spotifyBackend: (process.env.SPOTIFY_BACKEND ?? 'librespot').toLowerCase(),
   /** Path to the go-librespot binary (soloist backend). */
   goLibrespotPath: process.env.GO_LIBRESPOT_PATH ?? 'go-librespot',
   /** PulseAudio null-sink name the soloist backend plays into and captures. */
   pulseSinkName: process.env.PULSE_SINK_NAME ?? 'vaporzr',
   /** go-librespot config dir (persists its Spotify credentials). */
   goLibrespotConfigDir: process.env.GO_LIBRESPOT_CONFIG_DIR ?? path.join(process.env.DATA_DIR ?? 'data', 'go-librespot'),
   /** go-librespot local control API port. */
   goLibrespotApiPort: Number(process.env.GO_LIBRESPOT_API_PORT ?? 3678),
  /**
   * Hostname advertised in /viz, /panel, and /help links. Empty = auto-detect
   * the LAN IP. Set to a custom domain when running behind port forwarding.
   */
  publicHost: process.env.PUBLIC_HOST ?? '',
  /** cloudflared binary used to expose an HTTPS quick tunnel for /viz + /panel links. */
cloudflaredPath:
     process.env.CLOUDFLARED_PATH ??
     path.join(__dirname, '..', '..', '..', 'vendor', 'cloudflared', 'cloudflared'),
  /** Set VIZ_TUNNEL=off to disable the automatic HTTPS secure-link tunnel. */
  vizTunnel: process.env.VIZ_TUNNEL !== 'off' && process.env.VIZ_TUNNEL !== '0',
  /** Cloudflare named-tunnel token (dashboard "install connector" token). Enables your own branded domain, e.g. viz.vaporzr.app. Empty = ephemeral trycloudflare.com URL. */
  tunnelToken: process.env.TUNNEL_TOKEN ?? '',
  /**
   * Permanent public base URL for /viz + /panel links (e.g. a Tailscale Funnel
   * hostname like https://vaporzr-bot.your-tailnet.ts.net). When set, every
   * bot link uses it and the cloudflared quick tunnel stays off.
   */
  staticBaseUrl: process.env.PUBLIC_BASE_URL ?? '',
  /**
   * Shared-secret gate for /panel + /viz (and their WebSockets). When set,
   * first visit needs ?key=<SHARE_KEY> — a cookie then remembers the device.
   * Empty = no gate (LAN-only setups).
   */
  shareKey: process.env.SHARE_KEY ?? '',
  /**
   * Separate, lower-privilege key for the public /request page (search + queue
   * only, no playback control). Requiring it keeps the full-control SHARE_KEY
   * out of members' hands. When empty, /request is only reachable on LAN-only
   * setups (no SHARE_KEY); on a keyed deployment it stays disabled until set.
   */
  requestKey: process.env.REQUEST_KEY ?? '',
  /**
   * Marks this instance as the primary (the VPS). A second instance sharing the
   * same bot token fights the primary for the single Discord gateway session, so
   * non-primary instances refuse to boot while the primary is reachable.
   */
  botPrimary: process.env.BOT_PRIMARY === '1',
  /**
   * Explicit escape hatch to run a non-primary instance (e.g. local dev with the
   * VPS stopped). Without it, only the PRIMARY instance will boot.
   */
  allowSecondary: process.env.ALLOW_SECONDARY === '1',
  /** Health URL of the primary instance. Defaults to <PUBLIC_BASE_URL>/health. */
  primaryHealthUrl:
    process.env.PRIMARY_HEALTH_URL ??
    (process.env.PUBLIC_BASE_URL ? `${process.env.PUBLIC_BASE_URL.replace(/\/$/, '')}/health` : ''),
  /** Bitrate librespot requests from Spotify (320 needs Premium). */
  librespotBitrate: Number(process.env.LIBRESPOT_BITRATE ?? 320),
  /** Tail fade-out applied to decoded streams, in ms (0 disables it). */
  crossfadeMs: Number(process.env.CROSSFADE_MS ?? 2500),
  /** Opt-in true crossfade (overlap) for decoded tracks; off by default. */
  crossfadeOverlap: process.env.CROSSFADE_OVERLAP === '1' || process.env.CROSSFADE_OVERLAP === 'true',
  /**
   * Duck the music while channel members are talking. Opt-in (off by default):
   * the receiver's speaking events can be chatty, and dropping/restoring volume
   * on every event reads as random volume jumps.
   */
  ducking: process.env.DUCKING === '1' || process.env.DUCKING === 'true',
  /** Keep paused queues across restarts instead of dropping them as stale. */
  keepPausedQueue: process.env.KEEP_PAUSED_QUEUE === '1' || process.env.KEEP_PAUSED_QUEUE === 'true',
  /**
   * TTS engine for optional DJ announcements: 'off' (default) or 'espeak'
   * (local, offline espeak-ng). Never enabled automatically — each guild opts
   * in with `/tts on`.
   */
  ttsProvider: (process.env.TTS_PROVIDER ?? 'off').toLowerCase(),
  /** espeak-ng binary used when TTS_PROVIDER=espeak. */
  espeakPath: process.env.ESPEAK_PATH ?? 'espeak-ng',
  /** When true, `V@p` plays via YouTube instead of the Spotify device to save API quota. */
  spotifyPreferYoutube: process.env.SPOTIFY_PREFER_YOUTUBE === '1' || process.env.SPOTIFY_PREFER_YOUTUBE === 'true',
  /** Resolve public Spotify data with the anonymous web-player token (no app quota). Fallback to OAuth. */
  spotifyUseAnonymous: process.env.SPOTIFY_USE_ANONYMOUS !== '0' && process.env.SPOTIFY_USE_ANONYMOUS !== 'false',
  /** Free-text search via the quota-free web-player token. Set to 0/off to force OAuth /search. */
  spotifyAnonSearch: process.env.SPOTIFY_ANON_SEARCH !== '0' && process.env.SPOTIFY_ANON_SEARCH !== 'false',
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
     process.env.ELECTRON_PATH ?? path.join(__dirname, '..', '..', '..', 'node_modules', 'electron', 'dist', 'electron'),
};
