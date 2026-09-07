# Deploying Vaporzr to a cloud host (VPS)

This documents deploying the **bot** to a plain Linux VPS (DigitalOcean,
Hetzner, Vultr, Linode, …) using the included `apps/bot/Dockerfile`.
The control panel + visualizer are kept reachable only to **you** via an SSH
tunnel, so the bot runs independently of your home network.

> **Fast path:** `deploy/vps-setup.sh` is a one-shot provisioning script for a
> fresh Debian 12 / Ubuntu 22.04+ box. `scp` it up with your `.env` (and
> optional `cookies.txt`), run it, done — it performs every step below.

## CI/CD (optional, GitHub Actions)

The repo ships two workflows:

- **`.github/workflows/ci.yml`** — typecheck + unit tests on every push/PR.
- **`.github/workflows/deploy.yml`** — on push to `master` (or a `v*` tag):
  1. builds `librespot` from the pinned official source tag (v0.8.0),
  2. builds `apps/bot/Dockerfile` and pushes to GHCR,
  3. SSHes into the VPS, pulls the image, and recreates the `vaporzr` container.

The deploy job needs three **repository secrets** (Settings → Secrets → Actions):

| Secret | Value |
|---|---|
| `VPS_HOST` | your server IP / hostname |
| `VPS_USER` | ssh user (e.g. root) |
| `VPS_SSH_KEY` | private key for that user (set up `authorized_keys` first) |

The `.env` on the VPS stays at `/opt/vaporzr/.env`; the workflow only swaps the
image. Add a `:production` GitHub *environment* if you want an approval gate
before deploys.

## Quick provider pick

For a personal bot, the cheapest reliable option is **Hetzner Cloud CX11**
(1 vCPU, 2 GB RAM, ~€3.79/mo). The bot is light; even 1 GB is enough for a
few guilds, but 2 GB gives headroom for yt-dlp spikes. Alternatives:

- **Vultr Cloud Compute 1 GB** — $5/mo, simple UI.
- **DigitalOcean Basic Droplet 1 GB** — $6/mo.
- **Oracle Cloud Free Tier ARM** — literally $0, but setup is more involved
  and networking can be flaky.

## What "not relying on my home network" actually means

- The **bot process** (Discord gateway, voice, streaming, HTTP server) runs on
  the VPS. Nothing routes through your PC or LAN.
- **Playback** uses **native Spotify via a bundled `librespot` device** by
  default (`SPOTIFY_PREFER_YOUTUBE=0`, `LIBRESPOT_PATH=/usr/local/bin/librespot`
  in the Dockerfile). YouTube/yt-dlp + ffmpeg remains the fallback for
  non-Spotify sources (SoundCloud, Apple Music links, raw YouTube URLs).
- The only thing still tied to *you* is Discord credentials + optional Spotify
  OAuth, which are plain env values — not your network.

## 1. Prereqs on the VPS

- Docker + Docker Compose (or plain `docker run`).
- Node 20 is not needed on the host — the image carries it.

## 2. Build the image

From the repo root:

```bash
docker build -f apps/bot/Dockerfile -t vaporzr-bot .
```

## 3. Env file

Create `apps/bot/.env` **on the host** with the bot's secrets. Secrets stay out
of the image (passed via `--env-file`). Minimum:

```env
DISCORD_TOKEN=<bot token>
OWNER_ID=<discord user id>

# Optional: full-length public playlist resolution (no OAuth, no Premium).
# SPOTIFY_SP_DC=<sp_dc cookie from open.spotify.com>
```

The container already sets these cloud-appropriate defaults (see Dockerfile):

- `BIND_ADDRESS=127.0.0.1` — control server is NOT exposed to the internet.
- `LIBRESPOT_PATH=/usr/local/bin/librespot` — native Spotify device; the binary
  is baked into the image (librespot's OAuth credentials must live in the data
  volume — see "Enabling librespot" below, then authorize once).
- `YT_DLP_PATH=/usr/local/bin/yt-dlp`, `FFMPEG_PATH=/usr/bin/ffmpeg`, and
  `python3` are installed in the runtime stage.
- `PLAYER_DIR=/dev/null`, `ELECTRON_PATH=/bin/true` — desktop overlay stubs.
- `SPOTIFY_PREFER_YOUTUBE=0` — Spotify tracks stream natively via librespot.

`SPOTIFY_PREFER_YOUTUBE=0` + `SPOTIFY_USE_ANONYMOUS=1` (default) means no user
has to link an account for Spotify playback. Set a `SHARE_KEY` if you ever
expose the panel.

## YouTube cookies (strongly recommended)

Datacenter IPs get throttled / 403'd by YouTube much more aggressively than a
home connection, which causes tracks to stop mid-way. Pass a Netscape-format
`cookies.txt`:

1. Install a browser extension like **"Get cookies.txt LOCALLY"**.
2. While logged into YouTube, export cookies for `youtube.com` to `cookies.txt`.
3. Upload it to the VPS, e.g. `/opt/vaporzr/cookies.txt`.
4. Add to `apps/bot/.env`:

```env
YOUTUBE_COOKIES_PATH=/app/data/cookies.txt
```

5. Mount the file into the container (read-only):

```bash
-v /opt/vaporzr/cookies.txt:/app/data/cookies.txt:ro
```

## Enabling librespot on the VPS (optional — native Spotify)

The image ships librespot and points `LIBRESPOT_PATH` at it. **Anonymous playback works by default** (`SPOTIFY_PREFER_YOUTUBE=0` + `SPOTIFY_USE_ANONYMOUS=1`), so no account linking is required for most use cases. To enable native Spotify playback via librespot (can improve quality/reliability and enables the `/device` commands), authorize it **once** so Spotify's OAuth credentials are cached in the volume (this cmd runs your own Premium account through librespot's OAuth flow):

```bash
docker exec -it vaporzr librespot \
  --cache /app/data/librespot --enable-oauth
```

Follow the browser OAuth flow, then restart the container. On Linux the subprocess sink is more reliable than on Windows, so this is often the cleanest way to eliminate Spotify→YouTube fallback stalls.

In a multi-guild setup the device is shared — every server's Spotify playback routes through this one librespot instance (see the Dockerfile note about `SPOTIFY_PREFER_YOUTUBE=0`). Rename the device with `/device select <name>`.

## 4. Run

```bash
# create the data volume and (optionally) place cookies.txt next to it
docker volume create vaporzr-data

# run with SSH-tunnel posture (control server on loopback only)
docker run -d --name vaporzr \
  --restart unless-stopped \
  --env-file apps/bot/.env \
  -e BIND_ADDRESS=127.0.0.1 \
  -v vaporzr-data:/app/data \
  -v /opt/vaporzr/cookies.txt:/app/data/cookies.txt:ro \
  ghcr.io/kobadger/vaporzr/vaporzr-bot:latest
```

> Do NOT publish `-p 4876:4876`. The control server + WS bridge have **no
> auth** unless `SHARE_KEY` is set; keep them on the loopback interface.

## 5. Open the panel / visualizer (SSH tunnel)

From your machine (not the VPS):

```bash
ssh -N -L 4876:127.0.0.1:4876 user@your-vps
```

Then browse to:

- Panel: `http://127.0.0.1:4876/panel`
- Visualizer: `http://127.0.0.1:4876/viz`

Keep the tunnel open while you use them. Discord button links that point at
`PUBLIC_HOST` won't resolve externally in tunnel-only mode; commands via
Discord always work since they go through the bot's Discord gateway.

## If you DO want it reachable from the internet

1. Set `BIND_ADDRESS=0.0.0.0`.
2. **Required:** set `SHARE_KEY` — `/panel`, `/viz`, and the WS bridge are
   otherwise completely unauthenticated on a public interface.
3. Open only the ports you need; put it behind HTTPS (reverse proxy / tunnel)
   rather than raw TCP.
4. Share access with `V@key give`; revoke with `V@key rotate` (owner-only).

## Verifying the deploy works

```bash
docker logs vaporzr          # look for "control server on http://127.0.0.1:4876"
curl -s http://127.0.0.1:4876/health   # on the VPS itself
```

`/health` returns JSON with `ok: true`, uptime, guild/session counts.

## Data

`/app/data` (linked token store, DJ settings, theme, uploads) is a named volume
`vaporzr-data`. Back it up if you link an OAuth account.

## Lavalink (optional future path — NOT integrated)

The current pipeline (yt-dlp + ffmpeg + `@discordjs/voice` + cookies) is the
"anti-Lavalink" architecture used by projects like Streamify, and it is the
primary audio engine. Jockie Music and Luna both run on Lavalink, so it's a
proven fallback *direction* if raw yt-dlp reliability ever degrades badly.

Key architectural constraint: Lavalink cannot be used as a half-measure
resolver. It owns the Discord voice WebSocket for any track it plays — the bot
must forward `voice_state_update`/`voice_server_update` events to it and
receive its events back. That means the smallest useful integration is a
**feature-flagged per-guild Lavalink mode** (env: `LAVALINK_URL`,
`LAVALINK_PASSWORD`), where a guild's audio routes through Lavalink when
enabled and through the native pipeline otherwise.

If/when built, run it beside the bot on the same VPS:

```bash
docker run -d --name lavalink --restart unless-stopped \
  -p 127.0.0.1:2333:2333 \
  -v /opt/vaporzr/lavalink.yml:/opt/Lavalink/application.yml \
  ghcr.io/lavalink-devs/lavalink:4
```

Keep it loopback-bound like the control server. Until the client integration
exists, do not run it — an idle Lavalink adds nothing.
