/**
 * Short jam links: /j/<CODE> stands in for /jam?invite=<token>.
 *
 * The guest URL carries a rotating invite token, which makes it ~70 characters
 * long - and QR modules shrink as content grows. That is the difference
 * between "scans from the couch" and "nobody bothers" on a wall-mounted
 * screen. The short form fits in ~21 characters with a security margin to
 * spare, so the printed code comes out large and scannable.
 *
 * A short code IS the credential behind it (same blast radius as the invite
 * token the posted card already carries), so: a six-position unambiguous
 * alphabet (no 0/O, no 1/I/L - phones still get those wrong at distance), a
 * big enough space that guessing an active code by crawling is hopeless, a
 * hard cap with expiry-first eviction, and persistence next to the invites:
 * the invite behind a posted card survives restarts, so the code must too.
 */
import { randomInt } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '@vaporzr/core/config';
import { writeJsonAtomicSync } from './jsonFile.js';

/** Digits and letters minus the ones people misread: no 0/O, no 1/I/L. */
export const JAM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const JAM_CODE_LENGTH = 6;

/** Never let the table grow unbounded: invites rotate hourly and expire. */
const CODES_LIMIT = 64;

interface StoredCode {
  code: string;
  /** The invite token this code grants access to. */
  token: string;
  expiresAt: number;
}

function codesPath(): string {
  return path.join(config.dataDir, 'jam-links.json');
}

/** Loaded once, expired lazily, persisted on every mutation. */
let codes = new Map<string, StoredCode>();
let loaded = false;

function persist(): void {
  try {
    writeJsonAtomicSync(codesPath(), { codes: [...codes.values()] });
  } catch (err) {
    // Unwritable state must not take the jam card with it - codes keep
    // working from memory for as long as the process runs.
    console.warn(`[jam-links] could not persist codes: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function loadOnce(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = JSON.parse(fs.readFileSync(codesPath(), 'utf8')) as Partial<CodesFileShape>;
    if (Array.isArray(raw.codes)) {
      for (const c of raw.codes) {
        if (typeof c?.code === 'string' && typeof c?.token === 'string' && typeof c?.expiresAt === 'number') {
          codes.set(c.code, { code: c.code, token: c.token, expiresAt: c.expiresAt });
        }
      }
    }
  } catch {
    /* first boot or unreadable file - start empty */
  }
}

/** Legacy shape alias so the cast stays honest (kept out of the public API). */
interface CodesFileShape {
  codes: StoredCode[];
}

/** Drop expired codes; persists when anything was removed. */
function sweep(now: number): void {
  let changed = false;
  for (const [code, c] of codes) {
    if (c.expiresAt <= now) {
      codes.delete(code);
      changed = true;
    }
  }
  if (changed) persist();
}

/** A fresh random code, uppercase and unambiguous. */
function mint(): string {
  let out = '';
  for (let i = 0; i < JAM_CODE_LENGTH; i += 1) out += JAM_CODE_ALPHABET[randomInt(JAM_CODE_ALPHABET.length)];
  return out;
}

/**
 * The (stable, per-token) short code. Calling again with the same live token
 * hands back the same code, so every reposted card points at the same link.
 */
export function codeFor(token: string, expiresAt: number, now = Date.now()): string {
  loadOnce();
  sweep(now);
  for (const c of codes.values()) if (c.token === token) return c.code;

  // The table is full: evict whatever dies soonest, so the freshest invites
  // (the current party) always keep their links.
  if (codes.size >= CODES_LIMIT) {
    let oldest: { code: string; expiresAt: number } | null = null;
    for (const [code, c] of codes) {
      if (!oldest || c.expiresAt < oldest.expiresAt) oldest = { code, expiresAt: c.expiresAt };
    }
    if (oldest) {
      codes.delete(oldest.code);
      persist();
    }
  }

  let code = mint();
  while (codes.has(code)) code = mint();
  codes.set(code, { code, token, expiresAt });
  persist();
  return code;
}

/** Trade a short code back for its invite token, or null when unknown/expired. */
export function resolveJamCode(raw: string | undefined | null, now = Date.now()): string | null {
  if (!raw) return null;
  const code = raw.trim().toUpperCase();
  if (!/^[A-HJ-NP-Z2-9]{6}$/.test(code)) return null;
  loadOnce();
  const c = codes.get(code);
  if (!c || c.expiresAt <= now) return null;
  return c.token;
}

/** Test/ops helper: how many live codes are held right now. */
export function jamCodeCount(now = Date.now()): number {
  loadOnce();
  sweep(now);
  return codes.size;
}
