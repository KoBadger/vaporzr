import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(__dirname, 'src');
const dist = path.join(__dirname, 'dist');

const icon = encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64"><rect width="64" height="64" rx="14" fill="#04060f"/><rect width="64" height="64" rx="14" fill="none" stroke="#00d4ff" stroke-width="3" opacity="0.55"/><g stroke="#00e5ff" stroke-width="5" stroke-linecap="round"><line x1="20" y1="53.3" x2="53.3" y2="20"/><line x1="10.7" y1="53.3" x2="44" y2="20"/><line x1="1.3" y1="53.3" x2="34.7" y2="20"/></g><g stroke="#8a6cff" stroke-width="5" stroke-linecap="round"><line x1="5.3" y1="40" x2="58.7" y2="40"/><line x1="5.3" y1="30.7" x2="58.7" y2="30.7"/></g></svg>`,
);

const manifest = {
  name: 'vaporzr',
  icon,
  'active-icon': icon,
  'app-version': '0.1.0',
  description: 'Vaporzr shared playback control panel',
};

fs.mkdirSync(dist, { recursive: true });
fs.writeFileSync(path.join(dist, 'manifest.json'), JSON.stringify(manifest, null, 2));
fs.copyFileSync(path.join(src, 'styles.css'), path.join(dist, 'style.css'));

await build({
  entryPoints: [path.join(src, 'index.tsx')],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'chrome120',
  jsx: 'transform',
  jsxFactory: 'Spicetify.React.createElement',
  jsxFragment: 'Spicetify.React.Fragment',
  define: { 'process.env.NODE_ENV': '"production"' },
  external: [],
  outfile: path.join(dist, 'index.js'),
  logLevel: 'info',
});

console.log('Spicetify app built in dist/');
