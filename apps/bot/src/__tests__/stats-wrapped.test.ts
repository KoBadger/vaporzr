import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StatsStore, trackKey } from '@vaporzr/core/stats';
import { config } from '@vaporzr/core/config';

describe('StatsStore Wrapped (monthly aggregates)', () => {
  let tmp: string;
  const original = config.dataDir;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vz-wrapped-'));
    config.dataDir = tmp;
  });

  afterEach(() => {
    config.dataDir = original;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('aggregates plays, hours, tracks, artists and DJs into the current month', () => {
    const s = new StatsStore();
    s.noteQueued('g', 'alice', ['Bonobo']);
    s.notePlayed('g', 'alice', ['Bonobo'], { name: 'Kerala', artists: ['Bonobo'], durationMs: 300_000 });
    s.notePlayed('g', 'bob', ['Bonobo'], { name: 'Otomo', artists: ['Bonobo'], durationMs: 240_000 });

    const month = new Date().toISOString().slice(0, 7);
    const w = s.wrapped('g', month);
    expect(w.plays).toBe(2);
    expect(w.queued).toBe(1);
    // 5 min + 4 min = 9 minutes of playback.
    expect(w.playedMs).toBe(540_000);
    expect(w.topTracks[0][0]).toBe(trackKey('Kerala', ['Bonobo']));
    expect(w.topTracks).toHaveLength(2);
    expect(w.topArtists[0][0]).toBe('bonobo');
    expect(w.topDjs).toEqual([['alice', 1], ['bob', 1]]);
    expect(w.biggestDay).not.toBeNull();
    expect(w.biggestDay![1]).toBe(540_000);
    expect(w.allTimeMs).toBe(540_000);
  });

  it('without a track descriptor nothing is added to the Wrapped aggregates (pause/resume safe)', () => {
    const s = new StatsStore();
    s.notePlayed('g', 'alice', ['Bonobo']);
    s.notePlayed('g', 'alice', ['Bonobo']);
    const w = s.wrapped('g', new Date().toISOString().slice(0, 7));
    expect(w.plays).toBe(0);
    expect(w.playedMs).toBe(0);
    expect(w.topTracks).toHaveLength(0);
  });

  it('caps absurd (album-length) track durations so hours stay honest', () => {
    const s = new StatsStore();
    s.notePlayed('g', 'u', ['X'], { name: 'Wrong Match', artists: ['X'], durationMs: 20 * 60 * 60 * 1000 });
    const w = s.wrapped('g', new Date().toISOString().slice(0, 7));
    expect(w.playedMs).toBe(12 * 60 * 60 * 1000);
  });

  it('returns an empty summary for a month with no data', () => {
    const s = new StatsStore();
    const w = s.wrapped('g', '2001-01');
    expect(w.plays).toBe(0);
    expect(w.playedMs).toBe(0);
    expect(w.topTracks).toHaveLength(0);
    expect(w.biggestDay).toBeNull();
  });

  it('trackKey normalizes case and whitespace and keys on the first artist', () => {
    expect(trackKey('  kerala ', ['Bonobo', 'Other'])).toBe('kerala | bonobo');
    expect(trackKey('Kerala', [])).toBe('kerala');
  });
});
