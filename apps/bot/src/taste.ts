import fs from 'node:fs';
import path from 'node:path';
import { config } from '@vaporzr/core/config';
import { writeJsonAtomicSync } from './jsonFile.js';

/**
 * Long-lived per-guild taste memory.
 *
 * The Endless Wave's own penalty list lives inside the session (and expires in
 * 45 minutes). This store outlives restarts and sessions: artists that keep
 * getting skipped sink, artists that get played through rise, and the wave stops
 * serving lanes the room clearly doesn't want.
 */
interface TasteFile {
  artists: Record<string, number>;
  updatedAt: number;
}

const MUTE_AT = -3;
const MAX_SCORE = 12;

export class TasteStore {
  private cache = new Map<string, TasteFile>();

  private fileFor(guildId: string): string {
    return path.join(config.dataDir, 'taste', `${guildId}.json`);
  }

  private load(guildId: string): TasteFile {
    const cached = this.cache.get(guildId);
    if (cached) return cached;
    let data: TasteFile = { artists: {}, updatedAt: Date.now() };
    try {
      const raw = JSON.parse(fs.readFileSync(this.fileFor(guildId), 'utf8')) as Partial<TasteFile>;
      if (raw && typeof raw.artists === 'object' && raw.artists) {
        data = {
          artists: Object.fromEntries(
            Object.entries(raw.artists).filter(([, v]) => typeof v === 'number' && Number.isFinite(v)),
          ),
          updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now(),
        };
      }
    } catch {
      /* first run */
    }
    // Gentle decay: a month-old grudge shouldn't outlive the phase it came from.
    if (Date.now() - data.updatedAt > 30 * 24 * 60 * 60 * 1000) {
      for (const [k, v] of Object.entries(data.artists)) data.artists[k] = Math.trunc(v / 2);
      data.updatedAt = Date.now();
    }
    this.cache.set(guildId, data);
    return data;
  }

  private save(guildId: string, data: TasteFile): void {
    try {
      fs.mkdirSync(path.dirname(this.fileFor(guildId)), { recursive: true });
      writeJsonAtomicSync(this.fileFor(guildId), data);
    } catch {
      /* non-fatal */
    }
  }

  /** Positive = liked, negative = repeatedly skipped. */
  score(guildId: string, artist: string): number {
    const key = artist.toLowerCase().trim();
    if (!key) return 0;
    return this.load(guildId).artists[key] ?? 0;
  }

  note(guildId: string, artist: string, delta: number): void {
    const key = artist.toLowerCase().trim();
    if (key.length < 3) return;
    const data = this.load(guildId);
    const next = Math.max(-MAX_SCORE, Math.min(MAX_SCORE, (data.artists[key] ?? 0) + delta));
    data.artists[key] = next;
    data.updatedAt = Date.now();
    this.save(guildId, data);
  }

  /** True when the room has skipped this artist often enough to avoid it. */
  muted(guildId: string, artist: string): boolean {
    return this.score(guildId, artist) <= MUTE_AT;
  }

  /** Snapshot for the autoplay status readout. */
  summary(guildId: string): { muted: number; liked: number } {
    const artists = Object.values(this.load(guildId).artists);
    return {
      muted: artists.filter((v) => v <= MUTE_AT).length,
      liked: artists.filter((v) => v >= 3).length,
    };
  }
}

export const taste = new TasteStore();
