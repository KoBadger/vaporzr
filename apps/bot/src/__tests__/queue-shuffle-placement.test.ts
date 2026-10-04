import { describe, expect, it } from 'vitest';
import { QueueManager, type QueueListener } from '../queue.js';
import type { OutboundMessage } from '@vaporzr/shared';

const listeners: QueueListener[] = [
  { onQueueChanged: () => {}, onStateChanged: () => {} },
];
const mk = () => new QueueManager(listeners);

function track(uri: string, name: string) {
  return { uri, name, artists: [name], album: 'Test Album', durationMs: 180000, source: 'spotify' as const };
}

describe('shuffle placement honours who added the track', () => {
  it('an explicit NEXT add with shuffle ON sits directly after the current track', () => {
    const q = mk();
    q.enqueue(track('spotify:track:a', 'A'), 'user');
    q.enqueue(track('spotify:track:b', 'B'), 'user');
    q.enqueue(track('spotify:track:c', 'C'), 'user');
    // Pin the cursor to the first track so "next" has a meaningful target.
    q.previous();
    q.previous();
    expect(q.getSnapshot().currentIndex).toBe(0);
    q.setState({ shuffle: true, playing: true });
    q.enqueue(track('spotify:track:new', 'NEW'), 'user', { next: true });
    const uris = q.getSnapshot().tracks.map((t) => t.uri);
    expect(uris[1]).toBe('spotify:track:new');

    // Deterministic across many runs, not random.
    for (let run = 0; run < 30; run++) {
      const qq = mk();
      qq.enqueue(track('spotify:track:a', 'A'), 'user');
      qq.enqueue(track('spotify:track:b', 'B'), 'user');
      qq.enqueue(track('spotify:track:c', 'C'), 'user');
      qq.previous();
      qq.previous();
      qq.setState({ shuffle: true, playing: true });
      qq.enqueue(track('spotify:track:new', 'NEW'), 'user', { next: true });
      expect(qq.getSnapshot().tracks[1].uri).toBe('spotify:track:new');
    }
  });

  it('a user add with shuffle ON never lands before the current track', () => {
    for (let run = 0; run < 40; run++) {
      const q = mk();
      q.enqueue(track('spotify:track:a', 'A'), 'user');
      q.enqueue(track('spotify:track:b', 'B'), 'user');
      q.enqueue(track('spotify:track:c', 'C'), 'user');
      q.setState({ shuffle: true, playing: true });
      q.enqueue(track('spotify:track:new', 'NEW'), 'user');
      const snap = q.getSnapshot();
      const newIdx = snap.tracks.findIndex((t) => t.uri === 'spotify:track:new');
      // may be shuffled among upcoming, but never into the played region
      expect(newIdx).toBeGreaterThan(snap.currentIndex);
    }
  });

  it('a user BULK add keeps its internal order even with shuffle ON', () => {
    for (let run = 0; run < 30; run++) {
      const q = mk();
      q.enqueue(track('spotify:track:a', 'A'), 'user');
      q.enqueue(track('spotify:track:b', 'B'), 'user');
      q.setState({ shuffle: true });
      q.enqueueMany(
        [
          track('spotify:track:x1', 'X1'),
          track('spotify:track:x2', 'X2'),
          track('spotify:track:x3', 'X3'),
        ],
        'user',
      );
      const uris = q.getSnapshot().tracks.map((t) => t.uri);
      const i1 = uris.indexOf('spotify:track:x1');
      // the album must stay in sequence wherever the block landed
      expect(uris[i1 + 1]).toBe('spotify:track:x2');
      expect(uris[i1 + 2]).toBe('spotify:track:x3');
    }
  });

  it('an endless-wave refill with shuffle ON never lands ahead of a user track', () => {
    for (let run = 0; run < 40; run++) {
      const q = mk();
      q.enqueue(track('spotify:track:a', 'A'), 'user');
      q.enqueue(track('spotify:track:u1', 'U1'), 'user');
      q.enqueue(track('spotify:track:u2', 'U2'), 'user');
      q.setState({ shuffle: true });
      q.setState({ playing: true });
      q.enqueue(track('spotify:track:ew', 'EW'), 'endless-wave', { keepCursor: true });

      const snap = q.getSnapshot();
      const ewIdx = snap.tracks.findIndex((t) => t.uri === 'spotify:track:ew');
      const u1Idx = snap.tracks.findIndex((t) => t.uri === 'spotify:track:u1');
      const u2Idx = snap.tracks.findIndex((t) => t.uri === 'spotify:track:u2');
      // The filler must sit behind everything the user queued.
      expect(ewIdx).toBeGreaterThan(u1Idx);
      expect(ewIdx).toBeGreaterThan(u2Idx);
    }
  });

  it('repeated refills while only user tracks exist keep them contiguous at the front', () => {
    const q = mk();
    q.enqueue(track('spotify:track:a', 'A'), 'user');
    q.enqueue(track('spotify:track:u1', 'U1'), 'user');
    q.enqueue(track('spotify:track:u2', 'U2'), 'user');
    q.setState({ shuffle: true });
    q.setState({ playing: true });
    for (let i = 0; i < 10; i++) {
      q.enqueue(track(`spotify:track:ew${i}`, `EW${i}`), 'endless-wave', { keepCursor: true });
    }
    const uris = q.getSnapshot().tracks.map((t) => t.uri);
    // User tracks stay in their original relative order, directly after A.
    expect(uris.slice(1, 3)).toEqual(['spotify:track:u1', 'spotify:track:u2']);
  });
});
