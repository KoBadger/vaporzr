#!/usr/bin/env node
/**
 * npm run doctor - check the machine can actually run the bot's audio stack.
 *
 * Every failure mode this checks has bitten at least once, and most of them are
 * silent: the native Opus module missing (voice drops to 64 kbps), the ffmpeg
 * binary never downloaded (`--ignore-scripts` installs), or a Node ABI with no
 * upstream prebuild (covered by the postinstall shim, but only if it ran).
 *
 * Exit codes: 0 = fine (warnings allowed), 1 = a check failed (with --strict,
 * so CI can gate on it).
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '..');

const rows = [];
let failures = 0;
const ok = (name, detail) => rows.push(['ok  ', name, detail]);
const warn = (name, detail, hint) => rows.push(['warn', name, `${detail}${hint ? `\n      hint: ${hint}` : ''}`]);
const fail = (name, detail, hint) => {
  failures += 1;
  rows.push(['FAIL', name, `${detail}${hint ? `\n      hint: ${hint}` : ''}`]);
};

/**
 * Minimal .env reader: the bot loads apps/bot/.env with dotenv, and real env
 * wins. Only the keys doctor reports on are kept - the file also holds tokens,
 * and nothing here should ever be able to echo them.
 */
const ALLOWED_KEYS = [
  'FFMPEG_PATH',
  'VOICE_OPUS_BITRATE',
  'VOICE_RAISE_CHANNEL_BITRATE',
  'VOICE_OPUS_FEC',
  'VOICE_OPUS_ENCODER',
];

function envFile() {
  const file = join(root, 'apps', 'bot', '.env');
  const values = {};
  try {
    for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      if (!ALLOWED_KEYS.includes(key)) continue;
      values[key] = line
        .slice(eq + 1)
        .trim()
        .replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch {
    /* no .env - defaults apply */
  }
  return values;
}
const env = { ...envFile(), ...process.env };

// 1. Runtime.
const abi = process.versions.modules;
const napiHasPrebuild = Number(abi) <= 127; // node-v127 == Node 22 is the newest asset
ok('node', `${process.version} (ABI node-v${abi}) ${process.platform}-${process.arch}`);

// 2. Native Opus.
let opusVersion = null;
try {
  const pkgPath = require.resolve('@discordjs/opus/package.json');
  opusVersion = JSON.parse(readFileSync(pkgPath, 'utf8')).version;
  require('@discordjs/opus');
  ok('native opus', `@discordjs/opus ${opusVersion} loaded`);
} catch (err) {
  const why = err instanceof Error ? err.message.split('\n')[0] : String(err);
  if (napiHasPrebuild) {
    fail('native opus', `does not load: ${why}`, 'run `npm install` (or `npm rebuild @discordjs/opus`)');
  } else {
    fail(
      'native opus',
      `does not load on ABI node-v${abi}: ${why}`,
      'run `npm install` so the postinstall shim stages the Node 22 NAPI binding, ' +
        'or `node scripts/install-opus-prebuild.mjs` directly',
    );
  }
}

// 3. The dependency has to stay optional: as a required dep, a failed install
//    script aborts `npm install` before any postinstall could repair it.
try {
  const bot = JSON.parse(readFileSync(join(root, 'apps', 'bot', 'package.json'), 'utf8'));
  if (bot.optionalDependencies?.['@discordjs/opus']) {
    ok('opus dependency', 'optionalDependencies');
  } else {
    warn(
      'opus dependency',
      'declared as a required dependency',
      'move it to optionalDependencies - a failed native build otherwise aborts the whole install',
    );
  }
} catch {
  warn('opus dependency', 'could not read apps/bot/package.json');
}

// 4. ffmpeg: everything from track decode to TTS spawns this binary.
// Values derived from the environment are never echoed here (CodeQL's
// clear-text-logging query treats process.env as sensitive, and it is right
// to: the same file holds tokens). Only conclusions and package paths print.
const configured = env.FFMPEG_PATH || null;
let ffmpegPath = null;
if (configured && existsSync(configured)) {
  ffmpegPath = configured;
  ok('ffmpeg', 'configured via FFMPEG_PATH (path not shown)');
} else {
  try {
    const bundled = require('ffmpeg-static');
    if (bundled && existsSync(bundled)) {
      ffmpegPath = bundled;
      ok('ffmpeg', `${bundled} (ffmpeg-static)`);
    }
  } catch {
    /* fall through */
  }
  if (!ffmpegPath) {
    const probe = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8', timeout: 5000 });
    if (probe.status === 0) {
      ffmpegPath = 'ffmpeg';
      ok('ffmpeg', `ffmpeg (from PATH) ${String(probe.stdout).split('\n')[0]}`);
    } else if (configured) {
      fail('ffmpeg', 'FFMPEG_PATH points at a missing file', 'fix the path or unset FFMPEG_PATH');
    } else {
      fail(
        'ffmpeg',
        'no usable ffmpeg (ffmpeg-static binary missing and no ffmpeg on PATH)',
        'reinstall without --ignore-scripts (`npm install`), or set FFMPEG_PATH',
      );
    }
  }
}
if (ffmpegPath) {
  const v = spawnSync(ffmpegPath, ['-hide_banner', '-version'], { encoding: 'utf8', timeout: 5000 });
  const first = String(v.stdout || '').split('\n')[0];
  if (v.status !== 0) warn('ffmpeg runtime', 'binary exists but does not run', first || 'try running it by hand');
}

// 5. Voice settings as the bot would see them. Same rule: print the
// conclusion, never the raw value.
const bitrate = Number(env.VOICE_OPUS_BITRATE) || 0;
const ambiguousBitrate = bitrate > 0 && (bitrate < 64000 || bitrate > 512000);
ok(
  'voice settings',
  `encoder ${(env.VOICE_OPUS_ENCODER ?? 'native') === 'off' ? 'off' : 'native'} · ` +
    `target ${bitrate > 0 ? 'custom (VOICE_OPUS_BITRATE)' : 'follow channel'} · ` +
    `raise channel ${env.VOICE_RAISE_CHANNEL_BITRATE === '0' ? 'no' : 'yes'} · ` +
    `fec ${env.VOICE_OPUS_FEC === '0' ? 'no' : 'yes'}`,
);
if ((env.VOICE_OPUS_ENCODER ?? 'native') === 'off' && opusVersion) {
  warn(
    'voice settings',
    'VOICE_OPUS_ENCODER=off disables the native encoder path',
    'unset it to use the high-bitrate path',
  );
}
if (ambiguousBitrate) {
  warn('voice settings', 'VOICE_OPUS_BITRATE is outside 64k-512k', 'it will be clamped at encode time');
}

// Report.
const width = Math.max(...rows.map(([s, n]) => s.length + n.length + 2));
console.log('\nVaporzr doctor\n');
for (const [status, name, detail] of rows) {
  const label = `${status}  ${name}`;
  console.log(`  ${label.padEnd(width)}  ${detail}`);
}
console.log('');
if (failures > 0) {
  console.log(`  ${failures} check${failures === 1 ? '' : 's'} failed.\n`);
  process.exit(process.argv.includes('--strict') ? 1 : 0);
}
console.log('  All checks passed.\n');
process.exit(0);
