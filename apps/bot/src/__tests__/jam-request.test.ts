import { describe, expect, it } from 'vitest';
import { QueueManager } from '@vaporzr/core/queue';
import { Bridge } from '../bridge.js';

interface FakeTrack {
  uri: string;
  name: string;
  artists: string[];
  album: string;
  durationMs: number;
  source: 'youtube' | 'spotify';
  image?: string;
}

function yt(uri: string, name: string, artists: string[] = ['Kredo'], durationMs = 200_000): FakeTrack {
  return { uri, name, artists, album: 'YouTube', durationMs, source: 'youtube' };
}

/** requestTrack only touches `sessions.primary.queue` and `onResolveRequest`
 *  (both plain fields), so a prototype-level fake sidesteps the real Bridge
 *  constructor, which binds a WebSocket server and a librespot manager. */
function bridgeWith(queue: QueueManager, resolved: FakeTrack[]): Bridge {
  const b = Object.create(Bridge.prototype) as Bridge;
  Object.assign(b, {
    sessions: { primary: { queue } },
    onResolveRequest: async (): Promise<FakeTrack[]> => resolved,
  });
  return b;
}

const names = (q: QueueManager): string[] => q.getSnapshot().tracks.map((t) => t.name);

describe('Bridge.requestTrack (jam page) duplicate handling', () => {
  it('queues a fresh request, then refuses the same song instead of stacking it', async () => {
    // Two guests asking for the same song (or one guest double-tapping a slow
    // resolve) used to land two copies: this path never filtered while every
    // Discord add path did.
    const q = new QueueManager();
    const b = bridgeWith(q, [yt('youtube:video:x', 'Mikado')]);
    const first = await b.requestTrack('mikado', 'Guest');
    expect(first.ok).toBe(true);
    expect(names(q)).toEqual(['Mikado']);

    const second = await b.requestTrack('mikado', 'Other Guest');
    expect(second.ok).toBe(false);
    expect(second.error).toContain('already in the queue');
    expect(names(q)).toEqual(['Mikado']);
    expect(q.totalEnqueued).toBe(1);
  });

  it('is not fooled by a music-video title variant of a queued song', async () => {
    const q = new QueueManager();
    q.enqueue(
      { uri: 'spotify:track:a', name: 'Mikado', artists: ['Kredo'], album: '', durationMs: 200_000, source: 'spotify' },
      'user',
    );
    const b = bridgeWith(q, [yt('youtube:video:x', 'Mikado (Official Music Video)', ['Kredo'], 201_000)]);
    const res = await b.requestTrack('mikado video', 'Guest');
    expect(res.ok).toBe(false);
    expect(q.getSnapshot().tracks).toHaveLength(1);
  });

  it('a playlist request queues only what is not already waiting, in request order', async () => {
    const q = new QueueManager();
    q.enqueue(
      { uri: 'youtube:video:b', name: 'B', artists: ['Kredo'], album: '', durationMs: 200_000, source: 'youtube' },
      'user',
    );
    // B is already queued; A and C are fresh and must keep their order.
    const b = bridgeWith(q, [
      yt('youtube:video:a', 'A'),
      yt('youtube:video:b', 'B'),
      yt('youtube:video:c', 'C'),
    ]);
    const res = await b.requestTrack('a set', 'Guest');
    expect(res.ok).toBe(true);
    expect(res.name).toContain('2 tracks');
    expect(res.name).toContain('1 already queued');
    expect(names(q)).toEqual(['B', 'A', 'C']);
  });

  it('refuses the whole request when everything in it is already queued', async () => {
    const q = new QueueManager();
    const b = bridgeWith(q, [yt('youtube:video:a', 'A'), yt('youtube:video:b', 'B')]);
    expect((await b.requestTrack('set', 'Guest')).ok).toBe(true);
    const again = await b.requestTrack('set', 'Guest');
    expect(again.ok).toBe(false);
    expect(again.error).toContain('Those tracks are already in the queue');
    expect(names(q)).toEqual(['A', 'B']);
    expect(q.totalEnqueued).toBe(2);
  });
});
