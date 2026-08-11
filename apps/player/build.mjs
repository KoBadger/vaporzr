import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(__dirname, 'src');
const out = path.join(__dirname, 'www', 'bundle');

async function main() {
  await build({
    entryPoints: {
      main: path.join(src, 'main.ts'),
      preload: path.join(src, 'preload.ts'),
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['electron'],
    outdir: out,
    logLevel: 'info',
  });

  await build({
    entryPoints: {
      player: path.join(src, 'renderer', 'player.ts'),
      visualizer: path.join(src, 'renderer', 'visualizer.ts'),
    },
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    outdir: path.join(out, 'renderer'),
    logLevel: 'info',
  });

  console.log('Player build complete.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
