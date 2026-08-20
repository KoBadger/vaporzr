import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(__dirname, 'dist');

let customAppsDir;
if (process.platform === 'win32') {
  customAppsDir = path.join(process.env.APPDATA ?? '', 'spicetify', 'CustomApps');
} else {
  customAppsDir = path.join(os.homedir(), '.config', 'spicetify', 'CustomApps');
}

const target = path.join(customAppsDir, 'vaporzr');

if (!fs.existsSync(src)) {
  console.error('dist/ not found — run `npm run build` first.');
  process.exit(1);
}

fs.rmSync(target, { recursive: true, force: true });
fs.cpSync(src, target, { recursive: true });
console.log(`Installed Vaporzr app to ${target}`);

function currentCustomApps() {
  const out = execSync('spicetify config').toString().replace(/\x1b\[[0-9;]*m/g, '');
  const line = out.split(/\r?\n/).find((l) => /^\s*custom_apps\b/.test(l));
  if (!line) return [];
  const value = line.replace(/^\s*custom_apps\s*/, '').trim();
  return value.split('|').map((s) => s.trim()).filter(Boolean);
}

try {
  // Merge vaporzr into the existing list instead of replacing it, so other
  // custom apps (marketplace, stats, etc.) stay enabled.
  const apps = new Set(currentCustomApps());
  apps.add('vaporzr');
  execSync(`spicetify config custom_apps "${[...apps].join('|')}"`, { stdio: 'inherit' });
  execSync('spicetify apply', { stdio: 'inherit' });
  console.log('Spicetify configured. Restart Spotify if needed.');
} catch (e) {
  console.error('Could not run spicetify CLI automatically. Run manually:');
  console.error('  spicetify config custom_apps vaporzr');
  console.error('  spicetify apply');
}
