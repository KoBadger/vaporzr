import {
  AudioPlayer,
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnection,
  VoiceConnectionStatus,
  type AudioResource,
  type DiscordGatewayAdapterCreator,
} from '@discordjs/voice';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { config } from './config.js';

/**
 * User-Agent used when the bot itself (Node fetch) pulls a media stream.
 * googlevideo rejects plain client UAs, so we present a browser-like one.
 */
const STREAM_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

/**
 * Joins a Discord voice channel and streams raw PCM (48 kHz, stereo, Int16)
 * forwarded from the local loopback capture. The bot shows up as a normal
 * VC member and is the audio source for everyone in the channel.
 */
export class VoiceManager {
  private connection: VoiceConnection | null = null;
  private player: AudioPlayer | null = null;
  private stream: Transform | null = null;
  private resource: AudioResource | null = null;
  private ffmpeg: ChildProcess | null = null;
  /** Remaining 48 kHz stereo Int16 PCM of a sound effect to mix over the music. */
  private sfxBuffer: Buffer | null = null;
  /** Bumped whenever a stream is replaced so stale ffmpeg onEnd callbacks no-op. */
  private streamToken = 0;
  private streamStartTime = 0;
  private pausedPositionMs = 0;
  private channelId: string | null = null;
  private paused = false;
  private idleTimer: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private lastChunkAt = 0;
  private chunksSinceLog = 0;
  private bytesSinceLog = 0;
  /** True while the playback feed is expected to push PCM (arm/disarm from playback.ts). */
  private expectingPcm = false;
  /** Optional tap on every PCM chunk (audio:pcm broadcast to visualizer windows). */
  private pcmTap: ((data: Buffer) => void) | null = null;
  /** Dedicated spectrum-analyzer feed — independent of pcmTap so both coexist. */
  private spectrumTap: ((data: Buffer) => void) | null = null;
  /** Called when the active stream's write buffer drains (resume a paused source). */
  private onStreamDrain: (() => void) | null = null;
  /** Called after repeated stall warnings to try un-sticking the feed chain. */
  private onStallRecovery: (() => void) | null = null;
  private stallWarnings = 0;
  /** Called by playback when the voice link recovers to a Ready state. */
  private onVoiceReconnect: (() => void) | null = null;
  /** Periodic supervisor that force-rejoins a stuck voice link (bounded). */
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectStrikes = 0;
  private forcedRejoins = 0;
  private voiceLinkDown = false;
  /** Loudness applied to every new audio resource (0–100). */
  private volumePercent = 100;
  /** One-shot seek (ms) applied to the next decoded stream — crossfade handoff. */
  private streamOffsetMs = 0;
  /** Extra ffmpeg `-af` stage for session audio FX (e.g. nightcore/slowed/bass),
   *  appended after loudness normalization + fade-in. Empty when neutral. */
  private audioFx = '';
  /** Tail fade-out (seconds) applied to every decoded stream; 0 = hard cut. */
  private fadeOutSec = 2.5;
  /** Ducking: lower the music while channel members are speaking. */
  private duckEnabled = true;
  private duckFactor = 0.25;
  private duckHoldMs = 700;
  private duckSpeakers = new Set<string>();
  private duckTimer: NodeJS.Timeout | null = null;
  /** Music stays ducked until this timestamp (used over TTS announcements). */
  private duckForceUntil = 0;

  /** True when the voice connection is alive but the audio stream has died
   *  (ffmpeg crashed, pipe broken, etc.) — resume should re-stream instead of unpause. */
  isStalled(): boolean {
    return this.isJoined() && !this.paused && this.ffmpeg === null;
  }

  /** Auto-leave after this long with nothing playing. */
  static readonly IDLE_LEAVE_MS = 30 * 60 * 1000;
  /** ~1 second of 48 kHz stereo s16 PCM so bursts don't cause stutter. */
  static readonly STREAM_HIGH_WATER_MARK = 192_000;

  constructor(
    private onVoiceChange?: (joined: boolean, channelId: string | null) => void,
  ) {}

  setPcmTap(cb: ((data: Buffer) => void) | null): void {
    this.pcmTap = cb;
  }

  /** Session audio FX (nightcore/slowed/bass) applied to the next stream. */
  setAudioFx(fx: string): void {
    this.audioFx = fx;
  }

  /** Set the tail fade-out (seconds) applied to streams started from now on. */
  setFadeOut(sec: number): void {
    this.fadeOutSec = Math.max(0, Math.min(15, sec));
  }

  /** Set a one-shot start offset (ms) for the next decoded stream (crossfade). */
  setStreamOffset(ms: number): void {
    this.streamOffsetMs = Math.max(0, ms);
  }

  /** Feed the bot-side spectrum analyzer (separate slot from setPcmTap). */
  setSpectrumTap(cb: ((data: Buffer) => void) | null): void {
    this.spectrumTap = cb;
  }

  /** Re-point the join/leave notification (the bridge wires the primary session). */
  setOnVoiceChange(cb: (joined: boolean, channelId: string | null) => void): void {
    this.onVoiceChange = cb;
  }

  isJoined(): boolean {
    return this.connection !== null && this.connection.state.status !== VoiceConnectionStatus.Destroyed;
  }

  getChannelId(): string | null {
    return this.channelId;
  }

  /**
   * True while a live raw PCM feed stream is active (Spotify via librespot).
   * Server-side ffmpeg streams have this.ffmpeg set, so they return false.
   */
  isRawFeedActive(): boolean {
    return (
      this.ffmpeg === null &&
      this.stream !== null &&
      !this.stream.destroyed &&
      !this.stream.writableEnded &&
      this.stream.writable
    );
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  /** Start the auto-leave countdown; call this whenever playback goes idle. */
  private armIdleLeave(): void {
    this.clearIdleTimer();
    if (!this.isJoined()) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.isJoined()) {
        console.log('[voice] no audio for 30 minutes — leaving automatically');
        this.leave();
      }
    }, VoiceManager.IDLE_LEAVE_MS);
  }

  /** Cancel the idle auto-leave (e.g. while waiting out a Spotify rate-limit window). */
  cancelIdleLeave(): void {
    this.clearIdleTimer();
  }

  async join(guildId: string, channelId: string, adapterCreator: DiscordGatewayAdapterCreator): Promise<boolean> {
    this.leave();
    const connect = (): VoiceConnection => {
      const connection = joinVoiceChannel({ channelId, guildId, adapterCreator, selfDeaf: true });
      this.connection = connection;
      this.channelId = channelId;
      return connection;
    };
    const waitForReady = (connection: VoiceConnection): Promise<void> =>
      new Promise((resolve, reject) => {
        // Discord's voice gateway can be slow when the machine's DNS/network is
        // flaky, so give it a generous window and retry once below.
        const timer = setTimeout(() => reject(new Error('Timed out joining the voice channel.')), 20_000);
        timer.unref?.();
        connection.once(VoiceConnectionStatus.Ready, () => {
          clearTimeout(timer);
          resolve();
        });
        connection.once(VoiceConnectionStatus.Disconnected, () => {
          clearTimeout(timer);
          reject(new Error('Voice connection disconnected.'));
        });
      });

    let connection = connect();
    const attempts = 2;
    for (let attempt = 1; ; attempt++) {
      try {
        await waitForReady(connection);
        break;
      } catch (err) {
        if (attempt >= attempts) {
          this.leave();
          throw err;
        }
        console.warn(`[voice] join attempt ${attempt} failed (${err instanceof Error ? err.message : err}) — retrying`);
        try {
          connection.destroy();
        } catch {
          /* ignore */
        }
        await new Promise((resolve) => { const t = setTimeout(resolve, 1500); t.unref?.(); });
        connection = connect();
      }
    }

    this.player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
    connection.subscribe(this.player);
    this.attachHandlers(connection);
    this.player.on('error', (e) => {
      // A killed ffmpeg's tail packet can still hit the player after a
      // skip/stop. If the errored resource is not the current one, the
      // transition already replaced it — log nothing and, crucially, do NOT
      // stopStream() (that would tear down the NEW stream).
      const res = (e as { resource?: AudioResource | null }).resource;
      if (res && res !== this.resource) return;
      if (/write after end/.test(e.message)) return; // expected mid-teardown
      console.error('[voice] player error:', e.message);
      this.stopStream();
    });
    this.player.on('stateChange', (oldState, newState) => {
      // Only clear our stream/resource pointers when the resource that actually
      // ended is the one we started (a stale Idle from a stopped resource must
      // not clobber the pointers of a newer stream).
      if (newState.status === AudioPlayerStatus.Idle) {
        const endedResource = (oldState as { resource?: AudioResource | undefined }).resource;
        if (endedResource === this.resource) {
          this.stream = null;
          this.resource = null;
        }
      }
    });

    this.onVoiceChange?.(true, channelId);
    console.log(`[voice] joined voice channel ${channelId}`);
    this.armIdleLeave();
    this.startWatchdog();
    this.armReconnectSupervisor(guildId, channelId, adapterCreator);
    return true;
  }

  /** Playback registers this to be told when a downed voice link recovers to Ready. */
  setOnVoiceReconnect(cb: (() => void) | null): void {
    this.onVoiceReconnect = cb;
  }

  /**
   * Watches the live connection. Logs state transitions and, on a recovery to
   * Ready, notifies playback so an interrupted track can resume instead of the
   * queue silently skipping. Also rides out Disconnected; tears down only when
   * the library's own reconnect attempts fizzle.
   */
  private attachHandlers(connection: VoiceConnection): void {
    // Voice-activity ducking: the receiver's speaking map fires per user with
    // no audio decoding, so we can cheaply dip the music whenever anyone talks.
    if (this.duckEnabled && !(connection as unknown as { __vzDuck?: boolean }).__vzDuck) {
      (connection as unknown as { __vzDuck?: boolean }).__vzDuck = true;
      connection.receiver.speaking.on('start', (userId) => this.noteSpeaker(userId, true));
      connection.receiver.speaking.on('end', (userId) => this.noteSpeaker(userId, false));
    }
    connection.on('stateChange', (oldS, newS) => {
      if (newS.status === oldS.status) return;
      const reason = newS.status === VoiceConnectionStatus.Disconnected
        ? (newS as unknown as { reason?: string }).reason
        : undefined;
      console.log(
        `[voice] conn ${oldS.status} → ${newS.status}${reason ? ` (reason=${reason})` : ''}`,
      );
      if (newS.status === VoiceConnectionStatus.Ready && oldS.status !== VoiceConnectionStatus.Ready) {
        if (this.voiceLinkDown) {
          this.voiceLinkDown = false;
          this.forcedRejoins = 0;
          this.reconnectStrikes = 0;
          console.log('[voice] voice link recovered');
          this.onVoiceReconnect?.();
        }
      }
    });
    connection.on(VoiceConnectionStatus.Disconnected, () => {
      if (this.connection !== connection) return;
      void (async () => {
        try {
          await Promise.race([
            entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
            entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
          ]);
        } catch {
          console.warn('[voice] voice connection dropped — cleaning up');
          connection.destroy();
          if (this.connection === connection) {
            this.connection = null;
            this.channelId = null;
            this.stopStream();
            this.player?.stop();
            this.clearIdleTimer();
            this.stopReconnectSupervisor();
          }
        }
      })();
    });
  }

  /**
   * A ready connection is otherwise never watched again: a mid-play UDP drop
   * leaves @discordjs/voice stuck flapping between Signalling and Connecting
   * forever — every stream fails, the queue "skips" through the playlist, and
   * the bot sits in VC producing nothing. If the link hasn't reached Ready in
   * ~30s this forces a brand-new voice session; after several forced attempts
   * it gives up, leaves, and notifies playback via voice:update panels.
   */
  private armReconnectSupervisor(
    guildId: string,
    channelId: string,
    adapterCreator: DiscordGatewayAdapterCreator,
  ): void {
    this.clearReconnectChecks();
    this.reconnectStrikes = 0;
    this.forcedRejoins = 0;
    this.reconnectTimer = setInterval(() => {
      const c = this.connection;
      if (!c || c.state.status === VoiceConnectionStatus.Destroyed) {
        this.stopReconnectSupervisor();
        return;
      }
      const st = c.state.status;
      if (st === VoiceConnectionStatus.Ready) {
        this.reconnectStrikes = 0;
        this.voiceLinkDown = false;
        return;
      }
      this.voiceLinkDown = true;
      this.reconnectStrikes++;
      if (this.reconnectStrikes < 6) return; // give the library's own reconnect ~30s
      this.reconnectStrikes = 0;
      if (this.forcedRejoins >= 4) {
        console.warn('[voice] voice link unrecoverable after repeated rejoins — leaving');
        this.leave();
        return;
      }
      this.forcedRejoins++;
      console.warn(`[voice] voice link stuck — forcing fresh voice session (attempt ${this.forcedRejoins}/4)`);
      try {
        c.destroy();
      } catch {
        /* ignore */
      }
      const conn = joinVoiceChannel({ channelId, guildId, adapterCreator, selfDeaf: true });
      this.connection = conn;
      this.channelId = channelId;
      this.attachHandlers(conn);
      if (this.player) conn.subscribe(this.player);
    }, 5_000);
    this.reconnectTimer.unref?.();
  }

  private stopReconnectSupervisor(): void {
    this.clearReconnectChecks();
  }

  private clearReconnectChecks(): void {
    if (this.reconnectTimer) {
      clearInterval(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private startWatchdog(): void {
    this.clearWatchdog();
    this.watchdog = setInterval(() => {
      if (!this.isJoined()) return;
      if (this.chunksSinceLog > 0) {
        const hadStall = this.stallWarnings > 0;
        const mb = (this.bytesSinceLog / (1024 * 1024)).toFixed(2);
        this.chunksSinceLog = 0;
        this.bytesSinceLog = 0;
        this.lastChunkAt = Date.now();
        this.stallWarnings = 0;
        if (hadStall) {
          console.log(`[voice] streaming OK (recovered) — ${mb} MB since stall`);
        }
      } else if (this.ffmpeg) {
        // Server-side stream: silence is normal between tracks; don't warn.
      } else if (this.expectingPcm && Date.now() - this.lastChunkAt > 8000) {
        console.warn(
          '[voice] WARNING: expected audio but no chunks received in 8s — stream may be stalled',
        );
        this.lastChunkAt = Date.now();
        this.stallWarnings++;
        if (this.stallWarnings >= 3) {
          this.stallWarnings = 0;
          this.onStallRecovery?.();
        }
      }
    }, 5000);
  }

  private clearWatchdog(): void {
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
  }

  /** Arm/disarm the "audio expected" watchdog, set by the playback feed. */
  setExpectingPcm(expected: boolean): void {
    this.expectingPcm = expected;
    if (expected) this.lastChunkAt = Date.now();
    this.stallWarnings = 0;
  }

  leave(): void {
    this.clearIdleTimer();
    this.clearWatchdog();
    this.stopReconnectSupervisor();
    this.voiceLinkDown = false;
    this.stopStream();
    this.onVoiceChange?.(false, null);
    if (this.player) {
      this.player.stop();
      this.player = null;
    }
    if (this.connection) {
      try {
        this.connection.destroy();
      } catch {
        /* already destroyed */
      }
      this.connection = null;
    }
    this.channelId = null;
    const caller = new Error().stack?.split('\n').slice(2, 4).join(' | ').trim() ?? 'unknown';
    console.log(`[voice] left voice channel (via: ${caller})`);
  }

  /** Create a fresh streaming resource. Safe to call repeatedly. */
  startStream(): void {
    if (!this.player) return;
    this.clearIdleTimer();
    this.stopStream();
    const stream = this.makeMixStream();
    this.stream = stream;
    this.streamStartTime = Date.now();
    this.pausedPositionMs = 0;
    const resource = createAudioResource(stream, { inputType: StreamType.Raw, inlineVolume: true });
    this.resource = resource;
    this.applyVolumeToResource();
    this.player.play(resource);
    this.paused = false;
  }

  /** Generative ambient pad for an empty queue — synthesised live by ffmpeg
   *  (detuned sines + tremolo + echo). Runs until a real stream replaces it. */
  playAmbient(): void {
    if (!this.player) return;
    this.clearIdleTimer();
    this.stopStream();
    const freqs = [110, 164.81, 220, 329.63];
    const args = ['-hide_banner', '-loglevel', 'error'];
    for (const f of freqs) args.push('-f', 'lavfi', '-i', `sine=frequency=${f}:sample_rate=48000`);
    const ins = freqs.map((_, i) => `[${i}:a]`).join('');
    args.push(
      '-filter_complex',
      `${ins}amix=inputs=${freqs.length}:normalize=1,tremolo=f=0.12:d=0.6,lowpass=f=1400,aecho=0.8:0.9:600|900:0.35|0.25,volume=0.45,afade=t=in:st=0:d=4`,
      '-ac', '2', '-ar', '48000', '-f', 's16le', 'pipe:1',
    );
    const proc = spawn(config.ffmpegPath, args, { windowsHide: true });
    this.ffmpeg = proc;
    this.streamStartTime = Date.now();
    this.pausedPositionMs = 0;
    const stream = this.makeMixStream();
    this.stream = stream;
    proc.stdout.on('data', (d) => {
      this.chunksSinceLog++;
      this.bytesSinceLog += d.length;
    });
    proc.stderr.on('data', (d) => {
      const l = d.toString().trim();
      if (l) console.warn(`[voice] ambient: ${l.slice(0, 200)}`);
    });
    proc.stdout.pipe(stream);
    const resource = createAudioResource(stream, { inputType: StreamType.Raw, inlineVolume: true });
    this.resource = resource;
    this.applyVolumeToResource();
    this.player.play(resource);
    this.paused = false;
    proc.on('exit', () => {
      if (this.ffmpeg === proc) this.ffmpeg = null;
    });
    console.log('[voice] ambient intermission started');
  }

  /** Crossfade two source URLs into one continuous mix (ffmpeg acrossfade). */
  playMix(
    urlA: string,
    urlB: string,
    opts: { crossfadeSec?: number; volume?: number; cleanup?: string[] } = {},
  ): void {
    if (!this.player) return;
    this.clearIdleTimer();
    this.stopStream();
    const d = Math.max(2, Math.min(20, opts.crossfadeSec ?? 6));
    const filter =
      `[0:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a0];` +
      `[1:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a1];` +
      `[a0][a1]acrossfade=d=${d}:c1=tri:c2=tri[out]`;
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-i', urlA, '-i', urlB,
      '-filter_complex', filter,
      '-map', '[out]', '-vn', '-ac', '2', '-ar', '48000', '-f', 's16le', 'pipe:1',
    ];
    const proc = spawn(config.ffmpegPath, args, { windowsHide: true });
    this.ffmpeg = proc;
    this.streamStartTime = Date.now();
    this.pausedPositionMs = 0;
    const stream = this.makeMixStream();
    this.stream = stream;
    proc.stdout.on('data', (d) => {
      this.chunksSinceLog++;
      this.bytesSinceLog += d.length;
    });
    proc.stderr.on('data', (d) => {
      const l = d.toString().trim();
      if (l) console.warn(`[voice] mix: ${l.slice(0, 200)}`);
    });
    proc.stdout.pipe(stream);
    const resource = createAudioResource(stream, { inputType: StreamType.Raw, inlineVolume: true });
    this.resource = resource;
    if (opts.volume !== undefined) this.volumePercent = opts.volume;
    this.applyVolumeToResource();
    this.player.play(resource);
    this.paused = false;
    proc.on('exit', () => {
      if (this.ffmpeg === proc) this.ffmpeg = null;
      for (const f of opts.cleanup ?? []) {
        try {
          fs.rmSync(f, { force: true });
        } catch {
          /* ignore */
        }
      }
    });
    console.log(`[voice] crossfade mix started (${d}s)`);
  }

  /** Set the callback fired when the active stream can accept more PCM again. */
  setStreamDrain(cb: (() => void) | null): void {
    this.onStreamDrain = cb;
  }

  /** Set the callback fired after repeated "audio expected but none received" warnings. */
  setStallRecovery(cb: (() => void) | null): void {
    this.onStallRecovery = cb;
  }

  /** Mix a short sound effect (48 kHz stereo Int16 PCM) over the current audio. */
  queueSfxPcm(data: Buffer): void {
    if (!this.player) return;
    this.sfxBuffer = data;
  }

  /** Sum two Int16 PCM chunks sample-by-sample (clamped), consuming the SFX tail. */
  private mixSfx(chunk: Buffer): Buffer {
    const sfx = this.sfxBuffer;
    if (!sfx || sfx.length === 0) {
      this.sfxBuffer = null;
      return chunk;
    }
    const out = Buffer.allocUnsafe(chunk.length);
    const mixSamples = Math.floor(Math.min(chunk.length, sfx.length) / 2);
    for (let i = 0; i < mixSamples; i++) {
      const a = chunk.readInt16LE(i * 2);
      const b = sfx.readInt16LE(i * 2);
      out.writeInt16LE(Math.max(-32768, Math.min(32767, a + b)), i * 2);
    }
    if (mixSamples * 2 < chunk.length) chunk.copy(out, mixSamples * 2, mixSamples * 2);
    this.sfxBuffer = sfx.length > mixSamples * 2 ? sfx.subarray(mixSamples * 2) : null;
    return out;
  }

  /** The audio pipeline: mixes sound effects in, then taps the analyzer, then feeds the player. */
  private makeMixStream(): Transform {
    const stream = new Transform({
      highWaterMark: VoiceManager.STREAM_HIGH_WATER_MARK,
      transform: (chunk, _enc, cb) => {
        if (stream.writableEnded || stream.destroyed) return;
        const out = this.mixSfx(chunk as Buffer);
        this.pcmTap?.(out);
        this.spectrumTap?.(out);
        cb(null, out);
      },
    });
    stream.on('drain', () => {
      this.onStreamDrain?.();
    });
    // A late chunk from a killed ffmpeg can still race a just-ended stream.
    // Swallow it instead of letting an unhandled 'error' take the process down.
    // ERR_STREAM_WRITE_AFTER_END and ERR_STREAM_PREMATURE_CLOSE are the normal
    // signature of a skip/stop tearing the pipe down — expected, not noise.
    stream.on('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      const msg = err instanceof Error ? err.message : String(err);
      if (code.startsWith('ERR_STREAM_WRITE_AFTER_END') || code === 'ERR_STREAM_PREMATURE_CLOSE'
        || /premature close|write after end/i.test(msg)) return;
      if (err) console.warn(`[voice] mix stream error: ${msg}`);
    });
    return stream;
  }

  /**
   * Stream a URL (yt-dlp direct link) into the VC via ffmpeg → 48 kHz stereo PCM.
   *
   * For http(s) URLs the media is downloaded by Node itself and piped into
   * ffmpeg's stdin: googlevideo 403s ffmpeg's own HTTPS client (TLS
   * fingerprinting) and rejects requests without a `Range` header — Node's
   * fetch with `Range: bytes=0-` satisfies both. ffmpeg never touches the
   * network for streamed URLs.
   *
   * googlevideo intermittently answers 403 for signed stream URLs (YouTube's
   * anti-scraping throttle). When `refreshUrl` is provided the stream is
   * transparently re-resolved and retried a bounded number of times, so a
   * flaky 403 doesn't kill the track.
   */
  playFfmpegUrl(
    url: string,
    opts: {
      seekMs?: number;
      volume?: number;
      onEnd?: () => void;
      retries?: number;
      refreshUrl?: () => Promise<string>;
      /** Track length, used to schedule the tail fade-out. */
      durationMs?: number;
    } = {},
  ): void {
    if (!this.player) {
      console.warn('[voice] not in a voice channel — cannot stream');
      return;
    }
    this.clearIdleTimer();
    this.stopStream();
    const token = this.streamToken;
    const startedAt = Date.now();
    // Consume a one-shot start offset (a crossfade hands off partway into the
    // incoming track). Explicit opts.seekMs (resume) always wins.
    const requestedSeekMs = opts.seekMs ?? this.streamOffsetMs;
    this.streamOffsetMs = 0;
    console.log(
      `[voice] stream start ${requestedSeekMs > 0 ? `(seek ${requestedSeekMs}ms) ` : ''}retries=${opts.retries ?? 0} refresh=${opts.refreshUrl ? 'yes' : 'no'} · ${String(url).slice(0, 96).replace(/\s+/g, ' ')}`,
    );
    const isHttp = /^https?:\/\//i.test(url);
    // HLS playlists (SoundCloud serves .m3u8) must be demuxed by ffmpeg itself —
    // piping the playlist bytes into stdin produces noise, not audio.
    const isHls = isHttp && /\.m3u8(\?|$)/i.test(url);
    // googlevideo stream URLs are IP-bound to the IP that resolved them, so
    // when YouTube traffic is proxied, ffmpeg must fetch through that same
    // proxy (node's fetch can't honor http_proxy). For those URLs ffmpeg
    // reads the URL directly — the env below carries the proxy.
    const useYtProxy = !!config.youtubeProxy && /googlevideo\.com\//.test(url);
    // Suno's CDN blocks datacenter IPs too — when a Suno proxy is configured,
    // ffmpeg fetches the cdn1.suno.ai URL through it.
    const useSunoProxy = !!config.sunoProxy && /cdn1\.suno\.ai\//.test(url);
    // Suno's real media is a public CloudFront m4a: let ffmpeg fetch it directly
    // (piping MP4 through stdin can fail when the moov atom isn't at the front).
    const isSunoMedia = /(^|[./])cloudfront\.net\//.test(url) && /\/clip\//.test(url);
    const fetchSelf = isHttp && !isHls && !useYtProxy && !useSunoProxy && !isSunoMedia;
    const args = ['-hide_banner', '-loglevel', 'error'];
    if (fetchSelf) {
      // stdin is not seekable, so a resume seek runs on the output side
      // (decode + discard); opus/aac decoding is far faster than realtime.
      args.push('-i', 'pipe:0');
      if (requestedSeekMs) args.push('-ss', String(requestedSeekMs / 1000));
    } else {
      if (requestedSeekMs) args.push('-ss', String(requestedSeekMs / 1000));
      args.push('-i', url);
    }
    args.push('-vn', '-ac', '2', '-ar', '48000');
    // Force consistent loudness across every source (YouTube/SoundCloud/local/
    // Apple/Suno). Without this, a hot-mastered YouTube upload can be far louder
    // than a Spotify track that already lands at ~-14 LUFS. Single-pass dynamic
    // mode keeps latency low while still riding gain to the target — but it is
    // reactive, so the first ~1-3s pass through un-attenuated; the short fade-in
    // stops hot intros from punching through before the gain rider catches up.
    const filters = ['loudnorm=I=-14:TP=-1.5:LRA=11', 'afade=t=in:st=0:d=0.4'];
    // Tail fade so a track eases out instead of cutting off. Sits downstream of
    // loudnorm; skipped for very short tracks, resumes near the end, or when off.
    const fade = this.fadeOutSec;
    if (fade > 0 && opts.durationMs && opts.durationMs > 0) {
      const remainSec = (opts.durationMs - requestedSeekMs) / 1000;
      if (remainSec > fade + 0.5) {
        filters.push(`afade=t=out:st=${(remainSec - fade).toFixed(3)}:d=${fade}`);
      }
    }
    if (this.audioFx) filters.push(this.audioFx);
    args.push('-af', filters.join(','));
    args.push('-f', 's16le', 'pipe:1');

    // Strip ambient proxy vars (Windows system proxies break yt-dlp/ffmpeg),
    // then re-add ours for proxied YouTube fetches — ffmpeg's http protocol
    // reads the lowercase `http_proxy` env and CONNECT-tunnels https.
    const ffEnv = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !k.toLowerCase().endsWith('_proxy')),
    );
    if (useYtProxy) ffEnv.http_proxy = config.youtubeProxy;
    else if (useSunoProxy) ffEnv.http_proxy = config.sunoProxy;
    const proc = spawn(config.ffmpegPath, args, { windowsHide: true, env: ffEnv });
    this.ffmpeg = proc;
    this.streamStartTime = Date.now();
    this.pausedPositionMs = requestedSeekMs;
    const stream = this.makeMixStream();
    this.stream = stream;
    proc.stdout.on('data', (d) => {
      this.chunksSinceLog++;
      this.bytesSinceLog += d.length;
    });
    // Surface ffmpeg's own errors (connection refused, 403, bad URL, …) — they
    // were previously swallowed and every stream looked like a generic "cut short".
    proc.stderr.on('data', (d) => {
      const line = d.toString().trim();
      if (!line) return;
      console.warn(`[voice] ffmpeg: ${line.slice(0, 800)}`);
      // Detect critical errors and trigger retry/refresh if applicable.
      const l = line.toLowerCase();
      if ((l.includes('403') || l.includes('429') || l.includes('connection refused') || l.includes('connection reset') || l.includes('http error')) && token === this.streamToken) {
        console.warn('[voice] critical ffmpeg error detected — will attempt stream refresh on exit');
        proc.emit('ffmpeg-critical-error');
      }
    });
    proc.stdout.pipe(stream);
    if (fetchSelf) this.fetchIntoStdin(url, proc, token);
    const resource = createAudioResource(stream, { inputType: StreamType.Raw, inlineVolume: true });
    this.resource = resource;
    if (opts.volume !== undefined) this.volumePercent = opts.volume;
    this.applyVolumeToResource();
    this.player.play(resource);
    this.paused = false;
    proc.on('exit', (code, signal) => {
      if (token !== this.streamToken) {
        console.warn(`[voice] stale ffmpeg exit ignored (code ${code}${signal ? ` ${signal}` : ''})`);
        return;
      }
      if (code !== 0) {
        console.warn(`[voice] ffmpeg exited with code ${code}${signal ? ` (${signal})` : ''} — stream cut short`);
        const ranForMs = Date.now() - startedAt;
        const attemptsLeft = (opts.retries ?? 0) - 1;
        if (opts.refreshUrl && attemptsLeft >= 0) {
          // A signed YouTube URL can fail after minutes of otherwise healthy
          // playback. Refresh it and resume near the last known position rather
          // than treating a mid-track failure as a natural end and skipping.
          const resumeMs = requestedSeekMs + Math.max(0, ranForMs - 250);
          console.warn(
            `[voice] stream failed after ${ranForMs}ms — refreshing URL and resuming at ${Math.round(resumeMs)}ms (${attemptsLeft} retries left)`,
          );
          this.ffmpeg = null;
          const rt = setTimeout(() => {
            opts.refreshUrl!()
              .then((newUrl) => {
                this.playFfmpegUrl(newUrl, { ...opts, seekMs: resumeMs, retries: attemptsLeft });
              })
              .catch((err) => {
                const msg = err instanceof Error ? err.message : String(err);
                console.warn(`[voice] could not refresh stream URL: ${msg}`);
                this.ffmpeg = null;
                if (opts.onEnd) opts.onEnd();
              });
          }, 1500);
          rt.unref?.();
          return;
        }
      }
      this.ffmpeg = null;
      if (opts.onEnd) opts.onEnd();
    });
    proc.on('error', (err) => {
      console.warn(`[voice] ffmpeg failed to start: ${err.message}`);
      if (token !== this.streamToken) return;
      if (this.ffmpeg !== proc) return; // already replaced
      this.ffmpeg = null;
      if (opts.onEnd) opts.onEnd();
    });
    // If stderr detected a critical error, attempt refresh immediately on exit
    // rather than waiting for the exit handler to decide.
    proc.on('ffmpeg-critical-error', () => {
      if (token !== this.streamToken) return;
      if (this.ffmpeg !== proc) return;
      if (opts.refreshUrl && (opts.retries ?? 0) > 0) {
        proc.kill('SIGTERM'); // will trigger exit handler with retry logic
      }
    });
  }

  /**
   * Download `url` in Node and pipe it into ffmpeg's stdin. googlevideo
   * currently rejects requests whose `Range` header is missing, open-ended
   * (`bytes=0-`), or larger than ~256 KiB, so the file is fetched as a
   * series of bounded 256 KiB chunks. `Readable.from` + `pipe` apply
   * backpressure so only a couple of chunks buffer ahead of ffmpeg's
   * (realtime-paced) consumption. The download aborts as soon as ffmpeg
   * exits; download failures close stdin, which makes ffmpeg exit and
   * triggers the caller's refreshUrl retry path.
   */
  private fetchIntoStdin(url: string, proc: ChildProcess, token: number): void {
    const CHUNK_BYTES = 256 * 1024;
    const abort = new AbortController();
    proc.on('exit', () => abort.abort());
    // EPIPE is expected when ffmpeg is killed mid-download (skip/stop).
    proc.stdin?.on('error', () => {});

    async function* chunks(): AsyncGenerator<Buffer> {
      let offset = 0;
      for (;;) {
        const res = await fetch(url, {
          headers: {
            'User-Agent': STREAM_USER_AGENT,
            Range: `bytes=${offset}-${offset + CHUNK_BYTES - 1}`,
          },
          signal: abort.signal,
        });
        if (res.status === 416) return; // requested past EOF — track fully fetched
        if (res.status !== 206 && res.status !== 200) throw new Error(`HTTP ${res.status}`);
        const chunk = Buffer.from(await res.arrayBuffer());
        if (chunk.length === 0) return;
        const contentRange = res.headers.get('content-range'); // "bytes start-end/total"
        const total = contentRange ? Number(contentRange.split('/')[1]) : NaN;
        offset += chunk.length;
        yield chunk;
        if (Number.isFinite(total) ? offset >= total : chunk.length < CHUNK_BYTES) return;
      }
    }

    const source = Readable.from(chunks(), { highWaterMark: 2 });
    source.on('error', (err) => {
      if (token !== this.streamToken) return;
      console.warn(`[voice] stream download failed: ${err instanceof Error ? err.message : err}`);
      source.destroy();
      // EOF can make ffmpeg exit with code 0, which looks like a natural track
      // end and skips the song. Kill it as a failed stream so playFfmpegUrl's
      // refresh/resume path gets a chance to recover instead.
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
    });
    source.pipe(proc.stdin!);
  }

  /**
   * Decode the first `ms` of a stream/file to 48 kHz stereo PCM — used to
   * pre-render the incoming track's head for a crossfade. Node-fetches http
   * sources (avoids the googlevideo TLS-fingerprint 403 the normal path dodges);
   * returns null for HLS playlists or on any failure so callers fall back.
   */
  async decodeHeadPcm(url: string, ms: number): Promise<Buffer | null> {
    const seconds = Math.max(0.5, ms / 1000);
    const maxBytes = Math.ceil(seconds * 48000) * 4;
    const isHttp = /^https?:\/\//i.test(url);
    const isHls = isHttp && /\.m3u8(\?|$)/i.test(url);
    if (isHls) return null;
    const args = ['-hide_banner', '-loglevel', 'error'];
    if (isHttp) args.push('-i', 'pipe:0', '-t', String(seconds));
    else args.push('-t', String(seconds), '-i', url);
    args.push('-vn', '-ac', '2', '-ar', '48000', '-f', 's16le', 'pipe:1');
    return await new Promise<Buffer | null>((resolve) => {
      let settled = false;
      const out: Buffer[] = [];
      let size = 0;
      let proc: ChildProcess;
      try {
        proc = spawn(config.ffmpegPath, args, { windowsHide: true });
      } catch {
        resolve(null);
        return;
      }
      const finish = (buf: Buffer | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          proc.kill();
        } catch {
          /* ignore */
        }
        resolve(buf);
      };
      const timer = setTimeout(() => finish(null), Math.min(10_000, 3000 + seconds * 1000));
      timer.unref?.();
      proc.stdout?.on('data', (d: Buffer) => {
        if (size >= maxBytes) return;
        out.push(d);
        size += d.length;
        if (size >= maxBytes) finish(Buffer.concat(out).subarray(0, maxBytes));
      });
      proc.stderr?.on('data', () => {});
      proc.on('error', () => finish(null));
      proc.on('exit', () => finish(out.length ? Buffer.concat(out).subarray(0, maxBytes) : null));
      if (isHttp) {
        void this.fetchHeadIntoStdin(url, proc, Math.max(maxBytes * 6, 1_500_000));
      } else {
        try {
          proc.stdin?.end();
        } catch {
          /* ignore */
        }
      }
    });
  }

  private async fetchHeadIntoStdin(url: string, proc: ChildProcess, maxSourceBytes: number): Promise<void> {
    const abort = new AbortController();
    proc.on('exit', () => abort.abort());
    proc.stdin?.on('error', () => {});
    const CHUNK = 256 * 1024;
    try {
      let offset = 0;
      while (offset < maxSourceBytes) {
        const res = await fetch(url, {
          headers: { 'User-Agent': STREAM_USER_AGENT, Range: `bytes=${offset}-${offset + CHUNK - 1}` },
          signal: abort.signal,
        });
        if (res.status === 416) break;
        if (res.status !== 206 && res.status !== 200) break;
        const chunk = Buffer.from(await res.arrayBuffer());
        if (!chunk.length) break;
        offset += chunk.length;
        const stdin = proc.stdin;
        if (!stdin || stdin.destroyed) break;
        if (!stdin.write(chunk)) await new Promise<void>((r) => stdin.once('drain', () => r()));
        if (chunk.length < CHUNK) break;
      }
    } catch {
      /* aborted or network error — ffmpeg flushes whatever it got */
    }
    try {
      proc.stdin?.end();
    } catch {
      /* ignore */
    }
  }

  /** Set the loudness of the active server-side stream (0–100). */
  setVolume(volumePercent: number): void {
    const v = Math.max(0, Math.min(100, volumePercent));
    this.volumePercent = v;
    this.applyVolumeToResource();
  }

  private applyVolumeToResource(): void {
    this.resource?.volume?.setVolume(this.effectiveVolumePercent() / 100);
  }

  private isDucking(): boolean {
    return this.duckEnabled && (this.duckSpeakers.size > 0 || Date.now() < this.duckForceUntil);
  }

  /** Force-duck the music for a fixed window (e.g. over a TTS announcement). */
  duckFor(ms: number): void {
    if (ms <= 0) return;
    this.duckForceUntil = Math.max(this.duckForceUntil, Date.now() + ms);
    this.applyVolumeToResource();
    const t = setTimeout(() => {
      if (Date.now() >= this.duckForceUntil) {
        this.duckForceUntil = 0;
        this.applyVolumeToResource();
      }
    }, ms + 60);
    t.unref?.();
  }

  private effectiveVolumePercent(): number {
    return this.isDucking() ? this.volumePercent * this.duckFactor : this.volumePercent;
  }

  /** Track a speaker; duck while anyone talks, release after a short hold. */
  private noteSpeaker(userId: string, talking: boolean): void {
    if (!this.duckEnabled) return;
    if (talking) this.duckSpeakers.add(userId);
    else this.duckSpeakers.delete(userId);
    if (this.duckTimer) {
      clearTimeout(this.duckTimer);
      this.duckTimer = null;
    }
    if (this.duckSpeakers.size > 0) {
      this.applyVolumeToResource();
    } else {
      // Release shortly after the last speaker stops so short gaps don't pump.
      this.duckTimer = setTimeout(() => {
        this.duckTimer = null;
        this.duckSpeakers.clear();
        this.applyVolumeToResource();
      }, this.duckHoldMs);
      this.duckTimer.unref?.();
    }
  }

  /** Enable/disable voice-activity ducking for this session. */
  setDucking(enabled: boolean): void {
    this.duckEnabled = enabled;
    if (!enabled) {
      this.duckSpeakers.clear();
      if (this.duckTimer) {
        clearTimeout(this.duckTimer);
        this.duckTimer = null;
      }
    }
    this.applyVolumeToResource();
  }

  /** Playback position (ms) of the ffmpeg-backed stream, or 0 for raw feeds. */
  getPositionMs(): number {
    if (!this.ffmpeg) return 0;
    const elapsed = this.streamStartTime > 0 ? Date.now() - this.streamStartTime : 0;
    return Math.max(0, this.pausedPositionMs + elapsed);
  }

  stopStream(): void {
    this.streamToken++;
    if (this.ffmpeg) {
      // Detach ffmpeg's stdout before killing it. Otherwise its pipe can keep
      // writing into the stream we're about to end, which surfaces as a
      // "write after end" AudioPlayer error (seen when DJ buttons fired during
      // a track transition / stop).
      try {
        this.ffmpeg.stdout?.destroy();
      } catch {
        /* ignore */
      }
      try {
        this.ffmpeg.kill();
      } catch {
        /* ignore */
      }
      this.ffmpeg = null;
    }
    if (this.stream) {
      try {
        this.stream.end();
      } catch {
        /* already ended */
      }
      this.stream = null;
    }
    this.resource = null;
    if (this.player && this.player.state.status !== AudioPlayerStatus.Idle) {
      this.player.stop();
    }
    this.armIdleLeave();
  }

  /** Write a raw PCM chunk (48 kHz stereo Int16) into the active stream. Returns false when full. */
  feedPcm(data: Buffer): boolean {
    if (!this.stream || this.paused) return true;
    if (!this.stream.writableEnded && this.stream.writable) {
      const ok = this.stream.write(data);
      this.chunksSinceLog++;
      this.bytesSinceLog += data.length;
      return ok;
    }
    return true;
  }

  pause(): void {
    if (this.ffmpeg && this.streamStartTime > 0) {
      this.pausedPositionMs += Date.now() - this.streamStartTime;
      this.streamStartTime = 0;
    }
    this.paused = true;
    this.player?.pause();
    this.armIdleLeave();
  }

  resume(): void {
    if (this.ffmpeg) this.streamStartTime = Date.now();
    this.paused = false;
    this.clearIdleTimer();
    this.player?.unpause();
  }
}
