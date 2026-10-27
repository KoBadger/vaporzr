import { describe, expect, it } from 'vitest';
import {
  DECK_EQ_MIN_DB,
  DeckMixer,
  IDENTITY_BIQUAD,
  PcmRing,
  applyBiquad,
  beatLoopRegion,
  crossfaderGains,
  floatToInt16,
  highShelfCoefs,
  lowShelfCoefs,
  newBiquadState,
  peakingCoefs,
} from '../deckMixer.js';

/** RMS of a sine pushed through a filter, for relative-gain assertions. */
function filteredRms(freq: number, coefs: ReturnType<typeof lowShelfCoefs>, sampleRate = 48000): number {
  const state = newBiquadState();
  const n = sampleRate / 2;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const x = Math.sin((2 * Math.PI * freq * i) / sampleRate);
    const y = applyBiquad(coefs, state, x);
    // Skip the filter's settling window.
    if (i > 2048) sum += y * y;
  }
  return Math.sqrt(sum / (n - 2048));
}

const sineRms = (freq: number, sampleRate = 48000): number => {
  let sum = 0;
  const n = sampleRate / 2;
  for (let i = 2049; i < n; i++) {
    const x = Math.sin((2 * Math.PI * freq * i) / sampleRate);
    sum += x * x;
  }
  return Math.sqrt(sum / (n - 2048));
};

describe('beat-quantised loops', () => {
  it('snaps the loop-in to the last beat boundary', () => {
    const r = beatLoopRegion(3_700, 120, 4);
    expect(r.inMs).toBe(3_500);
    expect(r.outMs).toBe(5_500);
    expect(r.beats).toBe(4);
  });

  it('assumes 120 BPM when the tempo is unknown', () => {
    expect(beatLoopRegion(1_000, null, 2)).toEqual({ inMs: 1_000, outMs: 2_000, beats: 2 });
  });

  it('clamps silly beat counts and tolerates fractional loops', () => {
    expect(beatLoopRegion(0, 120, 999).beats).toBe(32);
    expect(beatLoopRegion(0, 120, 0).beats).toBe(0.25);
    expect(beatLoopRegion(0, 120, 0.5).outMs).toBe(250);
  });

  it('handles a faster grid and a negative position', () => {
    const r = beatLoopRegion(-50, 174, 1);
    expect(r.inMs).toBe(0);
    expect(r.outMs).toBeCloseTo(60_000 / 174, 5);
  });
});

describe('deck crossfader', () => {
  it('is full A at 0, full B at 1, and equal-power at centre', () => {
    expect(crossfaderGains(0)).toEqual({ a: 1, b: 0 });
    expect(crossfaderGains(1).a).toBeCloseTo(0, 6);
    expect(crossfaderGains(1).b).toBeCloseTo(1, 6);
    const mid = crossfaderGains(0.5);
    expect(mid.a).toBeCloseTo(Math.SQRT1_2, 6);
    expect(mid.b).toBeCloseTo(Math.SQRT1_2, 6);
    // Constant power: the sum of squares never dips during a fade.
    for (const x of [0, 0.2, 0.35, 0.5, 0.8, 1]) {
      const g = crossfaderGains(x);
      expect(g.a * g.a + g.b * g.b).toBeCloseTo(1, 6);
    }
  });

  it('clamps out-of-range and non-finite input', () => {
    expect(crossfaderGains(-3)).toEqual({ a: 1, b: 0 });
    expect(crossfaderGains(9).b).toBeCloseTo(1, 6);
    expect(crossfaderGains(Number.NaN)).toEqual(crossfaderGains(0.5));
  });
});

describe('deck EQ biquads', () => {
  it('returns the identity at 0 dB, so a flat deck costs nothing', () => {
    expect(lowShelfCoefs(200, 0)).toEqual(IDENTITY_BIQUAD);
    expect(highShelfCoefs(3500, 0)).toEqual(IDENTITY_BIQUAD);
    expect(peakingCoefs(1000, 0)).toEqual(IDENTITY_BIQUAD);
    const state = newBiquadState();
    for (const x of [0.5, -0.25, 0.125]) expect(applyBiquad(IDENTITY_BIQUAD, state, x)).toBe(x);
  });

  it('low-shelf kill removes bass but leaves highs intact', () => {
    const coefs = lowShelfCoefs(200, DECK_EQ_MIN_DB);
    const bassRatio = filteredRms(50, coefs) / sineRms(50);
    const trebleRatio = filteredRms(5000, coefs) / sineRms(5000);
    expect(bassRatio).toBeLessThan(0.05);
    expect(trebleRatio).toBeGreaterThan(0.85);
  });

  it('high-shelf kill removes treble but leaves bass intact', () => {
    const coefs = highShelfCoefs(3500, DECK_EQ_MIN_DB);
    const trebleRatio = filteredRms(8000, coefs) / sineRms(8000);
    const bassRatio = filteredRms(80, coefs) / sineRms(80);
    expect(trebleRatio).toBeLessThan(0.25);
    expect(bassRatio).toBeGreaterThan(0.85);
  });

  it('peaking band boosts around its centre frequency', () => {
    const boosted = filteredRms(1000, peakingCoefs(1000, 6)) / sineRms(1000);
    const untouched = filteredRms(6000, peakingCoefs(1000, 6)) / sineRms(6000);
    expect(boosted).toBeGreaterThan(1.6);
    expect(untouched).toBeGreaterThan(0.85);
    expect(untouched).toBeLessThan(1.15);
  });
});

describe('floatToInt16', () => {
  it('scales, applies master gain and clips instead of wrapping', () => {
    const acc = new Float32Array([0, 0.5, -0.5, 1.4, -1.4]);
    const out = Buffer.alloc(acc.length * 2);
    floatToInt16(acc, out, 1);
    expect(out.readInt16LE(0)).toBe(0);
    expect(out.readInt16LE(2)).toBe(16384);
    // Math.round rounds .5 toward +∞, so -0.5 lands on -16383, not -16384.
    expect(out.readInt16LE(4)).toBe(-16383);
    expect(out.readInt16LE(6)).toBe(32767);
    expect(out.readInt16LE(8)).toBe(-32767);

    floatToInt16(acc, out, 0.5);
    expect(out.readInt16LE(2)).toBe(8192);
  });
});

describe('PcmRing', () => {
  it('returns whole reads, partial starved reads, and tracks its size', () => {
    const ring = new PcmRing();
    ring.push(Buffer.from([1, 2]));
    ring.push(Buffer.from([3, 4, 5, 6]));
    expect(ring.byteLength).toBe(6);
    expect([...ring.readUpTo(3)]).toEqual([1, 2, 3]);
    expect(ring.byteLength).toBe(3);
    expect([...ring.readUpTo(10)]).toEqual([4, 5, 6]);
    expect(ring.byteLength).toBe(0);
    expect(ring.readUpTo(4).length).toBe(0);
  });

  it('spans chunks for a large read', () => {
    const ring = new PcmRing();
    ring.push(Buffer.alloc(4, 7));
    ring.push(Buffer.alloc(4, 9));
    const out = ring.readUpTo(8);
    expect(out.length).toBe(8);
    expect([...out]).toEqual([7, 7, 7, 7, 9, 9, 9, 9]);
    expect(ring.byteLength).toBe(0);
  });

  it('clear() empties the buffer', () => {
    const ring = new PcmRing();
    ring.push(Buffer.alloc(16));
    ring.clear();
    expect(ring.byteLength).toBe(0);
  });
});

describe('DeckMixer control surface', () => {
  const mixer = () => new DeckMixer({ sink: () => true });

  it('starts empty with the fader centred', () => {
    const st = mixer().state();
    expect(st.active).toBe(false);
    expect(st.crossfader).toBe(0.5);
    expect(st.a.source).toBeNull();
    expect(st.a.playing).toBe(false);
  });

  it('clamps the crossfader, trim and EQ into range', () => {
    const m = mixer();
    m.setCrossfader(4);
    expect(m.getCrossfader()).toBe(1);
    m.setCrossfader(-1);
    expect(m.getCrossfader()).toBe(0);
    m.setGain('a', 5);
    expect(m.state().a.gain).toBe(1);
    m.setEqBand('b', 'low', -999);
    expect(m.state().b.eq.low).toBe(DECK_EQ_MIN_DB);
    m.setEqBand('b', 'high', 99);
    expect(m.state().b.eq.high).toBe(6);
  });

  it('kill toggles a band between flat and the kill floor', () => {
    const m = mixer();
    m.killBand('a', 'mid');
    expect(m.state().a.eq.mid).toBe(DECK_EQ_MIN_DB);
    m.killBand('a', 'mid');
    expect(m.state().a.eq.mid).toBe(0);
  });

  it('reports state changes through onState', () => {
    let calls = 0;
    const m = new DeckMixer({ sink: () => true, onState: () => (calls += 1) });
    m.setCrossfader(0.25);
    m.setGain('b', 0.5);
    expect(calls).toBe(2);
  });

  it('stopAll clears both decks back to empty', () => {
    const m = mixer();
    m.setCrossfader(0.9);
    m.stopAll();
    const st = m.state();
    expect(st.a.source).toBeNull();
    expect(st.b.playing).toBe(false);
    expect(st.crossfader).toBe(0.5);
  });

  it('ignores transport calls with nothing loaded', () => {
    const m = mixer();
    m.play('a');
    m.seek('a', 5000);
    expect(m.state().a.playing).toBe(false);
    expect(m.state().a.positionMs).toBe(0);
    expect(m.isRunning()).toBe(false);
  });
});
