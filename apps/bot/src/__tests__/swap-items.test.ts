import { describe, expect, it } from 'vitest';
import type { ResolvedTrack } from '@vaporzr/core/spotify';
import { buildSwapItems, swapLabel, trackQuery } from '../swapItems.js';

function track(name: string, artists: string[], uri = `spotify:track:${name}`): ResolvedTrack {
  return { uri, name, artists, album: 'Album', durationMs: 180_000, source: 'spotify' } as ResolvedTrack;
}

describe('swapLabel / trackQuery', () => {
  it('formats the same label the add embed uses', () => {
    expect(swapLabel(track('One More Time', ['Daft Punk']))).toBe('One More Time — Daft Punk');
    expect(swapLabel(track('Untitled', []))).toBe('Untitled');
  });

  it('builds a search string from name + artists', () => {
    expect(trackQuery(track('One More Time', ['Daft Punk']))).toBe('One More Time Daft Punk');
    expect(trackQuery(track('Untitled', []))).toBe('Untitled');
  });
});

describe('buildSwapItems', () => {
  it('shares a typed query across every item', () => {
    const items = buildSwapItems([track('A', ['X']), track('B', ['Y'])], '  daft punk  ');
    expect(items).toHaveLength(2);
    expect(items!.map((i) => i.query)).toEqual(['daft punk', 'daft punk']);
    expect(items![0].label).toBe('A — X');
  });

  it('gives a typed single pick a query', () => {
    expect(buildSwapItems([track('A', ['X'])], 'some song')).toEqual([
      { uri: 'spotify:track:A', label: 'A — X', query: 'some song' },
    ]);
  });

  it('falls back to each track title for a playlist (nobody typed anything)', () => {
    const items = buildSwapItems([track('A', ['X']), track('B', ['Y', 'Z'])]);
    expect(items!.map((i) => i.query)).toEqual(['A X', 'B Y Z']);
  });

  it('offers nothing to correct for one explicit link', () => {
    expect(buildSwapItems([track('A', ['X'])])).toBeNull();
    expect(buildSwapItems([track('A', ['X'])], '   ')).toBeNull();
    expect(buildSwapItems([])).toBeNull();
  });
});
