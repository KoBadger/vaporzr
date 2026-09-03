import { emptyState, type PlaybackState, type TrackInfo } from '@vaporzr/shared';

export interface QueueListener {
  onQueueChanged(): void;
  onStateChanged(state: PlaybackState): void;
}

export class QueueManager {
  private tracks: TrackInfo[] = [];
  private currentIndex = -1;
  private state: PlaybackState = emptyState();
  /** Cumulative number of tracks queued over this queue's lifetime. */
  totalEnqueued = 0;

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
  serialize(): { tracks: TrackInfo[]; currentIndex: number; state: PlaybackState } {
    return {
      tracks: this.tracks.map((t) => ({ ...t })),
      currentIndex: this.currentIndex,
      state: { ...this.state },
    };
  }

  /** Restore a persisted queue. Never auto-resumes — playback starts paused. */
  restore(data: { tracks: TrackInfo[]; currentIndex: number; state: PlaybackState }): void {
    if (!Array.isArray(data.tracks) || data.tracks.length === 0) return;
    this.tracks = data.tracks.map((t) => ({ ...t }));
    this.currentIndex = Math.min(Math.max(data.currentIndex ?? -1, -1), this.tracks.length - 1);
    const current = this.getCurrentTrack();
    this.state = {
      ...this.state,
      ...(data.state ?? {}),
      track: current,
      playing: false,
      positionMs: data.state?.positionMs ?? 0,
      durationMs: current?.durationMs ?? data.state?.durationMs ?? 0,
    };
    this.emitQueue();
    this.emitState();
  }

  getCurrentTrack(): TrackInfo | undefined {
    if (this.currentIndex < 0 || this.currentIndex >= this.tracks.length) return undefined;
    return this.tracks[this.currentIndex];
  }

  /** If the queue finished (cursor on the last track, nothing playing), move the
   *  cursor so newly added tracks play instead of replaying the last one. */
  private resetCursorIfFinished(): void {
    if (!this.state.playing && this.currentIndex >= 0 && this.currentIndex === this.tracks.length - 1) {
      this.currentIndex = -1;
    }
  }

  /** When nothing is playing (idle / restored-paused / stale cursor), jump to a
   *  freshly added track so it plays immediately instead of an old queued one. */
  private advanceToAdded(addedIndex: number, countAfter: number): void {
    if (!this.state.playing && this.currentIndex >= 0 && this.currentIndex < countAfter) {
      this.currentIndex = addedIndex;
    }
  }

  enqueue(
    track: Omit<TrackInfo, 'addedBy' | 'addedAt'>,
    requestedBy: string,
    opts?: { keepCursor?: boolean },
  ): { added: boolean; currentIndex: number } {
    const item = { ...track, addedBy: requestedBy, addedAt: Date.now() };
    this.resetCursorIfFinished();
    let newIndex: number;
    if (this.state.shuffle && this.tracks.length > 0) {
      // Spotify-style: drop it at a random spot among the upcoming tracks.
      const start = this.currentIndex === -1 ? 0 : this.currentIndex + 1;
      const end = this.tracks.length;
      newIndex = start + Math.floor(Math.random() * (end - start + 1));
      this.tracks.splice(Math.min(newIndex, end), 0, item);
    } else {
      newIndex = this.tracks.length;
      this.tracks.push(item);
    }
    if (this.currentIndex === -1) this.currentIndex = 0;
    // Background refills (Endless Wave top-up) must NOT yank the cursor to the
    // new tail: while idle that pins the cursor at the end, so the next refill
    // pass sees an empty upcoming list, re-picks the same song forever, and
    // skip lands on "queue ended". User-initiated adds keep the jump-to-fresh.
    if (!opts?.keepCursor) this.advanceToAdded(newIndex, this.tracks.length);
    this.totalEnqueued++;
    this.emitQueue();
    return { added: true, currentIndex: this.currentIndex };
  }

  enqueueMany(tracks: Omit<TrackInfo, 'addedBy' | 'addedAt'>[], requestedBy: string): number {
    const wasEmpty = this.tracks.length === 0;
    this.resetCursorIfFinished();
    if (this.state.shuffle && this.tracks.length > 0) {
      for (const t of tracks) this.enqueue(t, requestedBy);
    } else {
      const addedIndex = this.tracks.length;
      for (const t of tracks) this.tracks.push({ ...t, addedBy: requestedBy, addedAt: Date.now() });
      if (this.currentIndex === -1) this.currentIndex = 0;
      this.advanceToAdded(addedIndex, this.tracks.length);
    }
    this.totalEnqueued += tracks.length;
    this.emitQueue();
    return wasEmpty ? this.tracks.length - tracks.length : -1;
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

  remove(index: number): TrackInfo | undefined {
    if (index < 0 || index >= this.tracks.length) return undefined;
    const [removed] = this.tracks.splice(index, 1);
    if (index < this.currentIndex) this.currentIndex -= 1;
    else if (index === this.currentIndex) {
      // the currently-playing track was removed; keep index pointing at the next track
      if (this.currentIndex >= this.tracks.length) this.currentIndex = this.tracks.length - 1;
    }
    this.emitQueue();
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
    this.state = { ...this.state, track: undefined, playing: false, positionMs: 0, durationMs: 0 };
    this.emitQueue();
    this.emitState();
  }

  next(): boolean {
    if (this.tracks.length === 0) return false;
    if (this.currentIndex < this.tracks.length - 1) {
      this.currentIndex += 1;
      return true;
    }
    return false;
  }

  previous(): boolean {
    if (this.currentIndex > 0) {
      this.currentIndex -= 1;
      return true;
    }
    return false;
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
