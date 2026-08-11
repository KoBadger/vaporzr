import { emptyState, type PlaybackState, type TrackInfo } from '@vaporzr/shared';

export interface QueueListener {
  onQueueChanged(): void;
  onStateChanged(state: PlaybackState): void;
}

export class QueueManager {
  private tracks: TrackInfo[] = [];
  private currentIndex = -1;
  private state: PlaybackState = emptyState();

  constructor(private listeners: QueueListener[] = []) {}

  subscribe(listener: QueueListener): void {
    this.listeners.push(listener);
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

  getCurrentTrack(): TrackInfo | undefined {
    if (this.currentIndex < 0 || this.currentIndex >= this.tracks.length) return undefined;
    return this.tracks[this.currentIndex];
  }

  enqueue(track: Omit<TrackInfo, 'addedBy' | 'addedAt'>, requestedBy: string): { added: boolean; currentIndex: number } {
    this.tracks.push({ ...track, addedBy: requestedBy, addedAt: Date.now() });
    if (this.currentIndex === -1) this.currentIndex = 0;
    this.emitQueue();
    return { added: true, currentIndex: this.currentIndex };
  }

  enqueueMany(tracks: Omit<TrackInfo, 'addedBy' | 'addedAt'>[], requestedBy: string): number {
    const wasEmpty = this.tracks.length === 0;
    for (const t of tracks) this.tracks.push({ ...t, addedBy: requestedBy, addedAt: Date.now() });
    if (this.currentIndex === -1) this.currentIndex = 0;
    this.emitQueue();
    return wasEmpty ? this.tracks.length - tracks.length : -1;
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
