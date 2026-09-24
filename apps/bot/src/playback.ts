import { type CommandMessage, type MediaSource, type TrackInfo } from '@vaporzr/shared';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { QueueManager } from './queue.js';
import { resolveYoutubeVideo, searchAndResolveYoutube, type ResolvedVideo } from './youtube.js';
import { resolveSuno, probeDuration } from './suno.js';
import { resolveSoundcloudVideo, soundcloudUriToUrl } from './soundcloud.js';
import { resolveApplePlayback } from './apple.js';
import { dj, sfxById, type SfxSound } from './soundboard.js';
import type { VoiceManager } from './voice.js';
import { librespotDeviceId, type SpotifyBackend } from './librespot.js';
import { config } from './config.js';
import { analyzer } from './analyzer.js';
import { fadeInPcm, planCrossfade, tempoMatchRatio } from './crossfade.js';
import * as EW from './endlesswave.js';
import {
  spotifyPause,
  spotifyPlay,
  spotifyResume,
  spotifySeek,
  spotifySetShuffle,
  spotifySetVolume,
  SpotifyError,
  type ResolvedTrack,
} from './spotify.js';

export type SendFn = (msg: CommandMessage) => void;

/** How long before a track ends we try to pre-resolve and buffer the next one. */
const PRELOAD_LEAD_MS = 30_000;
/** How long a resolved stream URL stays reusable before being re-resolved.
 *  Aligned with YouTube's signed-URL lifetime (~6h) so a stale URL never
 *  lands back in the queue. */
const PLAYBACK_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
/** Debounce before the stream cache is flushed to `stream-cache.json`. */
export const STREAM_CACHE_SAVE_DEBOUNCE_MS = 4000;
/** Resample librespot's 44.1 kHz PCM to Discord's 48 kHz, plus R128 loudness
 *  normalization so Spotify and YouTube/EW tracks land at the same target. A
 *  per-session effect filter string (upbeat/slowed/bass) is appended last so
 *  it rides on top of the loudness normalization. */
const RESAMPLE_ARGS = (fx: string): string[] => [
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
  '-af',
  fx ? `${config.audioNormFilter},afade=t=in:st=0:d=0.4,${fx}` : `${config.audioNormFilter},afade=t=in:st=0:d=0.4`,
  '-f',
  's16le',
  'pipe:1',
];

export class PlaybackController {
  private endTimer: NodeJS.Timeout | null = null;
  /** Track uri the current end timer was scheduled for (guards against double-advance). */
  private endUri: string | null = null;
  private preloadTimer: NodeJS.Timeout | null = null;
  /** Fires shortly before a track ends to overlay the next track's head (crossfade). */
  private crossfadeTimer: NodeJS.Timeout | null = null;
  /** Seek offset for the track we crossfaded into; consumed by play(). */
  private pendingXfadeSeekMs = 0;
  /** Offset the CURRENT stream started at (crossfade handoff); 0 for normal starts. */
  private currentStartOffsetMs = 0;
  /** Consecutive track-start failures, to avoid silently draining the queue. */
  private playFailures = 0;
  /** True while advancing because a stream ended on its own (keeps the xfade seek). */
  private fromNaturalEnd = false;
  private spotifyProgress: NodeJS.Timeout | null = null;
  /** PCM bytes seen on the previous progress tick (genuine-end detection). */
  private lastSpotifyBytes = 0;
  private spotifyRetry: NodeJS.Timeout | null = null;
  /** Consecutive 429 retries, drives the backoff so we can't re-drain the daily quota. */
  private spotifyRetryAttempts = 0;
  private positionTimer: NodeJS.Timeout | null = null;
  /** Last time the Spotify-feed stall recovery re-issued playback (debounce). */
  private lastStallRecoveryAt = 0;
  private currentUri: string | null = null;
  /** Device we last successfully issued Spotify commands to (librespot). */
  private spotifyDeviceId?: string;
  /** Once Spotify reports an app-quota 429, avoid repeating the command for a
   *  while; Spotify tracks can continue through the YouTube fallback meanwhile. */
  private spotifyPlaybackBlockedUntil = 0;
  /** Video of the server-side stream (YouTube or Spotify-fallback). */
  private currentVideo: ResolvedVideo | null = null;
  /** YouTube videoId of the last-started server-side stream. Used to prevent
   *  a Spotify→YouTube fallback from accidentally replaying the exact same
   *  video that just finished. */
  private lastYoutubeVideoId: string | null = null;
  /** Source of the track being left behind (drives visualizer PIP cleanup). */
  private lastSource: MediaSource | null = null;
  /** True while a Spotify track is being played via YouTube (no Spotify device). */
  private spotifyFallback = false;
  private resampler: ChildProcess | null = null;
  /** uri -> resolved video, so a preloaded next track starts instantly. */
  private streamCache = new Map<string, ResolvedVideo>();
  private static readonly STREAM_CACHE_MAX = 500;
  /** Debounced save of streamCache to disk (restart / requeue instant start). */
  private cacheSaveTimer: NodeJS.Timeout | null = null;
  /** Tempo factor for /upbeat & /slowed (1 = normal; 1.25 = Nightcore, 0.85 = slowed). */
  private speedFactor = 1;
  /** Bass boost gain in dB (0 = off). */
  private bassBoostDb = 0;
  /** Ambient intermission (queue-end): a quiet curated lo-fi track, looping. */
  private ambientActive = false;
  private ambientQueryIdx = 0;
  private static readonly AMBIENT_QUERIES = [
    'ambient music mix',
    'lofi hip hop mix',
    'chill ambient study music',
    'downtempo chill mix',
  ];
  /** Invalidates in-flight play() calls when skip/previous/stop changes the cursor. */
  private playGeneration = 0;
  /** Cumulative number of tracks that have started playing. */
  tracksPlayed = 0;

  constructor(
    private queue: QueueManager,
    private sendVisualizer: SendFn,
    private voice: VoiceManager,
    private librespot: SpotifyBackend | null = null,
  ) {
    this.loadStreamCache();
    // When the voice link drops mid-track and comes back, resume the current
    // track where it left off instead of letting the queue silently skip it.
    this.voice.setOnVoiceReconnect(() => {
      void this.resumeAfterReconnect();
    });
  }

  /**
   * Called by VoiceManager once the voice link recovers. If a server-side
   * stream died while the link was down, re-play the current track from the
   * last known position. Bounded: only acts when no stream is actively flowing
   * and the track isn't about to finish anyway.
   */
  private async resumeAfterReconnect(): Promise<void> {
    const state = this.queue.getState();
    if (!state.playing) return;
    const track = state.track;
    if (!track) return;
    if (!this.usingServerStream()) return;
    if (!this.voice.isStalled()) return;
    const pos = state.positionMs ?? 0;
    if (track.durationMs && pos >= track.durationMs - 1500) return;
    console.log(`[playback] voice link recovered — resuming "${track.name}" from ${Math.round(pos / 1000)}s`);
    this.sendVisualizer({ type: 'cmd', command: 'stop' });
    try {
      await this.play();
      if (pos > 0) this.seek(pos);
    } catch (err) {
      console.warn(`[playback] resume after reconnect failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Load previously resolved stream URLs from disk. YouTube stream URLs are
   * signed and decay in a few hours, so anything older than the TTL (or that
   * failed to carry a URL) is dropped — a restart then starts instant for
   * recently-played tracks instead of re-running yt-dlp.
   */
  loadStreamCache(): void {
    try {
      const file = path.join(config.dataDir, 'stream-cache.json');
      if (!fs.existsSync(file)) return;
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Array<{
        uri: string;
        savedAt: number;
        video: ResolvedVideo;
      }>;
      const cutoff = Date.now() - PLAYBACK_CACHE_TTL_MS;
      let restored = 0;
      for (const entry of raw) {
        if (!entry || !entry.video || !entry.video.streamUrl) continue;
        if (entry.savedAt < cutoff) continue;
        this.streamCache.set(entry.uri, entry.video);
        restored++;
      }
      if (restored > 0) console.log(`[playback] restored ${restored} cached stream URL(s)`);
    } catch (err) {
      console.warn(`[playback] could not load stream cache: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Debounced persist of the resolved-stream cache (dedupes across a burst). */
  scheduleCacheSave(): void {
    if (this.cacheSaveTimer) clearTimeout(this.cacheSaveTimer);
    this.cacheSaveTimer = setTimeout(() => {
      this.cacheSaveTimer = null;
      try {
        const cutoff = Date.now() - PLAYBACK_CACHE_TTL_MS;
        const rows: Array<{ uri: string; savedAt: number; video: ResolvedVideo }> = [];
        for (const [uri, video] of this.streamCache) {
          if (!video.streamUrl) continue;
          rows.push({ uri, savedAt: Date.now(), video });
        }
        // Keep the file small: only retain entries still inside the TTL.
        const fresh = rows.filter((r) => Date.now() - r.savedAt < PLAYBACK_CACHE_TTL_MS);
        fs.mkdirSync(config.dataDir, { recursive: true });
        fs.writeFileSync(path.join(config.dataDir, 'stream-cache.json'), JSON.stringify(fresh));
      } catch (err) {
        console.warn(`[playback] could not persist stream cache: ${err instanceof Error ? err.message : err}`);
      }
    }, 4000);
    this.cacheSaveTimer!.unref?.();
  }

  /** Set a cache entry and schedule its persistence. */
  cacheSet(uri: string, video: ResolvedVideo): void {
    this.streamCache.set(uri, video);
    if (this.streamCache.size > PlaybackController.STREAM_CACHE_MAX) {
      const firstKey = this.streamCache.keys().next().value;
      if (firstKey !== undefined) this.streamCache.delete(firstKey);
    }
    this.scheduleCacheSave();
  }

  /** Public read accessor for the resolved-stream cache (used by tests + status). */
  cachedStream(uri: string): ResolvedVideo | undefined {
    return this.streamCache.get(uri);
  }

  /** Callback fired when a track finishes (or is skipped). Useful for Endless Wave auto-queue. */
  onTrackEnd: ((endedTrack: TrackInfo) => void) | null = null;
  /** Callback fired when the queue runs dry (last track ended, nothing to advance). */
  onQueueEnd: (() => void) | null = null;
  /** Callback fired when playback stops because several tracks in a row failed to start. */
  onPlaybackStalled: (() => void) | null = null;

  /** Route visualizer-targeted state messages (only the primary session broadcasts). */
  setSendVisualizer(fn: SendFn): void {
    this.sendVisualizer = fn;
  }

  /** Kick off stream-URL resolution in the background the moment a track is
   *  queued. play() then starts the instant the voice-channel join completes
   *  instead of serially waiting 5-20s on yt-dlp afterwards. The YouTube
   *  resolver dedupes by query key, so play() reuses this exact resolve. */
  prefetchStream(track: ResolvedTrack | TrackInfo): void {
    if (this.streamCache.has(track.uri) || (track as ResolvedTrack).streamUrl) return;
    const uri = track.uri;
    void (async () => {
      try {
        let video: ResolvedVideo | null = null;
        if (track.source === 'youtube') {
          video = await resolveYoutubeVideo(uri.replace('youtube:video:', ''));
        } else if (track.source === 'apple') {
          video = await resolveApplePlayback(track);
        } else if (track.source === 'soundcloud') {
          video = await resolveSoundcloudVideo(soundcloudUriToUrl(uri));
        } else if (track.source === 'spotify') {
          // Only worth pre-resolving YouTube when the Spotify device can't play it.
          if (config.spotifyPreferYoutube || !this.librespot?.isRunning()) {
            const query = `${track.name} ${(track.artists ?? []).join(' ')}`.trim();
            video = await searchAndResolveYoutube(query, {
              name: track.name,
              artists: track.artists,
              durationMs: track.durationMs,
            });
          }
        }
        if (video) this.cacheSet(uri, video);
      } catch (err) {
        console.warn(`[playback] prefetch failed for ${uri}:`, err instanceof Error ? err.message : err);
      }
    })();
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

  private clearCrossfadeTimer(): void {
    if (this.crossfadeTimer) {
      clearTimeout(this.crossfadeTimer);
      this.crossfadeTimer = null;
    }
  }

  /** Keep the panel progress in sync while a server-side stream is playing. */
  private startPositionTracker(): void {
    this.stopPositionTracker();
    const currentUri = this.queue.getState().track?.uri;
    this.positionTimer = setInterval(() => {
      if (!this.usingServerStream()) {
        this.stopPositionTracker();
        return;
      }
      const state = this.queue.getState();
      if (!state.playing) return;
      if (state.track?.uri !== currentUri) {
        // Track changed, stop this tracker (a new one will start for the new track)
        this.stopPositionTracker();
        return;
      }
      this.queue.setState({ positionMs: this.voice.getPositionMs() });
    }, 2000);
  }

  private stopPositionTracker(): void {
    if (this.positionTimer) {
      clearInterval(this.positionTimer);
      this.positionTimer = null;
    }
  }

  /** Trust the known track length when a YouTube/stream upload runs long. The
   *  end timer used to follow the video, so a wrong or extra-long match played
   *  right through (and could include non-music/sponsor segments). A small
   *  slack keeps the natural outro. */
  private cappedDuration(videoMs: number, trackMs: number): number {
    if (!trackMs || trackMs <= 0) return videoMs || 0;
    if (!videoMs || videoMs <= 0) return trackMs;
    return Math.min(videoMs, trackMs + 5_000);
  }

  private scheduleEnd(durationMs: number, positionMs: number): void {
    this.clearEndTimer();
    // Reaching here means the track actually started — clear the failure streak.
    this.playFailures = 0;
    // A stream that was crossfaded into already skipped `currentStartOffsetMs`,
    // so its true position is positionMs + that offset. Forgetting this made the
    // next crossfade timer fire a full window late (overlaying the FOLLOWING
    // track) and could briefly double the audio.
    const effectivePosition = positionMs + this.currentStartOffsetMs;
    const remaining = Math.max(0, durationMs - effectivePosition);
    if (remaining <= 0) return;
    // The ffmpeg stream's natural onEnd is the authoritative advance for
    // server streams; this timer is only a fallback for when that never fires.
    // For the Spotify (go-librespot -> PulseAudio -> parec) path there IS no
    // ffmpeg onEnd, and our position is estimated from captured PCM, which runs
    // AHEAD of what the listener actually hears by the buffer depth — so
    // advancing at durationMs clips the ending. +6s lets the buffered tail drain.
    const wait = Math.min(remaining + 6000, 6 * 60 * 60 * 1000);
    this.endUri = this.queue.getCurrentTrack()?.uri ?? null;
    this.endTimer = setTimeout(() => {
      this.endTimer = null;
      this.onTrackMaybeEnded();
    }, wait);
    this.scheduleCrossfade(durationMs, positionMs);
  }

  /**
   * Opt-in (CROSSFADE_OVERLAP) true crossfade: shortly before `durationMs`, decode
   * the next decoded-source track's head and overlay it (ramped up) on the
   * current track's tail (which step A already fades out). The natural end then
   * hands off with a seek of `crossfadeMs` so the head is not replayed.
   * Spotify and unresolved/HLS next tracks keep the step-A fade.
   */
  private scheduleCrossfade(durationMs: number, positionMs: number): void {
    this.clearCrossfadeTimer();
    if (!config.crossfadeOverlap) return;
    const xfadeMs = config.crossfadeMs;
    if (xfadeMs <= 0) return;
    if (this.currentSource() === 'spotify' && !this.spotifyFallback) return;
    const snapshot = this.queue.getSnapshot();
    const next = snapshot.tracks[snapshot.currentIndex + 1];
    if (!next || next.source === 'spotify') return;
    const outgoingUri = this.queue.getCurrentTrack()?.uri ?? null;
    const plan = planCrossfade(durationMs, positionMs, this.currentStartOffsetMs, xfadeMs);
    if (!plan) return;
    this.crossfadeTimer = setTimeout(() => {
      this.crossfadeTimer = null;
      void this.startCrossfade(outgoingUri, next, xfadeMs);
    }, Math.min(plan.waitMs, 6 * 60 * 60 * 1000));
    this.crossfadeTimer.unref?.();
  }

  private async startCrossfade(outgoingUri: string | null, next: TrackInfo, xfadeMs: number): Promise<void> {
    // Need the already-resolved stream URL; preload normally warmed it. If it is
    // not cached yet, skip (step A still fades the tail) rather than resolve
    // synchronously here.
    const video = this.streamCache.get(next.uri);
    const url = video?.streamUrl ?? (next.source === 'local' ? next.filePath : undefined);
    if (!url) return;
    // Tempo-match the incoming head to the outgoing track when we have Spotify
    // features for both (best-effort with a short timeout — never blocks the blend).
    const [outTempo, inTempo] = await Promise.all([
      this.trackTempo(this.queue.getCurrentTrack()),
      this.trackTempo(next),
    ]);
    const ratio = tempoMatchRatio(outTempo, inTempo);
    const head = await this.voice.decodeHeadPcm(url, xfadeMs, ratio);
    if (!head) return;
    // The track may have changed while decoding — don't mix over the wrong song.
    if (!outgoingUri || this.queue.getCurrentTrack()?.uri !== outgoingUri) return;
    this.voice.queueSfxPcm(fadeInPcm(head, xfadeMs));
    // Stretching consumed `xfadeMs * ratio` of the incoming track's native time.
    this.pendingXfadeSeekMs = Math.round(xfadeMs * ratio);
  }

  /** Spotify tempo (BPM) for a track, best-effort (cached; short timeout). */
  private async trackTempo(track: TrackInfo | undefined): Promise<number | null> {
    if (!track?.uri?.startsWith('spotify:track:')) return null;
    try {
      const feat = await Promise.race([
        EW.fetchFeatures(track),
        new Promise<null>((resolve) => {
          const t = setTimeout(() => resolve(null), 1500);
          t.unref?.();
        }),
      ]);
      return feat?.tempo ?? null;
    } catch {
      return null;
    }
  }

  /** Pre-resolve the next track's stream URL so it can start with no yt-dlp delay. */
  private schedulePreload(durationMs: number, positionMs: number): void {
    this.clearPreloadTimer();
    const snapshot = this.queue.getSnapshot();
    const nextTrack = snapshot.tracks[snapshot.currentIndex + 1];
    if (!nextTrack) return;
    const nextIsYt = nextTrack.source === 'youtube' || nextTrack.source === 'suno' || nextTrack.source === 'soundcloud' || nextTrack.source === 'apple';
    // In prefer-YouTube mode a running librespot is irrelevant — Spotify tracks
    // still play via YouTube, so they need the same preload warming.
    const nextIsSpotifyFallback =
      nextTrack.source === 'spotify' && (config.spotifyPreferYoutube || !this.librespot?.isRunning());
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
        this.cacheSet(track.uri, video);
      } else if (track.source === 'spotify' || track.source === 'apple') {
        const query = `${track.name} ${(track.artists ?? []).join(' ')}`.trim();
        const video = await searchAndResolveYoutube(query, {
          name: track.name,
          artists: track.artists,
          durationMs: track.durationMs,
        });
        if (video) this.cacheSet(track.uri, video);
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
      const ended = { ...current };
      if (state.repeat) {
        this.replayCurrent();
        return;
      }
      this.next();
      if (this.onTrackEnd) this.onTrackEnd(ended);
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
    return src === 'youtube' || src === 'local' || src === 'direct' || src === 'suno' || src === 'soundcloud' || src === 'apple' || this.spotifyFallback;
  }

  /** Advance to the next track once a server-side stream naturally ends. */
  private serverStreamOnEnd(): () => void {
    const uri = this.currentUri;
    // Capture the track that is ending BEFORE we advance the queue, so the
    // Endless Wave onTrackEnd hook can record it (YouTube/SoundCloud/etc. paths
    // don't go through the position-timer and would otherwise never trigger EW).
    const endedTrack = this.queue.getCurrentTrack() ?? null;
    return () => {
      if (this.currentUri !== uri) return;
      if (this.spotifyFallback) {
        this.spotifyFallback = false;
      }
      if (this.queue.getState().repeat && this.queue.getCurrentTrack()) {
        this.replayCurrent();
        return;
      }
      this.next(true);
      if (this.onTrackEnd && endedTrack) this.onTrackEnd(endedTrack);
    };
  }

  async play(): Promise<void> {
    const generation = ++this.playGeneration;
    this.stopAmbient();
    this.clearSpotifyRetry();
    this.applyAudioFx();
    const current = this.queue.getCurrentTrack();
    if (!current) return;
    // Consume a pending crossfade handoff (set only on a natural end): the next
    // decoded track starts partway in, because its head already played as an
    // overlay on the outgoing track.
    const xfadeSeek = this.pendingXfadeSeekMs;
    this.pendingXfadeSeekMs = 0;
    this.currentStartOffsetMs = xfadeSeek > 0 && current.source !== 'spotify' ? xfadeSeek : 0;
    if (this.currentStartOffsetMs > 0) this.voice.setStreamOffset(this.currentStartOffsetMs);
    if (!this.voice.isJoined()) {
      throw new Error('I\'m not in a voice channel. Join one and try again.');
    }
    console.log(
      `[playback] start "${current.name}" (source=${current.source ?? '?'}${this.currentStartOffsetMs > 0 ? `, offset=${this.currentStartOffsetMs}ms` : ''})`,
    );
    this.tracksPlayed++;

    if (current.source === 'youtube') {
      await this.playYoutube(current);
      return;
    }

    if (current.source === 'local') {
      await this.playLocal(current);
      return;
    }

    if (current.source === 'direct') {
      await this.playDirect(current);
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
      if (generation !== this.playGeneration || this.queue.getCurrentTrack()?.uri !== current.uri) return;
      if (device) {
      this.spotifyDeviceId = device.id;
      this.currentUri = current.uri;
      // Proactively confirm the device is registered before issuing play. A
      // cheap local ping for go-librespot (restart only if it's actually gone),
      // so we usually avoid the 404-and-retry path entirely.
      if (this.librespot?.ensureDevice) {
        try {
          await this.librespot.ensureDevice();
        } catch {
          /* fall through — the play attempt below has its own retry */
        }
        if (generation !== this.playGeneration || this.queue.getCurrentTrack()?.uri !== current.uri) return;
      }
      if (device.viaLibrespot) {
        // Prime the PCM feed before issuing play so no initial audio is dropped.
        this.startSpotifyFeed();
      }
      try {
        await this.playOnDevice(device.id, current.uri);
        if (generation !== this.playGeneration || this.queue.getCurrentTrack()?.uri !== current.uri) {
          this.pauseSpotifyAny();
          return;
        }
        this.spotifyRetryAttempts = 0;
      } catch (err) {
        if (err instanceof SpotifyError && err.status === 404 && this.librespot?.ensureDevice) {
          // Device not registered (usually librespot mid-reconnect). Re-register
          // and retry the SAME track once before falling back to YouTube, so a
          // transient hiccup doesn't cascade into the fallback path.
          console.warn(`[playback] device not active — re-registering and retrying "${current.name}"`);
          try {
            this.stopSpotifyFeed();
            this.voice.stopStream();
            await this.librespot.ensureDevice();
            if (generation !== this.playGeneration || this.queue.getCurrentTrack()?.uri !== current.uri) return;
            this.startSpotifyFeed();
            await this.playOnDevice(device.id, current.uri);
            if (generation !== this.playGeneration || this.queue.getCurrentTrack()?.uri !== current.uri) {
              this.pauseSpotifyAny();
              return;
            }
            this.spotifyRetryAttempts = 0;
          } catch (retryErr) {
            this.stopSpotifyFeed();
            this.voice.stopStream();
            console.warn(
              `[playback] re-register/retry failed (${retryErr instanceof Error ? retryErr.message : retryErr}) — YouTube fallback for "${current.name}"`,
            );
            this.spotifyDeviceId = undefined;
            this.spotifyPlaybackBlockedUntil = Date.now() + 90 * 1000;
            await this.playYoutubeFallback(current, generation);
            return;
          }
        } else if (err instanceof SpotifyError && err.status === 404) {
          // Classic librespot (no ensureDevice): short block, then YouTube.
          this.stopSpotifyFeed();
          this.voice.stopStream();
          this.spotifyDeviceId = undefined;
          this.spotifyPlaybackBlockedUntil = Date.now() + 90 * 1000;
          console.warn(`[playback] device not active — YouTube fallback for "${current.name}"`);
          await this.playYoutubeFallback(current, generation);
          return;
        } else if (err instanceof SpotifyError && err.status === 429) {
          this.stopSpotifyFeed();
          this.voice.stopStream();
          this.spotifyDeviceId = undefined;
          console.warn(`[playback] Spotify app quota is rate-limited — using YouTube fallback for "${current.name}"`);
          await this.playYoutubeFallback(current, generation);
          return;
        } else if (err instanceof SpotifyError && !err.status) {
          this.stopSpotifyFeed();
          this.voice.stopStream();
          console.warn(`[playback] no Spotify OAuth token — using YouTube fallback for "${current.name}"`);
          this.spotifyDeviceId = undefined;
          this.spotifyPlaybackBlockedUntil = Date.now() + 10 * 60 * 1000;
          await this.playYoutubeFallback(current, generation);
          return;
        } else {
          this.stopSpotifyFeed();
          this.voice.stopStream();
          throw err;
        }
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

    await this.playYoutubeFallback(current, generation);
  }

  /**
   * Fire-and-forget play that can never leave an unhandled rejection. If a
   * track can't start (no device / no YouTube match / network blip), skip it
   * and keep the queue moving instead of stalling silently.
   */
  private safePlay(): void {
    void this.play().catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.playFailures++;
      console.warn(`[playback] track failed to start (${this.playFailures} in a row): ${msg}`);
      if (!this.voice.isJoined()) {
        // Not a track problem — leave the queue untouched for when we join.
        this.stopAll();
        this.queue.setState({ playing: false, track: undefined, positionMs: 0, durationMs: 0, source: undefined });
        return;
      }
      // A flaky backend (e.g. no Spotify device AND no YouTube match) used to
      // skip every track in turn, silently draining the queue. Stop instead and
      // surface it so the user knows why the music died.
      if (this.playFailures >= 3) {
        this.playFailures = 0;
        console.warn('[playback] 3 consecutive start failures — stopping instead of skipping the rest of the queue');
        this.stopAll();
        this.queue.setState({ playing: false });
        if (this.onPlaybackStalled) this.onPlaybackStalled();
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
        this.pauseSpotifyAny();
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
      this.currentUri = current.uri;
      this.currentVideo = video;
      this.lastYoutubeVideoId = video.videoId;
      this.queue.setState({
        playing: true,
        track: { ...current, image: video.image ?? current.image },
        durationMs: video.durationMs,
        positionMs: 0,
        source: 'youtube',
      });
      this.voice.playFfmpegUrl(video.streamUrl!, {
        durationMs: video.durationMs,
        volume: this.queue.getState().volume,
        onEnd: this.serverStreamOnEnd(),
        retries: 4,
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
  private async playYoutubeFallback(current: TrackInfo, generation: number): Promise<void> {
    const t0 = Date.now();
    console.log(
      `[playback] ${config.spotifyPreferYoutube ? 'prefer-YouTube mode' : 'no Spotify device'} — resolving "${current.name}" via YouTube`,
    );
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
    if (generation !== this.playGeneration || this.queue.getCurrentTrack()?.uri !== current.uri) return;
    if (!video) {
      throw new SpotifyError(`No Spotify device available and no YouTube match for "${current.name}".`);
    }
    // If the fallback resolves to the exact same YouTube video that just
    // played, treat it as a duplicate and skip. This prevents "the next song"
    // from being the same audio when Spotify recommendations/search return a
    // different track URI that happens to map to the same upload.
    if (this.lastYoutubeVideoId && video.videoId === this.lastYoutubeVideoId) {
      console.warn(`[playback] fallback for "${current.name}" resolved to the same YouTube video (${video.videoId}) as the previous track — skipping`);
      throw new SpotifyError(`Skipping "${current.name}" — it resolves to the same audio as the previous track.`);
    }
    this.currentUri = current.uri;
    this.currentVideo = video;
    this.lastYoutubeVideoId = video.videoId;
    this.spotifyFallback = true;
    const durationMs = this.cappedDuration(video.durationMs, current.durationMs);
    this.queue.setState({
      playing: true,
      track: current,
      durationMs,
      positionMs: 0,
      source: 'youtube',
    });
    this.voice.playFfmpegUrl(video.streamUrl!, {
      volume: this.queue.getState().volume,
      onEnd: this.serverStreamOnEnd(),
      retries: 4,
      refreshUrl: () => resolveYoutubeVideo(video.videoId).then((v) => v.streamUrl),
    });
    this.scheduleEnd(durationMs, 0);
    this.schedulePreload(durationMs, 0);
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
        this.pauseSpotifyAny();
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
      durationMs,
      volume: this.queue.getState().volume,
      onEnd: this.serverStreamOnEnd(),
      retries: 4,
      refreshUrl: () => Promise.resolve(filePath),
    });
    this.scheduleEnd(durationMs, 0);
    this.schedulePreload(durationMs, 0);
    this.startPositionTracker();
    this.sendVisualizer({ type: 'cmd', command: 'stop' });
  }

  /** Server-side playback of a direct audio/video file URL via ffmpeg. */
  private async playDirect(current: TrackInfo): Promise<void> {
    if (!current.streamUrl) throw new Error(`No stream URL for "${current.name}".`);
    this.spotifyFallback = false;
    this.stopSpotifyFeed();
    this.stopSpotifyProgress();
        this.pauseSpotifyAny();
    const durationMs = (await probeDuration(current.streamUrl)) ?? current.durationMs;
    this.currentUri = current.uri;
    this.queue.setState({
      playing: true,
      track: current,
      durationMs,
      positionMs: 0,
      source: 'direct',
    });
    this.voice.playFfmpegUrl(current.streamUrl, {
      durationMs,
      volume: this.queue.getState().volume,
      onEnd: this.serverStreamOnEnd(),
      retries: 4,
      refreshUrl: () => Promise.resolve(current.streamUrl!),
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
      this.cacheSet(current.uri, video);
    }
    this.spotifyFallback = false;
    this.stopSpotifyFeed();
    this.stopSpotifyProgress();
        this.pauseSpotifyAny();
    const durationMs = this.cappedDuration(video.durationMs, current.durationMs);
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
      durationMs,
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
      this.cacheSet(current.uri, video);
    }
    this.spotifyFallback = false;
    this.stopSpotifyFeed();
    this.stopSpotifyProgress();
        this.pauseSpotifyAny();
    const durationMs = this.cappedDuration(video.durationMs, current.durationMs);
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
      durationMs,
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
      this.cacheSet(current.uri, video);
    }
    this.spotifyFallback = false;
    this.stopSpotifyFeed();
    this.stopSpotifyProgress();
        this.pauseSpotifyAny();
    const durationMs = this.cappedDuration(video.durationMs, current.durationMs);
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
      durationMs,
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
        durationMs: track.durationMs,
        seekMs: positionMs,
        volume: this.queue.getState().volume,
        onEnd: this.serverStreamOnEnd(),
      });
      return;
    }
    const video = this.currentVideo;
    if (!video) return;
    this.voice.playFfmpegUrl(video.streamUrl!, {
      durationMs: video.durationMs,
      seekMs: positionMs,
      volume: this.queue.getState().volume,
      onEnd: this.serverStreamOnEnd(),
      retries: 4,
      refreshUrl: () => resolveYoutubeVideo(video.videoId).then((v) => v.streamUrl),
    });
  }

  private resolveSpotifyDevice(): Promise<{ id: string; name?: string; viaLibrespot: boolean } | null> {
    if (!this.librespot?.enabled) return Promise.resolve(null);
    // YouTube-first mode plays Spotify requests via the YouTube fallback, so no
    // Spotify API calls (device commands) happen at all.
    if (config.spotifyPreferYoutube) return Promise.resolve(null);
    if (Date.now() < this.spotifyPlaybackBlockedUntil) return Promise.resolve(null);
    // librespot process must actually be running before we try sending it a
    // Spotify Connect command — otherwise the API call wastes ~300-500 ms
    // failing with a 404 before falling back to YouTube.
    if (!this.librespot.isRunning()) return Promise.resolve(null);
    // go-librespot (soloist backend) plays through its own local HTTP API, so no
    // Web API device command / OAuth token is needed.
    if (this.librespot.playUri) {
      return Promise.resolve({ id: 'go-librespot', name: config.librespotDeviceName, viaLibrespot: true });
    }
    // librespot registers its Connect device with id = SHA1(device name), so we
    // don't need to hit the rate-limited /me/player/devices endpoint at all.
    const name = config.librespotDeviceName;
    const id = librespotDeviceId(name);
    return Promise.resolve({ id, name, viaLibrespot: true });
  }

  /** Start a track on the active backend: go-librespot's local API, or the
   *  Spotify Web API device command for librespot-org. */
  private async playOnDevice(deviceId: string, uri: string): Promise<void> {
    if (this.librespot?.playUri) {
      const ok = await this.librespot.playUri(uri);
      if (!ok) throw new SpotifyError('go-librespot could not start playback.');
      return;
    }
    await spotifyPlay(deviceId, [uri]);
  }

  /** Pause Spotify playback on whichever backend is active. */
  private pauseSpotifyAny(): void {
    if (this.librespot?.pausePlayback) {
      void this.librespot.pausePlayback();
      return;
    }
    // Web-API fallback. This used to call itself recursively, which blew the
    // stack whenever no backend supported pause — leaving the old track playing
    // (the "previous song keeps playing after stop/clear" bug).
    const dev = this.spotifyDeviceId;
    if (dev) {
      void import('./spotify.js')
        .then((m) => m.spotifyPause(dev))
        .catch(() => {});
    }
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
      ff = spawn(config.ffmpegPath, RESAMPLE_ARGS(this.audioFxFilter()), {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      this.resampler = ff;
      const fIn = ff.stdin!;
      const fOut = ff.stdout!;
      // ffmpeg can be killed or crash mid-stream (e.g. during a skip); without
      // error handlers a broken-pipe write here would take down the whole bot.
      fIn.on('error', (err) => {
        console.warn(`[playback] resampler stdin error: ${err instanceof Error ? err.message : err}`);
        if (this.resampler === ff) this.resampler = null;
        this.librespot?.pauseSocket();
      });
      fOut.on('error', (err) => {
        console.warn(`[playback] resampler stdout error: ${err instanceof Error ? err.message : err}`);
        if (this.resampler === ff) this.resampler = null;
        this.librespot?.pauseSocket();
      });
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
      // Socket resume alone can't revive a dead Spotify session (SESSION_DELETED
      // churn): re-issue the current track so play() re-takes the device or
      // falls back to YouTube. Debounced so a burst of stall warnings doesn't
      // hammer the play path.
      const state = this.queue.getState();
      // Near the end of the track the FIFO feed legitimately runs dry while the
      // buffered tail drains — let the end timer advance instead of re-seeking
      // (which used to fire a stale re-play even after the queue had ended).
      const pos = state.positionMs ?? 0;
      const dur = state.durationMs ?? 0;
      if (dur > 0 && pos >= dur - 8_000) return;
      if (state.track && state.playing && this.currentSource() === 'spotify' && !this.spotifyFallback) {
        const now = Date.now();
        if (!this.lastStallRecoveryAt || now - this.lastStallRecoveryAt > 20_000) {
          this.lastStallRecoveryAt = now;
          console.warn(`[playback] Spotify feed stalled — re-issuing "${state.track.name}"`);
          this.sendVisualizer({ type: 'cmd', command: 'stop' });
          void this.play().catch((err) => {
            console.warn(`[playback] stall re-issue failed: ${err instanceof Error ? err.message : err}`);
          });
        }
      }
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

  /** Build the `-af` stage for session audio FX from the current state. */
  private audioFxFilter(): string {
    const stages: string[] = [];
    if (this.bassBoostDb > 0) {
      // Corner at 150 Hz (not 100) so the shelf is actually audible on normal
      // speakers instead of only sub-bass. q=0.8 is a moderate, non-boomy slope.
      stages.push(`bass=g=${this.bassBoostDb.toFixed(1)}:f=150:width_type=q:width=0.8`);
    }
    if (this.speedFactor !== 1) {
      // asetrate shifts the sample-rate *field* only (pitch + tempo move
      // together); pre-resample to a known 48k so the factor is exact
      // regardless of the source's native rate, then aresample back out.
      const shifted = Math.round(48000 * this.speedFactor);
      stages.push(`aresample=48000,asetrate=${shifted},aresample=48000`);
    }
    return stages.join(',');
  }

  /** Push the current FX state into the voice layer (used on each stream start). */
  private applyAudioFx(): void {
    this.voice.setAudioFx(this.audioFxFilter());
  }

  /**
   * Set tempo plus pitch for the current session (/upbeat, /slowed, /normal).
   * Applied by re-issuing the current track after adjusting the ffmpeg chains,
   * while preserving our playback position.
   */
  setSpeed(factor: number): void {
    this.speedFactor = factor;
    this.queue.setState({ speed: factor });
    this.applyAudioFx();
    this.restartCurrent();
  }

  /** Toggle-style bass boost (adds a low-shelf to the session's ffmpeg chain). */
  setBassBoost(db: number): void {
    this.bassBoostDb = db;
    this.queue.setState({ bassBoost: db > 0 ? db : undefined });
    this.applyAudioFx();
    this.restartCurrent();
  }

  /** Re-apply audio FX by restarting the current track from its position. */
  private restartCurrent(): void {
    // Bass/speed are applied to the ffmpeg chain of the NEXT stream. We never
    // restart the current track: on the Spotify raw feed the resampler rebuild
    // can break the PCM feed, and on ffmpeg streams the seek + re-resolve can
    // stall the song - both read to the user as "the song stopped".
    this.applyAudioFx();
  }

  /** Queue-end intermission: play a quiet curated lo-fi/ambient track, looping
   *  until a real track resumes. Falls back to silence if it can't resolve. */
  async startAmbient(): Promise<void> {
    if (this.ambientActive) return;
    this.ambientActive = true;
    await this.playAmbientLoop();
  }

  private async playAmbientLoop(): Promise<void> {
    if (!this.ambientActive) return;
    const queries = PlaybackController.AMBIENT_QUERIES;
    const q = queries[this.ambientQueryIdx % queries.length];
    this.ambientQueryIdx++;
    try {
      const v = await searchAndResolveYoutube(q, {});
      if (!v?.streamUrl || !this.ambientActive) {
        this.ambientActive = false;
        return;
      }
      this.voice.playFfmpegUrl(v.streamUrl, {
        durationMs: v.durationMs,
        onEnd: () => {
          if (this.ambientActive) void this.playAmbientLoop();
        },
        refreshUrl: () => resolveYoutubeVideo(v.videoId).then((x) => x.streamUrl),
      });
    } catch {
      this.ambientActive = false;
    }
  }

  /** Stop the ambient intermission (a real track is starting). */
  stopAmbient(): void {
    this.ambientActive = false;
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
        if (this.onTrackEnd) {
          const ended = this.queue.getCurrentTrack();
          this.next();
          if (ended) this.onTrackEnd(ended);
        } else {
          this.next();
        }
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
  private deferSpotifyPlay(deviceId: string, current: TrackInfo, waitSec: number, generation: number): void {
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
      if (this.currentUri !== current.uri || this.playGeneration !== generation) return;
      try {
        await spotifyPlay(deviceId, [current.uri]);
      } catch (err) {
        if (this.currentUri !== current.uri) return;
        if (err instanceof SpotifyError && err.status === 429) {
           this.deferSpotifyPlay(deviceId, current, err.retryAfter ?? this.nextRetryWait(), generation);
          return;
        }
        if (err instanceof SpotifyError && err.status === 404) {
          this.spotifyDeviceId = undefined;
           await this.playYoutubeFallback(current, generation).catch(() => {});
          return;
        }
        if (err instanceof SpotifyError && !err.status) {
          console.warn(`[playback] deferred Spotify start: no OAuth token — using YouTube fallback for "${current.name}"`);
          this.spotifyDeviceId = undefined;
          await this.playYoutubeFallback(current, generation).catch(() => {});
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
    this.spotifyRetry!.unref?.();
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
    this.clearCrossfadeTimer();
    this.pendingXfadeSeekMs = 0;
    const tracks = this.queue.getSnapshot().tracks;
    if (index < 0 || index >= tracks.length) return false;
    while (this.queue.getCurrentTrack()?.uri !== tracks[index].uri) {
      if (!this.queue.next()) break;
    }
    this.safePlay();
    return true;
  }

  next(keepXfade = false): void {
    this.playGeneration++;
    this.clearPreloadTimer();
    this.clearCrossfadeTimer();
    // A manual skip invalidates a pending crossfade seek; a natural end keeps it.
    if (!keepXfade) this.pendingXfadeSeekMs = 0;
    this.lastSource = this.currentSource();
    if (!this.queue.next()) {
      const snap = this.queue.getSnapshot();
      console.log(`[playback] advance failed — queue ended (index ${snap.currentIndex} of ${snap.tracks.length})`);
      this.clearEndTimer();
      this.currentUri = null;
      this.spotifyFallback = false;
      this.sendVisualizer({ type: 'cmd', command: 'stop' });
          this.pauseSpotifyAny();
      this.stopSpotifyFeed();
      this.stopSpotifyProgress();
      this.stopPositionTracker();
      this.clearSpotifyRetry();
      // Keep the last track + the queue list visible when it runs out — only flip
      // off "playing". Wiping `track` here made the queue look like it had been
      // cleared, when really the user just reached the end and wants to replay.
      this.queue.setState({ playing: false });
      this.voice.stopStream();
      if (this.onQueueEnd) this.onQueueEnd();
      return;
    }
    this.clearEndTimer();
    const nextTrack = this.queue.getCurrentTrack();
    if (nextTrack) {
      // Publish the moved cursor before async Spotify/yt-dlp resolution finishes.
      this.queue.setState({ playing: false, track: nextTrack, durationMs: nextTrack.durationMs, positionMs: 0, source: nextTrack.source });
    }
    this.warmCacheAround(this.queue.getSnapshot().currentIndex);
    this.safePlay();
  }

  /**
   * Warm the stream-resolution cache around a queue index so a fast manual
   * skip / previous doesn't stall on a fresh yt-dlp resolve. The just-landed
   * track may already be mid-resolve by play(); prefetching only fills the
   * FOLLOWING one (the one a second skip would land on), which play() has no
   * reason to resolve yet. Cheap no-op when the cache is already warm.
   */
  private warmCacheAround(index: number): void {
    const snapshot = this.queue.getSnapshot();
    const warm = (i: number): void => {
      const t = snapshot.tracks[i];
      if (t && !this.streamCache.has(t.uri)) this.prefetchStream(t);
    };
    warm(index + 1);
  }

  previous(): void {
    this.playGeneration++;
    this.clearPreloadTimer();
    this.clearCrossfadeTimer();
    this.pendingXfadeSeekMs = 0;
    this.lastSource = this.currentSource();
    this.queue.previous();
    this.clearEndTimer();
    this.warmCacheAround(this.queue.getSnapshot().currentIndex);
    this.safePlay();
  }

  pause(): void {
    this.clearEndTimer();
    this.clearPreloadTimer();
    this.clearCrossfadeTimer();
    this.pendingXfadeSeekMs = 0;
    this.clearSpotifyRetry();
    if (this.usingServerStream()) {
      this.stopPositionTracker();
      this.queue.setState({ playing: false });
    } else if (this.spotifyDeviceId) {
      this.pauseSpotifyAny();
      this.voice.setExpectingPcm(false);
      this.queue.setState({ playing: false });
    }
    this.voice.pause();
  }

  /** Resume playback. If the stream has stalled (ffmpeg died), re-stream from
   *  the current position instead of just unpausing a dead pipe. */
  async resume(): Promise<void> {
    if (!this.voice.isJoined()) {
      console.warn('[playback] resume ignored — not in a voice channel');
      return;
    }
    // Stall recovery: stream died but voice is still connected — re-play from position.
    // (Position 0 counts too — a track that never produced audio must restart.)
    if (this.voice.isStalled()) {
      const state = this.queue.getState();
      const pos = state.positionMs || this.voice.getPositionMs();
      const track = state.track;
      if (track) {
        console.log(`[playback] stall detected — restarting "${track.name}" from ${Math.round(pos / 1000)}s`);
        this.sendVisualizer({ type: 'cmd', command: 'stop' });
        try {
          // A stall is usually a dropped Spotify dealer link, which also
          // unregisters the device. Re-register it before re-issuing so recovery
          // plays on Spotify instead of falling back to YouTube.
          await this.librespot?.ensureDevice?.();
        } catch {
          /* ignore */
        }
        try {
          await this.play();
          // seek to where we left off
          if (pos > 0) this.seek(pos);
          return;
        } catch (err) {
          console.warn(`[playback] stall recovery failed: ${err instanceof Error ? err.message : err}`);
          // Fall through to normal resume as last resort.
        }
      }
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
      if (this.librespot?.resumePlayback) void this.librespot.resumePlayback();
    else void spotifyResume(this.spotifyDeviceId).catch(() => {});
      const state = this.queue.getState();
      this.queue.setState({ playing: true });
      if (state.track) this.scheduleEnd(state.durationMs, state.positionMs);
      this.schedulePreload(state.durationMs, state.positionMs);
      this.voice.setExpectingPcm(true);
    }
    this.voice.resume();
  }

  async toggle(): Promise<void> {
    const state = this.queue.getState();
    if (state.playing) this.pause();
    else await this.resume();
  }

  seek(positionMs: number): void {
    const state = this.queue.getState();
    if (this.usingServerStream()) {
      this.seekServerStream(positionMs);
      this.queue.setState({ positionMs });
    } else if (this.spotifyDeviceId) {
      if (this.librespot?.seekMs) void this.librespot.seekMs(positionMs);
    else void spotifySeek(this.spotifyDeviceId, positionMs).catch(() => {});
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
    } else if (this.librespot?.setVolume) {
      // go-librespot applies volume through its own local API.
      void this.librespot.setVolume(v);
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

  /** Current session tempo factor (1 = normal; 1.25 = Nightcore; 0.85 = slowed). */
  getSpeed(): number {
    return this.speedFactor;
  }

  /** Current bass-boost gain in dB (0 = off). */
  getBassBoost(): number {
    return this.bassBoostDb;
  }

  /** Stop everything (queue cleared). */
  stopAll(): void {
    this.playGeneration++;
    this.clearEndTimer();
    this.clearPreloadTimer();
    this.clearCrossfadeTimer();
    this.pendingXfadeSeekMs = 0;
    this.currentStartOffsetMs = 0;
    this.streamCache.clear();
    this.spotifyFallback = false;
    this.lastSource = null;
    this.sendVisualizer({ type: 'cmd', command: 'stop' });
        this.pauseSpotifyAny();
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
    timer.unref?.();
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
