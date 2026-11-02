/**
 * Which servers have added the bot, and when.
 *
 * A public bot collects a little metadata the moment it joins a server — the
 * name, id, owner, member count and locale are on the gateway payload before a
 * single command runs. Keeping that in one explicit file does two things:
 *
 *  1. the operator can see who added the bot (and who removed it) instead of
 *     watching `client.guilds.cache` blink;
 *  2. the data lives somewhere named and documented, which is what the privacy
 *     page and the join notice describe. Nothing here is inferred or scraped —
 *     it is the fields Discord sends on GUILD_CREATE.
 *
 * Bounded on purpose: one record per guild (the latest snapshot) plus a capped
 * event log. No messages, no member lists, no voice audio.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '@vaporzr/core/config';
import { writeJsonAtomicSync } from '@vaporzr/core/jsonFile';

export interface GuildRecord {
  id: string;
  name: string;
  /** Server owner id. Stored so the operator knows who to contact, nothing else. */
  ownerId: string | null;
  /** Member count at the last time the bot saw the server. */
  members: number;
  joinedAt: number;
  leftAt?: number;
  lastSeenAt: number;
  locale?: string;
}

export interface RegistryEvent {
  at: number;
  type: 'join' | 'leave';
  id: string;
  name: string;
  members: number;
}

interface RegistryFile {
  version: 1;
  guilds: Record<string, GuildRecord>;
  events: RegistryEvent[];
}

/** Enough history to answer "what happened last month" without growing forever. */
const MAX_EVENTS = 400;

let cache: RegistryFile | null = null;

function registryPath(): string {
  return path.join(config.dataDir, 'guild-registry.json');
}

function load(): RegistryFile {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(registryPath(), 'utf8')) as Partial<RegistryFile>;
    cache = {
      version: 1,
      guilds: raw.guilds && typeof raw.guilds === 'object' ? (raw.guilds as Record<string, GuildRecord>) : {},
      events: Array.isArray(raw.events) ? raw.events.slice(0, MAX_EVENTS) : [],
    };
  } catch {
    cache = { version: 1, guilds: {}, events: [] };
  }
  return cache;
}

function save(): void {
  try {
    writeJsonAtomicSync(registryPath(), load());
  } catch (err) {
    console.warn('[guilds] could not save the registry:', err instanceof Error ? err.message : err);
  }
}

function pushEvent(reg: RegistryFile, event: RegistryEvent): void {
  reg.events.unshift(event);
  if (reg.events.length > MAX_EVENTS) reg.events.length = MAX_EVENTS;
}

export interface GuildSnapshotInput {
  id: string;
  name: string;
  ownerId?: string | null;
  memberCount: number;
  locale?: string;
}

/** Record a GUILD_CREATE. Returns whether this is the first time we see it. */
export function noteGuildJoin(input: GuildSnapshotInput): { first: boolean; record: GuildRecord } {
  const reg = load();
  const now = Date.now();
  const prev = reg.guilds[input.id];
  const first = !prev;
  const record: GuildRecord = {
    id: input.id,
    name: input.name,
    ownerId: input.ownerId ?? prev?.ownerId ?? null,
    members: input.memberCount,
    // Keep the original join date across re-adds: "added 3 times" is the signal.
    joinedAt: prev?.joinedAt ?? now,
    lastSeenAt: now,
    locale: input.locale ?? prev?.locale,
  };
  reg.guilds[input.id] = record;
  if (first) pushEvent(reg, { at: now, type: 'join', id: input.id, name: input.name, members: input.memberCount });
  save();
  return { first, record };
}

/** Refresh the snapshot for a guild the bot is currently in (boot backfill). */
export function noteGuildSeen(input: GuildSnapshotInput): void {
  noteGuildsSeen([input]);
}

/** Same as noteGuildSeen, batched so a boot is one write instead of N. */
export function noteGuildsSeen(inputs: GuildSnapshotInput[]): void {
  if (inputs.length === 0) return;
  const reg = load();
  const now = Date.now();
  for (const input of inputs) {
    const prev = reg.guilds[input.id];
    reg.guilds[input.id] = {
      id: input.id,
      name: input.name,
      ownerId: input.ownerId ?? prev?.ownerId ?? null,
      members: input.memberCount,
      joinedAt: prev?.joinedAt ?? now,
      lastSeenAt: now,
      locale: input.locale ?? prev?.locale,
    };
  }
  save();
}

/** Record a GUILD_DELETE (kicked, or the bot was removed). */
export function noteGuildLeave(id: string, name: string, members: number): void {
  const reg = load();
  const prev = reg.guilds[id];
  const now = Date.now();
  if (prev) {
    reg.guilds[id] = { ...prev, leftAt: now, lastSeenAt: now, members: members || prev.members };
  } else {
    reg.guilds[id] = { id, name, ownerId: null, members, joinedAt: now, leftAt: now, lastSeenAt: now };
  }
  pushEvent(reg, { at: now, type: 'leave', id, name, members });
  save();
}

export interface GuildRegistrySnapshot {
  guilds: GuildRecord[];
  events: RegistryEvent[];
  active: number;
  total: number;
  joinedLast7d: number;
  leftLast7d: number;
}

export function guildRegistry(): GuildRegistrySnapshot {
  const reg = load();
  const guilds = Object.values(reg.guilds).sort((a, b) => b.joinedAt - a.joinedAt);
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  return {
    guilds,
    events: reg.events,
    active: guilds.filter((g) => !g.leftAt).length,
    total: guilds.length,
    joinedLast7d: guilds.filter((g) => g.joinedAt >= weekAgo).length,
    leftLast7d: reg.events.filter((e) => e.type === 'leave' && e.at >= weekAgo).length,
  };
}

/** Test helper: drop the in-memory copy so the next call re-reads the file. */
export function resetGuildRegistryForTests(): void {
  cache = null;
}
