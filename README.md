<p align="center"><img src="docs/logo.png" width="140" alt="Vaporzr"></p>

# Vaporzr

A Discord music bot with a branded web control panel and a browser-based MilkDrop visualizer. Streams Spotify (server-side via librespot), YouTube, SoundCloud, and Apple Music links — in every server it joins, simultaneously.

<p align="center">
  <a href="https://kobadger.github.io/vaporzr/privacy.html">Privacy Policy</a> ·
  <a href="https://kobadger.github.io/vaporzr/tos.html">Terms of Service</a>
</p>

## Highlights

- **Multi-source playback** — Spotify (librespot device, server-side), YouTube, SoundCloud (incl. DRM-track YouTube fallback + HLS), Apple Music links (iTunes metadata → YouTube match), Suno, local files
- **🎛️ Web control panel** (`/panel`) — search-and-play, queue reordering, repeat, themes, reactivity, keyboard shortcuts; works from any device through an HTTPS link
- **👁 Guest mode** — the visualizer and a **view-only panel** are open to anyone with the URL; only *control* requires a key (enforced server-side)
- **🌈 Web visualizer** (`/viz`) — Butterchurn (MilkDrop 2) in the browser, ~1,700 presets, motion-skip + strobe-guard + 🌙 Calm mode, standalone (no desktop app needed)
- **Discord button panel** (`V@pan`) — custom icon emojis, live-updating embed, NOW PLAYING confirmations, secure link buttons; postable by **server admins**
- **🔴 Mini now-playing** — a compact strip auto-posts wherever commands are used the moment music starts; updates in place, re-anchors to the bottom on every track change
- **🔑 Share keys** — `SHARE_KEY` gates panel control behind a cookie; `/key give` (admin-level by default) hands pre-authorized links to trusted users, `/key rotate` (owner-only) kills them all
- **🥚 Easter egg** — servers that activate a key can rename the bot (`/nickname`, must end in `-rzr`/`-orzr`/`-porzr`)
- **Multi-server** — isolated per-guild sessions, per-guild permissions, queues persist across restarts
- **Self-healing** — watchdog launcher, auto-resume after voice timeouts, yt-dlp retry logic, preloading for gapless transitions, panel registrations persisted across restarts, owner auto-detect with retries

## Quick start

```bash
git clone https://github.com/KoBadger/vaporzr.git
cd vaporzr
npm install
Copy-Item apps/bot/.env.example apps/bot/.env   # fill in DISCORD_TOKEN, SPOTIFY_CLIENT_ID/SECRET
npm run dev -w @vaporzr/bot
```

The bot serves its panel/visualizer on `http://localhost:4876`. For links that work from other devices, see **Secure links** below.

## Secure links

| Mode | Config |
|---|---|
| Tailscale Funnel (recommended, free) | install Tailscale → `tailscale funnel --bg 4876` → set `PUBLIC_BASE_URL=https://<node>.<tailnet>.ts.net` |
| Cloudflare quick tunnel | automatic (random `*.trycloudflare.com` URL) |
| Cloudflare named tunnel (your domain) | `TUNNEL_TOKEN=<connector token>` |
| Gate | `SHARE_KEY=<secret>` — `/key give` hands out pre-authorized links |

## Sharing & permissions

The web tier is two-level: **viewing is open** (landing page, `/viz`, and a view-only panel), **control requires the key**. Discord commands need no keys — anyone in a server with the bot can use them.

| Rank | Who | Powers |
|---|---|---|
| **Bot owner** (`OWNER_ID`, or auto-detected) | you | everything, in every server — `/key rotate`, admin-level commands |
| **Admin** | server owner + roles granted via `/perms grant admin <role>` | post `/panel` panels, `/key give`, mod+ commands |
| **Mod / User** | `/perms grant mod <role>` / everyone | DJ + sfx / playback + queue commands |

Per-command levels are adjustable per guild (`/perms setlevel <command> <level>`).

**Health check:** `GET /health` → `{ ok, uptimeSec, guilds, playing, sessions, librespot, spotifyApi, memory, cache }` (open, metadata only).

## Commands

`/help` in Discord shows the full reference (prefix `V@` shortcuts included).

Playback: `/play` `/insert` `/skip` `/pause` `/queue` `/nowplaying` `/volume` …
Visuals: `/panel` `/viz` `/burst` `/theme` `/sensitivity` `/wave` …
Device: `/device list` (Spotify Connect status) `/device select <name>` (rename, restarts librespot)
Maintenance: `/cookie-refresh` (re-export YouTube cookies from a browser) — admin
Access: `/key give` `/key rotate` `/perms` (admin) — `/nickname` (🥚)

## Workspaces

- `packages/shared` — shared protocol types
- `apps/bot` — Discord bot + control server (HTTP/WS on port 4876)
- `apps/player` — legacy Electron visualizer/overlay (optional, dormant — the web visualizer replaced it)
- `apps/spicetify` — optional Spicetify control app

## Notes

- Vendor binaries (`yt-dlp`, `librespot`, `cloudflared`) are downloaded separately into `vendor/` (gitignored). Keep `yt-dlp` updated (`vendor\yt-dlp\yt-dlp.exe -U`) — extractors rot against site changes.
- Every guild's queue persists across restarts (`apps/bot/data/queues/`), restored paused. Panel/now-playing registrations persist too (`apps/bot/data/panels.json`).
- Set `OWNER_ID=<your Discord user id>` in `apps/bot/.env` to pin owner rank (otherwise auto-detected from the app record, with retries).
- Docker: `docker build -f apps/bot/Dockerfile -t vaporzr-bot .` (see Dockerfile header for caveats).
