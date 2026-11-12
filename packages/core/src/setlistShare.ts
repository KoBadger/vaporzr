import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '@vaporzr/core/config';
import { writeJsonAtomicSync } from './jsonFile.js';

/**
 * Shareable setlist snapshots.
 *
 * A tape is the truthful transcript of a room, but it only exists while a tape
 * is running — and the queue is what a host actually wants to hand out ("here
 * is tonight's set"). This store freezes the queue at the moment of sharing and
 * keeps it behind an unguessable id, so the link unfurls for anyone, including
 * a Discord preview that cannot send cookies or keys.
 *
 * Snapshots expire: a "what's playing right now" link that still works three
 * months later is a stale room, not a memory. The store prunes on every read
 * and write instead of running a timer, because a link nobody opens costs
 * nothing to keep until the next create.
 */

export interface SetlistShareTrack {
  uri: string;
  name: string;
  artists: string;
  album: string;
  durationMs: number;
  addedBy: string;
  image?: string;
  source?: string;
}

export interface SetlistShare {
  id: string;
  guildId: string;
  /** Display name for the room at share time. */
  guildName: string;
  /** Host-supplied title, or a generated one. */
  name: string;
  createdAt: number;
  expiresAt: number;
  /** Index into `tracks` of the track that was playing, or -1. */
  nowPlaying: number;
  tracks: SetlistShareTrack[];
}

interface ShareFile {
  shares: SetlistShare[];
}

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** A hard ceiling so a compromised panel cannot grow the file without bound. */
const MAX_SHARES = 500;
/** Long queues are truncated, matching the panel's own practical limits. */
const MAX_TRACKS = 200;
/** Field caps keep a single malformed track from bloating every read. */
const MAX_TEXT = 300;

function clip(value: unknown, max = MAX_TEXT): string {
  if (typeof value !== 'string') return '';
  return value.length > max ? value.slice(0, max) : value;
}

function normaliseTrack(raw: SetlistShareTrack): SetlistShareTrack | null {
  const name = clip(raw?.name).trim();
  const uri = clip(raw?.uri).trim();
  if (!name && !uri) return null;
  const track: SetlistShareTrack = {
    uri,
    name: name || 'Unknown track',
    artists: clip(raw?.artists).trim(),
    album: clip(raw?.album).trim(),
    durationMs: Number.isFinite(raw?.durationMs) ? Math.max(0, Math.round(raw.durationMs)) : 0,
    addedBy: clip(raw?.addedBy, 80).trim(),
  };
  const image = clip(raw?.image, 1000).trim();
  if (image) track.image = image;
  const source = clip(raw?.source, 40).trim();
  if (source) track.source = source;
  return track;
}

export interface CreateSetlistShareInput {
  guildId: string;
  guildName?: string;
  name?: string;
  tracks: SetlistShareTrack[];
  nowPlaying?: number;
  now?: number;
  ttlMs?: number;
}

/**
 * Per-deployment store of expiring setlist snapshots, persisted as one JSON
 * file. One file rather than one per share: shares are small, reads are always
 * by id, and the pruning pass wants the whole set anyway.
 */
export class SetlistShareStore {
  private cache: ShareFile | null = null;

  /** `dir` and `ttlMs` are injectable so tests can use a throwaway directory
   *  and drive expiry without waiting a week. */
  constructor(
    private readonly dir?: string,
    private readonly defaultTtlMs: number = DEFAULT_TTL_MS,
  ) {}

  private fileFor(): string {
    return path.join(this.dir ?? config.dataDir, 'setlist-shares.json');
  }

  private load(): ShareFile {
    if (this.cache) return this.cache;
    let file: ShareFile = { shares: [] };
    try {
      const raw = JSON.parse(fs.readFileSync(this.fileFor(), 'utf8')) as Partial<ShareFile>;
      if (raw && Array.isArray(raw.shares)) {
        file = {
          shares: raw.shares.filter(
            (s): s is SetlistShare =>
              !!s && typeof s.id === 'string' && Array.isArray(s.tracks) && typeof s.expiresAt === 'number',
          ),
        };
      }
    } catch {
      /* no shares yet, or a corrupt file we do not want to trust */
    }
    this.cache = file;
    return file;
  }

  private persist(file: ShareFile): void {
    try {
      writeJsonAtomicSync(this.fileFor(), file);
    } catch (err) {
      console.warn('[setlist] save failed:', err instanceof Error ? err.message : err);
    }
  }

  private newId(taken: Set<string>): string {
    // 8 random bytes → 11 base64url chars. Guessing one is infeasible, which is
    // what lets the page render for a cookie-less link unfurler.
    for (let i = 0; i < 8; i++) {
      const id = crypto.randomBytes(8).toString('base64url');
      if (!taken.has(id)) return id;
    }
    return crypto.randomUUID();
  }

  /** Drop expired shares in place; returns how many were removed. */
  prune(now = Date.now()): number {
    const file = this.load();
    const before = file.shares.length;
    file.shares = file.shares.filter((s) => s.expiresAt > now);
    const removed = before - file.shares.length;
    if (removed > 0) this.persist(file);
    return removed;
  }

  create(input: CreateSetlistShareInput): SetlistShare {
    const now = input.now ?? Date.now();
    this.prune(now);
    const file = this.load();
    const taken = new Set(file.shares.map((s) => s.id));
    const tracks = input.tracks
      .slice(0, MAX_TRACKS)
      .map(normaliseTrack)
      .filter((t): t is SetlistShareTrack => t !== null);
    const nowPlaying =
      typeof input.nowPlaying === 'number' && input.nowPlaying >= 0 && input.nowPlaying < tracks.length
        ? Math.floor(input.nowPlaying)
        : -1;
    const ttl = Math.max(60_000, input.ttlMs ?? this.defaultTtlMs);
    const share: SetlistShare = {
      id: this.newId(taken),
      guildId: clip(input.guildId, 64),
      guildName: clip(input.guildName, 120).trim(),
      name: clip(input.name, 120).trim() || 'Vaporzr setlist',
      createdAt: now,
      expiresAt: now + ttl,
      nowPlaying,
      tracks,
    };
    file.shares.push(share);
    // Oldest first, so trim from the front when over the ceiling.
    if (file.shares.length > MAX_SHARES) {
      file.shares = file.shares.slice(file.shares.length - MAX_SHARES);
    }
    this.persist(file);
    return share;
  }

  /** Resolve a share id, treating an expired share as not found and pruning it. */
  get(id: string, now = Date.now()): SetlistShare | null {
    const clean = clip(id, 64).trim();
    if (!clean) return null;
    const file = this.load();
    const share = file.shares.find((s) => s.id === clean);
    if (!share) return null;
    if (share.expiresAt <= now) {
      file.shares = file.shares.filter((s) => s.id !== clean);
      this.persist(file);
      return null;
    }
    return share;
  }

  /** Number of live shares (expired entries are dropped first). */
  count(now = Date.now()): number {
    this.prune(now);
    return this.load().shares.length;
  }

  clear(): void {
    this.cache = { shares: [] };
    this.persist(this.cache);
  }
}

export const setlistShares = new SetlistShareStore();
