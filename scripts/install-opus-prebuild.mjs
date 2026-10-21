#!/usr/bin/env node
/**
 * Postinstall shim: keeps native Opus alive on Node runtimes that ship no
 * prebuilt binding.
 *
 * Why this exists
 * ---------------
 * @discordjs/opus@0.10.0 names its prebuilds per Node ABI: node-v72..node-v127
 * (Node 12..22). On a newer ABI — Node 23/24/25/26 are node-v131..node-v147 —
 * its installer requests `...node-v<new-ABI>-napi-v3-win32-x64...` and gets a
 * 404 from the GitHub release, then falls back to a source compile with
 * node-gyp. That fallback is broken on current Windows toolchains twice over:
 * node-pre-gyp 0.4.5 dies with `spawn EINVAL` (it cannot spawn the node-gyp
 * .cmd shim on post-CVE Windows Node), and even a manual `node-gyp@11` build
 * cannot find Visual Studio 18 ("unknown version"). Result: `npm ci` with
 * scripts enabled fails outright, and the voice pipeline degrades to
 * opusscript, which encodes at libopus' 64 kbps default (and prism-media caps
 * any bitrate request at 128k).
 *
 * Why the shim works
 * ------------------
 * The binding in those tarballs is built against N-API v3, which is
 * ABI-stable: the very same opus.node loads on Node 24/25/26. Only the
 * on-disk folder name encodes the ABI node-pre-gyp looks for at require-time
 * (`<pkg>/prebuild/node-v<ABI>-napi-v3-<platform>-<arch>-<libc>-<libcver>/`).
 * So: if the native module does not load, fetch the published Node 22
 * (node-v127) tarball, and place opus.node in the folder this Node expects.
 *
 * Usage: add `node scripts/install-opus-prebuild.mjs` as the root
 * `postinstall`. Env: set OPUS_SHIM_DISABLE=1 to opt out. The install never
 * fails because of this script — on any problem it warns and exits 0, leaving
 * opusscript as the runtime fallback.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

const log = (msg) => console.log(`[opus-shim] ${msg}`);

try {
  const require = createRequire(import.meta.url);

  if (process.env.OPUS_SHIM_DISABLE) {
    log('skipped: OPUS_SHIM_DISABLE=1');
    process.exit(0);
  }

  // Locate the package (monorepo-hoisted node_modules).
  let pkgJsonPath;
  let pkgRoot;
  try {
    pkgJsonPath = require.resolve('@discordjs/opus/package.json');
    pkgRoot = join(pkgJsonPath, '..'); // .../<node_modules>/@discordjs/opus
  } catch {
    process.exit(0); // not installed -> nothing to do
  }

  // Already loading natively? Nothing to do (quiet, so installs stay clean).
  let loaded = false;
  try {
    require('@discordjs/opus');
    loaded = true;
  } catch {
    /* fall through to the shim */
  }
  if (loaded) {
    process.exit(0);
  }

  const pkg = JSON.parse(require('node:fs').readFileSync(pkgJsonPath, 'utf8'));
  const { platform, arch } = process;

  // File naming includes libc; only win32/macOS use "unknown-unknown".
  const toolchain = platform === 'win32' || platform === 'darwin' ? 'unknown-unknown' : null;
  if (!toolchain || !['x64', 'arm64'].includes(arch)) {
    log(`warn: no prebuild layout known for ${platform}-${arch}; staying on opusscript`);
    process.exit(0);
  }

  const prebuildDir = join(
    pkgRoot,
    'prebuild',
    `node-v${process.versions.modules}-napi-v3-${platform}-${arch}-${toolchain}`,
  );

  // Something is in place but does not load - do not chase that here.
  if (existsSync(join(prebuildDir, 'opus.node'))) {
    log('warn: prebuild file exists but does not load; staying on opusscript');
    process.exit(0);
  }

  // The published binding is N-API v3 = ABI-stable, so the Node 22 asset
  // (node-v127) runs everywhere it covers — the ABI only matters for the
  // folder name node-pre-gyp looks in.
  const LEGACY_ABI = 'v127';
  const tarballName = `opus-v${pkg.version}-node-${LEGACY_ABI}-napi-v3-${platform}-${arch}-${toolchain}.tar.gz`;
  const url = `https://github.com/discordjs/opus/releases/download/v${pkg.version}/${tarballName}`;
  // The tarball's internal folder name omits the package/version prefix used
  // by the .tar.gz filename itself.
  const innerPrefix = `node-${LEGACY_ABI}-napi-v3-${platform}-${arch}-${toolchain}`;
  const innerOpus = `${innerPrefix}/opus.node`;

  const gzPath = join(os.tmpdir(), tarballName);
  const gzTmp = `${gzPath}.${process.pid}.download`;
  let body;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    body = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    // Corporate TLS interception can break Node's own fetch; fall back to the
    // system downloader (Windows) once before giving up.
    if (platform === 'win32') {
      try {
        execFileSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-Command',
            `[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072; ` +
              `Invoke-WebRequest -Uri '${url}' -OutFile '${gzTmp}' -UseBasicParsing`,
          ],
          { stdio: 'ignore' },
        );
        if (!existsSync(gzTmp)) throw new Error('powershell download produced nothing');
        body = null; // content already on disk
      } catch (err2) {
        log(`warn: could not download the prebuild (fetch: ${err.message}; powershell: ${err2.message})`);
        log('staying on opusscript');
        process.exit(0);
      }
    } else {
      log(`warn: could not download the prebuild (${err.message}); staying on opusscript`);
      process.exit(0);
    }
  }
  if (body) writeFileSync(gzTmp, body);
  if (body && body.length < 1000) {
    log(`warn: downloaded ${body.length} bytes, not a tarball; staying on opusscript`);
    unlinkSync(gzTmp);
    process.exit(0);
  }

  // Layered tmpdir can block file moves: extract straight into place.
  mkdirSync(prebuildDir, { recursive: true });
  try {
    // Tarball layout: "<innerPrefix>/opus.node" (+ .lib et al). Keep only the binding.
    execFileSync('tar', ['-xzf', gzTmp, '-C', prebuildDir, '--strip-components=1', innerOpus], {
      stdio: 'ignore',
    });
  } catch {
    // Older tar variants dislike --strip-components with a member filter:
    // extract everything into a throwaway dir, then move the binding up.
    const workDir = join(os.tmpdir(), `opus-shim-${process.pid}`);
    try {
      rmSync(workDir, { recursive: true, force: true });
      mkdirSync(workDir, { recursive: true });
      execFileSync('tar', ['-xzf', gzTmp, '-C', workDir], { stdio: 'ignore' });
      renameSync(join(workDir, innerOpus), join(prebuildDir, 'opus.node'));
    } catch (err3) {
      log(`warn: extraction failed (${err3.message}); staying on opusscript`);
      process.exit(0);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  }

  // Verify in a fresh process (this one may have a failed-require cache entry).
  const check = spawnSync(
    process.execPath,
    ['-e', `try { require(${JSON.stringify(pkgRoot)}) } catch (e) { console.error(e.message); process.exit(1) }`],
    { stdio: 'pipe' },
  );
  if (check.status !== 0) {
    log(`warn: placed prebuild still does not load (${String(check.stderr).trim()}); staying on opusscript`);
    unlinkSync(join(prebuildDir, 'opus.node'));
    process.exit(0);
  }

  log(
    `installed ${tarballName} as ${join(prebuildDir, 'opus.node').replace(process.cwd(), '.')} -> native opus ready on ${process.version}`,
  );
} catch (err) {
  console.log(`[opus-shim] warn: unexpected failure (${err.message}) — staying on opusscript`);
}
process.exit(0);
