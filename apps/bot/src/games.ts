import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

/**
 * Mini-game state (DJ Duel, Stump the Bot, Track Roulette) — persisted per guild
 * in data/games.json so scores and ban lists survive redeploys.
 *
 * The pure helpers here (fitPercent / pickRoulette / describeFit) carry the game
 * logic and are unit-tested; the store only does load/save/mutate.
 */

export interface GuildGames {
  /** Stump the Bot: player display-name → wins. */
  stumpWins: Record<string, number>;
  /** Stump the Bot: how many times the bot has beaten the room. */
  botWins: number;
  /** DJ Duel: player display-name → duel wins. */
  duelWins: Record<string, number>;
  /** Roulette: track keys banned by a down-vote (never rouletted again). */
  banned: string[];
  /** Roulette: tracks each player starred into the Hall of Fame. */
  starred: Record<string, number>;
}

const MAX_BANNED = 500;

function empty(): GuildGames {
  return { stumpWins: {}, botWins: 0, duelWins: {}, banned: [], starred: {} };
}

function normalize(data: Partial<GuildGames> | undefined): GuildGames {
  const e = empty();
  if (!data) return e;
  return {
    stumpWins: data.stumpWins ?? {},
    botWins: typeof data.botWins === 'number' ? data.botWins : 0,
    duelWins: data.duelWins ?? {},
    banned: Array.isArray(data.banned) ? data.banned.filter((b): b is string => typeof b === 'string') : [],
    starred: data.starred ?? {},
  };
}

/** Per-guild mini-game scores, persisted with a debounced write. */
export class GamesStore {
  private cache: Record<string, GuildGames> | null = null;
  private timers = new Map<string, NodeJS.Timeout>();

  private file(): string {
    return path.join(config.dataDir, 'games.json');
  }

  private all(): Record<string, GuildGames> {
    if (this.cache) return this.cache;
    this.cache = {};
    try {
      const raw = JSON.parse(fs.readFileSync(this.file(), 'utf8')) as Record<string, Partial<GuildGames>>;
      for (const [guildId, data] of Object.entries(raw)) this.cache[guildId] = normalize(data);
    } catch {
      /* no games yet */
    }
    return this.cache;
  }

  get(guildId: string): GuildGames {
    return (this.all()[guildId] ??= empty());
  }

  private save(guildId: string): void {
    if (this.timers.has(guildId)) return;
    const t = setTimeout(() => {
      this.timers.delete(guildId);
      try {
        fs.mkdirSync(path.dirname(this.file()), { recursive: true });
        fs.writeFileSync(this.file(), JSON.stringify(this.all(), null, 2));
      } catch (err) {
        console.warn('[games] save failed:', err instanceof Error ? err.message : err);
      }
    }, 2000);
    t.unref?.();
    this.timers.set(guildId, t);
  }

  addStumpWin(guildId: string, user: string): number {
    const g = this.get(guildId);
    g.stumpWins[user] = (g.stumpWins[user] ?? 0) + 1;
    this.save(guildId);
    return g.stumpWins[user];
  }

  addBotWin(guildId: string): number {
    const g = this.get(guildId);
    g.botWins++;
    this.save(guildId);
    return g.botWins;
  }

  addDuelWin(guildId: string, user: string): number {
    const g = this.get(guildId);
    g.duelWins[user] = (g.duelWins[user] ?? 0) + 1;
    this.save(guildId);
    return g.duelWins[user];
  }

  isBanned(guildId: string, key: string): boolean {
    return this.get(guildId).banned.includes(key);
  }

  ban(guildId: string, key: string): void {
    const g = this.get(guildId);
    if (g.banned.includes(key)) return;
    g.banned.push(key);
    if (g.banned.length > MAX_BANNED) g.banned.splice(0, g.banned.length - MAX_BANNED);
    this.save(guildId);
  }

  star(guildId: string, user: string): number {
    const g = this.get(guildId);
    g.starred[user] = (g.starred[user] ?? 0) + 1;
    this.save(guildId);
    return g.starred[user];
  }

  topOf(record: Record<string, number>, n = 5): Array<[string, number]> {
    return Object.entries(record)
      .sort((a, b) => b[1] - a[1])
      .slice(0, n);
  }
}

/** Process-wide mini-game store. */
export const gamesStore = new GamesStore();

/* ---------- pure game logic ---------- */

/**
 * Endless Wave's candidate score is "lower = better fit" (feature distance,
 * harmonic distance, artist novelty…). Turn it into a 0–100 number a human can
 * argue about: 100 = a perfect fit for the room's current vibe.
 */
export function fitPercent(score: number): number {
  if (!Number.isFinite(score)) return 50;
  return Math.max(5, Math.min(99, Math.round(100 - score)));
}

/** Explain a fit number in one line, for the game posts. */
export function describeFit(fit: number): string {
  if (fit >= 85) return 'a perfect fit for the room right now';
  if (fit >= 70) return 'right in the room\'s lane';
  if (fit >= 55) return 'adjacent to the vibe — should land fine';
  if (fit >= 40) return 'a bit of a stretch from what\'s playing';
  return 'a real curveball for this room';
}

/**
 * Pick a random track key for roulette, excluding banned keys and anything
 * already queued. Returns null when nothing qualifies.
 */
export function pickRoulette(
  keys: Iterable<string>,
  banned: Iterable<string>,
  queued: Iterable<string>,
  rng: () => number = Math.random,
): string | null {
  const skip = new Set<string>([...banned, ...queued]);
  const pool = [...keys].filter((k) => k && !skip.has(k));
  if (pool.length === 0) return null;
  const i = Math.min(pool.length - 1, Math.max(0, Math.floor(rng() * pool.length)));
  return pool[i];
}

/** 'title | artist' → a search query the resolver understands. */
export function keyToQuery(key: string): string {
  return key.replace(/\s*\|\s*/g, ' ').trim();
}
