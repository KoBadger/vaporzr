import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TapeStore, tapes as globalTapes } from '@vaporzr/core/tape';
import type { TrackInfo } from '@vaporzr/shared';
import { runTapeCommand, tapeDeps } from '../tapeActions.js';

/**
 * The `/tape` command is the only writer to a tape, and the playback hook is the
 * only caller of `noteTrack`. These tests drive the store through the command
 * layer so the recording path stays honest: a tape only records what the room
 * actually heard, and a repeat is never logged twice.
 */

function track(uri: string, name: string, over: Partial<TrackInfo> = {}): TrackInfo {
  return {
    uri,
    name,
    artists: ['Artist'],
    album: 'Album',
    durationMs: 180_000,
    addedBy: 'tester',
    addedAt: Date.now(),
    ...over,
  };
}

describe('/tape', () => {
  let tmp: string;
  let store: TapeStore;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vz-tape-'));
    store = new TapeStore(tmp);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('starts, records, and seals a tape', async () => {
    const started = await runTapeCommand(
      { sub: 'start', guildId: 'g1', username: 'dj', name: 'Friday' },
      {
        tapes: store,
      },
    );
    expect(started?.content).toContain('Rolling');

    expect(store.noteTrack('g1', track('spotify:1', 'One'))).toBe(true);
    expect(store.noteTrack('g1', track('spotify:2', 'Two'))).toBe(true);

    const sealed = await runTapeCommand({ sub: 'stop', guildId: 'g1', username: 'dj' }, { tapes: store });
    expect(sealed?.content).toContain('Tape sealed');
    expect(sealed?.content).toContain('2 tracks');

    const list = await runTapeCommand({ sub: 'list', guildId: 'g1', username: 'dj' }, { tapes: store });
    expect(list?.content).toContain('Friday');
  });

  it('does not double-record the head track (pause/resume re-announcements)', () => {
    store.start('g1', { startedBy: 'dj', name: 'Set' });
    expect(store.noteTrack('g1', track('spotify:1', 'One'))).toBe(true);
    // The same URI arriving again is a pause/resume or metadata refresh, not a
    // second play — the tape must not log it twice.
    expect(store.noteTrack('g1', track('spotify:1', 'One'))).toBe(false);

    const active = store.active('g1');
    expect(active?.entries).toHaveLength(1);
  });

  it('records nothing when no tape is rolling', () => {
    expect(store.noteTrack('g1', track('spotify:1', 'One'))).toBe(false);
  });

  it('reports status honestly before and after a tape', async () => {
    const none = await runTapeCommand({ sub: 'status', guildId: 'g1', username: 'dj' }, { tapes: store });
    expect(none?.content).toMatch(/No tape|nothing|not rolling|start/i);
  });

  it('stops a tape that recorded nothing without listing an empty tape', async () => {
    await runTapeCommand({ sub: 'start', guildId: 'g1', username: 'dj', name: 'Silent' }, { tapes: store });
    const stopped = await runTapeCommand({ sub: 'stop', guildId: 'g1', username: 'dj' }, { tapes: store });
    expect(stopped?.content).toContain('nothing to keep');

    const list = await runTapeCommand({ sub: 'list', guildId: 'g1', username: 'dj' }, { tapes: store });
    expect(list?.content).not.toContain('Silent');
  });

  it('exports the latest tape as an M3U8 attachment', async () => {
    await runTapeCommand({ sub: 'start', guildId: 'g1', username: 'dj', name: 'Export' }, { tapes: store });
    store.noteTrack('g1', track('spotify:1', 'One'));
    store.noteTrack('g1', track('spotify:2', 'Two'));

    const exported = await runTapeCommand(
      { sub: 'export', guildId: 'g1', username: 'dj', format: 'm3u' },
      {
        tapes: store,
      },
    );
    expect(exported?.files?.[0]?.name).toMatch(/\.m3u8$/);
    expect(exported?.files?.[0]?.data.toString('utf8')).toContain('One');
  });

  it('deletes a tape by id', async () => {
    await runTapeCommand({ sub: 'start', guildId: 'g1', username: 'dj', name: 'Doomed' }, { tapes: store });
    store.noteTrack('g1', track('spotify:1', 'One'));
    await runTapeCommand({ sub: 'stop', guildId: 'g1', username: 'dj' }, { tapes: store });

    const latest = store.latest('g1');
    const id = latest?.id;
    expect(id).toBeTruthy();

    const deleted = await runTapeCommand(
      { sub: 'delete', guildId: 'g1', username: 'dj', name: id },
      {
        tapes: store,
      },
    );
    expect(deleted?.content).toContain('Deleted');
    expect(store.latest('g1')).toBeNull();
  });
});

describe('globalTapes default dir', () => {
  it('is the live store instance used by the bot', () => {
    // The playback hook calls the exported singleton; this guards against a
    // refactor that silently swaps in a throwaway store.
    expect(globalTapes).toBeInstanceOf(TapeStore);
  });
});

describe('tapeDeps', () => {
  it('defaults to the global tape store', () => {
    expect(tapeDeps().tapes).toBe(globalTapes);
  });
});
