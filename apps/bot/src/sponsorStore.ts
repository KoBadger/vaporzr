import fs from 'node:fs';
import path from 'node:path';
import { config } from '@vaporzr/core/config';
import { writeJsonAtomicSync } from './jsonFile.js';

/**
 * Per-guild SponsorBlock toggle. Defaults to ON (the feature is useful and
 * cheap); `V@sponsor off` is persisted so a redeploy does not silently turn it
 * back on for a server that asked for the original segments.
 */
let cache: Record<string, boolean> | null = null;

function file(): string {
  return path.join(config.dataDir, 'sponsorblock.json');
}

function load(): Record<string, boolean> {
  if (cache) return cache;
  cache = {};
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8')) as Record<string, unknown>;
    for (const [guildId, value] of Object.entries(raw)) {
      if (typeof value === 'boolean') cache[guildId] = value;
    }
  } catch {
    /* no settings yet */
  }
  return cache;
}

function save(): void {
  try {
    writeJsonAtomicSync(file(), load());
  } catch (err) {
    console.warn('[sponsorblock] could not save:', err instanceof Error ? err.message : err);
  }
}

export function getSponsorEnabled(guildId: string): boolean {
  const v = load()[guildId];
  return typeof v === 'boolean' ? v : true;
}

export function setSponsorEnabled(guildId: string, on: boolean): boolean {
  load()[guildId] = on;
  save();
  return on;
}
