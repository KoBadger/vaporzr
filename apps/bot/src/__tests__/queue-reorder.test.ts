import { describe, expect, it } from 'vitest';
import { emptyState } from '@vaporzr/shared';
import { QueueManager } from '@vaporzr/core/queue';

function track(uri: string): {
  uri: string;
  name: string;
  artists: string[];
  album: string;
  durationMs: number;
  addedBy: string;
  addedAt: number;
} {
  return { uri, name: uri, artists: ['Artist'], album: '', durationMs: 200_000, addedBy: 'user', addedAt: Date.now() };
}

const order = (q: QueueManager): string[] => q.getSnapshot().tracks.map((t) => t.uri);

describe('QueueManager.reorderUpcoming', () => {
  it('reorders the whole queue when nothing is loaded yet (cursor -1)', () => {
    // A restored-but-never-started queue keeps currentIndex -1; smart shuffle
    // must still work before playback begins.
    const q = new QueueManager();
    q.restore({ tracks: [track('a'), track('b'), track('c')], currentIndex: -1, state: emptyState() });
    const moved = q.reorderUpcoming(['c', 'a', 'b']);
    expect(moved).toBeGreaterThan(0);
    expect(order(q)).toEqual(['c', 'a', 'b']);
  });

  it('never touches the current track (reorders only what is ahead)', () => {
    const q = new QueueManager();
    q.restore({ tracks: [track('a'), track('b'), track('c')], currentIndex: 0, state: emptyState() });
    const moved = q.reorderUpcoming(['c', 'b']);
    expect(moved).toBeGreaterThan(0);
    expect(order(q)).toEqual(['a', 'c', 'b']);
  });
});
