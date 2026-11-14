import fs from 'node:fs';
import path from 'node:path';
import { config } from '@vaporzr/core/config';
import { writeJsonAtomicSync } from './jsonFile.js';

/**
 * Stem separation settings, editable from the control panel.
 *
 * The Replicate token used to be `.env`-only, which made "turn on hosted stem
 * separation" a shell job on the box — the one part of karaoke setup that needed
 * a server login. It lives in `data/stem-settings.json` now and is applied to
 * `config` in place, so saving in the panel takes effect on the next song with no
 * restart.
 *
 * Precedence: a token saved here wins over `REPLICATE_API_TOKEN` from the env,
 * because the panel is the surface the operator can actually reach.
 */

interface StemSettingsFile {
  replicateToken?: string;
  updatedAt?: number;
}

function settingsPath(): string {
  return path.join(config.dataDir, 'stem-settings.json');
}

let loaded = false;
let savedToken = '';

/** Read the saved token once and apply it. Safe to call repeatedly. */
export function loadStemSettings(): void {
  if (loaded) return;
  loaded = true;
  try {
    if (!fs.existsSync(settingsPath())) return;
    const raw = JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) as StemSettingsFile;
    const token = typeof raw.replicateToken === 'string' ? raw.replicateToken.trim() : '';
    if (token) apply(token);
  } catch (err) {
    console.warn(`[stems] could not read settings: ${err instanceof Error ? err.message : err}`);
  }
}

function apply(token: string): void {
  savedToken = token;
  config.replicateApiToken = token;
}

/** Last four characters, so the panel can show *which* key without showing it. */
function hintFor(token: string): string {
  return token.length <= 4 ? '••••' : `••••${token.slice(-4)}`;
}

export interface StemSettingsStatus {
  /** True when hosted separation will run. */
  configured: boolean;
  /** Where the token came from: the panel, the deployment env, or nowhere. */
  source: 'panel' | 'env' | 'none';
  /** Masked tail of the token in use. */
  hint?: string;
}

export function stemSettingsStatus(): StemSettingsStatus {
  loadStemSettings();
  const token = config.replicateApiToken.trim();
  if (!token) return { configured: false, source: 'none' };
  return {
    configured: true,
    // A token saved in the panel is the one in `savedToken`; anything else came
    // from the environment at boot.
    source: savedToken && savedToken === token ? 'panel' : 'env',
    hint: hintFor(token),
  };
}

/**
 * Save a token. Rejects obvious mistakes (a URL, a model slug, a whole `KEY=`
 * line copied out of a .env) instead of storing something that will fail on the
 * first song with a confusing 401.
 */
export function saveStemSettings(patch: { replicateToken?: string }): { ok: true } | { ok: false; error: string } {
  loadStemSettings();
  const raw = (patch.replicateToken ?? '').trim().replace(/^['"]|['"]$/g, '');
  if (!raw) return { ok: false, error: 'Paste the Replicate token first.' };
  // Tolerate `REPLICATE_API_TOKEN=r8_...` pasted straight from a .env file.
  const token = raw.includes('=') ? (raw.split('=').pop() ?? '').trim() : raw;
  if (/^https?:\/\//i.test(token)) {
    return { ok: false, error: 'That is a link, not a token. Copy the token itself (it starts with r8_).' };
  }
  if (!token.startsWith('r8_')) {
    return { ok: false, error: 'A Replicate token starts with r8_ — check you copied the whole thing.' };
  }
  if (token.length < 20) {
    return { ok: false, error: 'That token looks truncated.' };
  }
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    writeJsonAtomicSync(settingsPath(), { replicateToken: token, updatedAt: Date.now() } satisfies StemSettingsFile);
  } catch (err) {
    return { ok: false, error: `Could not save: ${err instanceof Error ? err.message : String(err)}` };
  }
  apply(token);
  console.log('[stems] Replicate token saved from the panel — hosted separation is on');
  return { ok: true };
}

/** Forget the panel token; the env value (if any) comes back into effect. */
export function clearStemSettings(): void {
  loadStemSettings();
  try {
    fs.rmSync(settingsPath(), { force: true });
  } catch {
    /* nothing to remove */
  }
  const envToken = (process.env.REPLICATE_API_TOKEN ?? '').trim();
  apply(envToken);
  console.log(`[stems] panel token cleared — ${envToken ? 'falling back to REPLICATE_API_TOKEN' : 'hosted stems off'}`);
}
