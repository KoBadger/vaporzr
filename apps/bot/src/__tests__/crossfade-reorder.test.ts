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
 * The crossfade guard used to ask only whether the CURRENT track had changed.
 * Reordering or removing the UPCOMING track leaves the current one untouched,
 * so the blend mixed a song that was no longer next. `nextIsStill()` now checks
 * both, at three points: the timer, the resolver wait, and after decoding.
 *
 * These tests drive `scheduleCrossfade` against a fake transport so each of the
 * three checkpoints can be reached deterministically.
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

interface TransportCalls {
  suppressed: number[];
  fades: number[];
  blends: Buffer[];
}

function fakeTransport(): { voice: AudioTransport; calls: TransportCalls } {
  const calls: TransportCalls = { suppressed: [], fades: [], blends: [] };
  const voice = {
    setOnVoiceReconnect: () => {},
    setFeatureTap: () => {},
    setOnStreamRefused: () => {},
    setStallRecovery: () => {},
    setSpectrumTap: () => {},
    setStreamDrain: () => {},
    suppressCurrentTailFade: (ms: number) => calls.suppressed.push(ms),
    fadeOutResource: (ms: number) => calls.fades.push(ms),
    queueSfxPcm: (buf: Buffer) => calls.blends.push(buf),
    decodeHeadPcm: vi.fn(async () => Buffer.alloc(480 * 4)),
    getPositionMs: () => 0,
    isStalled: () => false,
  };
  return { voice: voice as unknown as AudioTransport, calls };
}

/** Reach the private scheduler the way play() does, from a known track end. */
const scheduleCrossfade = (c: PlaybackController, durationMs = 240_000, positionMs = 0): void =>
  (c as unknown as { scheduleCrossfade(durationMs: number, positionMs: number): void }).scheduleCrossfade(
    durationMs,
    positionMs,
  );

const WAIT_MS = 237_500; // planCrossfade(240_000, 0, 0, 2500)

describe('crossfade handoff re-check', () => {
  let tmpDir: string;
  const originalDataDir = config.dataDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vaporzr-xfade-test-'));
    config.dataDir = tmpDir;
    vi.useFakeTimers();
    // Resolving the next stream would hit the network; the blend only needs the
    // cache entry these tests place (or its absence) to decide.
    vi.spyOn(PlaybackController.prototype, 'prefetchStream').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    config.dataDir = originalDataDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function setup(tracks: Enqueueable[] = [track('a'), track('b'), track('c')]) {
    const queue = new QueueManager();
    queue.enqueueMany(tracks, 'tester');
    queue.setState({ playing: true, track: queue.getCurrentTrack(), positionMs: 0, durationMs: 240_000 });
    const { voice, calls } = fakeTransport();
    const controller = new PlaybackController(queue, () => {}, voice);
    controller.setCrossfade(2500);
    return { queue, controller, voice, calls };
  }

  it('blends when the queue is untouched', async () => {
    const { controller, calls } = setup();

    scheduleCrossfade(controller);
    // A real blend owns the tail, so the outgoing fade-out is suppressed.
    expect(calls.suppressed).toEqual([240_000]);

    await vi.advanceTimersByTimeAsync(WAIT_MS);

    expect(calls.blends).toHaveLength(1);
    expect(calls.fades).toEqual([]);
  });

  it('degrades to a sequential fade when the upcoming track is reordered', async () => {
    const { queue, controller, calls } = setup();

    scheduleCrossfade(controller);
    // "c" jumps ahead of "b": the current track is unchanged, but the planned
    // incoming song is no longer next.
    expect(queue.reorderUpcoming(['c', 'b'])).toBeGreaterThan(0);

    await vi.advanceTimersByTimeAsync(WAIT_MS);

    expect(calls.blends).toEqual([]);
    expect(calls.fades).toEqual([2500]);
  });

  it('degrades when the upcoming track is removed entirely', async () => {
    const { queue, controller, calls } = setup();

    scheduleCrossfade(controller);
    expect(queue.remove(1)?.uri).toBe('b');

    await vi.advanceTimersByTimeAsync(WAIT_MS);

    expect(calls.blends).toEqual([]);
    expect(calls.fades).toEqual([2500]);
  });

  it('degrades when the queue changes while the incoming head decodes', async () => {
    const { queue, controller, voice, calls } = setup();
    let release: ((buf: Buffer | null) => void) | undefined;
    (voice.decodeHeadPcm as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<Buffer | null>((resolve) => (release = resolve)),
    );

    scheduleCrossfade(controller);
    await vi.advanceTimersByTimeAsync(WAIT_MS); // timer fires, decode is in flight

    queue.reorderUpcoming(['c', 'b']);
    release?.(Buffer.alloc(480 * 4));
    await vi.advanceTimersByTimeAsync(0);

    // The blend had already suppressed the outgoing tail fade, so it must hand
    // over with the fade rather than cutting the track short.
    expect(calls.blends).toEqual([]);
    expect(calls.fades).toEqual([2500]);
  });

  it('does not mute the freshly started track when the outgoing ends mid-decode', async () => {
    const { queue, controller, voice, calls } = setup();
    let release: ((buf: Buffer | null) => void) | undefined;
    (voice.decodeHeadPcm as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<Buffer | null>((resolve) => (release = resolve)),
    );

    scheduleCrossfade(controller);
    await vi.advanceTimersByTimeAsync(WAIT_MS); // timer fires, decode is in flight

    // The outgoing track ends naturally while the head is still decoding; the
    // queue advances to "b" and play() starts it. The blend then notices
    // nextIsStill is false — but fading now would grab "b"'s resource and mute it.
    queue.next();
    release?.(Buffer.alloc(480 * 4));
    await vi.advanceTimersByTimeAsync(0);

    expect(calls.blends).toEqual([]);
    // The bug was exactly this fadeOutResource: it ramped the incoming track to
    // silence. The handoff already happened, so nothing should be faded.
    expect(calls.fades).toEqual([]);
  });

  it('degrades when the queue changes while the resolver is still waiting', async () => {
    const { queue, controller, calls } = setup([track('a'), track('b', 'youtube'), track('c')]);
    // No cached stream for "b", so startCrossfade parks in resolveBlendUrl.
    expect(queue.reorderUpcoming(['c', 'b'])).toBeGreaterThan(0);
    // Reset: reorder after scheduling so the plan points at "b" again.
    queue.reorderUpcoming(['b', 'c']);
    scheduleCrossfade(controller);

    await vi.advanceTimersByTimeAsync(WAIT_MS); // timer fires, first 250ms wait starts
    queue.reorderUpcoming(['c', 'b']);
    await vi.advanceTimersByTimeAsync(2_000); // resolver notices, gives up

    expect(calls.blends).toEqual([]);
    expect(calls.fades).toEqual([2500]);
  });

  it('keeps the blend when an earlier track is reordered but next is intact', async () => {
    const { queue, controller, calls } = setup([track('a'), track('b'), track('c'), track('d')]);

    scheduleCrossfade(controller);
    // Move a track that is not next: the handoff a -> b is still valid.
    queue.reorderUpcoming(['b', 'd', 'c']);

    await vi.advanceTimersByTimeAsync(WAIT_MS);

    expect(calls.blends).toHaveLength(1);
    expect(calls.fades).toEqual([]);
  });
});
