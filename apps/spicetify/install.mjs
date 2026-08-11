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

try {
  execSync('spicetify config custom_apps vaporzr', { stdio: 'inherit' });
  execSync('spicetify apply', { stdio: 'inherit' });
  console.log('Spicetify configured. Restart Spotify if needed.');
} catch (e) {
  console.error('Could not run spicetify CLI automatically. Run manually:');
  console.error('  spicetify config custom_apps vaporzr');
  console.error('  spicetify apply');
}
