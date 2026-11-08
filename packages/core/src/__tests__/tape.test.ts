import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { TrackInfo } from '@vaporzr/shared';
import { TapeStore, entryFromTrack, orderSetlist, summarizeTape, tapeKey, toSetlist, type TapeEntry } from '../tape.js';

/**
 * Timestamps are anchored to the real clock: the store's staleness guards compare
 * entry times against the machine's now, so hard-coded historical dates would
 * (correctly) look like an abandoned tape from another era.
 */
const T0 = Date.now();

/** Each test gets its own directory: one shared dir would leak a sealed tape between tests. */
const dirs: string[] = [];
function tempDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vaporzr-tape-'));
  dirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

function track(over: Partial<TrackInfo> = {}): TrackInfo {
  return {
    uri: 'spotify:track:abc',
    name: 'Nightcall',
    artists: ['Kavinsky'],
    album: 'OutRun',
    durationMs: 258_000,
    source: 'spotify',
    addedBy: 'josh',
    addedAt: 1_700_000_000_000,
    ...over,
  };
}

function entry(over: Partial<TapeEntry> = {}): TapeEntry {
  return {
    uri: 'spotify:track:abc',
    name: 'Nightcall',
    artists: ['Kavinsky'],
    album: 'OutRun',
    durationMs: 258_000,
    source: 'spotify',
    addedBy: 'josh',
    playedAt: 1_700_000_000_000,
    heard: 'player',
    ...over,
  };
}

describe('tapeKey', () => {
  it('collapses case and whitespace so the same song has one identity', () => {
    expect(tapeKey({ name: '  Night CALL ', artists: ['Kavinsky'] })).toBe('night call | kavinsky');
    expect(tapeKey({ name: 'Nightcall', artists: ['Kavinsky', 'Guest'] })).toBe(
      tapeKey({ name: 'nightcall', artists: ['Kavinsky'] }),
    );
  });

  it('survives a missing artist without leaving a dangling separator', () => {
    expect(tapeKey({ name: 'Untitled', artists: [] })).toBe('untitled');
  });
});

describe('entryFromTrack', () => {
  it('carries the queue metadata across, including who queued it', () => {
    const e = entryFromTrack(track(), { now: 42 });
    expect(e).toMatchObject({
      uri: 'spotify:track:abc',
      name: 'Nightcall',
      artists: ['Kavinsky'],
      album: 'OutRun',
      durationMs: 258_000,
      source: 'spotify',
      addedBy: 'josh',
      playedAt: 42,
      heard: 'player',
    });
  });

  it('defaults heard entries to the ears and clamps confidence', () => {
    const e = entryFromTrack(track({ source: undefined }), { heard: 'ears', confidence: 9 });
    expect(e.heard).toBe('ears');
    expect(e.addedBy).toBe('ears');
    expect(e.confidence).toBe(1);
    expect(e.source).toBe('spotify');
  });

  it('copies the artist array rather than aliasing the queue track', () => {
    const source = track();
    const e = entryFromTrack(source);
    e.artists.push('Someone Else');
    expect(source.artists).toEqual(['Kavinsky']);
  });
});

describe('toSetlist', () => {
  it('keeps first-play order and counts repeats instead of dropping them', () => {
    const list = toSetlist([
      entry({ uri: 'a', name: 'One', artists: ['X'] }),
      entry({ uri: 'b', name: 'Two', artists: ['Y'] }),
      entry({ uri: 'a', name: 'One', artists: ['X'] }),
      entry({ uri: 'c', name: 'Three', artists: ['Z'] }),
      entry({ uri: 'a', name: 'One', artists: ['X'] }),
    ]);
    expect(list.map((i) => i.entry.name)).toEqual(['One', 'Two', 'Three']);
    expect(list.map((i) => i.plays)).toEqual([3, 1, 1]);
  });

  it('treats the same song re-queued from another provider as one entry', () => {
    const list = toSetlist([
      entry({ uri: 'spotify:track:1', name: 'Song', artists: ['Artist'] }),
      entry({ uri: 'youtube:video:xyz', name: 'song', artists: ['artist'], source: 'youtube' }),
    ]);
    expect(list).toHaveLength(1);
    expect(list[0].plays).toBe(2);
    expect(list[0].entry.uri).toBe('spotify:track:1');
  });
});

describe('summarizeTape', () => {
  it('reports unique songs, distinct artists and the heard/player split', () => {
    const tape = {
      id: 't',
      name: 'Tape',
      guildId: 'g',
      startedBy: 'josh',
      startedAt: 0,
      entries: [
        entry({ uri: 'a', name: 'One', artists: ['X', 'X2'], playedAt: 1_000 }),
        entry({ uri: 'b', name: 'Two', artists: ['Y'], playedAt: 61_000 }),
        entry({ uri: 'a', name: 'One', artists: ['X', 'X2'], playedAt: 121_000, heard: 'ears' }),
      ],
    };
    const s = summarizeTape(tape);
    expect(s.total).toBe(3);
    expect(s.unique).toBe(2);
    expect(s.artists.sort()).toEqual(['X', 'X2', 'Y']);
    expect(s.players).toBe(2);
    expect(s.ears).toBe(1);
    expect(s.elapsedMs).toBe(120_000);
  });

  it('reports zero elapsed time for a single-entry tape', () => {
    const s = summarizeTape({
      id: 't',
      name: 'Tape',
      guildId: 'g',
      startedBy: 'josh',
      startedAt: 0,
      entries: [entry()],
    });
    expect(s.elapsedMs).toBe(0);
  });
});

describe('orderSetlist', () => {
  const quiet = entry({ uri: 'q', name: 'Quiet', artists: ['A'] });
  const loud = entry({ uri: 'l', name: 'Loud', artists: ['B'] });
  const unknown = entry({ uri: 'u', name: 'Unknown', artists: ['C'] });
  const features: Record<string, { energy: number; valence: number; tempo: number }> = {
    q: { energy: 0.1, valence: 0.4, tempo: 80 },
    l: { energy: 0.95, valence: 0.8, tempo: 150 },
  };
  const featOf = (e: TapeEntry): { energy: number; valence: number; tempo: number } | undefined => features[e.uri];

  it('leaves the recorded order untouched in time mode', () => {
    const entries = [loud, quiet];
    expect(orderSetlist(entries, 'time', featOf)).toBe(entries);
  });

  it('never loses or invents songs when re-sequencing', () => {
    const entries = [quiet, unknown, loud];
    for (const mode of ['flow', 'arc', 'key'] as const) {
      const out = orderSetlist(entries, mode, featOf);
      expect(out).toHaveLength(3);
      expect(new Set(out.map((e) => e.uri))).toEqual(new Set(['q', 'l', 'u']));
    }
  });

  it('holds a song with no features at its original index', () => {
    const entries = [loud, unknown, quiet];
    const out = orderSetlist(entries, 'flow', featOf);
    expect(out[1].uri).toBe('u');
  });

  it('starts the set on the song that opened the tape', () => {
    // Greedy ranking anchors on entry 0, so a re-sequenced set still opens with
    // the track the room actually opened with.
    const entries = [quiet, loud, entry({ uri: 'm', name: 'Mid', artists: ['D'] })];
    const mid = { energy: 0.5, valence: 0.5, tempo: 110 };
    features.m = mid;
    expect(orderSetlist(entries, 'flow', featOf)[0].uri).toBe('q');
  });
});

describe('TapeStore lifecycle', () => {
  let store: TapeStore;
  let dir: string;
  beforeEach(() => {
    dir = tempDir();
    store = new TapeStore(dir);
  });

  it('rolls one tape at a time', () => {
    const first = store.start('g1', { startedBy: 'josh', now: T0 });
    expect(first.ok).toBe(true);
    const second = store.start('g1', { startedBy: 'josh', now: T0 + 1_000 });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toContain('already rolling');
    expect(store.isRolling('g1')).toBe(true);
  });

  it('records track starts and ignores a re-announced same track', () => {
    store.start('g1', { startedBy: 'josh' });
    expect(store.noteTrack('g1', track())).toBe(true);
    // Pause/resume re-announces the same track; it is one play, not two.
    expect(store.noteTrack('g1', track())).toBe(false);
    expect(store.noteTrack('g1', track({ uri: 'spotify:track:def', name: 'Other' }))).toBe(true);
    expect(store.active('g1')?.entries).toHaveLength(2);
  });

  it('records nothing while no tape is rolling', () => {
    expect(store.noteTrack('g1', track())).toBe(false);
    expect(store.active('g1')).toBeNull();
  });

  it('seals on stop and lists the finished tape', () => {
    store.start('g1', { startedBy: 'josh', name: 'Friday', now: T0 });
    store.noteTrack('g1', track());
    const sealed = store.stop('g1', T0 + 600_000);
    expect(sealed?.endedAt).toBe(T0 + 600_000);
    expect(store.active('g1')).toBeNull();
    expect(store.list('g1').map((t) => t.name)).toEqual(['Friday']);
    expect(store.latest('g1')?.id).toBe(sealed?.id);
  });

  it('drops an empty tape instead of listing a blank night', () => {
    store.start('g1', { startedBy: 'josh' });
    expect(store.stop('g1')).toBeNull();
    expect(store.list('g1')).toEqual([]);
  });

  it('keeps the rolling tape as latest() while it is open', () => {
    store.start('g1', { startedBy: 'josh', name: 'Old', now: T0 });
    store.noteTrack('g1', track());
    store.stop('g1', T0 + 1);
    store.start('g1', { startedBy: 'josh', name: 'New', now: T0 + 2 });
    expect(store.latest('g1')?.name).toBe('New');
  });

  it('persists across instances and reloads the sealed tape', () => {
    store.start('g2', { startedBy: 'josh', name: 'Persisted' });
    store.noteTrack('g2', track());
    store.stop('g2');
    const b = new TapeStore(dir);
    expect(b.list('g2').map((t) => t.name)).toEqual(['Persisted']);
    expect(b.list('g2')[0].entries).toHaveLength(1);
  });

  it('survives a hard exit by flushing debounced entries on demand', () => {
    // note() batches disk writes, so shutdown must be able to force one out or
    // a redeploy would silently drop the last few minutes of the tape.
    store.start('g3', { startedBy: 'josh', name: 'Flushed' });
    store.noteTrack('g3', track());
    store.noteTrack('g3', track({ uri: 'spotify:track:def', name: 'Second' }));
    // The open tape itself is written immediately; only its entries are batched.
    expect(new TapeStore(dir).active('g3')?.entries).toHaveLength(0);
    store.flushAll();
    expect(new TapeStore(dir).active('g3')?.entries).toHaveLength(2);
  });

  it('recognises a duplicate heard song by title and artist, not by uri', () => {
    store.start('g1', { startedBy: 'josh' });
    const heard = (name: string, artist: string, uri: string): TapeEntry =>
      entry({ name, artists: [artist], uri, heard: 'ears', addedBy: 'ears' });
    expect(store.noteHeard('g1', heard('Song', 'Artist', 'spotify:track:1'))).toBe(true);
    expect(store.noteHeard('g1', heard('song', 'artist', 'spotify:track:1'))).toBe(false);
    expect(store.noteHeard('g1', heard('Other', 'Artist', 'spotify:track:2'))).toBe(true);
  });

  it('seals the tape once it hits the entry cap and accepts a fresh one', () => {
    store.start('g1', { startedBy: 'josh', name: 'Marathon' });
    for (let i = 0; i < 300; i++) {
      expect(store.noteTrack('g1', track({ uri: `spotify:track:${i}`, name: `Track ${i}` }))).toBe(true);
    }
    expect(store.noteTrack('g1', track({ uri: 'spotify:track:overflow', name: 'Overflow' }))).toBe(false);
    expect(store.active('g1')).toBeNull();
    expect(store.list('g1')[0].entries).toHaveLength(300);
  });

  it('removes and looks up tapes by id', () => {
    store.start('g1', { startedBy: 'josh', name: 'Lookup' });
    store.noteTrack('g1', track());
    const sealed = store.stop('g1');
    expect(store.get('g1', sealed!.id)?.name).toBe('Lookup');
    expect(store.remove('g1', sealed!.id)).toBe(true);
    expect(store.get('g1', sealed!.id)).toBeNull();
    expect(store.remove('g1', 'nope')).toBe(false);
  });

  it('seals a tape that outlived its maximum span when the next one starts', () => {
    store.start('g1', { startedBy: 'josh', name: 'Stale', now: T0 });
    store.noteTrack('g1', track());
    // 13 hours later: the old tape is past MAX_TAPE_MS and must not block a new one.
    const fresh = store.start('g1', { startedBy: 'josh', name: 'Fresh', now: T0 + 13 * 60 * 60 * 1000 });
    expect(fresh.ok).toBe(true);
    expect(store.list('g1').map((t) => t.name)).toEqual(['Stale']);
  });
});
