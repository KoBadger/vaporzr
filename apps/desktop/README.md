# Vaporzr desktop panel

A portable Electron window around the live `/panel` page.

There is no panel code here, and that is the point: the window loads
`https://www.vaporzr.app/panel` (or whatever `VAPORZR_URL` points at), so every
panel change ships with the normal bot deploy and the app never needs a rebuild.
What the shell adds:

- a real window with a taskbar and Start-menu entry, remembered size, and zoom;
- **Reload** / **Reload ignoring cache** (Ctrl+R, Ctrl+Shift+R) and developer
  tools (F12) — the escape hatch for a wedged page, next to the panel's own 🔧
  audio fix;
- a single-instance lock, so launching it twice focuses the existing window
  instead of opening two panels that fight over the now-playing card;
- a local "can't reach the panel" page with retry, instead of Chromium's error
  screen.

The login cookie lives in Electron's persistent session, so an access key is
entered once and survives restarts. Links to other sites open in the real
browser.

## Run locally

The app has no npm dependencies, so Electron is not part of `npm ci` (a ~100 MB
download in every CI job and on every `npm install` for a window that only loads
a URL). Install it ad hoc when you want to run the shell:

```sh
npm i --no-save electron@33.4.11
npx electron apps/desktop
# or point it somewhere else:
VAPORZR_URL=http://localhost:4876/panel npx electron apps/desktop
```

`--url=<url>` works too; a bare host is treated as `https://<host>/panel`.

## Release

Tag `desktop-v0.1.0` (see [docs/RELEASES.md](../../docs/RELEASES.md)). The
workflow downloads a checksum-pinned Electron runtime, stages it with
`scripts/pack-desktop.mjs`, and attaches `Vaporzr-Panel-win32-x64.zip` plus its
SHA-256 to the release. The zip is a folder, not an installer: extract it
anywhere and run `Vaporzr Panel.exe`.

Builds are unsigned while the project is in beta, so Windows SmartScreen warns
on first launch.
