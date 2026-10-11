import { describe, expect, it } from 'vitest';
import { BULK_MAX, countBulkItems, parseBulkItems } from '../discord.js';

describe('parseBulkItems', () => {
  it('splits on newlines (the V@bulk regression)', () => {
    expect(parseBulkItems('never mess with sunday\nflip ya lid\n3030')).toEqual([
      'never mess with sunday',
      'flip ya lid',
      '3030',
    ]);
  });

  it('also splits on ; and |', () => {
    expect(parseBulkItems('a; b | c')).toEqual(['a', 'b', 'c']);
  });

  it('trims, drops blanks and keeps links intact', () => {
    expect(parseBulkItems('  https://open.spotify.com/track/abc  \n\n ; ')).toEqual([
      'https://open.spotify.com/track/abc',
    ]);
  });

  it('caps at BULK_MAX and leaves room for attached files', () => {
    const raw = Array.from({ length: BULK_MAX + 10 }, (_, i) => `s${i}`).join('\n');
    expect(parseBulkItems(raw)).toHaveLength(BULK_MAX);
    expect(parseBulkItems(raw, 3)).toHaveLength(BULK_MAX - 3);
    expect(parseBulkItems(raw, 99)).toEqual([]);
  });
});

describe('countBulkItems', () => {
  it('counts the whole list before the cap, so the reply can say what was ignored', () => {
    const raw = Array.from({ length: BULK_MAX + 7 }, (_, i) => `s${i}`).join('\n');
    expect(countBulkItems(raw)).toBe(BULK_MAX + 7);
    expect(parseBulkItems(raw)).toHaveLength(BULK_MAX);
  });

  it('ignores blanks the same way parseBulkItems does', () => {
    expect(countBulkItems('a\n\n ; \nb')).toBe(2);
  });
});
