import { describe, expect, it } from 'vitest';
import {
  KARAOKE_MAX_ENTRIES,
  KaraokeQueue,
  activeKaraokeLine,
  activeKaraokeWord,
  karaokeLineProgress,
  karaokeWordProgress,
  plainLyricLines,
  type AddKaraokeInput,
} from '@vaporzr/core/karaoke';

const singer = (singerId: string, title: string, addedAt: number): AddKaraokeInput => ({
  singer: singerId.toUpperCase(),
  singerId,
  title,
  addedAt,
});

describe('KaraokeQueue', () => {
  it('queues one song per singer and refuses a second', () => {
    const q = new KaraokeQueue();
    const first = q.add(singer('a', 'Song One', 1));
    expect(first.ok).toBe(true);
    expect(first.entry?.title).toBe('Song One');
    expect(first.entry?.status).toBe('queued');

    const second = q.add(singer('a', 'Song Two', 2));
    expect(second.ok).toBe(false);
    expect(second.message).toContain('Song One');
    expect(q.size).toBe(1);

    // A different person is always welcome.
    expect(q.add(singer('b', 'Song Three', 3)).ok).toBe(true);
    expect(q.size).toBe(2);
  });

  it('alternates singers instead of letting one person hog the line', () => {
    const q = new KaraokeQueue();
    q.add(singer('a', 'A1', 1));
    q.add(singer('a', 'A2', 2), { allowDuplicate: true });
    q.add(singer('b', 'B1', 3));
    expect(q.list().map((e) => e.title)).toEqual(['A1', 'B1', 'A2']);
  });

  it('marks the current turn and keeps it first in the list', () => {
    const q = new KaraokeQueue();
    q.add(singer('a', 'A1', 1));
    q.add(singer('b', 'B1', 2));
    const turn = q.next();
    expect(turn?.title).toBe('A1');
    expect(q.current()?.title).toBe('A1');
    expect(q.list()[0].title).toBe('A1');
    expect(q.state({ open: true, instrumental: true }).current?.title).toBe('A1');
  });

  it('moves a skipped song to the back of that singer own line', () => {
    const q = new KaraokeQueue();
    q.add(singer('a', 'A1', 1));
    q.add(singer('a', 'A2', 2), { allowDuplicate: true });
    q.add(singer('b', 'B1', 3));
    const turn = q.next();
    expect(turn?.title).toBe('A1');
    q.requeue(turn!.id, 10);
    expect(q.next()?.title).toBe('A2');
    expect(q.list().map((e) => e.title)).toEqual(['A2', 'B1', 'A1']);
  });

  it('removes an entry and forgets it as the current turn', () => {
    const q = new KaraokeQueue();
    const a1 = q.add(singer('a', 'A1', 1)).entry!;
    q.next();
    expect(q.remove(a1.id)?.title).toBe('A1');
    expect(q.current()).toBeNull();
    expect(q.empty).toBe(true);
    expect(q.remove('nope')).toBeNull();
  });

  it('updates preparation status in place', () => {
    const q = new KaraokeQueue();
    const entry = q.add(singer('a', 'A1', 1)).entry!;
    const updated = q.update(entry.id, { status: 'preparing', detail: 'separating 40%' });
    expect(updated?.status).toBe('preparing');
    expect(q.list()[0].detail).toBe('separating 40%');
  });

  it('caps the queue rather than accepting an unbounded wait', () => {
    const q = new KaraokeQueue();
    for (let i = 0; i < KARAOKE_MAX_ENTRIES; i++) q.add(singer(`s${i}`, `Song ${i}`, i));
    expect(q.size).toBe(KARAOKE_MAX_ENTRIES);
    const over = q.add(singer('late', 'Too Late', 999));
    expect(over.ok).toBe(false);
    expect(over.message).toContain('full');
  });

  it('clears everything including the current turn', () => {
    const q = new KaraokeQueue();
    q.add(singer('a', 'A1', 1));
    q.next();
    q.clear();
    expect(q.empty).toBe(true);
    expect(q.current()).toBeNull();
    expect(q.state({ open: true, instrumental: false }).entries).toEqual([]);
  });
});

describe('karaoke timing', () => {
  const lines = [
    { timeMs: 1000, text: 'first' },
    { timeMs: 4000, text: 'second' },
    { timeMs: 9000, text: 'third' },
  ];

  it('finds the line on screen, including before the first line', () => {
    expect(activeKaraokeLine(lines, 0)).toBe(-1);
    expect(activeKaraokeLine(lines, 999)).toBe(-1);
    expect(activeKaraokeLine(lines, 1000)).toBe(0);
    expect(activeKaraokeLine(lines, 3999)).toBe(0);
    expect(activeKaraokeLine(lines, 4000)).toBe(1);
    expect(activeKaraokeLine(lines, 60_000)).toBe(2);
    expect(activeKaraokeLine([], 0)).toBe(-1);
  });

  it('wipes a line across the gap to the next line', () => {
    expect(karaokeLineProgress(lines, 0, 1000)).toBe(0);
    expect(karaokeLineProgress(lines, 0, 2500)).toBeCloseTo(0.5, 3);
    expect(karaokeLineProgress(lines, 0, 4000)).toBe(1);
    // The last line has no successor, so it gets a fixed 4s window.
    expect(karaokeLineProgress(lines, 2, 11_000)).toBeCloseTo(0.5, 3);
    expect(karaokeLineProgress(lines, 9, 11_000)).toBe(0);
  });

  it('uses word timings when a line has them', () => {
    const line = {
      timeMs: 0,
      text: 'hold on',
      words: [
        { text: 'hold', timeMs: 0, endMs: 500 },
        { text: 'on', timeMs: 500, endMs: 900 },
      ],
    };
    expect(activeKaraokeWord(line, 100)).toBe(0);
    expect(activeKaraokeWord(line, 600)).toBe(1);
    expect(activeKaraokeWord(line, 1200)).toBe(1);
    expect(karaokeWordProgress(line, 0, 250)).toBeCloseTo(0.5, 3);
    // A word with no end borrows the next word's start.
    expect(karaokeWordProgress({ timeMs: 0, text: 'x', words: [{ text: 'x', timeMs: 0 }] }, 0, 150)).toBeCloseTo(
      0.5,
      3,
    );
    expect(activeKaraokeWord({ timeMs: 0, text: 'plain' }, 100)).toBe(-1);
    expect(karaokeWordProgress(undefined, 0, 100)).toBe(0);
  });

  it('falls back to evenly spaced plain lyrics', () => {
    const out = plainLyricLines('one\n\ntwo\nthree', 0, 1000);
    expect(out.map((l) => l.text)).toEqual(['one', 'two', 'three']);
    expect(out.map((l) => l.timeMs)).toEqual([0, 1000, 2000]);
  });
});
