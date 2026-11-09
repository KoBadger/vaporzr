/**
 * Stage a portable Vaporzr player from the vendored Electron build.
 *
 * The player is a thin Electron shell around `apps/player/www`, so a release
 * does not need electron-builder (or code signing) to be useful: this copies
 * the Electron runtime and drops the built app into `resources/app`, which is
 * exactly the layout Electron loads on startup. The workflow zips the staged
 * folder and publishes a SHA-256 next to it.
 *
 * Usage: node scripts/pack-player.mjs [--platform win32|linux] [--out DIR]
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
const dist = path.resolve(root, arg('--dist', path.join('vendor', 'electron-ecs', 'dist')));
const outRoot = path.resolve(root, arg('--out', path.join('apps', 'player', 'release')));
const staging = path.join(outRoot, `Vaporzr-${platform}-${arch}`);

if (!fs.existsSync(dist)) {
  console.error(`Electron dist not found at ${dist}. Download the castlabs build first (see docs/RELEASES.md).`);
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
renameRuntime('electron.exe', 'Vaporzr.exe');
renameRuntime('electron', 'vaporzr');

const appDir = path.join(staging, 'resources', 'app');
fs.mkdirSync(appDir, { recursive: true });
for (const dir of ['www', 'assets']) {
  const src = path.join(root, 'apps', 'player', dir);
  if (!fs.existsSync(src)) {
    console.error(`Missing ${src}; run "npm run build -w @vaporzr/player" first.`);
    process.exit(1);
  }
  fs.cpSync(src, path.join(appDir, dir), { recursive: true });
}

// Electron reads resources/app/package.json for the entry point. Keep it
// minimal: no dependencies, because everything the player needs is bundled.
const playerPkg = JSON.parse(fs.readFileSync(path.join(root, 'apps', 'player', 'package.json'), 'utf8'));
fs.writeFileSync(
  path.join(appDir, 'package.json'),
  JSON.stringify(
    {
      name: 'vaporzr-player',
      productName: 'Vaporzr',
      version: playerPkg.version ?? '0.1.0',
      private: true,
      main: 'www/bundle/main.js',
    },
    null,
    2,
  ) + '\n',
);

// The archive name is stable so the portal's checksum link can point at it.
const exe = platform === 'win32' ? 'Vaporzr.exe' : 'vaporzr';
if (!fs.existsSync(path.join(staging, exe))) {
  console.error(`Expected ${exe} in ${staging}; the Electron dist layout is not what this script expects.`);
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
