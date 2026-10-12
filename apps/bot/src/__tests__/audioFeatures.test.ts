import { describe, expect, it } from 'vitest';
import { LocalFeatureCollector, estimateEnergy, estimateKey, toAudioFeatures } from '@vaporzr/core/audioFeatures';

const ANALYSIS_RATE = 8000;
const note = (midi: number): number => 440 * Math.pow(2, (midi - 69) / 12);

/** Mono s16le at the 8 kHz analysis rate, built from pure partials. */
function tone(freqs: number[], secs: number, amp = 0.4): Buffer {
  const n = Math.floor(ANALYSIS_RATE * secs);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (const f of freqs) s += Math.sin((2 * Math.PI * f * i) / ANALYSIS_RATE);
    const v = (s / freqs.length) * amp * 32767;
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v))), i * 2);
  }
  return buf;
}

/** Stereo s16le at 48 kHz — the format the voice layer actually feeds. */
function stereo48(sampleAt: (i: number) => number, secs: number): Buffer {
  const n = Math.floor(48000 * secs);
  const buf = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-32768, Math.min(32767, Math.round(sampleAt(i) * 32767)));
    buf.writeInt16LE(v, i * 4);
    buf.writeInt16LE(v, i * 4 + 2);
  }
  return buf;
}

describe('local audio features — key', () => {
  it('names a C major triad as C major', () => {
    const { key, mode } = estimateKey(tone([note(60), note(64), note(67)], 6));
    expect(key).toBe(0);
    expect(mode).toBe(1);
  });

  it('names a C minor triad as C minor', () => {
    const { key, mode } = estimateKey(tone([note(60), note(63), note(67)], 6));
    expect(key).toBe(0);
    expect(mode).toBe(0);
  });

  it('names a G major triad as G major', () => {
    const { key, mode } = estimateKey(tone([note(55), note(59), note(62)], 6));
    expect(key).toBe(7);
    expect(mode).toBe(1);
  });

  it('returns unknown rather than guessing on silence', () => {
    expect(estimateKey(Buffer.alloc(ANALYSIS_RATE * 2)).key).toBe(-1);
  });
});

describe('local audio features — energy', () => {
  it('ranks a loud signal above a quiet one', () => {
    expect(estimateEnergy(tone([220], 2, 0.8))).toBeGreaterThan(estimateEnergy(tone([220], 2, 0.05)));
  });

  it('is zero for silence', () => {
    expect(estimateEnergy(Buffer.alloc(ANALYSIS_RATE * 2))).toBe(0);
  });
});

describe('toAudioFeatures', () => {
  it('emits only the fields it measured — never an invented neutral', () => {
    const f = toAudioFeatures({ energy: 0.7, tempo: 128, key: 7, mode: 1 }, 200_000);
    expect(f.energy).toBe(0.7);
    expect(f.tempo).toBe(128);
    expect(f.key).toBe(7);
    expect(f.mode).toBe(1);
    // The ordering maths SKIPS what it does not have, so a fabricated 0.5 would
    // be compared against a real target — adding noise and diluting the signal.
    expect(f.valence).toBeUndefined();
    expect(f.danceability).toBeUndefined();
    expect(f.acousticness).toBeUndefined();
    expect(f.instrumentalness).toBeUndefined();
  });

  it('omits an unknown key and an undetected tempo', () => {
    const f = toAudioFeatures({ energy: 0.4, tempo: 0, key: -1, mode: 1 });
    expect(f.energy).toBe(0.4);
    expect(f.key).toBeUndefined();
    expect(f.mode).toBeUndefined();
    expect(f.tempo).toBeUndefined();
  });
});

describe('LocalFeatureCollector', () => {
  it('measures tempo from a 120 BPM click track, fed in uneven chunks', () => {
    const interval = Math.round(48000 * 0.5); // 120 BPM at 48 kHz
    const buf = stereo48((i) => {
      const phase = i % interval;
      return phase < 200 ? 0.9 * Math.exp(-phase / 200) : 0;
    }, 20);
    const c = new LocalFeatureCollector();
    // Uneven chunks exercise the frame-carry path (buffers rarely align to 4).
    for (let off = 0; off < buf.length; off += 4096) c.feed(buf.subarray(off, off + 4096));
    const est = c.estimate();
    expect(est).not.toBeNull();
    expect(est!.tempo).toBeGreaterThan(115);
    expect(est!.tempo).toBeLessThan(125);
  });

  it('reports not-ready until enough audio has played, and resets cleanly', () => {
    const c = new LocalFeatureCollector();
    c.feed(stereo48(() => 0.2, 2));
    expect(c.ready(20)).toBe(false);
    expect(c.seconds()).toBeCloseTo(2, 1);
    c.reset();
    expect(c.seconds()).toBe(0);
    expect(c.estimate()).toBeNull();
  });

  it('recovers a C major key through the 48 kHz stereo decimation path', () => {
    const buf = stereo48(
      (i) =>
        0.4 *
        ((Math.sin((2 * Math.PI * note(60) * i) / 48000) +
          Math.sin((2 * Math.PI * note(64) * i) / 48000) +
          Math.sin((2 * Math.PI * note(67) * i) / 48000)) /
          3),
      20,
    );
    const c = new LocalFeatureCollector();
    c.feed(buf);
    const est = c.estimate();
    expect(est!.key).toBe(0);
    expect(est!.mode).toBe(1);
  });
});
