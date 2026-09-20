import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StatsStore } from '../stats.js';
import { config } from '../config.js';

describe('StatsStore daily history', () => {
  let tmp: string;
  const original = config.dataDir;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vz-stats-'));
    config.dataDir = tmp;
  });

  afterEach(() => {
    config.dataDir = original;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('records daily plays and queues and returns a zero-filled window', () => {
    const s = new StatsStore();
    s.noteQueued('g', 'u', []);
    s.notePlayed('g', 'u', ['Artist']);

    const hist = s.history('g', 7);
    expect(hist).toHaveLength(7);
    const today = hist[hist.length - 1];
    expect(today.played).toBe(1);
    expect(today.queued).toBe(1);
    expect(hist[0].played).toBe(0);
    expect(hist[0].queued).toBe(0);
  });

  it('persists history across instances', () => {
    vi.useFakeTimers();
    const s = new StatsStore();
    s.notePlayed('g', 'u', []);
    vi.advanceTimersByTime(3500); // flush the debounced save
    vi.useRealTimers();
    const again = new StatsStore();
    const today = again.history('g', 1)[0];
    expect(today.played).toBe(1);
  });
});
