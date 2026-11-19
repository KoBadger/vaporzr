import { describe, it, expect } from 'vitest';
import { analyzePcmWindow, classifyPcmWindow, type PcmWindowStats } from '../audioHealth.js';
import { PcmIntegrityMonitor } from '../voice.js';

function makeSineTone(freqHz: number, durationMs: number, sampleRate = 48000, amplitude = 16000): Buffer {
  const samples = Math.floor((durationMs / 1000) * sampleRate);
  const buf = Buffer.alloc(samples * 2 * 2); // stereo, int16
  for (let i = 0; i < samples; i++) {
    const v = Math.round(amplitude * Math.sin((2 * Math.PI * freqHz * i) / sampleRate));
    buf.writeInt16LE(v, i * 4); // L
    buf.writeInt16LE(v, i * 4 + 2); // R
  }
  return buf;
}

function makeWhiteNoise(durationMs: number, sampleRate = 48000, amplitude = 20000): Buffer {
  const samples = Math.floor((durationMs / 1000) * sampleRate);
  const buf = Buffer.alloc(samples * 2 * 2);
  for (let i = 0; i < samples; i++) {
    const vL = Math.round((Math.random() * 2 - 1) * amplitude);
    const vR = Math.round((Math.random() * 2 - 1) * amplitude);
    buf.writeInt16LE(vL, i * 4);
    buf.writeInt16LE(vR, i * 4 + 2);
  }
  return buf;
}

/**
 * Loud, decorrelated stereo: a 440 Hz left channel and a 1.5 kHz right channel.
 * Real mixes differ between channels (panning, reverb, width), which is what the
 * interleaved analyser used to misread as near-white noise.
 */
function makeStereoMusic(durationMs: number, sampleRate = 48000): Buffer {
  const samples = Math.floor((durationMs / 1000) * sampleRate);
  const buf = Buffer.alloc(samples * 2 * 2);
  for (let i = 0; i < samples; i++) {
    const l = Math.round(9000 * Math.sin((2 * Math.PI * 440 * i) / sampleRate));
    const r = Math.round(9000 * Math.sin((2 * Math.PI * 1500 * i) / sampleRate));
    buf.writeInt16LE(l, i * 4);
    buf.writeInt16LE(r, i * 4 + 2);
  }
  return buf;
}

function makeSilence(durationMs: number, sampleRate = 48000): Buffer {
  const samples = Math.floor((durationMs / 1000) * sampleRate);
  return Buffer.alloc(samples * 2 * 2);
}

describe('analyzePcmWindow', () => {
  it('returns correct stats for silence', () => {
    const buf = makeSilence(10);
    const stats = analyzePcmWindow(buf);
    expect(stats.rms).toBe(0);
    expect(stats.peak).toBe(0);
    expect(stats.zeroCrossings).toBe(0);
    expect(stats.samples).toBeGreaterThan(0);
  });

  it('returns correct stats for a 440 Hz sine tone', () => {
    const buf = makeSineTone(440, 50); // 50ms window
    const stats = analyzePcmWindow(buf);
    expect(stats.rms).toBeGreaterThan(8000);
    expect(stats.rms).toBeLessThan(12000);
    expect(stats.peak).toBeGreaterThan(14000);
    expect(stats.zeroCrossings).toBeGreaterThan(0);
  });

  it('returns high RMS and ZCR for white noise', () => {
    const buf = makeWhiteNoise(50);
    const stats = analyzePcmWindow(buf);
    expect(stats.rms).toBeGreaterThan(10000);
    expect(stats.zeroCrossings / stats.samples).toBeGreaterThan(0.4);
  });

  it('handles empty buffer', () => {
    const stats = analyzePcmWindow(Buffer.alloc(0));
    expect(stats.rms).toBe(0);
    expect(stats.peak).toBe(0);
    expect(stats.zeroCrossings).toBe(0);
    expect(stats.samples).toBe(0);
  });
});

describe('classifyPcmWindow', () => {
  it('classifies silence as silence', () => {
    const stats: PcmWindowStats = { rms: 10, peak: 20, zeroCrossings: 0, samples: 4800 };
    expect(classifyPcmWindow(stats)).toBe('silence');
  });

  it('classifies broadband noise as noise', () => {
    // RMS > 4000 and ZCR > 0.42
    const stats: PcmWindowStats = { rms: 5000, peak: 20000, zeroCrossings: 2100, samples: 4800 }; // ZCR = 0.4375
    expect(classifyPcmWindow(stats)).toBe('noise');
  });

  it('classifies music-like audio as good', () => {
    const stats: PcmWindowStats = { rms: 8000, peak: 18000, zeroCrossings: 1000, samples: 4800 }; // ZCR ~0.21
    expect(classifyPcmWindow(stats)).toBe('good');
  });

  it('handles edge case: high RMS but low ZCR = good', () => {
    const stats: PcmWindowStats = { rms: 10000, peak: 25000, zeroCrossings: 500, samples: 4800 }; // ZCR ~0.1
    expect(classifyPcmWindow(stats)).toBe('good');
  });

  it('handles edge case: low RMS but high ZCR = good (not noise)', () => {
    const stats: PcmWindowStats = { rms: 3000, peak: 10000, zeroCrossings: 2500, samples: 4800 }; // ZCR ~0.52 but RMS < 4000
    expect(classifyPcmWindow(stats)).toBe('good');
  });

  it('empty samples returns silence', () => {
    const stats: PcmWindowStats = { rms: 0, peak: 0, zeroCrossings: 0, samples: 0 };
    expect(classifyPcmWindow(stats)).toBe('silence');
  });
});

describe('analyzePcmWindow stereo handling', () => {
  /**
   * Regression: zero crossings were counted across the interleaved L,R,L,R
   * sequence. Two decorrelated channels (any real stereo mix) then cross zero
   * almost every sample, so loud music measured ZCR 0.4–0.9 and was classified
   * as broadband noise — gated to silence and, worse, treated as a stall, which
   * restarted and skipped tracks mid-song. Both channels here are loud sine
   * tones (RMS well over the 4000 threshold) but independent, which is the
   * shape that used to fool the analyser.
   */
  it('counts zero crossings per channel, so decorrelated stereo music is not noise', () => {
    const buf = makeStereoMusic(250);
    const stats = analyzePcmWindow(buf);
    expect(stats.rms).toBeGreaterThan(4000);
    expect(classifyPcmWindow(stats)).toBe('good');
    expect(stats.zeroCrossings / stats.samples).toBeLessThan(0.42);
  });

  it('still calls genuine two-channel white noise noise', () => {
    expect(classifyPcmWindow(analyzePcmWindow(makeWhiteNoise(250)))).toBe('noise');
  });
});

describe('PcmIntegrityMonitor streaks', () => {
  it('breaks a bad streak on ordinary music, not just digital silence', () => {
    // Regression: onGood used to fire only for pure silence, so isolated noise
    // windows accumulated across an entire session until a spurious auto-skip.
    let bad = 0;
    let good = 0;
    const monitor = new PcmIntegrityMonitor({
      onBad: () => bad++,
      onGood: () => good++,
    });
    const quietMusic = makeSineTone(440, 20, 48000, 800); // well under the noise RMS
    monitor.feed(makeWhiteNoise(20));
    monitor.feed(makeWhiteNoise(20));
    monitor.feed(quietMusic);
    monitor.feed(makeWhiteNoise(20));
    monitor.feed(makeWhiteNoise(20));
    expect(bad).toBe(4);
    expect(good).toBe(1);
  });
});

describe('PcmIntegrityMonitor.feed verdicts (mix-stream gate)', () => {
  it('classifies noise windows so the mix stream can gate them', () => {
    let bad = 0;
    let good = 0;
    const monitor = new PcmIntegrityMonitor({
      onBad: () => bad++,
      onGood: () => good++,
    });
    // One noisy window is not proof (a distorted track can look like this for
    // 250 ms), so the first is passed through while it is still counted.
    expect(monitor.feed(makeWhiteNoise(250))).toBe('good');
    expect(bad).toBe(1);
    // Two in a row is a real stall: from here the gate silences it.
    expect(monitor.feed(makeWhiteNoise(250))).toBe('noise');
    expect(bad).toBe(2);
    expect(monitor.feed(makeSineTone(440, 250))).toBe('good');
    expect(monitor.feed(makeSilence(250))).toBe('good');
    // Music breaks the streak, so the next noisy window starts over as good.
    expect(monitor.feed(makeWhiteNoise(250))).toBe('good');
    expect(bad).toBe(3);
    expect(good).toBe(2);
  });
});
