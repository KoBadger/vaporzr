/**
 * Stage a portable Vaporzr panel from an Electron runtime.
 *
 * This mirrors `pack-player.mjs` on purpose instead of sharing code with it:
 * the player release path is shipped and gated by a pinned castlabs checksum,
 * so a bug in a "shared" packer would take the player down with the panel. The
 * two payloads differ anyway — the player ships a bundled `www/`, while the
 * panel ships a main process that loads the live `/panel` URL.
 *
 * Usage: node scripts/pack-desktop.mjs [--platform win32|linux] [--arch x64]
 *                                     [--dist DIR] [--out DIR]
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const platform = arg('--platform', process.platform);
if (platform !== 'win32' && platform !== 'linux') {
  console.error(`Unsupported platform "${platform}". Windows and Linux are packaged; macOS needs a signed app bundle.`);
  process.exit(1);
}
const arch = arg('--arch', process.arch === 'x64' ? 'x64' : process.arch);
const dist = path.resolve(root, arg('--dist', path.join('vendor', 'electron', 'dist')));
const outRoot = path.resolve(root, arg('--out', path.join('apps', 'desktop', 'release')));
const staging = path.join(outRoot, `Vaporzr-Panel-${platform}-${arch}`);
const appSrc = path.join(root, 'apps', 'desktop');

if (!fs.existsSync(dist)) {
  console.error(`Electron dist not found at ${dist}. Download the runtime first (see docs/RELEASES.md).`);
  process.exit(1);
}

fs.rmSync(staging, { recursive: true, force: true });
fs.mkdirSync(staging, { recursive: true });

// Runtime files, minus signatures/debug logs that do not belong in a portable zip.
for (const entry of fs.readdirSync(dist)) {
  if (entry === 'electron.exe.sig' || entry === 'debug.log') continue;
  fs.cpSync(path.join(dist, entry), path.join(staging, entry), { recursive: true });
}

function renameRuntime(from, to) {
  const src = path.join(staging, from);
  if (fs.existsSync(src)) fs.renameSync(src, path.join(staging, to));
}
renameRuntime('electron.exe', 'Vaporzr Panel.exe');
renameRuntime('electron', 'vaporzr-panel');

const appDir = path.join(staging, 'resources', 'app');
fs.mkdirSync(appDir, { recursive: true });
const skip = new Set(['node_modules', 'release', '.env', '.env.local']);
for (const entry of fs.readdirSync(appSrc)) {
  if (skip.has(entry)) continue;
  fs.cpSync(path.join(appSrc, entry), path.join(appDir, entry), { recursive: true });
}

// Electron reads resources/app/package.json for the entry point. Written fresh
// rather than copied so dev-only fields never leak into a release.
const pkg = JSON.parse(fs.readFileSync(path.join(appSrc, 'package.json'), 'utf8'));
fs.writeFileSync(
  path.join(appDir, 'package.json'),
  JSON.stringify(
    {
      name: 'vaporzr-panel',
      productName: 'Vaporzr Panel',
      version: pkg.version ?? '0.1.0',
      private: true,
      type: 'module',
      main: 'main.js',
    },
    null,
    2,
  ) + '\n',
);

const exe = platform === 'win32' ? 'Vaporzr Panel.exe' : 'vaporzr-panel';
if (!fs.existsSync(path.join(staging, exe))) {
  console.error(`Expected ${exe} in ${staging}; the Electron dist layout is not what this script expects.`);
  process.exit(1);
}
if (!fs.existsSync(path.join(appDir, 'main.js'))) {
  console.error(`Missing ${path.join(appDir, 'main.js')}; the desktop app was not copied.`);
  process.exit(1);
}

// A tiny integrity manifest inside the zip, independent of the .sha256 asset.
const files = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.isFile()) files.push(full);
  }
}
walk(staging);
const lines = files
  .filter((f) => !f.endsWith('SHA256SUMS.txt'))
  .sort()
  .map((f) => {
    const hash = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
    return `${hash}  ${path.relative(staging, f).split(path.sep).join('/')}`;
  });
fs.writeFileSync(path.join(staging, 'SHA256SUMS.txt'), lines.join('\n') + '\n');

console.log(staging);
