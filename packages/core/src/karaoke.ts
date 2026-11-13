import type { KaraokeEntry, KaraokeLine, KaraokeState } from '@vaporzr/shared';

/**
 * Karaoke night: the sing queue, and the timing maths the stage screen uses.
 *
 * Two rules make or break a karaoke queue in practice:
 *
 * 1. **One song per singer at a time.** Without it the first enthusiastic person
 *    adds five and the room stops bothering.
 * 2. **Fair rotation, not FIFO.** Plain first-in-first-out lets whoever shouts
 *    first hog the night; the queue is ordered round-robin by singer, so a
 *    person who adds a second song goes to the back of *their* own line instead
 *    of in front of everyone else's first song.
 *
 * Nothing here touches audio, Discord or the filesystem — it is a list with an
 * ordering rule, so it can be tested and reused by the panel, the stage screen
 * and the bot alike.
 */

/** Longest queue we hold. Beyond this the wait stops being a promise. */
export const KARAOKE_MAX_ENTRIES = 40;

export interface AddKaraokeInput {
  singer: string;
  singerId: string;
  title: string;
  artist?: string;
  uri?: string;
  durationMs?: number;
  /** `Date.now()` by default; injectable so tests are deterministic. */
  addedAt?: number;
}

export interface AddKaraokeResult {
  ok: boolean;
  message: string;
  entry?: KaraokeEntry;
}

function tidy(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export class KaraokeQueue {
  private items: KaraokeEntry[] = [];
  private currentId: string | null = null;
  private seq = 0;

  /** Ordered snapshot: the rotation, with the current turn first. */
  list(): KaraokeEntry[] {
    return this.ordered().map((e) => ({ ...e }));
  }

  get size(): number {
    return this.items.length;
  }

  get empty(): boolean {
    return this.items.length === 0;
  }

  current(): KaraokeEntry | null {
    const hit = this.currentId ? this.items.find((e) => e.id === this.currentId) : undefined;
    return hit ? { ...hit } : null;
  }

  /**
   * Add a singer's song. Refuses a second queued song for the same person and
   * caps the line, but never refuses a *different* person's pick. The host can
   * override the one-per-singer rule when queueing on somebody's behalf.
   */
  add(input: AddKaraokeInput, opts: { allowDuplicate?: boolean } = {}): AddKaraokeResult {
    const singer = tidy(input.singer).slice(0, 40) || 'Someone';
    const title = tidy(input.title).slice(0, 120);
    if (!title) return { ok: false, message: 'Which song? Give me a title or a link.' };
    if (this.items.length >= KARAOKE_MAX_ENTRIES) {
      return { ok: false, message: `The sing queue is full (${KARAOKE_MAX_ENTRIES}). Try again after a few turns.` };
    }
    const mine = opts.allowDuplicate ? undefined : this.items.find((e) => e.singerId === input.singerId);
    if (mine) {
      return {
        ok: false,
        message: `${singer}, you're already in with **${mine.title}** — one song at a time keeps it fair.`,
      };
    }
    const entry: KaraokeEntry = {
      id: `k${Date.now().toString(36)}${(this.seq++).toString(36)}`,
      singer,
      singerId: input.singerId,
      title,
      artist: input.artist ? tidy(input.artist).slice(0, 80) : undefined,
      uri: input.uri,
      status: 'queued',
      durationMs: input.durationMs,
      deck: null,
      addedAt: input.addedAt ?? Date.now(),
    };
    this.items.push(entry);
    return { ok: true, message: `**${singer}** is in the queue with **${title}**.`, entry: { ...entry } };
  }

  /** Patch one entry (preparation progress, resolved uri, failures). */
  update(id: string, patch: Partial<Omit<KaraokeEntry, 'id' | 'singerId'>>): KaraokeEntry | null {
    const hit = this.items.find((e) => e.id === id);
    if (!hit) return null;
    Object.assign(hit, patch);
    return { ...hit };
  }

  remove(id: string): KaraokeEntry | null {
    const idx = this.items.findIndex((e) => e.id === id);
    if (idx < 0) return null;
    const [gone] = this.items.splice(idx, 1);
    if (this.currentId === gone.id) this.currentId = null;
    return gone;
  }

  /**
   * Take the next turn. Marks it current and returns it; the caller loads the
   * track and, on a skip, calls `release()` before `next()` so the same person
   * does not get stuck at the front.
   */
  next(): KaraokeEntry | null {
    const ordered = this.ordered();
    const pick = ordered[0] ?? null;
    this.currentId = pick ? pick.id : null;
    return pick ? { ...pick } : null;
  }

  /** Clear the current turn without dropping the entry (used on skip). */
  release(): void {
    this.currentId = null;
  }

  /** Drop everything, current turn included. */
  clear(): void {
    this.items = [];
    this.currentId = null;
  }

  /**
   * Rebuild the queue from a saved snapshot (a deploy mid-night).
   *
   * Nobody stays "on stage": the deck that was playing is gone, so the turn in
   * flight is put back in line and the first singer is picked up by `advance()`.
   */
  restore(state: KaraokeState): void {
    this.items = state.entries.map((e) => ({
      ...e,
      status: e.status === 'preparing' ? 'queued' : e.status,
      deck: null,
      attempts: e.attempts ?? 0,
    }));
    this.currentId = null;
    this.seq = this.items.length;
  }

  /** Move a singer's remaining song to the back of their own line. */
  requeue(id: string, at = Date.now()): void {
    const hit = this.items.find((e) => e.id === id);
    if (!hit) return;
    hit.addedAt = at;
    if (this.currentId === id) this.currentId = null;
  }

  state(extra: {
    open: boolean;
    instrumental: boolean;
    deck?: KaraokeEntry['deck'];
    transpose?: number;
  }): KaraokeState {
    return {
      open: extra.open,
      transpose: extra.transpose ?? 0,
      instrumental: extra.instrumental,
      current: this.current(),
      entries: this.list(),
      deck: extra.deck ?? this.current()?.deck ?? null,
    };
  }

  /**
   * Round-robin order: one turn per singer, in the order they first joined,
   * wrapping until every song is placed. The current turn stays first so the
   * screen and the bot agree on who is up.
   */
  private ordered(): KaraokeEntry[] {
    const bySinger = new Map<string, KaraokeEntry[]>();
    const order: string[] = [];
    for (const entry of this.items) {
      let line = bySinger.get(entry.singerId);
      if (!line) {
        line = [];
        bySinger.set(entry.singerId, line);
        order.push(entry.singerId);
      }
      line.push(entry);
    }
    for (const line of bySinger.values()) line.sort((a, b) => a.addedAt - b.addedAt);
    const out: KaraokeEntry[] = [];
    let placed = true;
    while (placed) {
      placed = false;
      for (const id of order) {
        const line = bySinger.get(id);
        const next = line?.shift();
        if (next) {
          out.push(next);
          placed = true;
        }
      }
    }
    const cur = this.currentId ? out.findIndex((e) => e.id === this.currentId) : -1;
    if (cur > 0) out.unshift(...out.splice(cur, 1));
    return out;
  }
}

/* --------------------------------------------------------------- timing -- */

/**
 * Index of the line that should be on screen at `ms`, or -1 before the first
 * line. Binary search: the screen calls this every animation frame.
 */
export function activeKaraokeLine(lines: KaraokeLine[], ms: number): number {
  if (lines.length === 0) return -1;
  if (ms < lines[0].timeMs) return -1;
  let lo = 0;
  let hi = lines.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lines[mid].timeMs <= ms) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * How far through a line we are, 0..1.
 *
 * `lines` holds line-level LRC timestamps only, so a line's own length is the
 * gap to the next one. That gap *is* the sung duration for most pop lyrics —
 * which is what lets the highlight wipe across the line instead of snapping on
 * at a single instant. Word timings, when present, override it.
 *
 * The wipe is capped: a gap of eight seconds is nearly always an instrumental
 * break, and a highlight that creeps through it looks like the lyrics are
 * broken rather than the song having a rest in it.
 */
export const KARAOKE_WIPE_MAX_MS = 6000;

export function karaokeLineProgress(lines: KaraokeLine[], index: number, ms: number): number {
  const line = lines[index];
  if (!line) return 0;
  const next = lines[index + 1];
  const gap = next ? next.timeMs - line.timeMs : 4000;
  const span = Math.max(1, Math.min(gap, KARAOKE_WIPE_MAX_MS));
  return Math.max(0, Math.min(1, (ms - line.timeMs) / span));
}

/** Index of the word being sung, or -1 when the line has no word timings. */
export function activeKaraokeWord(line: KaraokeLine | undefined, ms: number): number {
  const words = line?.words;
  if (!words || words.length === 0) return -1;
  let idx = -1;
  for (let i = 0; i < words.length; i++) {
    if (words[i].timeMs <= ms) idx = i;
    else break;
  }
  return idx;
}

/**
 * Word-level progress for the wipe: how far through the *word* we are, falling
 * back to `endMs` (or the next word's start) when a word has no end.
 */
export function karaokeWordProgress(line: KaraokeLine | undefined, wordIndex: number, ms: number): number {
  const words = line?.words;
  if (!words || wordIndex < 0) return 0;
  const word = words[wordIndex];
  const end = word.endMs ?? words[wordIndex + 1]?.timeMs ?? word.timeMs + 300;
  const span = Math.max(1, end - word.timeMs);
  return Math.max(0, Math.min(1, (ms - word.timeMs) / span));
}

/**
 * Split plain lyrics into lines for a screen with no timings at all. Used as a
 * last resort: the screen still shows words, just not in time.
 */
export function plainLyricLines(text: string, startMs = 0, perLineMs = 3200): KaraokeLine[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((text, i) => ({ timeMs: startMs + i * perLineMs, text }));
}
