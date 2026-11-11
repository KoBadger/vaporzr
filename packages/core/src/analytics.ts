import fs from 'node:fs';
import path from 'node:path';
import { config } from '@vaporzr/core/config';
import { writeJsonAtomicSync } from './jsonFile.js';

interface GuildAnalytics {
  /** Total plays credited to this guild. */
  plays: number;
  /** UTC hour (0–23) → plays started in that hour. */
  hours: number[];
  /** Last play credited, epoch ms. */
  lastPlayAt: number;
}

/** A zeroed 24-bucket day. The array is always length 24 so callers can index
 *  it without a fallback. */
function emptyHours(): number[] {
  return Array.from({ length: 24 }, () => 0);
}

function emptyGuild(): GuildAnalytics {
  return { plays: 0, hours: emptyHours(), lastPlayAt: 0 };
}

/**
 * Per-guild playback analytics: total plays and the hour-of-day distribution
 * behind "peak active hours". Kept separate from StatsStore because that store
 * is the public leaderboard/Wrapped surface — this is the Server-plan
 * analytics view, which also needs its own retention and shape.
 *
 * Writes are debounced so a busy guild does not hit the disk on every track,
 * and every write is atomic.
 */
export class AnalyticsStore {
  private cache = new Map<string, GuildAnalytics>();
  private timers = new Map<string, NodeJS.Timeout>();

  private fileFor(guildId: string): string {
    return path.join(config.dataDir, 'analytics', `${guildId}.json`);
  }

  private load(guildId: string): GuildAnalytics {
    const cached = this.cache.get(guildId);
    if (cached) return cached;
    let data = emptyGuild();
    try {
      const parsed = JSON.parse(fs.readFileSync(this.fileFor(guildId), 'utf8')) as Partial<GuildAnalytics>;
      const hours = Array.isArray(parsed.hours) ? parsed.hours.slice(0, 24) : [];
      data = {
        plays: typeof parsed.plays === 'number' ? parsed.plays : 0,
        hours: emptyHours().map((_, i) => (typeof hours[i] === 'number' ? hours[i] : 0)),
        lastPlayAt: typeof parsed.lastPlayAt === 'number' ? parsed.lastPlayAt : 0,
      };
    } catch {
      /* fresh guild */
    }
    this.cache.set(guildId, data);
    return data;
  }

  private scheduleSave(guildId: string): void {
    if (this.timers.has(guildId)) return;
    const t = setTimeout(() => {
      this.timers.delete(guildId);
      this.save(guildId);
    }, 3000);
    t.unref?.();
    this.timers.set(guildId, t);
  }

  private save(guildId: string): void {
    const data = this.cache.get(guildId);
    if (!data) return;
    try {
      writeJsonAtomicSync(this.fileFor(guildId), data);
    } catch (err) {
      console.warn('[analytics] save failed:', err instanceof Error ? err.message : err);
    }
  }

  /** Credit one fresh track start. Callers must skip pause/resume re-emits. */
  recordPlay(guildId: string, at = Date.now()): void {
    if (!guildId) return;
    const data = this.load(guildId);
    data.plays++;
    const hour = new Date(at).getUTCHours();
    data.hours[hour] = (data.hours[hour] ?? 0) + 1;
    data.lastPlayAt = at;
    this.scheduleSave(guildId);
  }

  /** Read-only summary for the analytics endpoint. */
  summary(guildId: string): { plays: number; hours: number[]; peakHour: number | null; lastPlayAt: number } {
    if (!guildId) return { plays: 0, hours: emptyHours(), peakHour: null, lastPlayAt: 0 };
    const data = this.load(guildId);
    let peakHour: number | null = null;
    let peak = 0;
    for (let h = 0; h < data.hours.length; h++) {
      const n = data.hours[h] ?? 0;
      if (n > peak) {
        peak = n;
        peakHour = h;
      }
    }
    return { plays: data.plays, hours: [...data.hours], peakHour, lastPlayAt: data.lastPlayAt };
  }

  /** Drop a guild's analytics file (used when the bot leaves a guild). */
  clear(guildId: string): void {
    if (!guildId) return;
    this.cache.delete(guildId);
    const timer = this.timers.get(guildId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(guildId);
    }
    try {
      fs.rmSync(this.fileFor(guildId), { force: true });
    } catch {
      /* ignore */
    }
  }
}

/** Process-wide analytics store shared by playback and the panel API. */
export const analyticsStore = new AnalyticsStore();
