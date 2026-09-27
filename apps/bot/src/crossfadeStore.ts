import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

/**
 * Per-guild crossfade length in milliseconds — one knob that covers both the
 * overlap crossfade and the end-of-track tail fade (0 = off, so tracks play to
 * the very end). Persisted so a redeploy never resets it; the CROSSFADE_* env
 * vars only seed the initial default.
 */
const DEFAULT_MS = config.crossfadeOverlap ? config.crossfadeMs : 0;
/** Longer than this would swallow whole tracks. */
export const CROSSFADE_MAX_MS = 15_000;

let cache: Record<string, number> | null = null;

function file(): string {
  return path.join(config.dataDir, 'crossfade.json');
}

function load(): Record<string, number> {
  if (cache) return cache;
  cache = {};
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8')) as Record<string, unknown>;
    for (const [guildId, value] of Object.entries(raw)) {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) cache[guildId] = Math.min(n, CROSSFADE_MAX_MS);
    }
  } catch {
    /* no settings yet */
  }
  return cache;
}

function save(): void {
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(load(), null, 2));
  } catch (err) {
    console.warn('[crossfade] could not save:', err instanceof Error ? err.message : err);
  }
}

/** Crossfade length for a guild (0 = off). */
export function getCrossfadeMs(guildId: string): number {
  const v = load()[guildId];
  return Number.isFinite(v) ? v : DEFAULT_MS;
}

/** Set and persist a guild's crossfade length, clamped to a sane range. */
export function setCrossfadeMs(guildId: string, ms: number): number {
  const v = Math.max(0, Math.min(CROSSFADE_MAX_MS, Math.round(ms)));
  load()[guildId] = v;
  save();
  return v;
}
