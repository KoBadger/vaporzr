import { describe, expect, it } from 'vitest';
import { QueueManager } from '@vaporzr/core/queue';

function track(
  uri: string,
  name = uri,
): { uri: string; name: string; artists: string[]; album: string; durationMs: number } {
  return { uri, name, artists: ['Artist'], album: '', durationMs: 200_000 };
}

describe('QueueManager.insertAfterCurrent (panel Play-next)', () => {
  it('lands the batch directly after the playing track and keeps the cursor', () => {
    const q = new QueueManager();
    q.enqueue(track('a'), 'user');
    q.enqueue(track('b'), 'user');
    q.enqueue(track('c'), 'user');
    q.setState({ playing: true });

    q.insertAfterCurrent([track('x'), track('y')], 'panel');

    const snap = q.getSnapshot();
    expect(snap.tracks.map((t) => t.uri)).toEqual(['a', 'x', 'y', 'b', 'c']);
    expect(snap.currentIndex).toBe(0); // still on "a" while it plays
    // Inserted tracks are credited to the panel, not the requesting user.
    expect(snap.tracks[1].addedBy).toBe('panel');
  });

  it('moves the cursor onto the inserted batch when nothing is playing', () => {
    const q = new QueueManager();
    q.enqueue(track('a'), 'user');
    q.enqueue(track('b'), 'user');

    q.insertAfterCurrent([track('x')], 'panel');

    const snap = q.getSnapshot();
    expect(snap.tracks.map((t) => t.uri)).toEqual(['a', 'x', 'b']);
    expect(snap.currentIndex).toBe(1); // so pressing play starts "x", not "a"
  });
});
