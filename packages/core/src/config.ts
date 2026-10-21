import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ffmpegStatic from 'ffmpeg-static';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Monorepo root, derived from this file's location (`packages/core/src`). Used
 * for the defaults that must keep pointing at the bot's/player's own folders now
 * that the engine lives in its own workspace package. Env vars override all of
 * these in production, so this only affects local dev.
 */
export const repoRoot = path.resolve(__dirname, '..', '..', '..');

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
  dataDir: process.env.DATA_DIR ?? path.join(repoRoot, 'apps', 'bot', 'data'),
  youtubeApiKey: process.env.YOUTUBE_API_KEY ?? '',
  /**
   * Replicate API token. When set, `V@mashup` separates stems on Replicate's
   * hosted Demucs (GPU, ~2¢/song, ~80s) instead of the local CPU run (~29 min).
   * Empty = local Demucs only.
   */
  replicateApiToken: process.env.REPLICATE_API_TOKEN ?? '',
  /** Replicate Demucs model slug used for hosted stem separation. */
  replicateDemucsModel: process.env.REPLICATE_DEMUCS_MODEL ?? 'cjwbw/demucs',
  /** Pin a specific Replicate model version; empty = look up the latest once. */
  replicateDemucsVersion: process.env.REPLICATE_DEMUCS_VERSION ?? '',
  ytDlpPath: process.env.YT_DLP_PATH ?? path.join(__dirname, '..', '..', '..', 'vendor', 'yt-dlp', 'yt-dlp'),
  /** Path to a Netscape-format cookies.txt for YouTube. Authenticated requests
   *  avoid most 403s and throttling that cause mid-track stream cuts. */
  youtubeCookiesPath: process.env.YOUTUBE_COOKIES_PATH ?? '',
  /**
   * Optional FIRST proxy hop for YouTube traffic (yt-dlp resolve + the
   * googlevideo stream fetch), tried only after a direct attempt fails — the
   * VPS leaves it empty, but the old clean-IP bridge can still fill it. The
   * direct route needs a clean host IP plus cookies + PO tokens; when it is
   * walled, YOUTUBE_PROXY_ALT takes over first. Format:
   * http://[user:pass@]host:port — empty = skipped.
   */
  youtubeProxy: process.env.YOUTUBE_PROXY ?? '',
  /**
   * Second proxy hop, tried when direct AND the first hop fail. The intended
   * deployment is Cloudflare WARP running locally on the bot host (`warp-cli
   * mode proxy`, default port 40000): free, unlimited, and a DIFFERENT egress
   * than the host — so it covers a host IP YouTube has flagged without
   * touching the metered fallback. Format: http://[user:pass@]host:port.
   */
  youtubeProxyAlt: process.env.YOUTUBE_PROXY_ALT ?? '',
  /**
   * Last-resort proxy hop, reached only when the direct route and every free
   * hop fail. DataImpulse residential here: metered and pay-per-GB, so it
   * spends its balance only on a real block, and on an `auth` alert its sticky
   * session is rotated to land the retry on a fresh exit. Format:
   * http://[user:pass@]host:port — empty = skipped.
   */
  youtubeProxyFallback: process.env.YOUTUBE_PROXY_FALLBACK ?? '',
  /**
   * How to name the FIRST proxy hop (YOUTUBE_PROXY) in the hop-down alert.
   * Alerts name the WARP and metered hops with fixed wording; only the primary
   * hop is free-form, because it has moved (PC → phone) without a code change:
   * set YOUTUBE_PROXY_LABEL to whatever is actually running it.
   */
  youtubeProxyLabel: process.env.YOUTUBE_PROXY_LABEL ?? 'the primary YouTube proxy hop',
  /**
   * Ceiling on the YouTube audio bitrate to download. The voice encoder now runs
   * at the channel's real ceiling (see `voiceOpusBitrate`), up to 384 kbps, so
   * the old 80 kbps cap was throwing away detail the pipe can carry. Lower it
   * (e.g. 80) when the metered proxy hops matter more than fidelity.
   */
  youtubeAudioMaxAbr: Number(process.env.YOUTUBE_AUDIO_MAX_ABR) || 160,
  /**
   * Public base URL for the jam join link and its QR code, e.g.
   * https://vaporzr.duckdns.org. The bot binds to loopback behind a reverse
   * proxy, so it cannot derive a reachable address for a guest's phone — the
   * tunnel address (127.0.0.1) only works on the machine holding the tunnel.
   * When empty the clients fall back to their own origin, which is correct for
   * the Activity but wrong for the player and the tunnel-opened panel.
   */
  jamPublicBase: (process.env.JAM_PUBLIC_BASE ?? '').replace(/\/+$/, ''),
  /**
   * Optional Suno session cookie (the `__client`/session pair from a logged-in
   * studio.suno.com). Without it the public clip API answers audio_url with
   * /api/forbidden for every clip, and restricted clips expose only an
   * undecodable m4a-opus file. With it the API returns real media URLs again.
   * Sent to studio-api.prod.suno.com only — never to the CDN.
   */
  sunoCookie: (process.env.SUNO_COOKIE ?? '').trim(),
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
  goLibrespotConfigDir:
    process.env.GO_LIBRESPOT_CONFIG_DIR ?? path.join(process.env.DATA_DIR ?? 'data', 'go-librespot'),
  /** go-librespot local control API port. */
  goLibrespotApiPort: Number(process.env.GO_LIBRESPOT_API_PORT ?? 3678),
  /**
   * Hostname advertised in /viz, /panel, and /help links. Empty = auto-detect
   * the LAN IP. Set to a custom domain when running behind port forwarding.
   */
  publicHost: process.env.PUBLIC_HOST ?? '',
  /** cloudflared binary used to expose an HTTPS quick tunnel for /viz + /panel links. */
  cloudflaredPath:
    process.env.CLOUDFLARED_PATH ?? path.join(__dirname, '..', '..', '..', 'vendor', 'cloudflared', 'cloudflared'),
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
  /**
   * ffmpeg normalization stage applied to every stream. Default is a transparent
   * peak limiter — dynamic `loudnorm` gain-rides music (audible "pumping"). Set
   * AUDIO_NORM_FILTER to override, e.g. "loudnorm=I=-14:TP=-1.5:LRA=11" for the
   * old behavior or "loudnorm=I=-14:TP=-1.5:LRA=14" for a milder dynamic one.
   */
  audioNormFilter: process.env.AUDIO_NORM_FILTER ?? 'alimiter=limit=0.95',
  /**
   * Opus bitrate for the music encoder, in bits/s. `0` (default) = whatever the
   * voice channel is allowed to carry (96 kbps free, then 128/256/384 by server
   * boost level). Discord's own default is 64 kbps — about a sixth of the
   * ceiling on a level-3 server, which is why this exists.
   */
  voiceOpusBitrate: Number(process.env.VOICE_OPUS_BITRATE) || 0,
  /**
   * Raise the voice channel's bitrate to the guild's cap when joining, so the
   * higher encoder bitrate is actually usable by listeners. Needs Manage
   * Channels; set `VOICE_RAISE_CHANNEL_BITRATE=0` to leave channels untouched.
   */
  voiceRaiseChannelBitrate: process.env.VOICE_RAISE_CHANNEL_BITRATE !== '0',
  /**
   * Enable Opus in-band FEC (forward error correction) on the music stream.
   * Costs a few kbps of redundancy and buys resistance to packet loss.
   */
  voiceOpusFec: process.env.VOICE_OPUS_FEC !== '0',
  /**
   * `native` (default) encodes with @discordjs/opus and sends pre-encoded Opus.
   * `off` restores the old path: raw PCM handed to @discordjs/voice, which
   * encodes at libopus's default and caps any explicit bitrate at 128 kbps.
   */
  voiceOpusEncoder: (process.env.VOICE_OPUS_ENCODER ?? 'native') === 'off' ? 'off' : 'native',
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
   * Optional dead-man's-switch URL (e.g. a healthchecks.io ping URL). The bot
   * GETs it every 5 min so an external service alerts if the whole process dies.
   */
  healthcheckPingUrl: process.env.HEALTHCHECK_PING_URL ?? '',
  /** VAPID subject for Web Push (a mailto: or https: URL). */
  pushContact: process.env.PUSH_CONTACT ?? 'mailto:admin@vaporzr.local',
  /** Optional fixed VAPID keys; otherwise generated once and persisted in dataDir. */
  vapidPublicKey: process.env.VAPID_PUBLIC_KEY ?? '',
  vapidPrivateKey: process.env.VAPID_PRIVATE_KEY ?? '',
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
  /**
   * Free-text search via the quota-free web-player token. OFF by default:
   * Spotify's partner API now requires a rotating persisted-query hash, so this
   * path fails and just wastes a request. Set SPOTIFY_ANON_SEARCH=1 to try it
   * anyway (it falls back to the OAuth `/search` on failure).
   */
  spotifyAnonSearch: process.env.SPOTIFY_ANON_SEARCH === '1' || process.env.SPOTIFY_ANON_SEARCH === 'true',
  /** sp_dc session cookie from open.spotify.com — unlocks FULL-length resolution of any public playlist. */
  spotifySpDc: process.env.SPOTIFY_SP_DC ?? '',
  /** TOTP secret bytes (comma-separated) for the web-player token endpoint; Spotify rotates this occasionally. */
  spotifyTotpSecret: process.env.SPOTIFY_TOTP_SECRET ?? '',
  /** TOTP version param for the web-player token endpoint. */
  spotifyTotpVer: process.env.SPOTIFY_TOTP_VER ?? '61',
  /** Player app directory (Electron) and binary used to open the player window. */
  playerDir: process.env.PLAYER_DIR ?? path.join(repoRoot, 'apps', 'player'),
  electronPath:
    process.env.ELECTRON_PATH ?? path.join(__dirname, '..', '..', '..', 'node_modules', 'electron', 'dist', 'electron'),
};
