import { describe, expect, it } from 'vitest';
import { parseVibe, vibeIsSteerable } from '../vibe.js';

describe('parseVibe (natural-language vibe requests)', () => {
  it('maps single adjectives to audio-feature targets', () => {
    const p = parseVibe('chill');
    expect(p.targets.energy).toBeCloseTo(0.35);
    expect(p.targets.valence).toBeCloseTo(0.5);
    expect(p.likeArtist).toBeUndefined();
    expect(p.matched).toContain('chill');
    expect(p.count).toBe(3);
  });

  it('averages multiple adjectives', () => {
    const p = parseVibe('chill happy');
    expect(p.targets.valence).toBeCloseTo((0.5 + 0.9) / 2);
    expect(p.matched).toContain('chill');
    expect(p.matched).toContain('happy');
  });

  it('captures "like <artist>" and keeps mood words as targets', () => {
    const p = parseVibe('chill like Bonobo');
    expect(p.likeArtist).toBe('bonobo');
    expect(p.targets.energy).toBeCloseTo(0.35);
    expect(p.matched).toEqual(['chill']);
  });

  it('captures "similar to <artist>"', () => {
    const p = parseVibe('similar to Daft Punk');
    expect(p.likeArtist).toBe('daft punk');
    expect(vibeIsSteerable(p)).toBe(true);
  });

  it('keeps mood words before "like" as targets and the artist phrase verbatim', () => {
    const p = parseVibe('hype like chill birds');
    expect(p.likeArtist).toBe('chill birds');
    expect(p.matched).toEqual(['hype']);
    expect(p.targets.energy).toBeCloseTo(0.95);
  });

  it('maps genre words to Spotify seed genres', () => {
    const p = parseVibe('lofi jazz');
    expect(p.genres).toContain('lofi');
    expect(p.genres).toContain('jazz');
    expect(p.matched.length).toBeGreaterThan(0);
  });

  it('a trailing integer sets the queue count (1..10)', () => {
    expect(parseVibe('chill 5').count).toBe(5);
    expect(parseVibe('chill 99').count).toBe(10);
    expect(parseVibe('chill 0').count).toBe(1);
    // A lone number is not a vibe.
    expect(parseVibe('5').count).toBe(3);
  });

  it('pure artist seed with no adjectives is still steerable', () => {
    const p = parseVibe('like Radiohead');
    expect(p.targets).toEqual({});
    expect(p.likeArtist).toBe('radiohead');
    expect(vibeIsSteerable(p)).toBe(true);
  });

  it('gibberish is not steerable (falls back to the classic mood path)', () => {
    const p = parseVibe('xyzzy plugh');
    expect(vibeIsSteerable(p)).toBe(false);
  });

  it('tempo words produce tempo bands, not point targets', () => {
    const p = parseVibe('workout');
    expect(p.targets.minTempo).toBe(130);
    expect(p.targets.maxTempo).toBe(180);
    expect(p.targets.energy).toBeCloseTo(0.9);
  });
});
