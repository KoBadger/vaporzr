import { describe, expect, it } from 'vitest';
import { emptyState } from '@vaporzr/shared';
import { QueueManager } from '../queue.js';

function track(uri: string, name = uri): { uri: string; name: string; artists: string[]; album: string; durationMs: number } {
  return { uri, name, artists: ['Artist'], album: '', durationMs: 200_000 };
}

describe('QueueManager.filterNew', () => {
  it('drops a track that is already waiting (same uri)', () => {
    const q = new QueueManager();
    q.enqueue(track('spotify:track:a', 'A'), 'user');
    expect(q.filterNew([track('spotify:track:a', 'A')])).toHaveLength(0);
  });

  it('drops the same song from a different upload (title|artist)', () => {
    const q = new QueueManager();
    q.enqueue({ ...track('spotify:track:a', 'Mikado'), artists: ['Kredo'] }, 'user');
    const other = { ...track('youtube:video:x', 'Mikado - Official Audio'), artists: ['Kredo - Topic'] };
    expect(q.filterNew([other])).toHaveLength(0);
  });

  it('allows re-queueing a song that already played (cursor moved past it)', () => {
    const q = new QueueManager();
    q.enqueue(track('spotify:track:a', 'A'), 'user');
    q.enqueue(track('spotify:track:b', 'B'), 'user');
    q.next();
    expect(q.filterNew([track('spotify:track:a', 'A')])).toHaveLength(1);
  });

  it('collapses duplicates inside the batch itself', () => {
    const q = new QueueManager();
    expect(q.filterNew([track('spotify:track:a', 'A'), track('spotify:track:a', 'A')])).toHaveLength(1);
  });
});

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

describe('QueueManager regressions', () => {
  it('enqueueMany counts each track exactly once, even under shuffle', () => {
    const q = new QueueManager();
    q.enqueue(track('spotify:track:a', 'A'), 'user');
    q.setState({ shuffle: true });
    q.enqueueMany([track('spotify:track:b', 'B'), track('spotify:track:c', 'C')], 'user');
    // Before the fix each shuffled add went through enqueue() (which counts)
    // and was then counted again in bulk, inflating the stats total.
    expect(q.totalEnqueued).toBe(3);
    expect(q.getSnapshot().tracks).toHaveLength(3);
  });

  it('enqueueMany returns the insert index instead of -1 after adding tracks', () => {
    const q = new QueueManager();
    expect(q.enqueueMany([track('spotify:track:a', 'A')], 'user')).toBe(0);
    expect(q.enqueueMany([track('spotify:track:b', 'B')], 'user')).toBe(1);
    expect(q.enqueueMany([], 'user')).toBe(-1);
  });

  it('next() and previous() notify listeners so the cursor cannot go stale', () => {
    const q = new QueueManager();
    q.enqueue(track('spotify:track:a', 'A'), 'user');
    q.enqueue(track('spotify:track:b', 'B'), 'user'); // idle → cursor pinned to the tail (1)
    let changes = 0;
    q.subscribe({ onQueueChanged: () => { changes++; }, onStateChanged: () => {} });
    expect(q.next()).toBe(false); // already at the end — no movement, no emit
    expect(changes).toBe(0);
    expect(q.previous()).toBe(true); // 1 → 0
    expect(changes).toBe(1);
    expect(q.next()).toBe(true); // 0 → 1
    expect(changes).toBe(2);
  });

  it('remove() of the now-playing track re-syncs state to the new current track', () => {
    const q = new QueueManager();
    q.setState({ playing: true });
    q.enqueue(track('spotify:track:a', 'A'), 'user');
    q.enqueue(track('spotify:track:b', 'B'), 'user');
    q.enqueue(track('spotify:track:c', 'C'), 'user'); // playing → cursor stays on A
    q.setState({ track: q.getCurrentTrack() });
    q.remove(0);
    const st = q.getState();
    expect(q.getSnapshot().currentIndex).toBe(0);
    expect(st.track?.uri).toBe('spotify:track:b');
    expect(st.playing).toBe(true);
  });

  it('remove() of the last track clears now-playing and stops playback', () => {
    const q = new QueueManager();
    q.setState({ playing: true });
    q.enqueue(track('spotify:track:a', 'A'), 'user');
    q.setState({ track: q.getCurrentTrack() });
    q.remove(0);
    const st = q.getState();
    expect(q.getSnapshot().tracks).toHaveLength(0);
    expect(q.getSnapshot().currentIndex).toBe(-1);
    expect(st.playing).toBe(false);
    expect(st.track).toBeUndefined();
  });

  it('restore() defaults a missing cursor to the first track', () => {
    const q = new QueueManager();
    q.restore({
      tracks: [{ ...track('spotify:track:a', 'A'), addedBy: 'u', addedAt: 0 }],
      currentIndex: undefined as unknown as number,
      state: emptyState(),
    });
    expect(q.getSnapshot().currentIndex).toBe(0);
    expect(q.getState().track?.uri).toBe('spotify:track:a');
  });

  it('restore() keeps an explicit finished cursor (-1) and zeroes the duration', () => {
    const q = new QueueManager();
    q.restore({
      tracks: [{ ...track('spotify:track:a', 'A'), addedBy: 'u', addedAt: 0 }],
      currentIndex: -1,
      state: { ...emptyState(), positionMs: 1234, durationMs: 200_000 },
    });
    const st = q.getState();
    expect(q.getSnapshot().currentIndex).toBe(-1);
    expect(st.track).toBeUndefined();
    expect(st.durationMs).toBe(0);
  });
});

describe('QueueManager.dedupe', () => {
  it('removes duplicate upcoming tracks by uri, keeping the first', () => {
    const q = new QueueManager();
    q.setState({ playing: true });
    q.enqueue(track('spotify:track:a', 'A'), 'u');
    q.enqueue(track('spotify:track:b', 'B'), 'u');
    q.enqueue(track('spotify:track:a', 'A'), 'u');
    q.enqueue(track('spotify:track:c', 'C'), 'u');
    expect(q.dedupe()).toBe(1);
    expect(q.getSnapshot().tracks.map((t) => t.uri)).toEqual([
      'spotify:track:a',
      'spotify:track:b',
      'spotify:track:c',
    ]);
  });

  it('catches the same song from a different upload (title+artist)', () => {
    const q = new QueueManager();
    q.setState({ playing: true });
    q.enqueue(track('youtube:video:x', 'Fix It'), 'u');
    q.enqueue(track('youtube:video:y', 'Fix It (Official Audio)'), 'u');
    expect(q.dedupe()).toBe(1);
    expect(q.getSnapshot().tracks).toHaveLength(1);
  });

  it('never touches played tracks or the current track', () => {
    const q = new QueueManager();
    q.setState({ playing: true });
    q.enqueue(track('spotify:track:a', 'A'), 'u'); // current (idx 0)
    q.enqueue(track('spotify:track:a', 'A'), 'u'); // duplicate upcoming
    q.enqueue(track('spotify:track:b', 'B'), 'u');
    expect(q.dedupe()).toBe(1);
    expect(q.getSnapshot().tracks).toHaveLength(2);
    expect(q.getSnapshot().currentIndex).toBe(0);
  });

  it('returns 0 when there is nothing to remove', () => {
    const q = new QueueManager();
    q.setState({ playing: true });
    q.enqueue(track('spotify:track:a', 'A'), 'u');
    q.enqueue(track('spotify:track:b', 'B'), 'u');
    expect(q.dedupe()).toBe(0);
  });
});

describe('QueueManager.removeUpTo (skip-to)', () => {
  it('drops the upcoming tracks before the chosen one', () => {
    const q = new QueueManager();
    q.setState({ playing: true });
    q.enqueue(track('spotify:track:a', 'A'), 'u');
    q.enqueue(track('spotify:track:b', 'B'), 'u');
    q.enqueue(track('spotify:track:c', 'C'), 'u');
    q.enqueue(track('spotify:track:d', 'D'), 'u');
    // current = index 0; jump to index 3 removes b and c
    expect(q.removeUpTo(3)).toBe(2);
    const snap = q.getSnapshot();
    expect(snap.tracks.map((t) => t.uri)).toEqual(['spotify:track:a', 'spotify:track:d']);
    expect(snap.currentIndex).toBe(0);
  });

  it('is a no-op for the current/next track or an out-of-range index', () => {
    const q = new QueueManager();
    q.setState({ playing: true });
    q.enqueue(track('spotify:track:a', 'A'), 'u');
    q.enqueue(track('spotify:track:b', 'B'), 'u');
    q.enqueue(track('spotify:track:c', 'C'), 'u');
    expect(q.removeUpTo(0)).toBe(0);
    expect(q.removeUpTo(1)).toBe(0);
    expect(q.removeUpTo(9)).toBe(0);
    expect(q.getSnapshot().tracks).toHaveLength(3);
  });
});
