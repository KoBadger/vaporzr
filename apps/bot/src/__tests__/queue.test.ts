import { describe, expect, it } from 'vitest';
import { QueueManager } from '../queue.js';

function track(uri: string, name = uri): { uri: string; name: string; artists: string[]; album: string; durationMs: number } {
  return { uri, name, artists: ['Artist'], album: '', durationMs: 200_000 };
}

describe('QueueManager.enqueue cursor behavior', () => {
  it('records addedBy on the stored item', () => {
    const q = new QueueManager();
    q.enqueue(track('spotify:track:a', 'A'), 'endless-wave');
    expect(q.getSnapshot().tracks[0].addedBy).toBe('endless-wave');
  });

  it('cold start: first enqueue points the cursor at track 0 (either mode)', () => {
    for (const opts of [undefined, { keepCursor: true }]) {
      const q = new QueueManager();
      q.enqueue(track('spotify:track:a', 'A'), 'endless-wave', opts);
      expect(q.getSnapshot().currentIndex).toBe(0);
    }
  });

  it('plain enqueue while idle jumps the cursor to the new tail (legacy behavior)', () => {
    const q = new QueueManager();
    q.enqueue(track('spotify:track:a', 'A'), 'user');
    q.enqueue(track('spotify:track:b', 'B'), 'user');
    // Cursor sits on the last track (index 1); idle enqueue yanks it to the end.
    q.enqueue(track('spotify:track:c', 'C'), 'user');
    expect(q.getSnapshot().currentIndex).toBe(2);
  });

  it('keepCursor enqueue while idle does not pin the cursor at the new tail', () => {
    const q = new QueueManager();
    q.enqueue(track('spotify:track:a', 'A'), 'user');
    q.enqueue(track('spotify:track:b', 'B'), 'user');
    q.enqueue(track('spotify:track:c', 'C'), 'endless-wave', { keepCursor: true });
    const snap = q.getSnapshot();
    // Finished-cursor reset parks at 0 (not the new tail at 2) — the key part
    // is the cursor does NOT follow the refill to the end.
    expect(snap.currentIndex).toBeLessThan(2);
    // The refill's exit counter sees the new track in the upcoming window.
    const upcomingUris = snap.tracks.slice(snap.currentIndex + 1).map((t) => t.uri);
    expect(upcomingUris).toContain('spotify:track:c');
  });

  it('repeated keepCursor refills while idle keep the upcoming window truthful (flood regression)', () => {
    // This is the Endless Wave top-up shape: idle, cursor parked, background
    // refills landing at the tail. Before keepCursor, every enqueue re-pinned
    // the cursor to the end, so `slice(currentIndex + 1)` read empty, the
    // ahead-counter never fired, and the same song queued ~20k times.
    const q = new QueueManager();
    q.enqueue(track('spotify:track:seed', 'Seed'), 'user');
    for (let i = 0; i < 5; i++) {
      q.enqueue(track(`spotify:track:ew${i}`, `EW ${i}`), 'endless-wave', { keepCursor: true });
    }
    const snap = q.getSnapshot();
    expect(snap.currentIndex).toBe(0);
    const upcoming = snap.tracks.slice(snap.currentIndex + 1);
    expect(upcoming).toHaveLength(5);
    expect(upcoming.filter((t) => t.addedBy === 'endless-wave')).toHaveLength(5);
  });

  it('enqueue while playing never moves the cursor (either mode)', () => {
    for (const opts of [undefined, { keepCursor: true }]) {
      const q = new QueueManager();
      q.enqueue(track('spotify:track:a', 'A'), 'user');
      q.setState({ playing: true });
      q.enqueue(track('spotify:track:b', 'B'), 'endless-wave', opts);
      expect(q.getSnapshot().currentIndex).toBe(0);
    }
  });

  it('finished queue + keepCursor refill keeps a countable upcoming window', () => {
    const q = new QueueManager();
    q.enqueue(track('spotify:track:a', 'A'), 'user');
    // Idle with the cursor on the last track (finished state).
    q.enqueue(track('spotify:track:ew1', 'EW 1'), 'endless-wave', { keepCursor: true });
    q.enqueue(track('spotify:track:ew2', 'EW 2'), 'endless-wave', { keepCursor: true });
    const snap = q.getSnapshot();
    // resetCursorIfFinished + cold-start rule park at 0; the two refills sit
    // after it where the top-up ahead-counter can see them.
    const upcoming = snap.tracks.slice(snap.currentIndex + 1);
    expect(upcoming.filter((t) => t.addedBy === 'endless-wave')).toHaveLength(2);
  });
});
