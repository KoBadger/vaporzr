import { describe, expect, it } from 'vitest';
import {
  bar,
  cardKeyboard,
  clip,
  clock,
  esc,
  fingerprint,
  indexOfHash,
  parseCallback,
  renderCard,
  renderQueue,
  trackHash,
  type JamQueue,
  type QueueTrack,
} from '../card.js';

function track(partial: Partial<QueueTrack> & { uri: string }): QueueTrack {
  return {
    name: 'A Song',
    artists: 'An Artist',
    album: '',
    addedBy: '',
    durationMs: 210_000,
    votes: 0,
    ...partial,
  };
}

function queue(partial: Partial<JamQueue> = {}): JamQueue {
  return {
    playing: track({ uri: 'spotify:track:current', name: 'Current <Hit>', artists: 'Someone' }),
    playingNow: true,
    ended: false,
    positionMs: 30_000,
    durationMs: 210_000,
    updatedAt: 0,
    queueTotal: 2,
    tracks: [
      track({ uri: 'spotify:track:one', name: 'One' }),
      track({ uri: 'spotify:track:two', name: 'Two', addedBy: 'josh' }),
    ],
    ...partial,
  };
}

describe('formatting helpers', () => {
  it('escapes only the characters Telegram parses as markup', () => {
    expect(esc('AC/DC <live> & loud')).toBe('AC/DC &lt;live&gt; &amp; loud');
  });

  it('clips on a word boundary and marks the cut', () => {
    const out = clip('one two three four five', 14);
    expect(out.length).toBeLessThanOrEqual(14);
    expect(out.endsWith('…')).toBe(true);
    expect(out).not.toContain('  ');
  });

  it('leaves short strings alone', () => {
    expect(clip('short', 20)).toBe('short');
  });

  it('formats positions as m:ss and h:mm:ss', () => {
    expect(clock(0)).toBe('0:00');
    expect(clock(65_000)).toBe('1:05');
    expect(clock(3_725_000)).toBe('1:02:05');
    expect(clock(Number.NaN)).toBe('0:00');
  });

  it('draws a bar proportional to the position, and nothing without a duration', () => {
    expect(bar(0, 100)).toHaveLength(12);
    expect(bar(0, 100)).toMatch(/^▭+$/);
    expect(bar(50, 100)).toBe('▬▬▬▬▬▬▭▭▭▭▭▭');
    expect(bar(100, 100)).toMatch(/^▬+$/);
    expect(bar(0, 0)).toBe('');
    // Overrun must clamp rather than throw off the width.
    expect(bar(500, 100)).toHaveLength(12);
  });
});

describe('trackHash', () => {
  it('is stable and short enough for callback data', () => {
    const a = trackHash('spotify:track:4uLU6hMCjMI75M1A2tKUQC');
    expect(a).toBe(trackHash('spotify:track:4uLU6hMCjMI75M1A2tKUQC'));
    expect(a).toMatch(/^[0-9a-z]{6}$/);
  });

  it('separates different tracks', () => {
    expect(trackHash('spotify:track:a')).not.toBe(trackHash('spotify:track:b'));
  });
});

describe('renderCard', () => {
  it('shows the track, its artist and the progress line', () => {
    const text = renderCard(queue());
    expect(text).toContain('Current &lt;Hit&gt;');
    expect(text).toContain('Someone');
    expect(text).toContain('0:30 / 3:30');
    expect(text).toContain('Playing');
    expect(text).toContain('Up next');
    expect(text).toContain('1. One');
  });

  it('says so when nothing is playing', () => {
    expect(renderCard(queue({ playing: null, queueTotal: 0 }))).toContain('Nothing playing');
    expect(renderCard(queue({ playing: null, ended: true }))).toContain('Set finished');
  });

  it('marks a paused track as paused', () => {
    expect(renderCard(queue({ playingNow: false }))).toContain('Paused');
  });

  it('stays inside Telegram’s message limit even with a long queue', () => {
    const tracks = Array.from({ length: 30 }, (_, i) =>
      track({ uri: `spotify:track:${i}`, name: 'x'.repeat(80), artists: 'y'.repeat(80) }),
    );
    const text = renderCard(queue({ tracks }));
    expect(text.length).toBeLessThan(4096);
    // Long titles are clipped, not dropped, so the card still names a track.
    expect(text).toContain('…');
  });
});

describe('cardKeyboard', () => {
  it('offers the control row and one remove button per visible track', () => {
    const keyboard = cardKeyboard(queue());
    const row = keyboard.inline_keyboard[0]!;
    expect(row.map((b) => b.callback_data)).toEqual(['t', 'n', 'q', 'f']);
    expect(keyboard.inline_keyboard[1]).toHaveLength(2);
    expect(keyboard.inline_keyboard[1]![0]!.callback_data).toBe(`r:${trackHash('spotify:track:one')}`);
  });

  it('labels the pause button by the current state', () => {
    expect(cardKeyboard(queue()).inline_keyboard[0]![0]!.text).toContain('Pause');
    expect(cardKeyboard(queue({ playingNow: false })).inline_keyboard[0]![0]!.text).toContain('Resume');
  });

  it('keeps every callback under Telegram’s 64-byte limit', () => {
    const keyboard = cardKeyboard(queue({ tracks: [track({ uri: 'x'.repeat(500) })] }));
    for (const row of keyboard.inline_keyboard) {
      for (const button of row) {
        if (button.callback_data) {
          expect(Buffer.byteLength(button.callback_data, 'utf8')).toBeLessThanOrEqual(64);
        }
      }
    }
  });

  it('adds the panel button only when a URL is supplied', () => {
    expect(cardKeyboard(queue()).inline_keyboard.some((row) => row.some((b) => b.url))).toBe(false);
    const withPanel = cardKeyboard(queue(), 'https://www.vaporzr.app/panel');
    expect(withPanel.inline_keyboard.at(-1)![0]!.url).toBe('https://www.vaporzr.app/panel');
  });
});

describe('parseCallback', () => {
  it('reads the control buttons', () => {
    expect(parseCallback('t')).toEqual({ kind: 'toggle' });
    expect(parseCallback('n')).toEqual({ kind: 'next' });
    expect(parseCallback('q')).toEqual({ kind: 'queue' });
    expect(parseCallback('f')).toEqual({ kind: 'refresh' });
  });

  it('reads a remove button and rejects malformed data', () => {
    expect(parseCallback('r:abc123')).toEqual({ kind: 'remove', hash: 'abc123' });
    expect(parseCallback('r:')).toEqual({ kind: 'unknown' });
    expect(parseCallback('r:NOT A HASH')).toEqual({ kind: 'unknown' });
    expect(parseCallback(undefined)).toEqual({ kind: 'unknown' });
    // A destructive action must never fall back to a default.
    expect(parseCallback('zzz')).toEqual({ kind: 'unknown' });
  });
});

describe('fingerprint', () => {
  it('is unchanged by a position move inside the same bucket', () => {
    expect(fingerprint(queue({ positionMs: 30_000 }))).toBe(fingerprint(queue({ positionMs: 34_000 })));
  });

  it('changes when the track, state or queue changes', () => {
    const base = fingerprint(queue());
    expect(fingerprint(queue({ positionMs: 40_000 }))).not.toBe(base);
    expect(fingerprint(queue({ playingNow: false }))).not.toBe(base);
    expect(fingerprint(queue({ tracks: [], queueTotal: 0 }))).not.toBe(base);
    expect(fingerprint(queue({ playing: track({ uri: 'spotify:track:other' }) }))).not.toBe(base);
  });
});

describe('renderQueue', () => {
  it('lists the upcoming tracks with duration and requester', () => {
    const text = renderQueue(queue());
    expect(text).toContain('Now: <b>Current &lt;Hit&gt;</b>');
    expect(text).toContain('3:30');
    expect(text).toContain('josh');
  });

  it('says the queue is empty rather than posting an empty message', () => {
    expect(renderQueue(queue({ playing: null, tracks: [], queueTotal: 0 }))).toBe('The queue is empty.');
  });
});

describe('indexOfHash', () => {
  it('resolves the button back to a queue slot', () => {
    const q = queue();
    expect(indexOfHash(q, trackHash('spotify:track:two'))).toEqual({
      index: 1,
      uri: 'spotify:track:two',
    });
  });

  it('returns null once the track has left the queue', () => {
    expect(indexOfHash(queue({ tracks: [] }), trackHash('spotify:track:two'))).toBeNull();
  });
});
