import { emptyState, type PlaybackState, type TrackInfo } from '@vaporzr/shared';

export interface QueueListener {
  onQueueChanged(): void;
  onStateChanged(state: PlaybackState): void;
}

/** Normalised "title|artist" key for duplicate detection. Strips the upload
 *  boilerplate that differs between sources ("Official Audio", "(Lyrics)", …)
 *  so the same song from a different upload collides on the same key. */
export function trackKey(t: { name?: string; artists?: string[] }): string {
  const norm = (x: string): string => x.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const name = norm(t.name ?? '')
    .replace(/\b(official|audio|lyric|lyrics|video|visuali[sz]er|hd|hq|remaster|remastered|mv)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!name) return '';
  const artist = norm((t.artists ?? [])[0] ?? '')
    .replace(/\btopic\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return `${name}|${artist}`;
}

export class QueueManager {
  private tracks: TrackInfo[] = [];
  private currentIndex = -1;
  private state: PlaybackState = emptyState();
  /** Cumulative number of tracks queued over this queue's lifetime. */
  totalEnqueued = 0;
  /**
   * True once playback has run the queue to its end. This is what distinguishes
   * a queue that genuinely FINISHED from one that merely built up while idle —
   * the two look identical by position alone (cursor on the last track, not
   * playing), and conflating them made an idle add insert at the FRONT.
   * Set by markPlayedThrough() from playback when an advance runs off the end;
   * cleared whenever a new track is added or the cursor moves back.
   */
  private playedThrough = false;

  constructor(private listeners: QueueListener[] = []) {}

  subscribe(listener: QueueListener): void {
    this.listeners.push(listener);
  }

  unsubscribe(listener: QueueListener): void {
    this.listeners = this.listeners.filter((l) => l !== listener);
  }

  getSnapshot() {
    return {
      tracks: this.tracks.map((t, i) => ({ ...t, current: i === this.currentIndex, index: i })),
      currentIndex: this.currentIndex,
      state: { ...this.state },
    };
  }

  getState(): PlaybackState {
    return { ...this.state };
  }

  /** Snapshot the queue for persistence. */
  serialize(): { tracks: TrackInfo[]; currentIndex: number; state: PlaybackState; playedThrough: boolean } {
    return {
      tracks: this.tracks.map((t) => ({ ...t })),
      currentIndex: this.currentIndex,
      state: { ...this.state },
      playedThrough: this.playedThrough,
    };
  }

  /** Restore a persisted queue. Never auto-resumes — playback starts paused. */
  restore(data: {
    tracks: TrackInfo[];
    currentIndex: number;
    state: PlaybackState;
    playedThrough?: boolean;
  }): void {
    if (!Array.isArray(data.tracks) || data.tracks.length === 0) return;
    this.tracks = data.tracks.map((t) => ({ ...t }));
    // A missing cursor defaults to the first track (a restored queue should have
    // a current track); an explicit -1 is kept so a finished queue stays finished.
    this.currentIndex = data.currentIndex == null
      ? 0
      : Math.min(Math.max(data.currentIndex, -1), this.tracks.length - 1);
    // Carry the finished marker across a restart so a queue that ran out before
    // the bot stopped does not silently look "not started" afterwards.
    this.playedThrough = data.playedThrough === true;
    const current = this.getCurrentTrack();
    this.state = {
      ...this.state,
      ...(data.state ?? {}),
      track: current,
      playing: false,
      positionMs: data.state?.positionMs ?? 0,
      durationMs: current?.durationMs ?? 0,
    };
    this.emitQueue();
    this.emitState();
  }

  getCurrentTrack(): TrackInfo | undefined {
    if (this.currentIndex < 0 || this.currentIndex >= this.tracks.length) return undefined;
    return this.tracks[this.currentIndex];
  }

  /** Called by playback when an advance runs off the end of the queue — the one
   *  unambiguous signal that the queue genuinely finished. */
  markPlayedThrough(): void {
    if (this.tracks.length === 0) return;
    // Only record the finish. The cursor deliberately stays on the last track:
    // the panel highlights via state.track, `play()` replays from the cursor,
    // and the many `upcoming = slice(currentIndex + 1)` consumers must keep
    // seeing an empty upcoming list. Placement of the NEXT add is decided by
    // resetCursorIfFinished() at enqueue time, not by where the cursor sits now.
    this.playedThrough = true;
  }

  /** True when playback has run the queue to its end and nothing has been added
   *  since. Distinct from "idle on the last track", which is not a finish. */
  isPlayedThrough(): boolean {
    return this.playedThrough;
  }

  /** Clear the finished marker — called when a new track is queued or the cursor
   *  is moved back to something playable. */
  private clearPlayedThrough(): void {
    this.playedThrough = false;
  }

  /** If the queue genuinely finished (playback ran off the end, nothing playing),
   *  park the cursor so newly added tracks play instead of replaying the last
   *  one. Position alone is NOT sufficient: an idle queue that merely built up to
   *  the last track looks identical, and treating it as finished inserted the
   *  next add at the FRONT. */
  private resetCursorIfFinished(): void {
    if (this.playedThrough && !this.state.playing) {
      this.currentIndex = -1;
    }
  }

  /** Point the cursor at a newly added track so playback starts there. Only
   *  meaningful on a cold start or after a genuine finish (both leave the cursor
   *  at -1); it must not run on ordinary idle adds, which would walk the cursor
   *  forward onto the newest tail track. */
  private advanceToAdded(addedIndex: number, countAfter: number): void {
    if (!this.state.playing && this.currentIndex >= 0 && this.currentIndex < countAfter) {
      this.currentIndex = addedIndex;
    }
  }

  enqueue(
    track: Omit<TrackInfo, 'addedBy' | 'addedAt'>,
    requestedBy: string,
    opts?: { keepCursor?: boolean; background?: boolean; next?: boolean },
  ): { added: boolean; currentIndex: number } {
    const item = { ...track, addedBy: requestedBy, addedAt: Date.now() };
    const wasEmpty = this.tracks.length === 0;
    // Capture the finished state BEFORE resetCursorIfFinished parks the cursor:
    // a finished queue behaves like a cold start for cursor placement.
    const wasFinished = this.playedThrough;
    this.resetCursorIfFinished();
    // Adding a track makes the queue playable again.
    this.clearPlayedThrough();
    let newIndex: number;
    // Where a new track lands depends on WHO added it.
    //
    // A user asked for this track, so with shuffle off it goes to the tail
    // (yielding to what is already queued) and with shuffle ON it is inserted
    // among the upcoming tracks — Spotify-style, so a shuffled queue stays
    // shuffled rather than queuing everything in request order.
    //
    // A BACKGROUND filler (Endless Wave top-up) always appends to the tail. It
    // must never be scattered in among tracks a listener chose, and never ahead
    // of them: the wave tops up repeatedly while shuffle is on, so scattering
    // each refill is what made a shuffled queue look jumbled.
    const isBackground = opts?.background === true || requestedBy === 'endless-wave';
    if (this.state.shuffle && this.tracks.length > 0 && !isBackground) {
      // Insert among the upcoming tracks, inclusive of the very next slot.
      // `next` keeps it exactly next (deterministic).
      const start = this.currentIndex === -1 ? 0 : this.currentIndex + 1;
      const end = this.tracks.length;
      newIndex = opts?.next ? start : start + Math.floor(Math.random() * (end - start + 1));
      this.tracks.splice(Math.min(newIndex, end), 0, item);
    } else {
      newIndex = this.tracks.length;
      this.tracks.push(item);
    }
    if (this.currentIndex === -1) this.currentIndex = 0;
    // Background refills (Endless Wave top-up) must NOT touch the cursor at all:
    // while idle that pins it at the tail, the next refill sees an empty
    // upcoming window, re-picks the same song forever, and skips hit "queue
    // ended". A user add moves the cursor only on a cold start or after a
    // genuine finish — NOT on every idle add, which walked it forward to the
    // newest tail track and made the queue look finished when it never played.
    if (opts?.next === true) {
      this.advanceToAdded(newIndex, this.tracks.length);
    } else if (!opts?.keepCursor && !isBackground && (wasEmpty || wasFinished)) {
      this.advanceToAdded(newIndex, this.tracks.length);
    }
    this.totalEnqueued++;
    this.emitQueue();
    return { added: true, currentIndex: this.currentIndex };
  }

  enqueueMany(tracks: Omit<TrackInfo, 'addedBy' | 'addedAt'>[], requestedBy: string): number {
    if (tracks.length === 0) return -1;
    const wasEmpty = this.tracks.length === 0;
    const wasFinished = this.playedThrough;
    this.resetCursorIfFinished();
    // Adding tracks makes the queue playable again.
    this.clearPlayedThrough();
    const addedIndex = this.tracks.length;
    const isBackground = requestedBy === 'endless-wave';
    if (this.state.shuffle && this.tracks.length > 0 && !isBackground) {
      // A user handed us a LIST. Scattering each item at its own random spot
      // would shuffle the list against itself and destroy the order the user
      // chose (an album plays out of sequence). Instead pick ONE insertion
      // point and keep the batch intact there, so the list arrives in order.
      const start = this.currentIndex === -1 ? 0 : this.currentIndex + 1;
      const end = this.tracks.length;
      const at = start + Math.floor(Math.random() * (end - start + 1));
      const items = tracks.map((t) => ({ ...t, addedBy: requestedBy, addedAt: Date.now() }));
      this.tracks.splice(Math.min(at, end), 0, ...items);
      if (this.currentIndex === -1) this.currentIndex = 0;
      this.totalEnqueued += items.length;
      this.emitQueue();
    } else {
      for (const t of tracks) this.tracks.push({ ...t, addedBy: requestedBy, addedAt: Date.now() });
      if (this.currentIndex === -1) this.currentIndex = 0;
      // Only establish the cursor on a cold start or after a genuine finish —
      // an ordinary idle add must not walk it forward (see advanceToAdded).
      if ((wasEmpty || wasFinished) && !isBackground) {
        this.advanceToAdded(addedIndex, this.tracks.length);
      }
      this.totalEnqueued += tracks.length;
      this.emitQueue();
    }
    return addedIndex;
  }

  /** Insert tracks right after the currently-playing track (or at the front if nothing is playing). */
  insertAfterCurrent(tracks: Omit<TrackInfo, 'addedBy' | 'addedAt'>[], requestedBy: string): void {
    const insertAt = this.currentIndex === -1 ? 0 : this.currentIndex + 1;
    const items = tracks.map((t) => ({ ...t, addedBy: requestedBy, addedAt: Date.now() }));
    this.tracks.splice(insertAt, 0, ...items);
    if (this.currentIndex === -1) this.currentIndex = 0;
    // If nothing is playing, jump to the inserted tracks so the user hears what
    // they just added, not an old stale/restored track.
    if (!this.state.playing && this.currentIndex >= 0) this.currentIndex = insertAt;
    this.totalEnqueued += items.length;
    this.emitQueue();
  }

  /** Insert a user batch as a priority block: after the current track (and any
   *  already-queued user tracks) but ahead of the first Endless Wave filler
   *  track, so an explicit list is never queued behind or interleaved with
   *  auto-play picks. With no wave tracks ahead it behaves like play-next. */
  insertUserBatch(tracks: Omit<TrackInfo, 'addedBy' | 'addedAt'>[], requestedBy: string): void {
    if (tracks.length === 0) return;
    const afterCurrent = this.currentIndex === -1 ? this.tracks.length : this.currentIndex + 1;
    let at = afterCurrent;
    for (let i = afterCurrent; i < this.tracks.length; i++) {
      if ((this.tracks[i].addedBy ?? '') === 'endless-wave') {
        at = i;
        break;
      }
      at = i + 1;
    }
    const items = tracks.map((t) => ({ ...t, addedBy: requestedBy, addedAt: Date.now() }));
    this.tracks.splice(at, 0, ...items);
    if (this.currentIndex === -1) this.currentIndex = 0;
    if (!this.state.playing && this.currentIndex >= 0) this.currentIndex = at;
    this.totalEnqueued += items.length;
    this.emitQueue();
  }

  /** Replace the upcoming slice with the same tracks in a new order (matched by
   *  uri; anything unlisted keeps its old position). Returns how many moved. */
  reorderUpcoming(orderedUris: string[]): number {
    const from = this.currentIndex + 1;
    if (from <= 0 || from >= this.tracks.length) return 0;
    const upcoming = this.tracks.slice(from);
    const next: TrackInfo[] = [];
    const used = new Set<TrackInfo>();
    for (const uri of orderedUris) {
      const t = upcoming.find((x) => x.uri === uri && !used.has(x));
      if (t) {
        next.push(t);
        used.add(t);
      }
    }
    for (const t of upcoming) if (!used.has(t)) next.push(t);
    if (next.length !== upcoming.length) return 0;
    let moved = 0;
    for (let i = 0; i < next.length; i++) if (next[i] !== upcoming[i]) moved++;
    if (moved > 0) {
      this.tracks.splice(from, upcoming.length, ...next);
      this.emitQueue();
    }
    return moved;
  }

  /** Shuffle the upcoming tracks (everything after the current one). */
  shuffleUpcoming(): void {
    if (this.currentIndex < 0) return;
    const start = this.currentIndex + 1;
    const upcoming = this.tracks.slice(start);
    for (let i = upcoming.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [upcoming[i], upcoming[j]] = [upcoming[j], upcoming[i]];
    }
    this.tracks.splice(start, upcoming.length, ...upcoming);
    this.emitQueue();
  }

  /** Remove duplicate *upcoming* tracks, keeping the first occurrence. Matches
   *  on exact uri OR the same normalised "title|artist" — so the same song from a
   *  different upload is caught too. Played tracks and the current track are left
   *  alone. Returns the count removed. */
  dedupe(): number {
    const seen = new Set<string>();
    const keep: TrackInfo[] = [];
    let removed = 0;
    this.tracks.forEach((t, i) => {
      const keys = [t.uri ? `u:${t.uri}` : '', trackKey(t) ? `k:${trackKey(t)}` : ''].filter(Boolean);
      if (i <= this.currentIndex) {
        keep.push(t);
        for (const k of keys) seen.add(k);
        return;
      }
      if (keys.some((k) => seen.has(k))) {
        removed++;
        return;
      }
      for (const k of keys) seen.add(k);
      keep.push(t);
    });
    if (removed > 0) {
      this.tracks = keep;
      this.emitQueue();
    }
    return removed;
  }

  /** The subset of `list` whose uri and title|artist are NOT already waiting in
   *  the current + upcoming queue. Collapses duplicates inside `list` too, so a
   *  paste of the same song twice only queues it once. Already-played tracks are
   *  ignored, so re-queueing a song you liked still works. */
  filterNew<T extends { uri?: string; name: string; artists?: string[] }>(list: T[]): T[] {
    const seen = new Set<string>();
    for (let i = Math.max(0, this.currentIndex); i < this.tracks.length; i++) {
      const t = this.tracks[i];
      if (t.uri) seen.add(`u:${t.uri}`);
      const k = trackKey(t);
      if (k) seen.add(`k:${k}`);
    }
    const out: T[] = [];
    for (const t of list) {
      const keys = [t.uri ? `u:${t.uri}` : '', trackKey(t) ? `k:${trackKey(t)}` : ''].filter(Boolean);
      if (keys.some((k) => seen.has(k))) continue;
      for (const k of keys) seen.add(k);
      out.push(t);
    }
    return out;
  }

  /** Skip-forward: drop every upcoming track before `index` so the chosen one
   *  plays next. Returns how many were removed. */
  removeUpTo(index: number): number {
    if (index <= this.currentIndex + 1 || index >= this.tracks.length) return 0;
    const from = this.currentIndex + 1;
    const removed = index - from;
    this.tracks.splice(from, removed);
    this.emitQueue();
    return removed;
  }

  remove(index: number): TrackInfo | undefined {
    if (index < 0 || index >= this.tracks.length) return undefined;
    const [removed] = this.tracks.splice(index, 1);
    const removedCurrent = index === this.currentIndex;
    if (index < this.currentIndex) this.currentIndex -= 1;
    else if (removedCurrent && this.currentIndex >= this.tracks.length) {
      // the currently-playing track was removed; keep index pointing at the next track
      this.currentIndex = this.tracks.length - 1;
    }
    this.emitQueue();
    if (removedCurrent) {
      // The cursor moved (or the queue emptied): re-sync the now-playing state
      // so it never points at a track that is no longer in the queue.
      const current = this.getCurrentTrack();
      this.state = {
        ...this.state,
        track: current,
        positionMs: 0,
        durationMs: current?.durationMs ?? 0,
        playing: current ? this.state.playing : false,
        updatedAt: Date.now(),
      };
      this.emitState();
    }
    return removed;
  }

  /** Move a track from one position to another (panel reordering). */
  move(from: number, to: number): boolean {
    if (
      from < 0 || from >= this.tracks.length ||
      to < 0 || to >= this.tracks.length || from === to
    ) return false;
    const [item] = this.tracks.splice(from, 1);
    this.tracks.splice(to, 0, item);
    // Keep the playing cursor glued to its track.
    if (from === this.currentIndex) this.currentIndex = to;
    else if (from < this.currentIndex && to >= this.currentIndex) this.currentIndex -= 1;
    else if (from > this.currentIndex && to <= this.currentIndex) this.currentIndex += 1;
    this.emitQueue();
    return true;
  }

  clear(): void {
    this.tracks = [];
    this.currentIndex = -1;
    this.clearPlayedThrough();
    this.state = {
      ...this.state,
      track: undefined,
      playing: false,
      positionMs: 0,
      durationMs: 0,
      updatedAt: Date.now(),
    };
    this.emitQueue();
    this.emitState();
  }

  next(): boolean {
    if (this.tracks.length === 0) return false;
    if (this.currentIndex < this.tracks.length - 1) {
      this.currentIndex += 1;
      this.emitQueue();
      return true;
    }
    return false;
  }

  previous(): boolean {
    if (this.currentIndex > 0) {
      this.currentIndex -= 1;
      // Stepping back to a playable track un-finishes the queue.
      this.clearPlayedThrough();
      this.emitQueue();
      return true;
    }
    return false;
  }

  /**
   * Point the cursor at the track with this uri. Used to restore the invariant
   * that, while audio is playing, the cursor must point at the PLAYING track:
   * the playback layer resolves "the current track" through this cursor, so a
   * cursor that has drifted ahead (e.g. a "move cursor then play" that never
   * actually started) silently disables every advance path. Returns true when
   * it actually moved.
   */
  focusUri(uri: string): boolean {
    const idx = this.tracks.findIndex((t) => t.uri === uri);
    if (idx < 0 || idx === this.currentIndex) return false;
    this.currentIndex = idx;
    this.emitQueue();
    return true;
  }

  /** Swap two positions (used by the interactive queue editor). */
  swap(a: number, b: number): boolean {
    if (a === b) return false;
    if (a < 0 || b < 0 || a >= this.tracks.length || b >= this.tracks.length) return false;
    [this.tracks[a], this.tracks[b]] = [this.tracks[b], this.tracks[a]];
    if (this.currentIndex === a) this.currentIndex = b;
    else if (this.currentIndex === b) this.currentIndex = a;
    this.emitQueue();
    return true;
  }

  setState(patch: Partial<PlaybackState>): PlaybackState {
    this.state = { ...this.state, ...patch, updatedAt: Date.now() };
    this.emitState();
    return this.state;
  }

  private emitQueue(): void {
    for (const l of this.listeners) l.onQueueChanged();
  }

  private emitState(): void {
    for (const l of this.listeners) l.onStateChanged(this.state);
  }
}
