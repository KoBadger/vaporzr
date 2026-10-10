import { describe, expect, it } from 'vitest';
import { QueueManager } from '@vaporzr/core/queue';

function track(uri: string, name = uri) {
  return { uri, name, artists: ['Artist'], album: '', durationMs: 200_000 };
}

// Regression: the queue cursor could drift ahead of the track actually playing
// (a cursor move whose play never started). Every advance path in playback
// resolves "the current track" through the cursor, so a drifted cursor made them
// all bail silently and the bot went quiet until the user skipped. focusUri
// restores the invariant before advancing.
describe('QueueManager.focusUri (cursor/audio re-sync)', () => {
  it('re-points the cursor at the playing track after it drifted', () => {
    const q = new QueueManager();
    q.enqueue(track('spotify:track:a', 'A'), 'user');
    q.enqueue(track('spotify:track:b', 'B'), 'user');
    q.enqueue(track('spotify:track:c', 'C'), 'user');
    // The drift: the cursor moved to C while B is what is actually playing.
    q.next();
    q.next();
    expect(q.getCurrentTrack()?.uri).toBe('spotify:track:c');

    expect(q.focusUri('spotify:track:b')).toBe(true);
    expect(q.getCurrentTrack()?.uri).toBe('spotify:track:b');

    // Advancing from here plays the track AFTER the playing one — not the one the
    // cursor had drifted to (which would have silently skipped it).
    q.next();
    expect(q.getCurrentTrack()?.uri).toBe('spotify:track:c');
  });

  it('is a no-op when already on the track, or when the uri is not in the queue', () => {
    const q = new QueueManager();
    q.enqueue(track('spotify:track:a', 'A'), 'user');
    expect(q.focusUri('spotify:track:a')).toBe(false);
    expect(q.focusUri('spotify:track:missing')).toBe(false);
    expect(q.getCurrentTrack()?.uri).toBe('spotify:track:a');
  });
});
