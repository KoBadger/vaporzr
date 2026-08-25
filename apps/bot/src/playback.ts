import { type CommandMessage, type MediaSource, type TrackInfo } from '@vaporzr/shared';
import { spawn, type ChildProcess } from 'node:child_process';
import { QueueManager } from './queue.js';
import { resolveYoutubeVideo, searchAndResolveYoutube, type ResolvedVideo } from './youtube.js';
import { resolveSuno } from './suno.js';
import { resolveSoundcloudVideo, soundcloudUriToUrl } from './soundcloud.js';
import { resolveApplePlayback } from './apple.js';
import { dj, sfxById, type SfxSound } from './soundboard.js';
import type { VoiceManager } from './voice.js';
import { librespotDeviceId, type LibrespotManager } from './librespot.js';
import { config } from './config.js';
import { analyzer } from './analyzer.js';
import {
  spotifyPause,
  spotifyPlay,
  spotifyResume,
  spotifySeek,
  spotifySetShuffle,
  spotifySetVolume,
  SpotifyError,
} from './spotify.js';

export type SendFn = (msg: CommandMessage) => void;

/** How long before a track ends we try to pre-resolve and buffer the next one. */
const PRELOAD_LEAD_MS = 30_000;
/** Resample librespot's 44.1 kHz PCM to Discord's 48 kHz. */
const RESAMPLE_ARGS = [
  '-hide_banner',
  '-loglevel',
  'error',
  '-f',
  's16le',
  '-ar',
  '44100',
  '-ac',
  '2',
  '-i',
  'pipe:0',
  '-ar',
  '48000',
  '-ac',
  '2',
  '-f',
  's16le',
  'pipe:1',
];

export class PlaybackController {
  private endTimer: NodeJS.Timeout | null = null;
  /** Track uri the current end timer was scheduled for (guards against double-advance). */
  private endUri: string | null = null;
  private preloadTimer: NodeJS.Timeout | null = null;
  private spotifyProgress: NodeJS.Timeout | null = null;
  /** PCM bytes seen on the previous progress tick (genuine-end detection). */
  private lastSpotifyBytes = 0;
  private spotifyRetry: NodeJS.Timeout | null = null;
  /** Consecutive 429 retries, drives the backoff so we can't re-drain the daily quota. */
  private spotifyRetryAttempts = 0;
  private positionTimer: NodeJS.Timeout | null = null;
  private currentUri: string | null = null;
  /** Device we last successfully issued Spotify commands to (librespot). */
  private spotifyDeviceId?: string;
  /** Video of the server-side stream (YouTube or Spotify-fallback). */
  private currentVideo: ResolvedVideo | null = null;
  /** Source of the track being left behind (drives visualizer PIP cleanup). */
  private lastSource: MediaSource | null = null;
  /** True while a Spotify track is being played via YouTube (no Spotify device). */
  private spotifyFallback = false;
  private resampler: ChildProcess | null = null;
  /** uri -> resolved video, so a preloaded next track starts instantly. */
  private streamCache = new Map<string, ResolvedVideo>();
  /** Cumulative number of tracks that have started playing. */
  tracksPlayed = 0;

  constructor(
    private queue: QueueManager,
    private sendVisualizer: SendFn,
    private voice: VoiceManager,
    private librespot: LibrespotManager | null = null,
  ) {}

  /** Route visualizer-targeted state messages (only the primary session broadcasts). */
  setSendVisualizer(fn: SendFn): void {
    this.sendVisualizer = fn;
  }

  /** Feed the live PCM spectrum analyzer (only the primary session should). */
  setAnalyzerTap(enabled: boolean): void {
    this.voice.setSpectrumTap(enabled ? (data) => analyzer.feedPcm(data) : null);
  }

  /** Repeat-current-track mode (natural ends replay instead of advancing). */
  setRepeat(on: boolean): void {
    this.queue.setState({ repeat: on });
  }

  private clearEndTimer(): void {
    if (this.endTimer) {
      clearTimeout(this.endTimer);
      this.endTimer = null;
    }
    this.endUri = null;
  }

  private clearPreloadTimer(): void {
    if (this.preloadTimer) {
      clearTimeout(this.preloadTimer);
      this.preloadTimer = null;
    }
  }

  /** Keep the panel progress in sync while a server-side stream is playing. */
  private startPositionTracker(): void {
    this.stopPositionTracker();
    this.positionTimer = setInterval(() => {
      if (!this.usingServerStream()) {
        this.stopPositionTracker();
        return;
      }
      if (!this.queue.getState().playing) return;
      this.queue.setState({ positionMs: this.voice.getPositionMs() });
    }, 2000);
  }

  private stopPositionTracker(): void {
    if (this.positionTimer) {
      clearInterval(this.positionTimer);
      this.positionTimer = null;
    }
  }

  private scheduleEnd(durationMs: number, positionMs: number): void {
    this.clearEndTimer();
    const remaining = Math.max(0, durationMs - positionMs);
    if (remaining <= 0) return;
    const wait = Math.min(remaining + 800, 6 * 60 * 60 * 1000);
    this.endUri = this.queue.getCurrentTrack()?.uri ?? null;
    this.endTimer = setTimeout(() => {
      this.endTimer = null;
      this.onTrackMaybeEnded();
    }, wait);
  }

  /** Pre-resolve the next track's stream URL so it can start with no yt-dlp delay. */
  private schedulePreload(durationMs: number, positionMs: number): void {
    this.clearPreloadTimer();
    const snapshot = this.queue.getSnapshot();
    const nextTrack = snapshot.tracks[snapshot.currentIndex + 1];
    if (!nextTrack) return;
    const nextIsYt = nextTrack.source === 'youtube' || nextTrack.source === 'suno' || nextTrack.source === 'soundcloud' || nextTrack.source === 'apple';
    const nextIsSpotifyFallback = nextTrack.source === 'spotify' && !this.librespot?.isRunning();
    if (!nextIsYt && !nextIsSpotifyFallback) return;
    const remaining = Math.max(0, durationMs - positionMs);
    if (remaining <= 0) return;
    const wait = Math.min(Math.max(remaining - PRELOAD_LEAD_MS, 2000), 6 * 60 * 60 * 1000);
    this.preloadTimer = setTimeout(() => {
      this.preloadTimer = null;
      this.preloadNextTrack(nextTrack);
    }, wait);
  }

  private async preloadNextTrack(track: TrackInfo): Promise<void> {
    if (this.streamCache.has(track.uri)) return;
    try {
      if (track.source === 'youtube') {
        const video = await resolveYoutubeVideo(track.uri.replace('youtube:video:', ''));
        this.streamCache.set(track.uri, video);
      } else if (track.source === 'spotify' || track.source === 'apple') {
        const query = `${track.name} ${(track.artists ?? []).join(' ')}`.trim();
        const video = await searchAndResolveYoutube(query, {
          name: track.name,
          artists: track.artists,
          durationMs: track.durationMs,
        });
        if (video) this.streamCache.set(track.uri, video);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[vaporzr] preload failed for ${track.name}: ${msg}`);
    }
  }

  private onTrackMaybeEnded(): void {
    const state = this.queue.getState();
    if (!state.playing) return;
    const current = this.queue.getCurrentTrack();
    // Only advance if we're still on the track this timer was scheduled for.
    if (this.endUri && current?.uri !== this.endUri) return;
    if (current && state.track?.uri === current.uri) {
      if (state.repeat) {
        this.replayCurrent();
        return;
      }
      this.next();
    }
  }

  /** Replay the current track from the top (repeat mode). */
  private replayCurrent(): void {
    const cur = this.queue.getCurrentTrack();
    if (!cur) {
      this.next();
      return;
    }
    this.queue.setState({ positionMs: 0 });
    void this.play().catch((err) => {
      console.warn(`[playback] repeat replay failed: ${err instanceof Error ? err.message : err}`);
    });
  }

  private currentSource(): MediaSource {
    return this.queue.getCurrentTrack()?.source ?? 'spotify';
  }

  /** True while audio is coming through the bot's own ffmpeg stream. */
  private usingServerStream(): boolean {
    const src = this.currentSource();
    return src === 'youtube' || src === 'local' || src === 'suno' || src === 'soundcloud' || src === 'apple' || this.spotifyFallback;
  }

  /** Advance to the next track once a server-side stream naturally ends. */
  private serverStreamOnEnd(): () => void {
    const uri = this.currentUri;
    return () => {
      if (this.currentUri !== uri) return;
      if (this.spotifyFallback) {
        this.spotifyFallback = false;
      }
      if (this.queue.getState().repeat && this.queue.getCurrentTrack()) {
        this.replayCurrent();
        return;
      }
      this.next();
    };
  }

  async play(): Promise<void> {
    this.clearSpotifyRetry();
    const current = this.queue.getCurrentTrack();
    if (!current) return;
    if (!this.voice.isJoined()) {
      throw new Error('I\'m not in a voice channel. Join one and try again.');
    }
    this.tracksPlayed++;

    if (current.source === 'youtube') {
      await this.playYoutube(current);
      return;
    }

    if (current.source === 'local') {
      await this.playLocal(current);
      return;
    }

    if (current.source === 'suno') {
      await this.playSuno(current);
      return;
    }

    if (current.source === 'soundcloud') {
      await this.playSoundcloud(current);
      return;
    }

    if (current.source === 'apple') {
      await this.playApple(current);
      return;
    }

    // Spotify: prefer the bot's own librespot device. If it's unavailable,
    // fall back to YouTube.
    this.spotifyFallback = false;
    this.stopPositionTracker();
    if (this.lastSource === 'youtube' || this.lastSource === 'local' || this.lastSource === 'suno' || this.lastSource === 'soundcloud' || this.lastSource === 'apple' || this.spotifyFallback) {
      this.sendVisualizer({ type: 'cmd', command: 'stop' });
    }
    const device = await this.resolveSpotifyDevice();
    if (device) {
      this.spotifyDeviceId = device.id;
      this.currentUri = current.uri;
      if (device.viaLibrespot) {
        // Prime the PCM feed before issuing play so no initial audio is dropped.
        this.startSpotifyFeed();
      }
      try {
        await spotifyPlay(device.id, [current.uri]);
        this.spotifyRetryAttempts = 0;
      } catch (err) {
        this.stopSpotifyFeed();
        this.voice.stopStream();
        if (err instanceof SpotifyError && err.status === 404) {
          console.warn(`[playback] device not active — falling back to YouTube for "${current.name}"`);
          this.spotifyDeviceId = undefined;
          await this.playYoutubeFallback(current);
          return;
        }
        if (err instanceof SpotifyError && err.status === 429) {
          const waitSec = err.retryAfter ?? this.nextRetryWait();
          this.deferSpotifyPlay(device.id, current, waitSec);
          throw new SpotifyError(
            `Spotify is rate-limited for ~${Math.max(1, Math.ceil(waitSec / 60))} min. I queued "${current.name}" and will start it automatically when the window clears.`,
            429,
            waitSec,
          );
        }
        throw err;
      }
      this.queue.setState({
        playing: true,
        track: current,
        durationMs: current.durationMs,
        positionMs: 0,
        source: 'spotify',
      });
      this.scheduleEnd(current.durationMs, 0);
      this.schedulePreload(current.durationMs, 0);
      if (device.viaLibrespot) {
        this.librespot?.resetPosition();
        this.lastSpotifyBytes = 0;
        this.startSpotifyProgress();
      }
      return;
    }

    await this.playYoutubeFallback(current);
  }

  /**
   * Fire-and-forget play that can never leave an unhandled rejection. If a
   * track can't start (no device / no YouTube match / network blip), skip it
   * and keep the queue moving instead of stalling silently.
   */
  private safePlay(): void {
    void this.play().catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[playback] track failed to start: ${msg}`);
      if (!this.voice.isJoined()) {
        // Not a track problem — leave the queue untouched for when we join.
        this.stopAll();
        this.queue.setState({ playing: false, track: undefined, positionMs: 0, durationMs: 0, source: undefined });
        return;
      }
      this.next();
    });
  }

  /** Server-side YouTube via ffmpeg straight into the voice channel. */
  private async playYoutube(current: TrackInfo): Promise<void> {
    this.spotifyFallback = false;
    this.stopSpotifyFeed();
    this.stopSpotifyProgress();
    if (this.spotifyDeviceId) void spotifyPause(this.spotifyDeviceId).catch(() => {});
    try {
      const cached = this.streamCache.get(current.uri);
      let video = cached;
      if (!video && current.streamUrl) {
        video = {
          videoId: current.uri.replace('youtube:video:', ''),
          uri: current.uri,
          name: current.name,
          artists: current.artists,
          album: current.album,
          durationMs: current.durationMs,
          image: current.image,
          source: 'youtube',
          streamUrl: current.streamUrl,
          channel: current.artists[0] ?? 'YouTube',
          thumbnail: current.image,
        };
      }
      if (!video) {
        video = await resolveYoutubeVideo(current.uri.replace('youtube:video:', ''));
      }
      this.streamCache.delete(current.uri);
      this.currentUri = current.uri;
      this.currentVideo = video;
      this.queue.setState({
        playing: true,
        track: { ...current, image: video.image ?? current.image },
        durationMs: video.durationMs,
        positionMs: 0,
        source: 'youtube',
      });
      this.voice.playFfmpegUrl(video.streamUrl!, {
        volume: this.queue.getState().volume,
        onEnd: this.serverStreamOnEnd(),
        retries: 2,
        refreshUrl: () => resolveYoutubeVideo(video.videoId).then((v) => v.streamUrl),
      });
      this.scheduleEnd(video.durationMs, 0);
      this.schedulePreload(video.durationMs, 0);
      this.startPositionTracker();
      this.sendVisualizer({ type: 'cmd', command: 'stop' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.sendVisualizer({ type: 'cmd', command: 'stop' });
      throw new Error(`Could not start YouTube track: ${msg}`);
    }
  }

  /** No Spotify device available — play the track's YouTube match instead. */
  private async playYoutubeFallback(current: TrackInfo): Promise<void> {
    const t0 = Date.now();
    console.log(`[playback] no Spotify device — falling back to YouTube for "${current.name}"`);
    this.stopSpotifyFeed();
    this.stopSpotifyProgress();
    let video: ResolvedVideo | null | undefined = this.streamCache.get(current.uri);
    if (!video) {
      const query = `${current.name} ${(current.artists ?? []).join(' ')}`.trim();
      video = await searchAndResolveYoutube(query, {
        name: current.name,
        artists: current.artists,
        durationMs: current.durationMs,
      });
      console.log(`[playback] youtube fallback resolve took ${Date.now() - t0}ms for "${current.name}"`);
    }
    if (!video) {
      throw new SpotifyError(`No Spotify device available and no YouTube match for "${current.name}".`);
    }
    this.currentUri = current.uri;
    this.currentVideo = video;
    this.spotifyFallback = true;
    this.queue.setState({
      playing: true,
      track: current,
      durationMs: video.durationMs,
      positionMs: 0,
      source: 'spotify',
    });
    this.voice.playFfmpegUrl(video.streamUrl!, {
      volume: this.queue.getState().volume,
      onEnd: this.serverStreamOnEnd(),
      retries: 2,
      refreshUrl: () => resolveYoutubeVideo(video.videoId).then((v) => v.streamUrl),
    });
    this.scheduleEnd(video.durationMs, 0);
    this.schedulePreload(video.durationMs, 0);
    this.startPositionTracker();
    this.sendVisualizer({ type: 'cmd', command: 'stop' });
  }

  /** Server-side playback of a locally-uploaded file (e.g. a .wav) via ffmpeg. */
  private async playLocal(current: TrackInfo): Promise<void> {
    const filePath = current.filePath;
    if (!filePath) throw new Error(`No local file path for "${current.name}".`);
    this.spotifyFallback = false;
    this.stopSpotifyFeed();
    this.stopSpotifyProgress();
    if (this.spotifyDeviceId) void spotifyPause(this.spotifyDeviceId).catch(() => {});
    const durationMs = (await probeLocalDuration(filePath)) ?? current.durationMs;
    this.currentUri = current.uri;
    this.queue.setState({
      playing: true,
      track: { ...current, durationMs },
      durationMs,
      positionMs: 0,
      source: 'local',
    });
    this.voice.playFfmpegUrl(filePath, {
      volume: this.queue.getState().volume,
      onEnd: this.serverStreamOnEnd(),
    });
    this.scheduleEnd(durationMs, 0);
    this.schedulePreload(durationMs, 0);
    this.startPositionTracker();
    this.sendVisualizer({ type: 'cmd', command: 'stop' });
  }

  private async playSuno(current: TrackInfo): Promise<void> {
    let video = this.streamCache.get(current.uri);
    if (!video && current.streamUrl) {
      video = {
        videoId: current.uri.replace('suno:', ''),
        uri: current.uri,
        name: current.name,
        artists: current.artists,
        album: current.album,
        durationMs: current.durationMs,
        image: current.image,
        source: 'suno',
        streamUrl: current.streamUrl,
        channel: current.artists[0] ?? 'Suno',
        thumbnail: current.image,
      };
    }
    if (!video) {
      video = await resolveSuno(current.uri.replace('suno:', ''));
      this.streamCache.set(current.uri, video);
    }
    this.spotifyFallback = false;
    this.stopSpotifyFeed();
    this.stopSpotifyProgress();
    if (this.spotifyDeviceId) void spotifyPause(this.spotifyDeviceId).catch(() => {});
    const durationMs = video.durationMs || current.durationMs;
    this.currentUri = current.uri;
    this.currentVideo = video;
    this.queue.setState({
      playing: true,
      track: { ...current, name: video.name, artists: video.artists, durationMs },
      durationMs,
      positionMs: 0,
      source: 'suno',
    });
    this.voice.playFfmpegUrl(video.streamUrl!, {
      volume: this.queue.getState().volume,
      onEnd: this.serverStreamOnEnd(),
    });
    this.scheduleEnd(durationMs, 0);
    this.schedulePreload(durationMs, 0);
    this.startPositionTracker();
    this.sendVisualizer({ type: 'cmd', command: 'stop' });
  }

  private async playSoundcloud(current: TrackInfo): Promise<void> {
    let video = this.streamCache.get(current.uri);
    if (!video && current.streamUrl) {
      video = {
        videoId: current.uri.replace('soundcloud:', ''),
        uri: current.uri,
        name: current.name,
        artists: current.artists,
        album: current.album,
        durationMs: current.durationMs,
        image: current.image,
        source: 'soundcloud',
        streamUrl: current.streamUrl,
        channel: current.artists[0] ?? 'SoundCloud',
        thumbnail: current.image,
      };
    }
    if (!video) {
      video = await resolveSoundcloudVideo(soundcloudUriToUrl(current.uri));
      this.streamCache.set(current.uri, video);
    }
    this.spotifyFallback = false;
    this.stopSpotifyFeed();
    this.stopSpotifyProgress();
    if (this.spotifyDeviceId) void spotifyPause(this.spotifyDeviceId).catch(() => {});
    const durationMs = video.durationMs || current.durationMs;
    this.currentUri = current.uri;
    this.currentVideo = video;
    this.queue.setState({
      playing: true,
      track: { ...current, name: video.name, artists: video.artists, durationMs },
      durationMs,
      positionMs: 0,
      source: 'soundcloud',
    });
    this.voice.playFfmpegUrl(video.streamUrl!, {
      volume: this.queue.getState().volume,
      onEnd: this.serverStreamOnEnd(),
    });
    this.scheduleEnd(durationMs, 0);
    this.schedulePreload(durationMs, 0);
    this.startPositionTracker();
    this.sendVisualizer({ type: 'cmd', command: 'stop' });
  }

  /** Apple Music tracks carry metadata only — play the YouTube match. */
  private async playApple(current: TrackInfo): Promise<void> {
    let video = this.streamCache.get(current.uri);
    if (!video) {
      const match = await resolveApplePlayback(current);
      if (!match) {
        throw new Error(`No playable match found for Apple Music track "${current.name}".`);
      }
      video = match;
      this.streamCache.set(current.uri, video);
    }
    this.spotifyFallback = false;
    this.stopSpotifyFeed();
    this.stopSpotifyProgress();
    if (this.spotifyDeviceId) void spotifyPause(this.spotifyDeviceId).catch(() => {});
    const durationMs = video.durationMs || current.durationMs;
    this.currentUri = current.uri;
    this.currentVideo = video;
    this.queue.setState({
      playing: true,
      track: { ...current, name: video.name, artists: video.artists, durationMs },
      durationMs,
      positionMs: 0,
      source: 'apple',
    });
    this.voice.playFfmpegUrl(video.streamUrl!, {
      volume: this.queue.getState().volume,
      onEnd: this.serverStreamOnEnd(),
    });
    this.scheduleEnd(durationMs, 0);
    this.schedulePreload(durationMs, 0);
    this.startPositionTracker();
    this.sendVisualizer({ type: 'cmd', command: 'stop' });
  }

  // ---- DJ soundboard ----

  isDjEnabled(guildId: string): boolean {
    return dj.isEnabled(guildId);
  }

  setDjEnabled(guildId: string, on: boolean): void {
    dj.setEnabled(guildId, on);
  }

  listSoundEffects(): SfxSound[] {
    return dj.list();
  }

  /** Mix a sound effect over the current audio. Returns false if unavailable. */
  async playSoundEffect(id: string): Promise<boolean> {
    if (!this.voice.isJoined()) return false;
    if (!sfxById(id)) return false;
    const pcm = await dj.getPcm(id);
    if (!pcm) return false;
    this.voice.queueSfxPcm(pcm);
    return true;
  }

  /** Restart the current server-side stream from a new position. */
  private seekServerStream(positionMs: number): void {
    if (this.currentSource() === 'local') {
      const track = this.queue.getCurrentTrack();
      if (!track?.filePath) return;
      this.voice.playFfmpegUrl(track.filePath, {
        seekMs: positionMs,
        volume: this.queue.getState().volume,
        onEnd: this.serverStreamOnEnd(),
      });
      return;
    }
    const video = this.currentVideo;
    if (!video) return;
    this.voice.playFfmpegUrl(video.streamUrl!, {
      seekMs: positionMs,
      volume: this.queue.getState().volume,
      onEnd: this.serverStreamOnEnd(),
      retries: 2,
      refreshUrl: () => resolveYoutubeVideo(video.videoId).then((v) => v.streamUrl),
    });
  }

  private resolveSpotifyDevice(): Promise<{ id: string; name?: string; viaLibrespot: boolean } | null> {
    if (!this.librespot?.enabled) return Promise.resolve(null);
    // YouTube-first mode plays Spotify requests via the YouTube fallback, so no
    // Spotify API calls (device commands) happen at all.
    if (config.spotifyPreferYoutube) return Promise.resolve(null);
    // librespot process must actually be running before we try sending it a
    // Spotify Connect command — otherwise the API call wastes ~300-500 ms
    // failing with a 404 before falling back to YouTube.
    if (!this.librespot.isRunning()) return Promise.resolve(null);
    // librespot registers its Connect device with id = SHA1(device name), so we
    // don't need to hit the rate-limited /me/player/devices endpoint at all.
    const name = config.librespotDeviceName;
    const id = librespotDeviceId(name);
    return Promise.resolve({ id, name, viaLibrespot: true });
  }

  /** Resample librespot's 44.1 kHz PCM to 48 kHz and feed the voice channel. */
  private startSpotifyFeed(): void {
    if (this.voice.isRawFeedActive()) {
      // Spotify→Spotify skip: keep the live feed stream so audio doesn't cut
      // out and replay the previous track's tail while the next one loads.
      this.voice.resume();
    } else {
      this.voice.startStream();
    }
    this.voice.setExpectingPcm(true);
    if (!this.librespot) return;
    let ff = this.resampler;
    if (!ff) {
      ff = spawn(config.ffmpegPath, RESAMPLE_ARGS, { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
      this.resampler = ff;
      const fIn = ff.stdin!;
      const fOut = ff.stdout!;
      // ffmpeg can be killed or crash mid-stream (e.g. during a skip); without
      // error handlers a broken-pipe write here would take down the whole bot.
      fIn.on('error', () => {});
      fOut.on('error', () => {});
      fIn.on('drain', () => this.librespot?.resumeSocket());
      fOut.on('data', (d) => {
        const ok = this.voice.feedPcm(d);
        if (!ok) fOut.pause();
      });
      ff.on('error', (err) => console.warn(`[playback] resampler error: ${err.message}`));
      ff.on('exit', () => {
        if (this.resampler === ff) this.resampler = null;
      });
    }
    this.voice.setStreamDrain(() => {
      if (this.resampler === ff && ff.stdout && ff.stdout.isPaused()) {
        ff.stdout.resume();
      }
    });
    this.librespot.setPcmHandler((data) => {
      // A stale handler (resampler replaced/killed during a skip) must not write
      // into a dead ffmpeg's stdin.
      if (this.resampler !== ff) return true;
      if (ff.stdin?.destroyed) return true;
      return ff.stdin?.write(data) ?? true;
    });
    this.voice.setStallRecovery(() => {
      this.librespot?.resumeSocket();
      const r = this.resampler;
      if (r?.stdout && r.stdout.isPaused()) r.stdout.resume();
    });
  }

  private stopSpotifyFeed(): void {
    this.librespot?.setPcmHandler(null);
    this.voice.setExpectingPcm(false);
    this.voice.setStreamDrain(null);
    if (this.resampler) {
      try {
        this.resampler.kill();
      } catch {
        /* ignore */
      }
      this.resampler = null;
    }
  }

  /**
   * Keep the panel's progress in sync and advance on natural end, all from
   * locally decoded PCM bytes — no /me/player polling, so no rate-limit drain.
   */
  private startSpotifyProgress(): void {
    this.stopSpotifyProgress();
    this.spotifyProgress = setInterval(() => {
      if (this.currentSource() !== 'spotify' || this.spotifyFallback) return;
      if (!this.queue.getState().playing) return;
      const pos = this.librespot?.getPositionMs() ?? 0;
      const dur = this.queue.getCurrentTrack()?.durationMs ?? 0;
      const bytes = this.librespot?.getPcmBytes() ?? 0;
      this.queue.setState({ positionMs: pos });
      // Only advance once librespot has actually stopped producing (track
      // genuinely ended) — the position catches the real end, not 2s early.
      if (dur > 0 && pos >= dur - 2000 && bytes === this.lastSpotifyBytes) {
        this.clearEndTimer();
        this.next();
        return;
      }
      this.lastSpotifyBytes = bytes;
    }, 2000);
  }

  private stopSpotifyProgress(): void {
    if (this.spotifyProgress) {
      clearInterval(this.spotifyProgress);
      this.spotifyProgress = null;
    }
  }

  /**
   * Spotify's app quota is exhausted (429). Keep the track queued as the current
   * track and retry the play command once Spotify's window clears, so the user
   * doesn't have to babysit the wait.
   */
  private deferSpotifyPlay(deviceId: string, current: TrackInfo, waitSec: number): void {
    this.clearSpotifyRetry();
    this.spotifyDeviceId = deviceId;
    this.currentUri = current.uri;
    this.voice.cancelIdleLeave();
    this.queue.setState({
      playing: true,
      track: current,
      durationMs: current.durationMs,
      positionMs: 0,
      source: 'spotify',
    });
    console.warn(
      `[playback] Spotify rate-limited — will retry "${current.name}" in ${Math.max(1, Math.ceil(waitSec / 60))} min`,
    );
    this.spotifyRetry = setTimeout(async () => {
      this.spotifyRetry = null;
      if (this.currentUri !== current.uri) return;
      try {
        await spotifyPlay(deviceId, [current.uri]);
      } catch (err) {
        if (this.currentUri !== current.uri) return;
        if (err instanceof SpotifyError && err.status === 429) {
          this.deferSpotifyPlay(deviceId, current, err.retryAfter ?? this.nextRetryWait());
          return;
        }
        if (err instanceof SpotifyError && err.status === 404) {
          this.spotifyDeviceId = undefined;
          await this.playYoutubeFallback(current).catch(() => {});
          return;
        }
        console.warn(`[playback] deferred Spotify start failed: ${err instanceof Error ? err.message : String(err)}`);
        this.next();
        return;
      }
      this.spotifyRetryAttempts = 0;
      if (this.currentUri !== current.uri) return;
      this.startSpotifyFeed();
      this.librespot?.resetPosition();
      this.lastSpotifyBytes = 0;
      this.scheduleEnd(current.durationMs, 0);
      this.schedulePreload(current.durationMs, 0);
      this.startSpotifyProgress();
      console.log(`[playback] started "${current.name}" after rate-limit wait`);
    }, waitSec * 1000);
  }

  private clearSpotifyRetry(): void {
    if (this.spotifyRetry) {
      clearTimeout(this.spotifyRetry);
      this.spotifyRetry = null;
    }
  }

  /** Backoff for 429 retries: 1, 2, 4, … min, capped at 1h so we can't re-drain the daily quota. */
  private nextRetryWait(): number {
    const attempts = Math.max(0, this.spotifyRetryAttempts++);
    return Math.min(3600, 60 * 2 ** attempts);
  }

  playAt(index: number): boolean {
    const tracks = this.queue.getSnapshot().tracks;
    if (index < 0 || index >= tracks.length) return false;
    while (this.queue.getCurrentTrack()?.uri !== tracks[index].uri) {
      if (!this.queue.next()) break;
    }
    this.safePlay();
    return true;
  }

  next(): void {
    this.clearPreloadTimer();
    this.lastSource = this.currentSource();
    if (!this.queue.next()) {
      this.clearEndTimer();
      this.currentUri = null;
      this.spotifyFallback = false;
      this.sendVisualizer({ type: 'cmd', command: 'stop' });
      if (this.spotifyDeviceId) void spotifyPause(this.spotifyDeviceId).catch(() => {});
      this.stopSpotifyFeed();
      this.stopSpotifyProgress();
      this.stopPositionTracker();
      this.clearSpotifyRetry();
      this.queue.setState({ playing: false, track: undefined, positionMs: 0, durationMs: 0, source: undefined });
      this.voice.stopStream();
      return;
    }
    this.clearEndTimer();
    this.safePlay();
  }

  previous(): void {
    this.clearPreloadTimer();
    this.lastSource = this.currentSource();
    this.queue.previous();
    this.clearEndTimer();
    this.safePlay();
  }

  pause(): void {
    this.clearEndTimer();
    this.clearPreloadTimer();
    this.clearSpotifyRetry();
    if (this.usingServerStream()) {
      this.stopPositionTracker();
      this.queue.setState({ playing: false });
    } else if (this.spotifyDeviceId) {
      void spotifyPause(this.spotifyDeviceId).catch(() => {});
      this.voice.setExpectingPcm(false);
      this.queue.setState({ playing: false });
    }
    this.voice.pause();
  }

  resume(): void {
    if (!this.voice.isJoined()) {
      console.warn('[playback] resume ignored — not in a voice channel');
      return;
    }
    if (this.usingServerStream()) {
      this.voice.resume();
      const state = this.queue.getState();
      const pos = this.voice.getPositionMs();
      this.queue.setState({ playing: true, positionMs: pos });
      if (state.track) this.scheduleEnd(state.durationMs, pos);
      this.schedulePreload(state.durationMs, pos);
      this.startPositionTracker();
      return;
    }
    if (this.spotifyDeviceId) {
      void spotifyResume(this.spotifyDeviceId).catch(() => {});
      const state = this.queue.getState();
      this.queue.setState({ playing: true });
      if (state.track) this.scheduleEnd(state.durationMs, state.positionMs);
      this.schedulePreload(state.durationMs, state.positionMs);
      this.voice.setExpectingPcm(true);
    }
    this.voice.resume();
  }

  toggle(): void {
    const state = this.queue.getState();
    if (state.playing) this.pause();
    else this.resume();
  }

  seek(positionMs: number): void {
    const state = this.queue.getState();
    if (this.usingServerStream()) {
      this.seekServerStream(positionMs);
      this.queue.setState({ positionMs });
    } else if (this.spotifyDeviceId) {
      void spotifySeek(this.spotifyDeviceId, positionMs).catch(() => {});
      this.librespot?.setPositionMs(positionMs);
      this.queue.setState({ positionMs });
    }
    if (state.playing) this.scheduleEnd(state.durationMs, positionMs);
    this.schedulePreload(state.durationMs, positionMs);
  }

  volume(vol: number): void {
    const v = Math.max(0, Math.min(100, vol));
    if (this.usingServerStream()) {
      this.voice.setVolume(v);
    } else if (this.spotifyDeviceId) {
      void spotifySetVolume(this.spotifyDeviceId, v).catch(() => {});
    }
    this.queue.setState({ volume: v });
  }

  shuffle(enabled: boolean): void {
    this.queue.setState({ shuffle: enabled });
    if (enabled) {
      this.queue.shuffleUpcoming();
      if (this.currentSource() === 'spotify' && this.spotifyDeviceId) {
        void spotifySetShuffle(this.spotifyDeviceId, enabled).catch(() => {});
      }
    }
  }

  /** Stop everything (queue cleared). */
  stopAll(): void {
    this.clearEndTimer();
    this.clearPreloadTimer();
    this.streamCache.clear();
    this.spotifyFallback = false;
    this.lastSource = null;
    this.sendVisualizer({ type: 'cmd', command: 'stop' });
    if (this.spotifyDeviceId) void spotifyPause(this.spotifyDeviceId).catch(() => {});
    this.stopSpotifyFeed();
    this.stopSpotifyProgress();
    this.stopPositionTracker();
    this.voice.stopStream();
  }
}

/** Read a local media file's duration via ffmpeg (killed as soon as it's known). */
function probeLocalDuration(filePath: string): Promise<number | null> {
  return new Promise((resolve) => {
    const proc = spawn(config.ffmpegPath, ['-hide_banner', '-i', filePath, '-f', 'null', '-'], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    const done = (): void => {
      clearTimeout(timer);
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
    };
    const timer = setTimeout(() => {
      done();
      resolve(parseDuration(stderr));
    }, 5000);
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
      const ms = parseDuration(stderr);
      if (ms !== null) {
        done();
        resolve(ms);
      }
    });
    proc.on('exit', () => {
      clearTimeout(timer);
      resolve(parseDuration(stderr));
    });
    proc.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

function parseDuration(stderr: string): number | null {
  const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
  if (!m) return null;
  return (+m[1] * 3600 + +m[2] * 60 + parseFloat(m[3])) * 1000;
}
