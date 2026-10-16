import { afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The store resolves its file from config.dataDir, so point DATA_DIR at a
// throwaway folder before importing anything that reads it.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vaporzr-store-'));
process.env.DATA_DIR = TMP;

const { getMeasuredFeatures, rememberMeasuredFeatures } = await import('@vaporzr/core/featureStore');
const { config } = await import('@vaporzr/core/config');
config.dataDir = TMP;

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('measured feature store', () => {
  it('round-trips measured features by uri', () => {
    rememberMeasuredFeatures('spotify:track:one', { key: 7, mode: 0, energy: 0.8 });
    expect(getMeasuredFeatures('spotify:track:one')).toEqual({ key: 7, mode: 0, energy: 0.8 });
    expect(getMeasuredFeatures('spotify:track:nope')).toBeNull();
  });

  it('overwrites an older measurement with newer data', () => {
    rememberMeasuredFeatures('spotify:track:two', { key: 1, mode: 1 });
    rememberMeasuredFeatures('spotify:track:two', { key: 2, mode: 0 });
    expect(getMeasuredFeatures('spotify:track:two')).toEqual({ key: 2, mode: 0 });
  });

  it('persists to disk and reloads in a fresh module instance', async () => {
    rememberMeasuredFeatures('spotify:track:three', { key: 5, mode: 1, tempo: 128 });
    const raw = JSON.parse(fs.readFileSync(path.join(TMP, 'feature-store.json'), 'utf8')) as Record<string, unknown>;
    expect(raw['spotify:track:three']).toEqual({ key: 5, mode: 1, tempo: 128 });

    vi.resetModules();
    const fresh = await import('@vaporzr/core/featureStore');
    expect(fresh.getMeasuredFeatures('spotify:track:three')).toEqual({ key: 5, mode: 1, tempo: 128 });
  });
});
