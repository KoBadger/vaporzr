import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { QueueManager } from '../queue.js';
import { VoiceManager } from '../voice.js';
import { PlaybackController, STREAM_CACHE_SAVE_DEBOUNCE_MS } from '../playback.js';
import { parseSleepSpec } from '../discord.js';
import { config } from '../config.js';
import type { ResolvedVideo } from '../youtube.js';

function video(uri: string, streamUrl = `https://stream.example/${uri}.m3u8`): ResolvedVideo {
  return {
    videoId: `video_${uri}`,
    streamUrl,
    channel: 'Test Channel',
    uri,
    name: 'Test Track',
    artists: ['Test Artist'],
    album: '',
    durationMs: 200_000,
    image: undefined,
    source: 'youtube',
  };
}

describe('parseSleepSpec', () => {
  it('parses seconds, minutes, and hours', () => {
    expect(parseSleepSpec('30s')).toBe(30_000);
    expect(parseSleepSpec('30m')).toBe(30 * 60_000);
    expect(parseSleepSpec('1h')).toBe(3_600_000);
  });

  it('accepts case-insensitive input and surrounding whitespace', () => {
    expect(parseSleepSpec(' 2H ')).toBe(7_200_000);
    expect(parseSleepSpec('45S')).toBe(45_000);
  });

  it('accepts decimals', () => {
    expect(parseSleepSpec('1.5m')).toBe(90_000);
  });

  it('rejects garbage, empty strings, and zero/negative durations', () => {
    expect(parseSleepSpec('')).toBeNull();
    expect(parseSleepSpec('soon')).toBeNull();
    expect(parseSleepSpec('1d')).toBeNull();
    expect(parseSleepSpec('0m')).toBeNull();
    expect(parseSleepSpec('-5m')).toBeNull();
  });
});

describe('stream cache persistence', () => {
  let tmpDir: string;
  const originalDataDir = config.dataDir;
  const cacheFile = (): string => path.join(tmpDir, 'stream-cache.json');

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vaporzr-cache-test-'));
    config.dataDir = tmpDir;
  });

  afterEach(() => {
    config.dataDir = originalDataDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  function makeController(): PlaybackController {
    return new PlaybackController(new QueueManager(), () => {}, new VoiceManager(), null);
  }

  it('restores fresh entries and drops stale / url-less ones on load', () => {
    const now = Date.now();
    const fresh = video('spotify:track:alpha');
    const stale = video('spotify:track:beta');
    const noUrl = video('spotify:track:gamma', '');
    fs.writeFileSync(
      cacheFile(),
      JSON.stringify([
        { uri: fresh.uri, savedAt: now - 1000, video: fresh },
        { uri: stale.uri, savedAt: now - 7 * 60 * 60 * 1000, video: stale },
        { uri: noUrl.uri, savedAt: now - 1000, video: noUrl },
      ]),
    );

    const c = makeController();
    expect(c.cachedStream(fresh.uri)).toEqual(fresh);
    expect(c.cachedStream(stale.uri)).toBeUndefined();
    expect(c.cachedStream(noUrl.uri)).toBeUndefined();
  });

  it('survives a missing or corrupt cache file', () => {
    const missing = makeController();
    expect(missing.cachedStream('spotify:track:x')).toBeUndefined();

    fs.writeFileSync(cacheFile(), '{ not json');
    const corrupt = makeController();
    expect(corrupt.cachedStream('spotify:track:x')).toBeUndefined();
  });

  it('round-trips a cacheSet through the debounced save and a fresh load', () => {
    const t = vi.useFakeTimers();
    const c = makeController();
    c.cacheSet('spotify:track:omega', video('spotify:track:omega'));
    expect(fs.existsSync(cacheFile())).toBe(false);
    t.advanceTimersByTime(STREAM_CACHE_SAVE_DEBOUNCE_MS + 50);

    const saved = JSON.parse(fs.readFileSync(cacheFile(), 'utf8')) as Array<{ uri: string; savedAt: number; video: ResolvedVideo }>;
    expect(saved).toHaveLength(1);
    expect(saved[0].uri).toBe('spotify:track:omega');
    expect(saved[0].video.streamUrl).toBeTruthy();

    const fresh = new PlaybackController(new QueueManager(), () => {}, new VoiceManager(), null);
    expect(fresh.cachedStream('spotify:track:omega')).toBeDefined();
  });
});