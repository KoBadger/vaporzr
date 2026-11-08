import fs from 'node:fs';
import path from 'node:path';
import type { MediaSource, TrackInfo } from '@vaporzr/shared';
import { config } from '@vaporzr/core/config';
import { writeJsonAtomicSync } from './jsonFile.js';
import { orderByVibe, type ShuffleMode } from './smartShuffle.js';
import type { AudioFeatures } from './spotify.js';

/**
 * Session tape: a running record of what a room actually heard, kept with
 * enough detail that it can be turned into a real playlist afterwards.
 *
 * The queue is not that record. It is the *plan*: tracks get inserted, skipped,
 * cleared and reordered, and the same song can pass through twice. The tape is
 * the *transcript* — append-only, timestamped, one entry per audible start, so
 * "what was that night" survives every queue edit.
 *
 * `heard: 'player'` entries come from our own playback (free, exact metadata).
 * `heard: 'ears'` entries were identified from audio somebody else put into the
 * voice channel, so they carry a confidence and deserve a second look before
 * anyone trusts them.
 */

/** Where a tape entry came from: our own playback, or the voice-channel ears. */
export type TapeHeard = 'player' | 'ears';

export interface TapeEntry {
  uri: string;
  name: string;
  artists: string[];
  album: string;
  durationMs: number;
  image?: string;
  source: MediaSource;
  /** Username who queued it, or 'ears' when nobody did. */
  addedBy: string;
  playedAt: number;
  heard: TapeHeard;
  /** 0..1 — only present for `heard: 'ears'` (recogniser confidence). */
  confidence?: number;
}

export interface Tape {
  id: string;
  name: string;
  guildId: string;
  startedBy: string;
  startedAt: number;
  /** Set when the tape is sealed; an open tape keeps rolling. */
  endedAt?: number;
  entries: TapeEntry[];
}

/** Most recent tapes kept per guild; older ones are dropped. */
const MAX_TAPES = 10;
/** A tape stops accepting entries past this, so one runaway session cannot grow without bound. */
const MAX_ENTRIES = 300;
/** A tape left rolling overnight seals itself rather than spanning weeks. */
const MAX_TAPE_MS = 12 * 60 * 60 * 1000;

interface TapeFile {
  active: Tape | null;
  tapes: Tape[];
}

/** Stable song identity — same words stats.ts counts by, minus the play count. */
export function tapeKey(track: { name: string; artists: string[] }): string {
  const title = (track.name ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  const artist = (track.artists?.[0] ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  return `${title} | ${artist}`.replace(/\s*\|\s*$/, '');
}

/**
 * Build a tape entry from a queue track. `now` is injectable so the recorder can
 * be tested without sleeping, and so a caller replaying history can date
 * entries properly.
 */
export function entryFromTrack(
  track: TrackInfo,
  opts: { heard?: TapeHeard; addedBy?: string; now?: number; confidence?: number } = {},
): TapeEntry {
  const heard = opts.heard ?? 'player';
  // An ears entry has no queue attribution worth keeping — nobody queued it —
  // so it is stamped 'ears' even when a placeholder track object carries a name.
  const addedBy = opts.addedBy ?? (heard === 'ears' ? 'ears' : (track.addedBy ?? 'unknown'));
  const entry: TapeEntry = {
    uri: track.uri,
    name: track.name,
    artists: [...(track.artists ?? [])],
    album: track.album ?? '',
    durationMs: track.durationMs ?? 0,
    source: track.source ?? 'spotify',
    addedBy,
    playedAt: opts.now ?? Date.now(),
    heard,
  };
  if (typeof opts.confidence === 'number') entry.confidence = Math.max(0, Math.min(1, opts.confidence));
  return entry;
}

export interface SetlistItem {
  entry: TapeEntry;
  /** How many times this song passed through the tape. */
  plays: number;
}

/**
 * Collapse a tape into a setlist: one row per song, in first-play order.
 *
 * Repeats matter (a song dropped twice was clearly the room's favourite) so the
 * count is kept rather than discarded — it is what makes the saved playlist's
 * description worth reading. First occurrence wins for metadata: the earliest
 * copy is the one with the best chance of having been the intended pick.
 */
export function toSetlist(entries: TapeEntry[]): SetlistItem[] {
  const order: string[] = [];
  const byKey = new Map<string, SetlistItem>();
  for (const entry of entries) {
    const key = tapeKey(entry);
    const hit = byKey.get(key);
    if (hit) {
      hit.plays++;
      continue;
    }
    byKey.set(key, { entry, plays: 1 });
    order.push(key);
  }
  return order.map((key) => byKey.get(key) as SetlistItem);
}

export interface TapeSummary {
  total: number;
  unique: number;
  artists: string[];
  players: number;
  ears: number;
  /** Wall-clock span from first to last entry (0 when there is only one). */
  elapsedMs: number;
}

export function summarizeTape(tape: Tape): TapeSummary {
  const setlist = toSetlist(tape.entries);
  const artists = new Set<string>();
  for (const item of tape.entries) {
    for (const a of item.artists) {
      const k = a.trim();
      if (k) artists.add(k);
    }
  }
  const first = tape.entries[0]?.playedAt ?? 0;
  const last = tape.entries[tape.entries.length - 1]?.playedAt ?? 0;
  return {
    total: tape.entries.length,
    unique: setlist.length,
    artists: [...artists],
    players: tape.entries.filter((e) => e.heard === 'player').length,
    ears: tape.entries.filter((e) => e.heard === 'ears').length,
    elapsedMs: last > first ? last - first : 0,
  };
}

export type TapeOrderMode = 'time' | ShuffleMode;

/**
 * Order a setlist for listening. `time` keeps the truth (the room's actual
 * order); every other mode re-sequences the same songs so the saved playlist
 * plays like a set rather than a log. Ordering is delegated to smart shuffle's
 * pure ranking, which leaves songs without features exactly where they were.
 */
export function orderSetlist(
  entries: TapeEntry[],
  mode: TapeOrderMode,
  featuresOf: (entry: TapeEntry) => Partial<AudioFeatures> | undefined,
): TapeEntry[] {
  if (mode === 'time' || entries.length < 2) return entries;
  const anchor = featuresOf(entries[0]) ?? null;
  const featOf = (e: TapeEntry): Partial<AudioFeatures> | null => featuresOf(e) ?? null;
  return orderByVibe(entries, anchor, mode, featOf, (e) => e.artists[0] ?? '').ordered;
}

function dateStamp(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

/** Per-guild session tapes, persisted to data/tapes/<guildId>.json. */
export class TapeStore {
  private cache = new Map<string, TapeFile>();
  private timers = new Map<string, NodeJS.Timeout>();

  /**
   * `dir` is injectable so tests can drive a throwaway directory instead of the
   * live bot data. Production always uses the default.
   */
  constructor(private readonly dir: string = path.join(config.dataDir, 'tapes')) {}

  private fileFor(guildId: string): string {
    return path.join(this.dir, `${guildId}.json`);
  }

  private load(guildId: string): TapeFile {
    const cached = this.cache.get(guildId);
    if (cached) return cached;
    let data: TapeFile = { active: null, tapes: [] };
    try {
      const raw = JSON.parse(fs.readFileSync(this.fileFor(guildId), 'utf8')) as Partial<TapeFile>;
      // A crash mid-write can leave the file truncated or hand-edited; only
      // trust the shape we recognise rather than letting bad JSON through.
      if (raw && Array.isArray(raw.tapes)) {
        data = {
          active: raw.active && Array.isArray(raw.active.entries) ? raw.active : null,
          tapes: raw.tapes.filter((t) => t && Array.isArray(t.entries)),
        };
      }
    } catch {
      /* first run */
    }
    this.cache.set(guildId, data);
    return data;
  }

  private persist(guildId: string): void {
    const pending = this.timers.get(guildId);
    if (pending) {
      clearTimeout(pending);
      this.timers.delete(guildId);
    }
    try {
      writeJsonAtomicSync(this.fileFor(guildId), this.load(guildId));
    } catch (err) {
      console.warn('[tape] save failed:', err instanceof Error ? err.message : err);
    }
  }

  /**
   * Track starts arrive every few minutes but each one rewrites the whole file,
   * so a long tape would be quadratic in disk work. Batch the writes: the
   * in-memory copy is authoritative and a lost 2 s of tape on a hard kill is
   * worth far less than a synchronous write on the playback hot path.
   */
  private schedulePersist(guildId: string): void {
    if (this.timers.has(guildId)) return;
    const t = setTimeout(() => {
      this.timers.delete(guildId);
      this.persist(guildId);
    }, 2000);
    t.unref?.();
    this.timers.set(guildId, t);
  }

  /** Write any debounced tape state now (called on shutdown). */
  flush(guildId: string): void {
    if (this.timers.has(guildId)) this.persist(guildId);
  }

  flushAll(): void {
    for (const guildId of [...this.timers.keys()]) this.persist(guildId);
  }

  /** The tape currently rolling in this guild, if any. */
  active(guildId: string): Tape | null {
    return this.load(guildId).active;
  }

  isRolling(guildId: string): boolean {
    return this.load(guildId).active !== null;
  }

  /** Start rolling. One tape at a time: two would halve the record. */
  start(
    guildId: string,
    opts: { name?: string; startedBy: string; now?: number },
  ): { ok: true; tape: Tape } | { ok: false; error: string } {
    const data = this.load(guildId);
    const now = opts.now ?? Date.now();
    const existing = data.active;
    if (existing) {
      if (now - existing.startedAt < MAX_TAPE_MS) {
        return { ok: false, error: `A tape is already rolling (**${existing.name}**). Use /tape stop first.` };
      }
      // Something died mid-tape (redeploy, crash). Seal it rather than losing it.
      this.seal(data, existing, now);
    }
    const startedAt = now;
    const stamp = dateStamp(new Date(startedAt));
    const taken = new Set([...data.tapes.map((t) => t.id), stamp]);
    let id = stamp;
    for (let n = 2; taken.has(id); n++) id = `${stamp}-${n}`;
    const tape: Tape = {
      id,
      name: (opts.name ?? `Tape ${stamp}`).trim().slice(0, 60) || `Tape ${stamp}`,
      guildId,
      startedBy: opts.startedBy,
      startedAt,
      entries: [],
    };
    data.active = tape;
    this.persist(guildId);
    return { ok: true, tape };
  }

  private seal(data: TapeFile, tape: Tape, now: number): void {
    tape.endedAt = tape.endedAt ?? now;
    data.active = null;
    if (tape.entries.length === 0) return; // an empty tape is not worth listing
    data.tapes.unshift(tape);
    if (data.tapes.length > MAX_TAPES) data.tapes.length = MAX_TAPES;
  }

  /**
   * Append a track start. Returns false when nothing was recorded — no tape
   * rolling, a repeat of the track already at the head, or a full/expired tape.
   *
   * The head check is what makes this safe to call on every playback state
   * change: pause/resume and metadata refreshes re-announce the same track, and
   * a transcript that logs those as plays is worthless.
   */
  note(guildId: string, entry: TapeEntry): boolean {
    const data = this.load(guildId);
    const tape = data.active;
    if (!tape) return false;
    if (Date.now() - tape.startedAt > MAX_TAPE_MS || tape.entries.length >= MAX_ENTRIES) {
      this.seal(data, tape, Date.now());
      this.persist(guildId);
      return false;
    }
    const head = tape.entries[tape.entries.length - 1];
    if (head && head.uri === entry.uri) return false;
    tape.entries.push(entry);
    this.schedulePersist(guildId);
    return true;
  }

  /** Convenience wrapper: record a queue track as heard from our own player. */
  noteTrack(guildId: string, track: TrackInfo, opts: { now?: number; addedBy?: string } = {}): boolean {
    return this.note(guildId, entryFromTrack(track, { heard: 'player', ...opts }));
  }

  /**
   * Record ears recognition. Songs already on the tape are ignored — the room
   * hearing the same chorus twice is one song, and a wrong match must not be
   * able to flood the record.
   */
  noteHeard(guildId: string, entry: TapeEntry): boolean {
    const tape = this.load(guildId).active;
    if (!tape) return false;
    const key = tapeKey(entry);
    if (tape.entries.some((e) => tapeKey(e) === key)) return false;
    return this.note(guildId, entry);
  }

  /** Seal the rolling tape and return it. */
  stop(guildId: string, now?: number): Tape | null {
    const data = this.load(guildId);
    const tape = data.active;
    if (!tape) return null;
    this.seal(data, tape, now ?? Date.now());
    this.persist(guildId);
    return tape.entries.length > 0 ? tape : null;
  }

  /** Rolling tape if there is one, else the most recent finished one. */
  latest(guildId: string): Tape | null {
    const data = this.load(guildId);
    return data.active ?? data.tapes[0] ?? null;
  }

  /** Finished tapes, newest first. */
  list(guildId: string): Tape[] {
    return [...this.load(guildId).tapes];
  }

  get(guildId: string, id: string): Tape | null {
    const data = this.load(guildId);
    if (data.active?.id === id) return data.active;
    return data.tapes.find((t) => t.id === id) ?? null;
  }

  remove(guildId: string, id: string): boolean {
    const data = this.load(guildId);
    const idx = data.tapes.findIndex((t) => t.id === id);
    if (idx < 0) return false;
    data.tapes.splice(idx, 1);
    this.persist(guildId);
    return true;
  }
}

/** Process-wide tape store shared by the Discord commands, the panel and the ears. */
export const tapes = new TapeStore();
