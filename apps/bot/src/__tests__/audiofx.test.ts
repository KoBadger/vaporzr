import { describe, expect, it } from 'vitest';
import { buildAudioFxChain, EQ_PRESETS, isEqPreset } from '@vaporzr/core/audiofx';

describe('buildAudioFxChain (EQ + loudnorm)', () => {
  it('flat with nothing else yields an empty chain', () => {
    expect(buildAudioFxChain({})).toBe('');
    expect(buildAudioFxChain({ eq: 'flat' })).toBe('');
  });

  it('every known preset yields its filter chain and survives round-trips', () => {
    for (const p of EQ_PRESETS) {
      expect(isEqPreset(p)).toBe(true);
      const chain = buildAudioFxChain({ eq: p });
      if (p === 'flat') expect(chain).toBe('');
      else expect(chain.length).toBeGreaterThan(0);
    }
    expect(isEqPreset('nonsense')).toBe(false);
    expect(buildAudioFxChain({ eq: 'nonsense' })).toBe('');
  });

  it('loudnorm is always followed by aresample back to 48k (loudnorm upsamples to 192k)', () => {
    const chain = buildAudioFxChain({ loudnorm: true });
    expect(chain.startsWith('loudnorm=I=-14')).toBe(true);
    expect(chain).toContain(',aresample=48000');
  });

  it('stacks norm first, then EQ, then bass, then speed', () => {
    const chain = buildAudioFxChain({ loudnorm: true, eq: 'vocal', bassBoostDb: 5, speedFactor: 1.25 });
    const parts = chain.split(',');
    const normIdx = parts.findIndex((p) => p.startsWith('loudnorm='));
    const eqIdx = parts.findIndex((p) => p.startsWith('equalizer='));
    const bassIdx = parts.findIndex((p) => p.startsWith('bass='));
    const speedIdx = parts.findIndex((p) => p.startsWith('asetrate='));
    expect(normIdx).toBeGreaterThanOrEqual(0);
    expect(eqIdx).toBeGreaterThan(normIdx);
    expect(bassIdx).toBeGreaterThan(eqIdx);
    expect(speedIdx).toBeGreaterThan(bassIdx);
  });

  it('keeps the classic bass/speed chains byte-identical to the pre-refactor output', () => {
    expect(buildAudioFxChain({ bassBoostDb: 8 })).toBe('bass=g=8.0:f=150:width_type=q:width=0.8');
    expect(buildAudioFxChain({ speedFactor: 1.25 })).toBe('aresample=48000,asetrate=60000,aresample=48000');
  });
});
