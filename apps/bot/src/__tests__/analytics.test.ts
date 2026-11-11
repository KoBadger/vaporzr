import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AnalyticsStore } from '@vaporzr/core/analytics';
import { config } from '@vaporzr/core/config';

describe('AnalyticsStore', () => {
  let tmp: string;
  const original = config.dataDir;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vz-analytics-'));
    config.dataDir = tmp;
  });

  afterEach(() => {
    config.dataDir = original;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('counts plays into the right UTC hour and reports the peak', () => {
    const store = new AnalyticsStore();
    // 09:15 UTC, 09:45 UTC, then 21:00 UTC.
    store.recordPlay('g', Date.UTC(2026, 0, 5, 9, 15));
    store.recordPlay('g', Date.UTC(2026, 0, 5, 9, 45));
    store.recordPlay('g', Date.UTC(2026, 0, 5, 21, 0));

    const summary = store.summary('g');
    expect(summary.plays).toBe(3);
    expect(summary.hours).toHaveLength(24);
    expect(summary.hours[9]).toBe(2);
    expect(summary.hours[21]).toBe(1);
    expect(summary.peakHour).toBe(9);
  });

  it('returns a zeroed summary for a guild with no plays', () => {
    const summary = new AnalyticsStore().summary('missing');
    expect(summary.plays).toBe(0);
    expect(summary.peakHour).toBeNull();
    expect(summary.hours.every((n) => n === 0)).toBe(true);
  });

  it('persists plays across instances', () => {
    vi.useFakeTimers();
    const store = new AnalyticsStore();
    store.recordPlay('g', Date.UTC(2026, 0, 5, 14, 0));
    vi.advanceTimersByTime(3500); // flush the debounced save
    vi.useRealTimers();

    const again = new AnalyticsStore();
    const summary = again.summary('g');
    expect(summary.plays).toBe(1);
    expect(summary.hours[14]).toBe(1);
  });
});
