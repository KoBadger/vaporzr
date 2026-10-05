import fs from 'node:fs';
import path from 'node:path';
import { config } from '@vaporzr/core/config';

interface UserStat {
  queued: number;
  played: number;
}

interface DayStat {
  played: number;
  queued: number;
  /** Total playback time counted that day (ms). */
  playedMs?: number;
}

interface MonthStat {
  plays: number;
  queued: number;
  /** Total playback time that month (ms). */
  playedMs: number;
  tracks: Record<string, number>;
  artists: Record<string, number>;
  /** DJ display-name → plays. */
  djs: Record<string, number>;
}

interface GuildStats {
  users: Record<string, UserStat>;
  artists: Record<string, number>;
  totalQueued: number;
  /** 'YYYY-MM-DD' (UTC) → plays/queues that day. */
  days: Record<string, DayStat>;
  /** 'title|artist' → plays (all-time, for dedupe/leaderboards). */
  tracks: Record<string, number>;
  /** 'YYYY-MM' (UTC) → monthly aggregates (the Wrapped view). */
  months: Record<string, MonthStat>;
}

const MAX_DAYS = 120;
/** Months are far smaller than days; keep a year plus the current one. */
const MAX_MONTHS = 13;
/** A single track can't credit more than 12h (guards wrong album-length metadata). */
const MAX_MS_PER_TRACK = 12 * 60 * 60 * 1000;

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function monthKey(d = new Date()): string {
  return d.toISOString().slice(0, 7);
}

/** Stable, human-readable key for a track ("title | first artist"). */
export function trackKey(name: string, artists: string[]): string {
  const t = (name ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  const a = (artists[0] ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  return `${t} | ${a}`.replace(/\s*\|\s*$/, '');
}

export interface WrappedSummary {
  month: string;
  playedMs: number;
  plays: number;
  queued: number;
  topTracks: Array<[string, number]>;
  topArtists: Array<[string, number]>;
  topDjs: Array<[string, number]>;
  /** [date, playedMs] — the month's biggest listening day. */
  biggestDay: [string, number] | null;
  allTimeMs: number;
  allTimeQueued: number;
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
    let data: GuildStats = { users: {}, artists: {}, totalQueued: 0, days: {}, tracks: {}, months: {} };
    try {
      const parsed = JSON.parse(fs.readFileSync(this.fileFor(guildId), 'utf8')) as Partial<GuildStats>;
      data = {
        users: parsed.users ?? {},
        artists: parsed.artists ?? {},
        totalQueued: parsed.totalQueued ?? 0,
        days: parsed.days ?? {},
        tracks: parsed.tracks ?? {},
        months: parsed.months ?? {},
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
    const m = (d.months[monthKey()] ??= { plays: 0, queued: 0, playedMs: 0, tracks: {}, artists: {}, djs: {} });
    m.queued++;
    this.pruneMonths(d);
    this.pruneDays(d);
    this.scheduleSave(guildId);
  }

  notePlayed(guildId: string, user: string, artists: string[], track?: { name: string; artists: string[]; durationMs: number }): void {
    if (!guildId) return;
    const d = this.load(guildId);
    const u = (d.users[user] ??= { queued: 0, played: 0 });
    u.played++;
    for (const a of artists) {
      const k = (a ?? '').toLowerCase().trim();
      if (k) d.artists[k] = (d.artists[k] ?? 0) + 1;
    }
    this.day(d).played++;
    // Wrapped aggregates only count fresh starts (positionMs < a few seconds):
    // a pause/resume re-emits the state and must never double-count a play.
    if (track) {
      const ms = Math.min(Math.max(0, track.durationMs ?? 0), MAX_MS_PER_TRACK);
      const key = trackKey(track.name, track.artists.length ? track.artists : artists);
      d.tracks[key] = (d.tracks[key] ?? 0) + 1;
      const mk = monthKey();
      const m = (d.months[mk] ??= { plays: 0, queued: 0, playedMs: 0, tracks: {}, artists: {}, djs: {} });
      m.plays++;
      m.playedMs += ms;
      m.tracks[key] = (m.tracks[key] ?? 0) + 1;
      if (user) m.djs[user] = (m.djs[user] ?? 0) + 1;
      for (const a of track.artists.length ? track.artists : artists) {
        const k = (a ?? '').toLowerCase().trim();
        if (k) m.artists[k] = (m.artists[k] ?? 0) + 1;
      }
      const day = this.day(d);
      day.playedMs = (day.playedMs ?? 0) + ms;
      this.pruneMonths(d);
    }
    this.pruneDays(d);
    this.scheduleSave(guildId);
  }

  private pruneMonths(d: GuildStats): void {
    const keys = Object.keys(d.months);
    if (keys.length <= MAX_MONTHS) return;
    keys.sort();
    for (const k of keys.slice(0, keys.length - MAX_MONTHS)) delete d.months[k];
  }

  /** Spotify-Wrapped-style summary for a month ('YYYY-MM'; default = current). */
  wrapped(guildId: string, month = monthKey()): WrappedSummary {
    const d = this.load(guildId);
    const m = d.months[month] ?? { plays: 0, queued: 0, playedMs: 0, tracks: {}, artists: {}, djs: {} };
    let biggestDay: [string, number] | null = null;
    for (const [date, s] of Object.entries(d.days)) {
      if (!date.startsWith(month)) continue;
      const ms = s.playedMs ?? 0;
      if (ms > 0 && (!biggestDay || ms > biggestDay[1])) biggestDay = [date, ms];
    }
    let allTimeMs = 0;
    for (const mo of Object.values(d.months)) allTimeMs += mo.playedMs;
    return {
      month,
      playedMs: m.playedMs,
      plays: m.plays,
      queued: m.queued,
      topTracks: Object.entries(m.tracks).sort((a, b) => b[1] - a[1]).slice(0, 5),
      topArtists: Object.entries(m.artists).sort((a, b) => b[1] - a[1]).slice(0, 5),
      topDjs: Object.entries(m.djs).sort((a, b) => b[1] - a[1]).slice(0, 3),
      biggestDay,
      allTimeMs,
      allTimeQueued: d.totalQueued,
    };
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

  /** All-time tracks with play counts, most-played first (used by /roulette). */
  historyTracks(guildId: string, limit = 300): Array<[string, number]> {
    return Object.entries(this.load(guildId).tracks)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit);
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
