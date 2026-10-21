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
 * cannot find Visual Studio 18 ("unknown version"). Result: voice degrades to
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
 * Because @discordjs/opus is an *optional* dependency of the bot (it must be:
 * as a required one, a failing install script aborts the whole `npm install`
 * before any postinstall can run), npm deletes the package directory on a
 * failed build. So when the package is missing entirely, this script also
 * bootstraps it from the npm registry tarball first — pure JS, no install
 * scripts — and then stages the binding into it.
 *
 * Usage: root `postinstall`. Env: OPUS_SHIM_DISABLE=1 opts out. The install
 * never fails because of this script — on any problem it warns and exits 0,
 * leaving opusscript as the runtime fallback.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

const log = (msg) => console.log(`[opus-shim] ${msg}`);
const REGISTRY = 'https://registry.npmjs.org/@discordjs/opus';

/**
 * Download `url` to a temp file. Node's own fetch first; on Windows a
 * PowerShell fallback, because corporate TLS interception breaks Node's
 * bundled CA list while the Windows store still has the proxy's root.
 * Returns the file path, or null.
 */
async function download(url, suffix) {
  const dest = join(os.tmpdir(), `opus-shim-${process.pid}-${Date.now()}-${suffix}`);
  const tmp = `${dest}.part`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
    renameSync(tmp, dest);
    return dest;
  } catch (err) {
    if (process.platform === 'win32') {
      try {
        execFileSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-Command',
            `[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072; ` +
              `Invoke-WebRequest -Uri '${url}' -OutFile '${dest}' -UseBasicParsing`,
          ],
          { stdio: 'ignore' },
        );
        if (existsSync(dest)) return dest;
      } catch {
        /* fall through */
      }
    }
    log(`warn: could not download ${url} (${err.message})`);
    return null;
  }
}

/** Version the repo asks for, so the shim matches package.json when it can. */
function wantedVersion() {
  for (const rel of [join('apps', 'bot', 'package.json'), 'package.json']) {
    try {
      const pkg = JSON.parse(readFileSync(join(process.cwd(), rel), 'utf8'));
      const spec = { ...pkg.dependencies, ...pkg.optionalDependencies }['@discordjs/opus'];
      const clean = String(spec ?? '').replace(/^[~^=\s]+/, '');
      if (/^\d+\.\d+\.\d+$/.test(clean)) return clean;
    } catch {
      /* try next candidate */
    }
  }
  return null; // caller falls back to the registry's latest
}

/** Recreate the package npm deleted, from the registry tarball (no scripts). */
async function bootstrapPackage() {
  let version = wantedVersion();
  if (!version) {
    try {
      const res = await fetch(`${REGISTRY}/latest`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      version = JSON.parse(await res.text()).version;
    } catch (err) {
      log(`warn: could not determine a version to bootstrap (${err.message})`);
      return null;
    }
  }
  const dest = join(process.cwd(), 'node_modules', '@discordjs', 'opus');
  const tgz = await download(`${REGISTRY}/-/opus-${version}.tgz`, 'opus-npm.tgz');
  if (!tgz) return null;
  try {
    mkdirSync(dest, { recursive: true });
    execFileSync('tar', ['-xzf', tgz, '-C', dest, '--strip-components=1'], { stdio: 'ignore' });
    if (!existsSync(join(dest, 'package.json'))) throw new Error('tarball had no package.json');
    return dest;
  } catch (err) {
    rmSync(dest, { recursive: true, force: true });
    log(`warn: could not unpack @discordjs/opus ${version} (${err.message})`);
    return null;
  } finally {
    rmSync(tgz, { force: true });
  }
}

/**
 * The opus loader is two lines: `require('@discordjs/node-pre-gyp').find(pkg)`.
 * npm drops that dependency too when it deletes the failed optional package, so
 * a bootstrapped copy cannot load without it. Installing the real tree from
 * here would mean a nested `npm install` inside a postinstall; instead drop in
 * a minimal stand-in that implements exactly the `find()` contract, which is
 * just "path of the binding for this ABI". Only created when it is missing.
 */
function ensureNodePreGyp(pkgRoot) {
  try {
    require.resolve('@discordjs/node-pre-gyp/package.json');
    return; // real dependency present
  } catch {
    /* install the stand-in below */
  }
  const dir = join(pkgRoot, '..', 'node-pre-gyp');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: '@discordjs/node-pre-gyp', version: '0.0.0-vaporzr-shim', main: 'index.js' }, null, 2),
  );
  writeFileSync(
    join(dir, 'index.js'),
    `// Installed by vaporzr scripts/install-opus-prebuild.mjs: minimal stand-in for
// @discordjs/node-pre-gyp, which npm removed together with the optional
// @discordjs/opus package. Implements only the find() contract: return the
// absolute path of the native binding for the running ABI.
'use strict';
const { join, dirname } = require('node:path');
const { existsSync } = require('node:fs');

exports.find = (packageJsonPath) => {
  const root = dirname(packageJsonPath);
  const libc = process.platform === 'win32' || process.platform === 'darwin' ? 'unknown-unknown' : 'unknown-unknown';
  const abi = 'node-v' + process.versions.modules + '-napi-v3-' + process.platform + '-' + process.arch + '-' + libc;
  const candidates = [join(root, 'prebuild', abi, 'opus.node'), join(root, 'build', 'Release', 'opus.node')];
  const hit = candidates.find((p) => existsSync(p));
  if (!hit) throw new Error('native binding not found for ' + abi + ' (looked in ' + candidates.join(', ') + ')');
  return hit;
};
`,
  );
  log('installed a minimal @discordjs/node-pre-gyp stand-in (the real one was removed with the package)');
}

try {
  const require = createRequire(import.meta.url);

  if (process.env.OPUS_SHIM_DISABLE) {
    log('skipped: OPUS_SHIM_DISABLE=1');
    process.exit(0);
  }

  // Already loading natively? Nothing to do (quiet, so installs stay clean).
  try {
    require('@discordjs/opus');
    process.exit(0);
  } catch {
    /* fall through to the shim */
  }

  const { platform, arch } = process;
  // File naming includes libc; only win32/macOS use "unknown-unknown".
  const toolchain = platform === 'win32' || platform === 'darwin' ? 'unknown-unknown' : null;
  if (!toolchain || !['x64', 'arm64'].includes(arch)) {
    log(`warn: no prebuild layout known for ${platform}-${arch}; staying on opusscript`);
    process.exit(0);
  }

  // Find the package. npm deletes a failed *optional* dependency, so on a
  // newer ABI the folder is usually gone by the time this runs: recreate it.
  let pkgRoot = null;
  try {
    pkgRoot = join(require.resolve('@discordjs/opus/package.json'), '..');
  } catch {
    pkgRoot = await bootstrapPackage();
    if (!pkgRoot) {
      log('warn: @discordjs/opus is not installed and could not be bootstrapped; staying on opusscript');
      process.exit(0);
    }
    log(`bootstrapped @discordjs/opus from the npm registry (the installer had removed it)`);
  }

  // npm removes the package's own dependencies along with it.
  ensureNodePreGyp(pkgRoot);

  const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
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

  const gz = await download(url, tarballName);
  if (!gz) {
    log('warn: no prebuild downloaded; staying on opusscript');
    process.exit(0);
  }

  // Layered tmpdir can block file moves: extract straight into place.
  mkdirSync(prebuildDir, { recursive: true });
  try {
    // Tarball layout: "<innerPrefix>/opus.node" (+ .lib et al). Keep only the binding.
    execFileSync('tar', ['-xzf', gz, '-C', prebuildDir, '--strip-components=1', innerOpus], {
      stdio: 'ignore',
    });
  } catch {
    // Older tar variants dislike --strip-components with a member filter:
    // extract everything into a throwaway dir, then move the binding up.
    const workDir = join(os.tmpdir(), `opus-shim-${process.pid}`);
    try {
      rmSync(workDir, { recursive: true, force: true });
      mkdirSync(workDir, { recursive: true });
      execFileSync('tar', ['-xzf', gz, '-C', workDir], { stdio: 'ignore' });
      renameSync(join(workDir, innerOpus), join(prebuildDir, 'opus.node'));
    } catch (err3) {
      log(`warn: extraction failed (${err3.message}); staying on opusscript`);
      process.exit(0);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
      rmSync(gz, { force: true });
    }
  }
  rmSync(gz, { force: true });

  // Verify in a fresh process (this one may have a failed-require cache entry).
  const check = spawnSync(process.execPath, ['-e', "require('@discordjs/opus')"], { stdio: 'pipe' });
  if (check.status !== 0) {
    log(`warn: placed prebuild still does not load (${String(check.stderr).trim()}); staying on opusscript`);
    rmSync(join(prebuildDir, 'opus.node'), { force: true });
    process.exit(0);
  }

  log(`native opus ready on ${process.version} (${tarballName} -> ${prebuildDir.replace(process.cwd(), '.')})`);
} catch (err) {
  console.log(`[opus-shim] warn: unexpected failure (${err.message}) — staying on opusscript`);
}
process.exit(0);
