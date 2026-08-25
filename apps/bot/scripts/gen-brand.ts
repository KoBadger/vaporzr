import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Copies the OFFICIAL Vaporzr logo (brand/logo.png) to every location that
 * displays it: web favicon + og:image, Spicetify app, Electron player,
 * GitHub Pages. The Discord avatar syncs automatically on bot restart
 * (hash-tracked in apps/bot/data/avatar.hash).
 *
 * Run: npx tsx apps/bot/scripts/gen-brand.ts
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const source = path.join(repoRoot, 'brand', 'logo.png');

if (!fs.existsSync(source)) {
  console.error(`Official logo not found at ${source}`);
  console.error('Save the Vaporzr emblem there first (any square-ish PNG works).');
  process.exit(1);
}

const targets = [
  'apps/bot/public/logo.png',
  'apps/bot/public/favicon.png',
  'apps/spicetify/src/logo.png',
  'docs/logo.png',
  'apps/player/assets/logo.png',
];

for (const rel of targets) {
  const abs = path.join(repoRoot, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.copyFileSync(source, abs);
  console.log(`${rel}`);
}
console.log('brand assets synced from brand/logo.png');
