import { describe, expect, it } from 'vitest';
import { parseHelpLine, searchHelp } from '../help.js';

// `V@help <anything>` is the only way anyone finds a command they have not
// memorised, so the ranking is worth pinning: a command-name hit must beat a
// mention in prose, and the answer must stay short enough to read.

const CATS = [
  {
    id: 'playback',
    emoji: '🎵',
    name: 'Playback',
    blurb: 'start, pause, skip and control the music',
    lines: [
      '**▶ Start**',
      '`/play` `V@p` — song, link or attached file',
      '`/skip` `V@s` — skip (non-DJs start a vote)',
      '`/nowplaying` `V@np` — what is playing',
    ],
  },
  {
    id: 'tape',
    emoji: '📼',
    name: 'Tape & setlists',
    blurb: 'record what the room actually heard',
    lines: [
      '`/tape start [name]` `V@tape start` — start recording the room',
      '`/tape stop` `V@tape stop` — seal the tape',
      '`/tape export [format]` — M3U8, CSV or Markdown files',
    ],
  },
  {
    id: 'system',
    emoji: '🛠️',
    name: 'System',
    blurb: 'stats, diagnostics and admin tools',
    lines: ['`/stats` — bot statistics', '`/help` `V@help` — this menu'],
  },
];

describe('parseHelpLine', () => {
  it('separates commands from the description', () => {
    expect(parseHelpLine('`/skip` `V@s` — skip (non-DJs start a vote)')).toEqual({
      commands: ['/skip', 'V@s'],
      detail: 'skip (non-DJs start a vote)',
    });
  });

  it('ignores headings', () => {
    expect(parseHelpLine('**▶ Start**')).toBeNull();
  });
});

describe('searchHelp', () => {
  it('returns nothing for an empty query', () => {
    expect(searchHelp(CATS, '   ')).toEqual([]);
  });

  it('finds a command by name', () => {
    const results = searchHelp(CATS, 'skip');
    expect(results[0]?.commands).toContain('/skip');
  });

  it('prefers a command-name hit over a prose mention', () => {
    // "tape" appears in the Tape category's prose; "/tape start" is a command.
    const results = searchHelp(CATS, 'tape');
    expect(results[0]?.commands).toContain('/tape');
  });

  it('treats a leading slash as a command search', () => {
    const results = searchHelp(CATS, '/play');
    expect(results[0]?.commands).toContain('/play');
  });

  it('finds things from a natural-language question', () => {
    const results = searchHelp(CATS, 'how do I record the room');
    expect(results.some((r) => r.commands.includes('/tape'))).toBe(true);
  });

  it('always offers at least three suggestions', () => {
    const results = searchHelp(CATS, 'zzzzz');
    expect(results.length).toBeGreaterThanOrEqual(3);
  });

  it('never returns more than ten', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      id: `c${i}`,
      emoji: '•',
      name: `Category ${i}`,
      blurb: 'music things',
      lines: [`\`/cmd${i}\` — music command ${i}`],
    }));
    expect(searchHelp(many, 'music').length).toBeLessThanOrEqual(10);
  });

  it('does not repeat the same line twice', () => {
    const results = searchHelp(CATS, 'tape');
    const keys = results.map((r) => `${r.commands}::${r.detail}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('pads with categories rather than returning one lonely hit', () => {
    const results = searchHelp(CATS, 'skip');
    expect(results.length).toBeGreaterThan(1);
    // The padding entries carry no commands and describe a whole section.
    expect(results.some((r) => r.commands === '')).toBe(true);
  });
});
