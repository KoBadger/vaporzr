import { describe, expect, it } from 'vitest';
import { QueueManager } from '../queue.js';

function track(uri: string, name: string) {
  return { uri, name, artists: [name], album: 'Test Album', durationMs: 180000, source: 'spotify' as const };
}
const mk = () => new QueueManager([]);

describe('playedThrough distinguishes a finished queue from an idle one', () => {
  it('an idle queue that merely built up is NOT treated as finished', () => {
    const q = mk();
    q.enqueue(track('u:a', 'A'), 'user');
    q.enqueue(track('u:b', 'B'), 'user');
    q.enqueue(track('u:c', 'C'), 'user');
    expect(q.isPlayedThrough()).toBe(false);
  });

  it('markPlayedThrough flags the queue but keeps the cursor on the last track', () => {
    const q = mk();
    q.enqueue(track('u:a', 'A'), 'user');
    q.enqueue(track('u:b', 'B'), 'user');
    expect(q.next()).toBe(true); // walk to the last track (0 → 1)
    q.markPlayedThrough();
    expect(q.isPlayedThrough()).toBe(true);
    // The cursor stays put so `play()` can replay it and the many
    // `upcoming = slice(currentIndex + 1)` consumers read an empty list.
    expect(q.getSnapshot().currentIndex).toBe(1);
  });

  it('a genuinely finished queue takes a new track at the TAIL and plays it', () => {
    const q = mk();
    q.enqueue(track('u:a', 'A'), 'user');
    q.enqueue(track('u:b', 'B'), 'user');
    q.markPlayedThrough();
    q.enqueue(track('u:c', 'C'), 'user');
    const snap = q.getSnapshot();
    expect(snap.tracks.map((t) => t.uri)).toEqual(['u:a', 'u:b', 'u:c']);
    expect(snap.currentIndex).toBe(2); // the new track becomes current
    expect(q.isPlayedThrough()).toBe(false); // queue is playable again
  });

  it('adding to an IDLE (unfinished) queue does not reorder it', () => {
    const q = mk();
    q.enqueue(track('u:a', 'A'), 'user');
    q.enqueue(track('u:b', 'B'), 'user');
    q.enqueue(track('u:c', 'C'), 'user');
    q.enqueue(track('u:d', 'D'), 'user');
    const snap = q.getSnapshot();
    // must append in order — never insert at the front
    expect(snap.tracks.map((t) => t.uri)).toEqual(['u:a', 'u:b', 'u:c', 'u:d']);
    expect(q.isPlayedThrough()).toBe(false);
  });

  it('stepping back with previous() un-finishes the queue', () => {
    const q = mk();
    q.enqueue(track('u:a', 'A'), 'user');
    q.enqueue(track('u:b', 'B'), 'user');
    q.next();
    q.markPlayedThrough();
    expect(q.isPlayedThrough()).toBe(true);
    expect(q.previous()).toBe(true);
    expect(q.isPlayedThrough()).toBe(false);
  });

  it('clear() resets the finished marker', () => {
    const q = mk();
    q.enqueue(track('u:a', 'A'), 'user');
    q.markPlayedThrough();
    q.clear();
    expect(q.isPlayedThrough()).toBe(false);
  });

  it('the finished marker survives serialize/restore', () => {
    const q = mk();
    q.enqueue(track('u:a', 'A'), 'user');
    q.markPlayedThrough();
    const saved = q.serialize();
    expect(saved.playedThrough).toBe(true);

    const q2 = mk();
    q2.restore(saved);
    expect(q2.isPlayedThrough()).toBe(true);
    // and a restored-finished queue still appends rather than front-inserting
    q2.enqueue(track('u:b', 'B'), 'user');
    expect(q2.getSnapshot().tracks.map((t) => t.uri)).toEqual(['u:a', 'u:b']);
  });

  it('a plain restore without the marker is not considered finished', () => {
    const q = mk();
    q.enqueue(track('u:a', 'A'), 'user');
    q.enqueue(track('u:b', 'B'), 'user');
    const q2 = mk();
    q2.restore(q.serialize());
    expect(q2.isPlayedThrough()).toBe(false);
  });
});
