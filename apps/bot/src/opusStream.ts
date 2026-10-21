/**
 * Opus encoding for the voice channel.
 *
 * Why this exists at all: `@discordjs/voice` builds its encoder as
 *
 *     new prism.opus.Encoder({ rate: 48000, channels: 2, frameSize: 960 })
 *
 * with no `bitrate`, so libopus falls back to OPUS_AUTO (~64 kbps for 48 kHz
 * stereo), and prism-media 1.3.5 clamps `setBitrate()` to 128 kbps on top of
 * that. A boosted channel can carry 256-384 kbps, so the bot was throwing away
 * most of the bandwidth it was paying for.
 *
 * So: encode here with `@discordjs/opus` directly, at the bitrate the channel
 * can actually carry, and hand `@discordjs/voice` finished Opus frames
 * (`StreamType.Opus`). That also removes ~50 JS encodes/second per guild from
 * the hot path.
 *
 * Two things move as a consequence, both handled here:
 *   - volume can no longer ride along after encoding (`inlineVolume` transforms
 *     int16 samples, which would corrupt Opus packets), so a gain stage sits in
 *     front of the encoder and is exposed as `resource.volume`;
 *   - FEC was never enabled, which matters more now that packets are bigger.
 *
 * If the native module will not load (bad prebuild in a container, wrong libc),
 * `createMusicResource` returns null and the caller keeps using the old raw-PCM
 * path — a slow, lower-quality pipeline is still infinitely better than no audio.
 */
import { createAudioResource, StreamType, type AudioResource } from '@discordjs/voice';
import { createRequire } from 'node:module';
import { Transform, type Readable } from 'node:stream';

/** 20 ms at 48 kHz — Discord's packet size. */
export const FRAME_SAMPLES = 960;
export const CHANNELS = 2;
/** s16le interleaved stereo, so one frame is 960 * 2 * 2 bytes. */
export const BYTES_PER_FRAME = FRAME_SAMPLES * CHANNELS * 2;

/** libopus control requests (the values `@discordjs/opus` forwards to the codec). */
export const CTL = {
  BITRATE: 4002,
  INBAND_FEC: 4012,
  PACKET_LOSS_PERC: 4014,
} as const;

/** Opus wideband ceiling; anything above this is memory, not fidelity. */
export const MAX_BITRATE = 512_000;
export const MIN_BITRATE = 16_000;

/** Assumed in-band-FEC loss target — FEC only helps if the encoder predicts loss. */
const FEC_LOSS_PERCENT = 10;

export interface NativeEncoder {
  encode(pcm: Buffer, frameSize: number): Buffer;
  applyEncoderCTL?(ctl: number, value: number): void;
}

export interface NativeOpusModule {
  OpusEncoder: new (sampleRate: number, channels: number) => NativeEncoder;
}

export type LoadNative = () => NativeOpusModule | null;

/** A volume control shaped like the one `inlineVolume` used to provide. */
export interface GainControl {
  setVolume(volume: number): void;
  readonly volume: number;
}

export interface MusicResourceOptions {
  /** Bits per second to encode at. Clamped to 16-512 kbps. */
  bitrate: number;
  /** Enable in-band FEC. On by default — music dropouts are more audible than the bits. */
  fec?: boolean;
  /** Injection point for tests; production uses `@discordjs/opus`. */
  loadNative?: LoadNative;
}

export interface OpusPlan {
  /** Which implementation encoded the current stream. */
  module: string;
  bitrate: number;
  fec: boolean;
}

let cachedNative: NativeOpusModule | null | undefined;
let lastPlan: OpusPlan | null = null;
let loggedFirstUse = false;

const req = createRequire(import.meta.url);

function defaultLoadNative(): NativeOpusModule | null {
  try {
    // Resolved lazily: a broken prebuild must degrade the pipeline, not crash
    // the process at import time (voice.ts is imported on every boot).
    const mod = req('@discordjs/opus') as Partial<NativeOpusModule> | undefined;
    return typeof mod?.OpusEncoder === 'function' ? (mod as NativeOpusModule) : null;
  } catch {
    return null;
  }
}

function nativeModule(load: LoadNative): NativeOpusModule | null {
  if (load !== defaultLoadNative) return load();
  if (cachedNative === undefined) cachedNative = defaultLoadNative();
  return cachedNative;
}

/**
 * Which encoder the `StreamType.Raw` fallback would actually use.
 *
 * prism-media tries @discordjs/opus, then node-opus, then opusscript. The last
 * one is pure WASM — much slower and audibly worse at the same bitrate — so it is
 * worth naming in /diag instead of discovering it by ear. The probe mirrors
 * prism's own order so the answer matches what would really run.
 */
export function fallbackOpusModule(): string {
  const hasEncoder = (name: string): boolean => {
    try {
      const mod = req(name) as { OpusEncoder?: unknown } | undefined;
      return typeof mod?.OpusEncoder === 'function';
    } catch {
      // A present-but-unloadable native module throws from its own index.js.
      return false;
    }
  };
  if (hasEncoder('@discordjs/opus')) return '@discordjs/opus';
  if (hasEncoder('node-opus')) return 'node-opus';
  try {
    const mod = req('opusscript') as unknown;
    const ctor = typeof mod === 'function' ? mod : (mod as { default?: unknown })?.default;
    if (typeof ctor === 'function') return 'opusscript';
  } catch {
    /* nothing left */
  }
  return 'none';
}

/** What the last created stream actually used, for /diag. Null if never used. */
export function opusPlan(): OpusPlan | null {
  return lastPlan;
}

export function clampBitrate(bitrate: number): number {
  if (!Number.isFinite(bitrate) || bitrate <= 0) return 64_000;
  return Math.max(MIN_BITRATE, Math.min(MAX_BITRATE, Math.round(bitrate)));
}

/**
 * Applies a linear gain to interleaved s16le PCM.
 *
 * Doubles as the `resource.volume` shim: `@discordjs/voice` calls
 * `resource.volume.setVolume()` and the callers here drive fades through it.
 */
export class PcmGain extends Transform {
  private gain = 1;
  /** An odd trailing byte, held until the next chunk completes the sample. */
  private carry: Buffer | null = null;

  constructor() {
    super();
  }

  setVolume(volume: number): void {
    this.gain = Number.isFinite(volume) ? Math.max(0, Math.min(4, volume)) : 1;
  }

  get volume(): number {
    return this.gain;
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, done: (err?: Error | null, data?: Buffer) => void): void {
    let buf = this.carry ? Buffer.concat([this.carry, chunk]) : chunk;
    this.carry = null;
    if (buf.length % 2 !== 0) {
      this.carry = Buffer.from(buf.subarray(buf.length - 1));
      buf = buf.subarray(0, buf.length - 1);
    }
    if (buf.length === 0) return done();
    if (this.gain === 1) return done(null, buf);

    const out = Buffer.allocUnsafe(buf.length);
    for (let i = 0; i < buf.length; i += 2) {
      const scaled = Math.round(buf.readInt16LE(i) * this.gain);
      out.writeInt16LE(scaled > 32767 ? 32767 : scaled < -32768 ? -32768 : scaled, i);
    }
    done(null, out);
  }
}

/** Re-frames an arbitrary PCM byte stream into exact 20 ms Opus packets. */
export class OpusFrameEncoder extends Transform {
  private pending: Buffer = Buffer.alloc(0);

  constructor(private readonly encoder: NativeEncoder) {
    super({ readableObjectMode: true });
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, done: (err?: Error | null) => void): void {
    const buf = this.pending.length > 0 ? Buffer.concat([this.pending, chunk]) : chunk;
    let offset = 0;
    try {
      while (buf.length - offset >= BYTES_PER_FRAME) {
        this.push(this.encoder.encode(buf.subarray(offset, offset + BYTES_PER_FRAME), FRAME_SAMPLES));
        offset += BYTES_PER_FRAME;
      }
    } catch (err) {
      return done(err instanceof Error ? err : new Error(String(err)));
    }
    // Copy the remainder: holding a subarray would pin the whole upstream chunk.
    this.pending = offset > 0 ? Buffer.from(buf.subarray(offset)) : buf;
    done();
  }
}

/**
 * Encode `pcm` (48 kHz stereo s16le) into an Opus `AudioResource` at `bitrate`.
 * Returns null when no native Opus encoder is available — callers must fall back.
 */
export function createMusicResource(pcm: Readable, opts: MusicResourceOptions): AudioResource | null {
  const mod = nativeModule(opts.loadNative ?? defaultLoadNative);
  if (!mod) {
    lastPlan = null;
    return null;
  }

  const bitrate = clampBitrate(opts.bitrate);
  const fec = opts.fec !== false;
  let encoder: NativeEncoder;
  try {
    encoder = new mod.OpusEncoder(48_000, CHANNELS);
  } catch {
    // Constructor throws when the native binding is present but unusable.
    if (opts.loadNative === undefined) cachedNative = null;
    lastPlan = null;
    return null;
  }

  try {
    encoder.applyEncoderCTL?.(CTL.BITRATE, bitrate);
    if (fec) {
      encoder.applyEncoderCTL?.(CTL.INBAND_FEC, 1);
      // FEC chooses its redundancy from the expected loss; 0% means it will
      // never add any.
      encoder.applyEncoderCTL?.(CTL.PACKET_LOSS_PERC, FEC_LOSS_PERCENT);
    }
  } catch {
    /* an unsupported CTL is not worth failing the track over */
  }

  const gain = new PcmGain();
  const frames = new OpusFrameEncoder(encoder);
  // An encoder error must take the source down with it, or the player would
  // sit on a dead resource until the watchdog fires.
  frames.once('error', () => pcm.destroy());
  pcm.pipe(gain).pipe(frames);

  const resource = createAudioResource(frames, { inputType: StreamType.Opus });
  // `inlineVolume` cannot be used: it scales int16 samples, which would corrupt
  // already-encoded packets. The gain stage above is the volume instead.
  (resource as unknown as { volume: GainControl }).volume = gain;

  lastPlan = { module: '@discordjs/opus', bitrate, fec };
  if (!loggedFirstUse) {
    loggedFirstUse = true;
    console.log(
      `[opus] native encoder · ${Math.round(bitrate / 1000)} kbps · ${CHANNELS}ch · ${FRAME_SAMPLES}-sample frames` +
        `${fec ? ` · fec(${FEC_LOSS_PERCENT}%)` : ''}`,
    );
  }
  return resource;
}
