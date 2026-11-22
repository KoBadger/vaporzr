# Desktop releases

Two things ship as portable Electron folders: the **player** (local playback
and visuals) and the **panel** (a window around the live `/panel` page, so it
never needs a rebuild to pick up panel changes). Neither is an installer.

## Player

The desktop player is a portable Electron folder, not an installer. A release
is the Electron runtime plus `apps/player/www` in `resources/app`, zipped with a
SHA-256 next to it. This keeps the build path dependency-free (no
electron-builder, no signing service) while still producing a real artifact.

## Publish

```sh
git tag player-v0.1.0
git push origin player-v0.1.0
```

The **Player release** workflow then:

1. builds `apps/player` with esbuild;
2. downloads the castlabs Electron `43.2.0+wvcus` Windows zip and verifies the
   checksum pinned in the workflow;
3. stages `Vaporzr-win32-x64/` with `scripts/pack-player.mjs`;
4. zips it and writes `Vaporzr-win32-x64.zip.sha256`;
5. uploads both to the `player-v0.1.0` release.

Manual runs (`workflow_dispatch`) do the same build but upload a workflow
artifact instead of a release.

## Verify

Windows:

```powershell
Get-FileHash .\Vaporzr-win32-x64.zip -Algorithm SHA256
Get-Content .\Vaporzr-win32-x64.zip.sha256
```

The zip also contains `SHA256SUMS.txt`, covering every file inside, so a
partially extracted copy can be checked too.

## Signing

Builds are **unsigned** while the project is in beta. Windows SmartScreen will
warn on first launch. Do not describe them as signed until an Authenticode
certificate (and an Apple notarization identity for macOS) is configured.

## Panel

The panel window (`apps/desktop`) has no npm dependencies — it loads the live
`/panel` URL — so its release needs neither `npm ci` nor a build step.

```sh
git tag desktop-v0.1.0
git push origin desktop-v0.1.0
```

The **Desktop release** workflow then:

1. downloads the upstream Electron `33.4.11` Windows zip and verifies the
   checksum pinned in the workflow;
2. stages `Vaporzr-Panel-win32-x64/` with `scripts/pack-desktop.mjs`;
3. zips it, writes `Vaporzr-Panel-win32-x64.zip.sha256`, and uploads both
   (artifact-only on a manual run).

The zip extracts to a folder containing `Vaporzr Panel.exe`. Because the window
loads the hosted panel, a new panel release reaches existing installs without a
new download. The panel's ⋯ menu links to
`github.com/KoBadger/vaporzr/releases?q=desktop-v` for the current download.

## macOS and Linux

`scripts/pack-player.mjs` supports Linux staging (`--platform linux`) but the
workflow currently publishes Windows only. macOS needs an `.app` bundle rename
and a signed/notarized identity, so it is deliberately out of scope until that
exists.
