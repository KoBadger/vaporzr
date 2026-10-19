/**
 * Persistent store of audio features measured from the tracks themselves (see
 * audioFeatures.ts). The ReccoBeats mirror only knows part of the catalog, so
 * for everything else the only source of real key/energy/tempo is our own
 * analysis of the audio the first time the track plays. Keeping that analysis
 * on disk is what lets `V@shuffle key|arc|smart` order those tracks across
 * restarts instead of starting featureless again.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '@vaporzr/core/config';
import type { AudioFeatures } from '@vaporzr/core/spotify';
import { writeJsonAtomicSync } from './jsonFile.js';

/** Evict the oldest measurements past this many entries (~0.7 MB on disk). */
const MAX_ENTRIES = 5000;

type Store = Record<string, Partial<AudioFeatures>>;

let store: Store | null = null;

function storeFile(): string {
  return join(config.dataDir, 'feature-store.json');
}

function load(): Store {
  if (store) return store;
  store = {};
  try {
    if (existsSync(storeFile())) {
      const parsed = JSON.parse(readFileSync(storeFile(), 'utf8')) as Store;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) store = parsed;
    }
  } catch {
    /* first run or corrupt file — start fresh */
  }
  return store;
}

function persist(): void {
  if (!store) return;
  try {
    writeJsonAtomicSync(storeFile(), store, 0);
  } catch {
    /* best effort — a failed write only loses this measurement on restart */
  }
}

/**
 * Remember features measured locally for a track uri. Overwrites older data
 * (a later play may have measured more fields), and keeps insertion order as
 * recency so eviction drops the least-recently-measured tracks first.
 */
export function rememberMeasuredFeatures(uri: string, features: Partial<AudioFeatures>): void {
  const s = load();
  delete s[uri];
  s[uri] = features;
  const keys = Object.keys(s);
  if (keys.length > MAX_ENTRIES) {
    for (const key of keys.slice(0, keys.length - MAX_ENTRIES)) delete s[key];
  }
  persist();
}

/** Features previously measured for this uri, or null if none. */
export function getMeasuredFeatures(uri: string): Partial<AudioFeatures> | null {
  return load()[uri] ?? null;
}
