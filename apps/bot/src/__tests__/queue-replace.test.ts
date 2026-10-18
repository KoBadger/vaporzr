import { describe, expect, it } from 'vitest';
import { emptyState } from '@vaporzr/shared';
import { QueueManager } from '@vaporzr/core/queue';

/** TrackInfo-shaped fixture (addedBy/addedAt are supplied by the queue). */
function track(uri: string): { uri: string; name: string; artists: string[]; album: string; durationMs: number } {
  return { uri, name: uri, artists: ['Artist'], album: '', durationMs: 200_000 };
}

const order = (q: QueueManager): string[] => q.getSnapshot().tracks.map((t) => t.uri);

describe('QueueManager.replaceAt', () => {
  it('swaps an upcoming track in place, keeping its position and the queue length', () => {
    const q = new QueueManager();
    q.restore({
      tracks: [
        { ...track('a'), addedBy: 'u', addedAt: 1 },
        { ...track('b'), addedBy: 'u', addedAt: 2 },
        { ...track('c'), addedBy: 'u', addedAt: 3 },
      ],
      currentIndex: 0,
      state: emptyState(),
    });
    const prev = q.replaceAt(2, track('right'), 'u');
    expect(prev?.uri).toBe('c');
    expect(order(q)).toEqual(['a', 'b', 'right']);
  });

  it('refuses to replace the track that is already playing', () => {
    const q = new QueueManager();
    q.restore({
      tracks: [
        { ...track('a'), addedBy: 'u', addedAt: 1 },
        { ...track('b'), addedBy: 'u', addedAt: 2 },
      ],
      currentIndex: 0,
      state: emptyState(),
    });
    expect(q.replaceAt(0, track('x'), 'u')).toBeUndefined();
    expect(order(q)).toEqual(['a', 'b']);
  });

  it('replaces the first slot when nothing has started yet (cursor -1)', () => {
    const q = new QueueManager();
    q.restore({
      tracks: [{ ...track('a'), addedBy: 'u', addedAt: 1 }],
      currentIndex: -1,
      state: emptyState(),
    });
    expect(q.replaceAt(0, track('b'), 'u')?.uri).toBe('a');
    expect(order(q)).toEqual(['b']);
  });

  it('ignores out-of-range indexes', () => {
    const q = new QueueManager();
    q.restore({
      tracks: [{ ...track('a'), addedBy: 'u', addedAt: 1 }],
      currentIndex: 0,
      state: emptyState(),
    });
    expect(q.replaceAt(5, track('x'), 'u')).toBeUndefined();
    expect(q.replaceAt(-1, track('x'), 'u')).toBeUndefined();
    expect(order(q)).toEqual(['a']);
  });

  it('stamps the new track with the requester', () => {
    const q = new QueueManager();
    q.restore({
      tracks: [
        { ...track('a'), addedBy: 'u', addedAt: 1 },
        { ...track('wrong'), addedBy: 'u', addedAt: 2 },
      ],
      currentIndex: 0,
      state: emptyState(),
    });
    q.replaceAt(1, track('right'), 'someone-else');
    expect(q.getSnapshot().tracks[1].addedBy).toBe('someone-else');
  });
});
