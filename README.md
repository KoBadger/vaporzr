<p align="center"><img src="docs/logo.png" width="140" alt="Vaporzr"></p>

# Vaporzr

Shared Spotify playback: queue songs in Discord, stream audio through a local Electron player, watch the visualization in Spotify via a Spicetify panel.

## Workspaces

- `packages/shared` — shared protocol types
- `apps/bot` — Discord bot + control server (WS bridge on port 4876)
- `apps/player` — Electron app: hidden Web Playback SDK device + butterchurn visualizer window
- `apps/spicetify` — Spicetify custom app (control panel + always-visible top-bar button)

## Startup flow (end-to-end test)

1. **Bot**: needs real credentials first.
   `Copy-Item apps/bot/.env.example apps/bot/.env`, fill in `DISCORD_TOKEN`, `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` (redirect URI in the Spotify dashboard must match `SPOTIFY_REDIRECT_URI`).
   Then `npm run dev -w @vaporzr/bot` (or `npm run start`). Server listens on `http://localhost:4876`. Visit `/login` to link a Spotify account.
2. **Player**: `npm run dev -w @vaporzr/player` (builds then launches Electron; two windows: hidden player + visualizer). Must run **after** the bot so it can reach `ws://127.0.0.1:4876/ws`.
3. **Spicetify**: after editing the app, `npm run install-app -w @vaporzr/spicetify-app` (builds + `spicetify apply`). Restart Spotify to see the icon and the button next to Search.
4. Sanity checks in the bot log:
   - `[bridge] player connected`
   - `[bridge] visualizer connected`
   - `[bridge] panel connected`
   To verify without full creds, run a standalone bridge: start `apps/bot` with only the server by bootstrapping `startServer` (a temporary `smoke.ts` works — don't commit it).

## Notes

- Electron main/preload are bundled as CommonJS by `apps/player/build.mjs`; `package.json` must **not** have `"type": "module"`. `path.txt` in `node_modules/electron` must contain `electron.exe` (postinstall can be blocked).
- `VAPORZR_SHOW_PLAYER=1` shows the player window; `VAPORZR_VISUALIZER=0` disables the visualizer window.
- Frames stream at 960×540 JPEG q0.6 over the WS.

## Control server & security

- The HTTP server and WS bridge bind **only to `127.0.0.1:4876`** — localhost only. Do **not** port-forward or tunnel port 4876: the browser panel at `http://localhost:4876/panel` and the WS bridge have **no authentication** and full control over the queue/playback. Anyone who can reach it can operate the bot.
- The control panel (`/panel`), desktop overlay, and player window are meant for the machine hosting the bot. `/panel`, `/overlay`, `/screensaver`, and `V@pan`/`V@ov`/`V@sc`/`V@player` are **owner-only** — the owner is auto-detected from the Discord application owner, or pinned with `OWNER_ID` in `apps/bot/.env`. They spawn windows on the **host** machine, so without this a friend's `/overlay` could pop a window on your screen.

## Commands

- `/help` — full command reference (also `V@help`).
- `/play` `/insert` `/yt` — search or paste a Spotify/YouTube link; `/wav` plays an uploaded file.
- `/queue` `/nowplaying` `/skip` `/pause` `/resume` `/clear` `/remove` `/volume` `/shuffle` `/join` `/leave`.
- `/panel` `/overlay` `/screensaver` `/theme` `/wave` `/burst` — visualizer windows and visuals (owner-only on the host machine).
- `/sfx` `/dj` — soundboard over the music.
- `/perms` — per-server command levels and roles (admin).
- `/stats` — uptime, tracks played/queued, commands run.

Prefix `V@…` shortcuts exist for the common commands (see `/help`). Every guild's queue **persists across bot restarts** (`apps/bot/data/queues/`), restored paused so nothing auto-resumes.

## Multi-server (per-guild playback)

Every guild the bot is invited to gets its own isolated **Session**: its own queue, voice connection, and playback controller. Any number of servers can queue and stream independently at the same time — this is the Luna/Jockie architecture.

- Set `SPOTIFY_PREFER_YOUTUBE=1` in `apps/bot/.env` (already set here). In this mode Spotify requests play via the YouTube fallback, so the single shared librespot device is never contended for and no Spotify account is consumed per listener.
- Each server's permissions and DJ toggle are already per-guild (`/perms`, `/dj`). The desktop/browser panel and visualizer mirror the **primary** guild (the first one the bot joined).
- Headless VPS hosting: `docker build -f apps/bot/Dockerfile -t vaporzr-bot .` then run with `--env-file apps/bot/.env` and a `-v` volume for `/app/data`. See the Dockerfile header for caveats (Spotify linking, localhost-only port).
