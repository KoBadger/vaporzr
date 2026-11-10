/**
 * Per-guild jam request policy: the host's handle on the crowd.
 *
 * Persisted next to the queue so a redeploy does not silently unlock a party.
 * Policy checks live in Bridge.requestTrack — the endpoint is only transport.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '@vaporzr/core/config';
import { writeJsonAtomicSync } from './jsonFile.js';

export interface JamPolicy {
  /** Stop accepting new requests entirely. */
  locked: boolean;
  /** Queue requests for host approval instead of adding immediately. */
  approval: boolean;
  /** Display names the host muted (case-insensitive, trimmed). */
  mute: string[];
  /** Max requests per guest for this session (0 = unlimited). */
  maxPerGuest: number;
  /** Seconds between requests from one guest (0 = no cooldown). */
  cooldownSec: number;
}

export const DEFAULT_JAM_POLICY: JamPolicy = {
  locked: false,
  approval: false,
  mute: [],
  maxPerGuest: 0,
  cooldownSec: 0,
};

const cache = new Map<string, JamPolicy>();
let loaded = false;

function storePath(): string {
  return path.join(config.dataDir, 'jam-policy.json');
}

function loadOnce(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = JSON.parse(fs.readFileSync(storePath(), 'utf8')) as {
      guilds?: Record<string, Partial<JamPolicy>>;
    };
    for (const [gid, p] of Object.entries(raw.guilds ?? {})) {
      cache.set(gid, normalize(p));
    }
  } catch {
    /* first boot */
  }
}

function normalize(p: Partial<JamPolicy> | undefined): JamPolicy {
  return {
    locked: Boolean(p?.locked),
    approval: Boolean(p?.approval),
    mute: Array.isArray(p?.mute)
      ? p.mute
          .map((n) =>
            String(n)
              .replace(/[\u0000-\u001f\u007f]/g, '')
              .trim()
              .slice(0, 24),
          )
          .filter(Boolean)
          .slice(0, 100)
      : [],
    maxPerGuest: Math.max(0, Math.min(99, Math.round(Number(p?.maxPerGuest) || 0))),
    cooldownSec: Math.max(0, Math.min(600, Math.round(Number(p?.cooldownSec) || 0))),
  };
}

function persist(): void {
  try {
    writeJsonAtomicSync(storePath(), { guilds: Object.fromEntries(cache) });
  } catch (err) {
    console.warn('[jam-policy] could not save:', err instanceof Error ? err.message : String(err));
  }
}

export function getJamPolicy(guildId: string | undefined): JamPolicy {
  if (!guildId) return { ...DEFAULT_JAM_POLICY };
  loadOnce();
  return cache.get(guildId) ?? { ...DEFAULT_JAM_POLICY };
}

export function setJamPolicy(guildId: string, patch: Partial<JamPolicy>): JamPolicy {
  loadOnce();
  const next = normalize({ ...getJamPolicy(guildId), ...patch });
  cache.set(guildId, next);
  persist();
  return next;
}
