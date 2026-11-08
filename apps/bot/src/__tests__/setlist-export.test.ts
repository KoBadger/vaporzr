import { describe, expect, it } from 'vitest';
import { safeFilename, toCsv, toM3U, toMarkdown, toYouTubeSearchLinks, type ExportTrack } from '../setlistExport.js';

/** A complete track; individual tests override only the field they are probing. */
function track(overrides: Partial<ExportTrack> = {}): ExportTrack {
  return {
    name: 'Echoes',
    artists: ['Pink Floyd'],
    album: 'Meddle',
    durationMs: 1_235_000,
    uri: 'spotify:track:4k1Xf2m',
    source: 'spotify',
    addedBy: 'josh',
    playedAt: new Date(2026, 4, 1, 21, 15).getTime(),
    ...overrides,
  };
}

describe('toM3U', () => {
  it('writes the header, playlist title and one EXTINF plus URL per track', () => {
    const out = toM3U([track(), track({ name: 'Time', durationMs: 412_500, uri: 'https://example.com/time.mp3' })], {
      title: 'Friday Night',
    });
    expect(out).toBe(
      [
        '#EXTM3U',
        '#PLAYLIST:Friday Night',
        '#EXTINF:1235,Pink Floyd - Echoes',
        'spotify:track:4k1Xf2m',
        '#EXTINF:413,Pink Floyd - Time',
        'https://example.com/time.mp3',
        '',
      ].join('\n'),
    );
  });

  it('rounds durations to the nearest second', () => {
    const out = toM3U([track({ durationMs: 2_214_499 }), track({ durationMs: 2_215_500 })]);
    expect(out).toContain('#EXTINF:2214,');
    expect(out).toContain('#EXTINF:2216,');
  });

  it('treats a missing duration as zero', () => {
    expect(toM3U([track({ durationMs: undefined })])).toContain('#EXTINF:0,');
  });

  it('falls back to a YouTube Music search when the uri is not playable', () => {
    const out = toM3U([
      track({ name: 'Back In Black', artists: ['AC/DC'], uri: undefined }),
      track({ name: 'Cache Hit', artists: ['Local'], uri: 'cache:track:1' }),
    ]);
    expect(out).toContain('https://music.youtube.com/search?q=AC%2FDC%20-%20Back%20In%20Black');
    expect(out).toContain('https://music.youtube.com/search?q=Local%20-%20Cache%20Hit');
    expect(out).not.toContain('cache:track:1');
  });

  it('emits a valid empty playlist and omits PLAYLIST without a title', () => {
    expect(toM3U([])).toBe('#EXTM3U\n');
    expect(toM3U([track()])).not.toContain('#PLAYLIST');
  });

  it('flattens newlines so a track name cannot forge playlist records', () => {
    const out = toM3U([track({ name: 'A\n#EXTINF:1,Evil', artists: ['X'] })]);
    const extinfLines = out.split('\n').filter((line) => line.startsWith('#EXTINF:'));
    expect(extinfLines).toHaveLength(1);
    expect(out).toContain('X - A #EXTINF:1,Evil');
  });
});

describe('toCsv', () => {
  it('writes the documented header even for an empty setlist', () => {
    expect(toCsv([])).toBe('title,artists,album,duration_ms,source,added_by,played_at,uri\n');
  });

  it('quotes and doubles exactly the fields that need it', () => {
    const playedAt = new Date(2026, 4, 1, 21, 15).getTime();
    const out = toCsv([
      track({
        name: 'He said "hi", then left\nand came back',
        artists: ['AC/DC', 'Muse'],
        album: 'Live',
        durationMs: 61_000,
        source: 'youtube',
        addedBy: 'jo,sh',
        playedAt,
      }),
    ]);
    expect(out).toBe(
      [
        'title,artists,album,duration_ms,source,added_by,played_at,uri',
        '"He said ""hi"", then left',
        `and came back",AC/DC; Muse,Live,61000,youtube,"jo,sh",${playedAt},spotify:track:4k1Xf2m`,
        '',
      ].join('\n'),
    );
  });

  it('quotes fields containing a carriage return', () => {
    expect(toCsv([track({ name: 'a\rb' })])).toContain('"a\rb"');
  });

  it('leaves unknown optional metadata empty instead of writing "undefined"', () => {
    const out = toCsv([{ name: 'Mystery', artists: [] }]);
    expect(out.split('\n')[1]).toBe('Mystery,,,,,,,');
    expect(out).not.toContain('undefined');
  });
});

describe('toMarkdown', () => {
  it('renders the heading, summary and a numbered list with clock times', () => {
    const startedAt = new Date(2026, 4, 1, 20, 0).getTime();
    const endedAt = startedAt + 83 * 60_000;
    const out = toMarkdown(
      [
        track({ playedAt: new Date(2026, 4, 1, 21, 15).getTime() }),
        track({ name: 'Time', playedAt: new Date(2026, 4, 1, 21, 20).getTime() }),
      ],
      { title: 'Friday Night', guildName: 'Vaporzr', startedAt, endedAt },
    );
    expect(out).toBe(
      [
        '# Friday Night',
        '',
        '**2 tracks** · 1h 23m · Vaporzr',
        '',
        '1. **Pink Floyd - Echoes** — Meddle · spotify · 21:15',
        '2. **Pink Floyd - Time** — Meddle · spotify · 21:20',
      ].join('\n') + '\n',
    );
  });

  it('uses the singular and omits the duration unless both timestamps exist', () => {
    expect(toMarkdown([track()], { title: 'Solo' }).split('\n')[2]).toBe('**1 track**');
    expect(toMarkdown([track()], { title: 'Solo', startedAt: 1_000 }).split('\n')[2]).toBe('**1 track**');
    expect(toMarkdown([track()], { title: 'Solo', startedAt: 2_000, endedAt: 1_000 }).split('\n')[2]).toBe(
      '**1 track**',
    );
  });

  it('drops metadata the track does not have', () => {
    const item = toMarkdown([{ name: 'Mystery', artists: ['Nobody'] }], { title: 'Unknown' })
      .split('\n')
      .find((line) => line.startsWith('1.'));
    expect(item).toBe('1. **Nobody - Mystery**');
  });

  it('falls back to a generic heading for a blank title', () => {
    expect(toMarkdown([], { title: '   ' }).split('\n')[0]).toBe('# Setlist');
  });
});

describe('toYouTubeSearchLinks', () => {
  it('emits one encoded search URL per track, in order', () => {
    expect(
      toYouTubeSearchLinks([
        track({ name: 'Back In Black', artists: ['AC/DC'] }),
        track({ name: 'Hysteria', artists: ['Muse'] }),
      ]),
    ).toBe(
      [
        'https://music.youtube.com/search?q=AC%2FDC%20-%20Back%20In%20Black',
        'https://music.youtube.com/search?q=Muse%20-%20Hysteria',
        '',
      ].join('\n'),
    );
  });

  it('joins multiple artists into one search query', () => {
    expect(toYouTubeSearchLinks([track({ name: 'X', artists: ['A', 'B'] })])).toBe(
      'https://music.youtube.com/search?q=A%2C%20B%20-%20X\n',
    );
  });

  it('returns an empty string for an empty setlist', () => {
    expect(toYouTubeSearchLinks([])).toBe('');
  });
});

describe('safeFilename', () => {
  it('replaces Windows-illegal characters and collapses whitespace to dashes', () => {
    expect(safeFilename('  AC/DC: "Back In Black"? ', 'm3u8')).toBe('ac-dc-back-in-black.m3u8');
  });

  it('does not append the extension twice', () => {
    expect(safeFilename('Friday Night.M3U8', 'm3u8')).toBe('friday-night.m3u8');
  });

  it('never returns an empty filename', () => {
    expect(safeFilename('///***', 'csv')).toBe('setlist.csv');
    expect(safeFilename('   ', 'm3u8')).toBe('setlist.m3u8');
  });

  it('caps the stem at 60 characters without leaving a trailing separator', () => {
    expect(safeFilename('x'.repeat(80), 'm3u8')).toBe(`${'x'.repeat(60)}.m3u8`);
    const long = safeFilename('word '.repeat(30), 'm3u8');
    const stem = long.slice(0, -'.m3u8'.length);
    expect(stem.length).toBeLessThanOrEqual(60);
    expect(stem.length).toBeGreaterThan(0);
    expect(long.endsWith('-.m3u8')).toBe(false);
  });

  it('normalises the extension and tolerates an empty one', () => {
    expect(safeFilename('Track', '.csv')).toBe('track.csv');
    expect(safeFilename('Track', 'CSV')).toBe('track.csv');
    expect(safeFilename('Track', '')).toBe('track');
  });

  it('strips control characters that would break a Content-Disposition header', () => {
    expect(safeFilename('a\u0000b\u001fc', 'm3u8')).toBe('a-b-c.m3u8');
  });

  it('lowercases while keeping unicode letters that Windows accepts', () => {
    expect(safeFilename('Café Del Mar', 'm3u8')).toBe('café-del-mar.m3u8');
  });
});
