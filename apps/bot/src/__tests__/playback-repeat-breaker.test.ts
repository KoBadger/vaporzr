import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '@vaporzr/core/config';
import { PlaybackController } from '@vaporzr/core/playback';
import { QueueManager } from '@vaporzr/core/queue';
import type { AudioTransport } from '@vaporzr/core/transport';
import type { MediaSource, TrackInfo } from '@vaporzr/shared';

/**
 * A dead stream used to replay itself forever under repeat: each restart
 * broadcast reset the panel progress to 0, so the track looked stuck at 0–1s.
 * These tests drive the private replay path the way the end handlers do.
 */
type Enqueueable = Omit<TrackInfo, 'addedBy' | 'addedAt'>;

const track = (uri: string, source: MediaSource = 'local'): Enqueueable => ({
  uri,
  name: uri,
  artists: ['someone'],
  album: '',
  durationMs: 240_000,
  source,
  ...(source === 'local' ? { filePath: `C:/media/${uri}.flac` } : {}),
});

const replay = (c: PlaybackController, elapsedMs: number, durationMs: number): void =>
  (c as unknown as { replayCurrent(elapsedMs: number, durationMs: number): void }).replayCurrent(elapsedMs, durationMs);

describe('repeat loop breaker', () => {
  let tmpDir: string;
  const originalDataDir = config.dataDir;
  let playSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vaporzr-repeat-test-'));
    config.dataDir = tmpDir;
    vi.useFakeTimers();
    // A real play() would hit the network; the breaker only cares that it was
    // asked to replay (or, on the final strike, deliberately wasn't).
    playSpy = vi.spyOn(PlaybackController.prototype, 'play').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    config.dataDir = originalDataDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function setup() {
    const queue = new QueueManager();
    queue.enqueueMany([track('a')], 'tester');
    const current = queue.getCurrentTrack()!;
    queue.setState({ playing: true, track: current, positionMs: 0, durationMs: current.durationMs, repeat: true });
    const stopped: string[] = [];
    const voice = {
      setOnVoiceReconnect: () => {},
      setFeatureTap: () => {},
      setOnStreamRefused: () => {},
      setStallRecovery: () => {},
      setSpectrumTap: () => {},
      setStreamDrain: () => {},
      stopStream: () => stopped.push('stream'),
      getPositionMs: () => 0,
      isStalled: () => false,
    } as unknown as AudioTransport;
    const sent: unknown[] = [];
    const controller = new PlaybackController(queue, (msg) => sent.push(msg), voice);
    const stalled = vi.fn();
    controller.onPlaybackStalled = stalled;
    return { queue, controller, stopped, sent, stalled, current };
  }

  it('stops repeating after three near-empty replays instead of looping at 0s', () => {
    const { queue, controller, stopped, sent, stalled, current } = setup();

    replay(controller, 900, current.durationMs);
    replay(controller, 900, current.durationMs);
    expect(playSpy).toHaveBeenCalledTimes(2);
    expect(queue.getState().repeat).toBe(true);

    replay(controller, 900, current.durationMs);

    expect(playSpy).toHaveBeenCalledTimes(2); // no fourth restart
    expect(queue.getState()).toMatchObject({ repeat: false, playing: false, positionMs: 0 });
    expect(stopped).toEqual(['stream']);
    expect(sent).toContainEqual({ type: 'cmd', command: 'stop' });
    expect(stalled).toHaveBeenCalledTimes(1);
    expect(stalled.mock.calls[0][0]).toContain(current.name);
  });

  it('does not count a genuine full-length replay toward the limit', () => {
    const { queue, controller, stalled, current } = setup();

    replay(controller, 900, current.durationMs);
    replay(controller, 200_000, current.durationMs); // normal end — clears the counter
    replay(controller, 900, current.durationMs);
    replay(controller, 900, current.durationMs);

    expect(playSpy).toHaveBeenCalledTimes(4);
    expect(queue.getState().repeat).toBe(true);
    expect(stalled).not.toHaveBeenCalled();
  });
});
