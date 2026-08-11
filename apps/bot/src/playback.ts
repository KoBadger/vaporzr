import { emptyState, type CommandMessage, type PlaybackState, type TrackInfo } from '@vaporzr/shared';
import { QueueManager } from './queue.js';

export type SendFn = (msg: CommandMessage) => void;

export class PlaybackController {
  private endTimer: NodeJS.Timeout | null = null;
  private currentUri: string | null = null;
  private wasPlaying = false;
  private deviceId?: string;
  private deviceName?: string;

  constructor(
    private queue: QueueManager,
    private send: SendFn,
  ) {}

  private clearEndTimer(): void {
    if (this.endTimer) {
      clearTimeout(this.endTimer);
      this.endTimer = null;
    }
  }

  private scheduleEnd(durationMs: number, positionMs: number): void {
    this.clearEndTimer();
    if (!this.deviceId) return;
    const remaining = Math.max(0, durationMs - positionMs);
    const wait = Math.min(remaining + 800, 6 * 60 * 60 * 1000);
    this.endTimer = setTimeout(() => {
      this.endTimer = null;
      this.onTrackMaybeEnded();
    }, wait);
  }

  private onTrackMaybeEnded(): void {
    const state = this.queue.getState();
    if (!state.playing) return;
    const current = this.queue.getCurrentTrack();
    if (current && state.track?.uri === current.uri) {
      this.next();
    }
  }

  onPlayerReady(deviceId?: string, deviceName?: string): void {
    this.deviceId = deviceId;
    this.deviceName = deviceName;
    this.queue.setState({ deviceId, deviceName });
  }

  onPlayerState(state: PlaybackState): void {
    const wasPlaying = this.wasPlaying;
    this.wasPlaying = state.playing;

    // Natural track change (Spotify advanced on its own, e.g. after last track).
    if (state.track && this.currentUri && state.track.uri !== this.currentUri && state.playing) {
      const current = this.queue.getCurrentTrack();
      if (current && current.uri === this.currentUri) {
        // advance queue pointer if the new uri is the next entry, otherwise leave
        const idx = this.queue.getSnapshot().tracks.findIndex((t) => t.uri === state.track!.uri);
        if (idx > -1) {
          while (this.queue.getCurrentTrack()?.uri !== state.track!.uri) {
            if (!this.queue.next()) break;
          }
        }
      }
    }

    this.currentUri = state.track?.uri ?? null;

    // Rebuild richer track info if we have it in the queue
    const known = this.queue.getSnapshot().tracks.find((t) => t.uri === state.track?.uri);
    this.queue.setState({
      ...state,
      track: known ? { ...known, addedBy: state.track?.addedBy ?? known.addedBy } : state.track,
      deviceId: this.deviceId,
      deviceName: this.deviceName,
    });

    if (state.playing) {
      this.scheduleEnd(state.durationMs || state.track?.durationMs || 0, state.positionMs);
    } else if (wasPlaying) {
      this.clearEndTimer();
    }
  }

  play(): void {
    const current = this.queue.getCurrentTrack();
    if (!current) return;
    this.currentUri = current.uri;
    this.send({ type: 'cmd', command: 'play', uris: [current.uri] });
    this.scheduleEnd(current.durationMs, 0);
  }

  playAt(index: number): boolean {
    const tracks = this.queue.getSnapshot().tracks;
    if (index < 0 || index >= tracks.length) return false;
    while (this.queue.getCurrentTrack()?.uri !== tracks[index].uri) {
      if (!this.queue.next()) break;
    }
    this.play();
    return true;
  }

  next(): void {
    if (!this.queue.next()) {
      // end of queue
      this.clearEndTimer();
      this.currentUri = null;
      this.queue.setState({ playing: false, track: undefined, positionMs: 0, durationMs: 0 });
      return;
    }
    this.play();
  }

  previous(): void {
    this.queue.previous();
    this.play();
  }

  pause(): void {
    this.clearEndTimer();
    this.send({ type: 'cmd', command: 'pause' });
  }

  resume(): void {
    this.send({ type: 'cmd', command: 'resume' });
    const state = this.queue.getState();
    if (state.track) this.scheduleEnd(state.durationMs, state.positionMs);
  }

  toggle(): void {
    const state = this.queue.getState();
    if (state.playing) this.pause();
    else this.resume();
  }

  seek(positionMs: number): void {
    this.send({ type: 'cmd', command: 'seek', positionMs });
    const state = this.queue.getState();
    if (state.playing) this.scheduleEnd(state.durationMs, positionMs);
  }

  volume(vol: number): void {
    this.send({ type: 'cmd', command: 'volume', volume: Math.max(0, Math.min(100, vol)) });
  }

  shuffle(enabled: boolean): void {
    this.send({ type: 'cmd', command: 'shuffle', shuffle: enabled });
    this.queue.setState({ shuffle: enabled });
  }
}
