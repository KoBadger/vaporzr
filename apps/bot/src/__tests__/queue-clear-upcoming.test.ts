import { describe, expect, it } from 'vitest';
import { QueueManager } from '@vaporzr/core/queue';

function track(uri: string, name: string) {
  return { uri, name, artists: [name], album: 'Test Album', durationMs: 180000, source: 'spotify' as const };
}
const mk = () => new QueueManager([]);

describe('clearUpcoming: "clear queue" must not stop the music', () => {
  it('keeps the current track and drops everything after it', () => {
    const q = mk();
    q.enqueue(track('u:a', 'A'), 'user');
    q.enqueue(track('u:b', 'B'), 'user');
    q.enqueue(track('u:c', 'C'), 'user');
    q.next(); // cursor on B
    const removed = q.clearUpcoming();
    expect(removed).toBe(1); // only C was ahead
    const snap = q.getSnapshot();
    expect(snap.tracks.map((t) => t.uri)).toEqual(['u:b']);
    expect(snap.currentIndex).toBe(0);
  });

  it('keeps the playing flag alone (the state is not reset)', () => {
    const q = mk();
    q.enqueue(track('u:a', 'A'), 'user');
    q.enqueue(track('u:b', 'B'), 'user');
    const playingBefore = q.getState().playing;
    q.clearUpcoming();
    expect(q.getState().playing).toBe(playingBefore);
  });

  it('behaves like a full clear when nothing is loaded', () => {
    const q = mk();
    expect(q.clearUpcoming()).toBe(0);
    expect(q.getSnapshot().tracks).toHaveLength(0);
  });

  it('falls back to clear() when the cursor points at nothing', () => {
    const q = mk();
    q.enqueue(track('u:a', 'A'), 'user');
    // Pretend the queue was emptied behind our back: cursor at -1.
    (q as unknown as { currentIndex: number }).currentIndex = -1;
    (q as unknown as { state: { track?: unknown } }).state = { ...q.getState(), track: undefined };
    const removed = q.clearUpcoming();
    expect(removed).toBe(1);
    expect(q.getSnapshot().tracks).toHaveLength(0);
  });
});
