import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

interface UserStat {
  queued: number;
  played: number;
}

interface DayStat {
  played: number;
  queued: number;
}

interface GuildStats {
  users: Record<string, UserStat>;
  artists: Record<string, number>;
  totalQueued: number;
  /** 'YYYY-MM-DD' (UTC) → plays/queues that day. */
  days: Record<string, DayStat>;
}

const MAX_DAYS = 120;

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Per-guild listening statistics for leaderboards + a daily history. Debounced persistence. */
export class StatsStore {
  private cache = new Map<string, GuildStats>();
  private timers = new Map<string, NodeJS.Timeout>();

  private fileFor(guildId: string): string {
    return path.join(config.dataDir, 'stats', `${guildId}.json`);
  }

  private load(guildId: string): GuildStats {
    const cached = this.cache.get(guildId);
    if (cached) return cached;
    let data: GuildStats = { users: {}, artists: {}, totalQueued: 0, days: {} };
    try {
      const parsed = JSON.parse(fs.readFileSync(this.fileFor(guildId), 'utf8')) as Partial<GuildStats>;
      data = {
        users: parsed.users ?? {},
        artists: parsed.artists ?? {},
        totalQueued: parsed.totalQueued ?? 0,
        days: parsed.days ?? {},
      };
    } catch {
      /* fresh */
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
    try {
      const file = this.fileFor(guildId);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(this.load(guildId), null, 2));
    } catch (err) {
      console.warn('[stats] save failed:', err instanceof Error ? err.message : err);
    }
  }

  private day(d: GuildStats): DayStat {
    return (d.days[todayKey()] ??= { played: 0, queued: 0 });
  }

  private pruneDays(d: GuildStats): void {
    const keys = Object.keys(d.days);
    if (keys.length <= MAX_DAYS) return;
    keys.sort();
    for (const k of keys.slice(0, keys.length - MAX_DAYS)) delete d.days[k];
  }

  noteQueued(guildId: string, user: string, _artists: string[]): void {
    if (!guildId) return;
    const d = this.load(guildId);
    d.totalQueued++;
    const u = (d.users[user] ??= { queued: 0, played: 0 });
    u.queued++;
    this.day(d).queued++;
    this.pruneDays(d);
    this.scheduleSave(guildId);
  }

  notePlayed(guildId: string, user: string, artists: string[]): void {
    if (!guildId) return;
    const d = this.load(guildId);
    const u = (d.users[user] ??= { queued: 0, played: 0 });
    u.played++;
    for (const a of artists) {
      const k = (a ?? '').toLowerCase().trim();
      if (k) d.artists[k] = (d.artists[k] ?? 0) + 1;
    }
    this.day(d).played++;
    this.pruneDays(d);
    this.scheduleSave(guildId);
  }

  topUsers(guildId: string, n = 10): Array<[string, UserStat]> {
    return Object.entries(this.load(guildId).users)
      .sort((a, b) => b[1].queued - a[1].queued || b[1].played - a[1].played)
      .slice(0, n);
  }

  topArtists(guildId: string, n = 10): Array<[string, number]> {
    return Object.entries(this.load(guildId).artists)
      .sort((a, b) => b[1] - a[1])
      .slice(0, n);
  }

  user(guildId: string, name: string): UserStat {
    return this.load(guildId).users[name] ?? { queued: 0, played: 0 };
  }

  totalQueued(guildId: string): number {
    return this.load(guildId).totalQueued;
  }

  /** Daily play/queue counts for the last `n` days (UTC), oldest → newest. */
  history(guildId: string, n = 30): Array<{ date: string; played: number; queued: number }> {
    const d = this.load(guildId);
    const now = new Date();
    const out: Array<{ date: string; played: number; queued: number }> = [];
    for (let i = n - 1; i >= 0; i--) {
      const dt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
      const key = dt.toISOString().slice(0, 10);
      const s = d.days[key] ?? { played: 0, queued: 0 };
      out.push({ date: key, played: s.played, queued: s.queued });
    }
    return out;
  }
}

/** Process-wide stats store shared by the Discord commands and the panel API. */
export const statsStore = new StatsStore();
