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
