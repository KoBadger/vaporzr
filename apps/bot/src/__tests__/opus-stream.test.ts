import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  BYTES_PER_FRAME,
  CTL,
  OpusFrameEncoder,
  OpusRateMeter,
  PcmGain,
  clampBitrate,
  createMusicResource,
  opusPlan,
  type NativeEncoder,
  type NativeOpusModule,
} from '../opusStream.js';

/** Records what the encoder was asked to do, so the wiring can be asserted. */
class FakeEncoder implements NativeEncoder {
  frames: number[] = [];
  ctls: Array<[number, number]> = [];

  encode(pcm: Buffer): Buffer {
    this.frames.push(pcm.length);
    return Buffer.alloc(4);
  }

  applyEncoderCTL(ctl: number, value: number): void {
    this.ctls.push([ctl, value]);
  }
}

function fakeModule(encoder: FakeEncoder): NativeOpusModule {
  const OpusEncoder = function OpusEncoder() {
    return encoder;
  } as unknown as NativeOpusModule['OpusEncoder'];
  return { OpusEncoder };
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('clampBitrate', () => {
  it('keeps sane values and clamps the extremes', () => {
    expect(clampBitrate(384_000)).toBe(384_000);
    expect(clampBitrate(1_000)).toBe(16_000);
    expect(clampBitrate(9_000_000)).toBe(512_000);
  });

  it('falls back to 64 kbps for nonsense input', () => {
    expect(clampBitrate(0)).toBe(64_000);
    expect(clampBitrate(Number.NaN)).toBe(64_000);
  });
});

describe('PcmGain', () => {
  it('passes PCM through untouched at unity gain', async () => {
    const gain = new PcmGain();
    const input = Buffer.from([0x10, 0x00, 0x20, 0x00]);
    const chunks: Buffer[] = [];
    gain.on('data', (c: Buffer) => chunks.push(c));
    gain.write(input);
    await tick();

    expect(Buffer.concat(chunks).equals(input)).toBe(true);
    expect(gain.volume).toBe(1);
  });

  it('scales interleaved int16 samples', async () => {
    const gain = new PcmGain();
    gain.setVolume(0.5);
    const input = Buffer.alloc(8);
    input.writeInt16LE(1000, 0);
    input.writeInt16LE(-2000, 2);
    input.writeInt16LE(32767, 4);
    input.writeInt16LE(-32768, 6);

    const chunks: Buffer[] = [];
    gain.on('data', (c: Buffer) => chunks.push(c));
    gain.write(input);
    await tick();

    const out = Buffer.concat(chunks);
    expect(out.readInt16LE(0)).toBe(500);
    expect(out.readInt16LE(2)).toBe(-1000);
    // Overflow clamps instead of wrapping around to full-scale noise.
    expect(out.readInt16LE(4)).toBe(16384);
    expect(out.readInt16LE(6)).toBe(-16384);
  });

  it('clamps the volume range and ignores NaN', () => {
    const gain = new PcmGain();
    gain.setVolume(99);
    expect(gain.volume).toBe(4);
    gain.setVolume(-5);
    expect(gain.volume).toBe(0);
    gain.setVolume(Number.NaN);
    expect(gain.volume).toBe(1);
  });
});

describe('OpusFrameEncoder', () => {
  it('re-frames arbitrary chunk sizes into exact 20 ms packets', async () => {
    const encoder = new FakeEncoder();
    const frames = new OpusFrameEncoder(encoder);
    const out: Buffer[] = [];
    frames.on('data', (b: Buffer) => out.push(b));

    // Two full frames plus a partial one.
    frames.write(Buffer.alloc(BYTES_PER_FRAME * 2 + 100));
    await tick();

    expect(out).toHaveLength(2);
    expect(encoder.frames).toEqual([BYTES_PER_FRAME, BYTES_PER_FRAME]);
  });

  it('carries a split frame across chunk boundaries', async () => {
    const encoder = new FakeEncoder();
    const frames = new OpusFrameEncoder(encoder);
    const out: Buffer[] = [];
    frames.on('data', (b: Buffer) => out.push(b));

    // 8192-byte ffmpeg reads never line up with 3840-byte frames.
    frames.write(Buffer.alloc(8192));
    await tick();
    expect(out).toHaveLength(2);

    frames.write(Buffer.alloc(8192));
    await tick();
    expect(out).toHaveLength(4);
    expect(encoder.frames.every((n) => n === BYTES_PER_FRAME)).toBe(true);
  });

  it('drops a trailing partial packet instead of sending a short frame', async () => {
    const encoder = new FakeEncoder();
    const frames = new OpusFrameEncoder(encoder);
    const out: Buffer[] = [];
    frames.on('data', (b: Buffer) => out.push(b));

    frames.write(Buffer.alloc(BYTES_PER_FRAME + 17));
    frames.end();
    await tick();

    expect(out).toHaveLength(1);
    expect(encoder.frames).toEqual([BYTES_PER_FRAME]);
  });
});

describe('createMusicResource', () => {
  it('returns null when no native encoder is available, so callers can fall back', () => {
    const pcm = new PassThrough();
    const resource = createMusicResource(pcm, { bitrate: 256_000, loadNative: () => null });
    expect(resource).toBeNull();
    pcm.destroy();
  });

  it('encodes at the negotiated bitrate and enables FEC', () => {
    const encoder = new FakeEncoder();
    const pcm = new PassThrough();
    const resource = createMusicResource(pcm, {
      bitrate: 384_000,
      fec: true,
      loadNative: () => fakeModule(encoder),
    });

    expect(resource).not.toBeNull();
    expect(encoder.ctls).toContainEqual([CTL.BITRATE, 384_000]);
    expect(encoder.ctls).toContainEqual([CTL.INBAND_FEC, 1]);
    expect(encoder.ctls).toContainEqual([CTL.PACKET_LOSS_PERC, 10]);
    expect(opusPlan()).toMatchObject({ bitrate: 384_000, fec: true });
    pcm.destroy();
  });

  it('leaves FEC alone when disabled', () => {
    const encoder = new FakeEncoder();
    const pcm = new PassThrough();
    createMusicResource(pcm, { bitrate: 128_000, fec: false, loadNative: () => fakeModule(encoder) });

    expect(encoder.ctls.some(([ctl]) => ctl === CTL.INBAND_FEC)).toBe(false);
    pcm.destroy();
  });

  it('exposes a volume control that survives pre-encoded Opus', () => {
    const encoder = new FakeEncoder();
    const pcm = new PassThrough();
    const resource = createMusicResource(pcm, {
      bitrate: 256_000,
      loadNative: () => fakeModule(encoder),
    });

    // @discordjs/voice drives fades through resource.volume.setVolume(); with
    // StreamType.Opus that has to be the pre-encoder gain stage.
    const volume = resource?.volume as unknown as { setVolume(v: number): void; volume: number };
    expect(typeof volume.setVolume).toBe('function');
    volume.setVolume(0.25);
    expect(volume.volume).toBe(0.25);
    pcm.destroy();
  });
});

describe('OpusRateMeter (live bitrate for /diag)', () => {
  it('reports nothing until there is at least a second of audio', () => {
    const meter = new OpusRateMeter();
    expect(meter.kbps(0)).toBeNull();
    meter.push(100, 1_000);
    expect(meter.kbps(1_100)).toBeNull(); // one frame is not a rate
  });

  it('measures bytes per millisecond over the window', () => {
    const meter = new OpusRateMeter();
    // 100-byte packets every 100 ms for 1 s -> 1000 B/s -> 8 kbps.
    for (let i = 0; i <= 10; i++) meter.push(100, i * 100);
    // span = 1000 ms, bytes = 1100 -> 8.8 kbps.
    expect(meter.kbps(1_000)).toBeCloseTo(8.8, 1);
  });

  it('forgets samples that fall out of the window', () => {
    const meter = new OpusRateMeter(5_000);
    meter.push(500, 0);
    meter.push(500, 1_000);
    // Both samples inside a full 5 s window: 1000 B / 5000 ms = 1.6 kbps.
    expect(meter.kbps(5_000)).toBeCloseTo(1.6, 1);
    // Past 5 s the first sample ages out; the span clamps to the window.
    expect(meter.kbps(6_000)).toBeCloseTo(0.8, 1);
    // Long after the fact everything has aged out.
    expect(meter.kbps(60_000)).toBeNull();
  });

  it('keeps lifetime totals independent of the window', () => {
    const meter = new OpusRateMeter(1_000);
    meter.push(10, 0);
    meter.push(20, 2_000);
    meter.push(30, 4_000);
    expect(meter.totals).toEqual({ frames: 3, bytes: 60 });
  });

  it('is fed by the frame encoder', () => {
    const meter = new OpusRateMeter();
    const encoder = new FakeEncoder();
    const frames = new OpusFrameEncoder(encoder, meter);
    const pcm = Buffer.alloc(BYTES_PER_FRAME * 3);
    frames.write(pcm);
    expect(meter.totals.frames).toBe(3);
    expect(meter.totals.bytes).toBe(12); // FakeEncoder emits 4-byte packets
    frames.destroy();
  });
});
