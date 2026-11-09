# Player releases

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

## macOS and Linux

`scripts/pack-player.mjs` supports Linux staging (`--platform linux`) but the
workflow currently publishes Windows only. macOS needs an `.app` bundle rename
and a signed/notarized identity, so it is deliberately out of scope until that
exists.
