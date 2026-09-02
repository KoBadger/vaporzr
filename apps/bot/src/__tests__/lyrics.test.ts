import { describe, it, expect } from 'vitest';
import { parseSyncedLines } from '../lyrics.js';

describe('parseSyncedLines (LRC parser)', () => {
  it('parses timestamped lines with milliseconds', () => {
    const lines = parseSyncedLines('[00:28.46] First line\n[01:04.90] Second line\n[02:00.00] Third');
    expect(lines).toEqual([
      { timeMs: 28_460, text: 'First line' },
      { timeMs: 64_900, text: 'Second line' },
      { timeMs: 120_000, text: 'Third' },
    ]);
  });

  it('handles whole-second timestamps and skips empty lines', () => {
    const lines = parseSyncedLines('[00:12] Line A\n[00:15.5]  \n[00:20] Line B\n[00:25] ');
    expect(lines).toEqual([
      { timeMs: 12_000, text: 'Line A' },
      { timeMs: 20_000, text: 'Line B' },
    ]);
  });

  it('ignores metadata lines without timestamps', () => {
    const lines = parseSyncedLines('[ar: Artist]\n[ti: Title]\n[00:05.00] Real lyric');
    expect(lines).toEqual([{ timeMs: 5_000, text: 'Real lyric' }]);
  });

  it('returns [] for plain text', () => {
    expect(parseSyncedLines('just some\nplain lyrics')).toEqual([]);
  });
});