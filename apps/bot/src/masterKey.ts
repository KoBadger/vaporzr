import fs from 'node:fs';
import path from 'node:path';
import { config } from '@vaporzr/core/config';
import { writeJsonAtomicSync } from './jsonFile.js';

/**
 * Owner-pinned master key.
 *
 * `SHARE_KEY` in the deployment env is the built-in credential, but it is only
 * reachable by editing the container: `V@key rotate` writes a new one to
 * `.env`, and the next redeploy puts the old value back — which is exactly how
 * an owner's remembered key silently stops working.
 *
 * A key set from Discord lives in `data/master-key.json`, which survives
 * deploys (the same volume the stems cache and the karaoke nights use), and is
 * applied over the env value at boot. Rotating still works: /key rotate writes
 * the env file, and /key set overrides it again.
 */

interface MasterKeyFile {
  key: string;
  updatedAt?: number;
}

function keyPath(): string {
  return path.join(config.dataDir, 'master-key.json');
}

let pinned = false;

/** Apply a stored key, if there is one. Safe to call more than once. */
export function loadMasterKey(): void {
  if (pinned) return;
  pinned = true;
  try {
    if (!fs.existsSync(keyPath())) return;
    const raw = JSON.parse(fs.readFileSync(keyPath(), 'utf8')) as MasterKeyFile;
    const key = typeof raw.key === 'string' ? raw.key.trim() : '';
    if (!key) return;
    config.shareKey = key;
    console.log('[access] using the master key pinned from Discord (data/master-key.json)');
  } catch (err) {
    console.warn(`[access] could not read the pinned key: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Pin a new master key. Long enough to be worth typing, no whitespace, and
 * stored 0600-ish (it is a credential).
 */
export function setMasterKey(typed: string): { ok: true; hint: string } | { ok: false; error: string } {
  const key = typed.trim();
  if (key.length < 10) {
    return { ok: false, error: 'Give me at least 10 characters — this key opens the control panel.' };
  }
  if (/\s/.test(key)) return { ok: false, error: 'A key cannot contain spaces.' };
  if (key.length > 128) return { ok: false, error: 'That is too long to be a key.' };
  try {
    fs.mkdirSync(path.dirname(keyPath()), { recursive: true });
    const file = keyPath();
    writeJsonAtomicSync(file, { key, updatedAt: Date.now() } satisfies MasterKeyFile);
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* Windows: no POSIX modes */
    }
  } catch (err) {
    return { ok: false, error: `Could not save the key: ${err instanceof Error ? err.message : String(err)}` };
  }
  config.shareKey = key;
  return { ok: true, hint: `${key.slice(0, 3)}${'•'.repeat(Math.max(0, key.length - 4))}${key.slice(-1)}` };
}

/** Drop the pinned key and fall back to the env value. */
export function clearMasterKey(): void {
  try {
    fs.rmSync(keyPath(), { force: true });
  } catch {
    /* nothing to remove */
  }
  config.shareKey = (process.env.SHARE_KEY ?? '').trim();
  pinned = true;
}

/** True when the live key came from Discord rather than the env. */
export function masterKeyIsPinned(): boolean {
  return fs.existsSync(keyPath());
}
