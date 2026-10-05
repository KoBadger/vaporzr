/**
 * The transport boundary between the playback engine and however audio is
 * actually delivered. `PlaybackController` depends only on this interface, so
 * the same engine can drive Discord voice (`VoiceManager`) or the Telegram Mini
 * App PCM fan-out (a future `WebTransport`) with no engine changes.
 *
 * Every method here is one the engine already calls on `VoiceManager`; this is
 * the extracted contract, not new behaviour. (Phase 1 of the Telegram plan moves
 * this file to `packages/core/src/transport.ts`.)
 */
export interface AudioTransport {
  // ---- lifecycle / state ----
  /** A listener destination is attached (Discord: in a voice channel; Telegram: a Mini App subscribed). */
  isJoined(): boolean;
  /** The feed has stalled and a restart/recovery is warranted. */
  isStalled(): boolean;
  /** Audio is arriving via the raw PCM feed (Spotify/librespot path). */
  isRawFeedActive(): boolean;
  /** Current playback position in ms, derived from the feed. */
  getPositionMs(): number;
  /** Cancel a pending idle-leave (a command or track start counts as activity). */
  cancelIdleLeave(): void;

  // ---- server-side stream playback (ffmpeg -> transport) ----
  playFfmpegUrl(
    url: string,
    opts?: {
      seekMs?: number;
      volume?: number;
      onEnd?: () => void;
      retries?: number;
      refreshUrl?: () => Promise<string>;
      /** Track length, used to schedule the tail fade-out. */
      durationMs?: number;
    },
  ): void;
  stopStream(): void;

  // ---- raw PCM feed (Spotify/librespot path) ----
  startStream(): void;
  feedPcm(data: Buffer): boolean;
  setStreamDrain(cb: (() => void) | null): void;
  setExpectingPcm(expected: boolean): void;

  // ---- effects / mixing ----
  setAudioFx(fx: string): void;
  setVolume(volumePercent: number): void;
  setStreamOffset(ms: number): void;
  queueSfxPcm(data: Buffer): void;
  suppressCurrentTailFade(minRemainingMs: number): void;
  decodeHeadPcm(url: string, ms: number, tempo?: number): Promise<Buffer | null>;

  // ---- callbacks / taps ----
  setOnVoiceReconnect(cb: (() => void) | null): void;
  setStallRecovery(cb: (() => void) | null): void;
  setSpectrumTap(cb: ((data: Buffer) => void) | null): void;

  // ---- pause / resume ----
  pause(): void;
  resume(): void;
}
