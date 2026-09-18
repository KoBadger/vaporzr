import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

interface UserStat {
  queued: number;
  played: number;
}

interface GuildStats {
  users: Record<string, UserStat>;
  artists: Record<string, number>;
  totalQueued: number;
}

/** Per-guild listening statistics for leaderboards. Debounced persistence. */
export class StatsStore {
  private cache = new Map<string, GuildStats>();
  private timers = new Map<string, NodeJS.Timeout>();

  private fileFor(guildId: string): string {
    return path.join(config.dataDir, 'stats', `${guildId}.json`);
  }

  private load(guildId: string): GuildStats {
    const cached = this.cache.get(guildId);
    if (cached) return cached;
    let data: GuildStats = { users: {}, artists: {}, totalQueued: 0 };
    try {
      const parsed = JSON.parse(fs.readFileSync(this.fileFor(guildId), 'utf8')) as Partial<GuildStats>;
      data = { users: parsed.users ?? {}, artists: parsed.artists ?? {}, totalQueued: parsed.totalQueued ?? 0 };
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

  noteQueued(guildId: string, user: string, _artists: string[]): void {
    if (!guildId) return;
    const d = this.load(guildId);
    d.totalQueued++;
    const u = (d.users[user] ??= { queued: 0, played: 0 });
    u.queued++;
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
}

/** Process-wide stats store shared by the Discord commands and the panel API. */
export const statsStore = new StatsStore();
