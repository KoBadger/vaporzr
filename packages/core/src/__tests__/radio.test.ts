import { describe, expect, it, vi } from 'vitest';
import { RADIO_PRESETS, findRadioPreset, searchRadioBrowser } from '../radio.js';

describe('findRadioPreset', () => {
  it('matches id, exact name and genre', () => {
    expect(findRadioPreset('nightwave')?.name).toBe('Nightwave Plaza');
    expect(findRadioPreset('drone zone')?.id).toBe('dronezone');
    expect(findRadioPreset('ambient')?.id).toBe('dronezone');
    expect(findRadioPreset('')).toBeNull();
    expect(findRadioPreset('nope')).toBeNull();
  });

  it('ships https stream URLs', () => {
    for (const s of RADIO_PRESETS) expect(s.url).toMatch(/^https:\/\//);
  });
});

describe('searchRadioBrowser', () => {
  it('maps results and drops broken rows', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => [
        { stationuuid: '1', name: 'Lofi One', url_resolved: 'https://s/1', tags: 'lofi,chill' },
        { stationuuid: '2', name: 'Bad', url_resolved: 'not-a-url' },
      ],
    })) as unknown as typeof fetch;
    expect(await searchRadioBrowser('lofi', fetchImpl)).toEqual([
      { id: '1', name: 'Lofi One', url: 'https://s/1', genre: 'lofi, chill', homepage: undefined },
    ]);
  });

  it('returns [] on failure', async () => {
    const boom = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await searchRadioBrowser('lofi', boom)).toEqual([]);
  });
});
