import { describe, expect, it, vi } from 'vitest';
import type { DeckId, DeckMixerState } from '@vaporzr/shared';
import { KaraokeNight } from '../karaoke.js';
import type { DeckController } from '../decks.js';

/**
 * Karaoke night, room side. The queue rules live in `@vaporzr/core/karaoke` and
 * are tested there; what matters here is the part that touches a deck:
 *
 *  - a turn is a deck load with the vocal lane at zero,
 *  - the end of a song removes that singer rather than leaving them up front,
 *  - a skip puts the singer back in line (a broken load is not their fault),
 *  - queueing a song always gets the stage moving when it is empty.
 */

interface FakeDeck {
  load: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  play: ReturnType<typeof vi.fn>;
  stemGain: ReturnType<typeof vi.fn>;
  transpose: ReturnType<typeof vi.fn>;
  state: () => DeckMixerState;
}

/** A deck that reports whatever the test sets as its current slot. */
function fakeDecks(): { decks: DeckController; deck: FakeDeck; slot: Record<string, unknown> } {
  const slot: Record<string, unknown> = { source: null, durationMs: 0, positionMs: 0, ended: false };
  const deck: FakeDeck = {
    load: vi.fn(async () => ({ ok: true, message: 'loaded' })),
    stop: vi.fn(),
    play: vi.fn(),
    stemGain: vi.fn(),
    transpose: vi.fn(),
    state: () => ({ a: slot, b: slot, c: slot, d: slot }) as unknown as DeckMixerState,
  };
  return { decks: deck as unknown as DeckController, deck, slot };
}

function staged(stems: { lanes: string[]; gains: number[] } | null, title = 'Song') {
  return {
    source: { title, artist: 'Artist', durationMs: 180_000 },
    durationMs: 180_000,
    positionMs: 0,
    ended: false,
    playing: true,
    stems,
  };
}

describe('karaoke night', () => {
  it('refuses a song while the night is closed', () => {
    const { decks } = fakeDecks();
    const night = new KaraokeNight({ decks, onState: () => {} });
    expect(night.add('Ana', 'web:ana', 'Wonderwall')).toContain('not running');
    expect(night.state().entries).toHaveLength(0);
  });

  it('starts a song as soon as it is queued onto an empty deck', async () => {
    const { decks, deck, slot } = fakeDecks();
    deck.load.mockImplementation(async () => {
      Object.assign(slot, staged({ lanes: ['vocals', 'drums', 'bass', 'other'], gains: [1, 1, 1, 1] }));
      return { ok: true, message: 'loaded' };
    });
    const night = new KaraokeNight({ decks, onState: () => {} });
    night.openNight();
    night.add('Ana', 'web:ana', 'Wonderwall');
    await vi.waitFor(() => expect(deck.play).toHaveBeenCalledWith('a'));
    expect(deck.stemGain).toHaveBeenCalledWith('a', 'vocals', 0);
    expect(night.state().instrumental).toBe(true);
  });

  it('leaves a deck that is already playing alone', async () => {
    const { decks, deck, slot } = fakeDecks();
    Object.assign(slot, staged(null, 'DJ set'));
    const night = new KaraokeNight({ decks, onState: () => {} });
    night.openNight();
    night.add('Ana', 'web:ana', 'Wonderwall');
    await Promise.resolve();
    expect(deck.load).not.toHaveBeenCalled();
    expect(night.state().entries).toHaveLength(1);
  });

  it('notes when a track has no vocals to drop', async () => {
    const { decks, deck, slot } = fakeDecks();
    deck.load.mockImplementation(async () => {
      Object.assign(slot, staged(null, 'Live take'));
      return { ok: true, message: 'loaded' };
    });
    const night = new KaraokeNight({ decks, onState: () => {} });
    night.openNight();
    night.add('Ana', 'web:ana', 'Live take');
    await vi.waitFor(() => expect(deck.play).toHaveBeenCalled());
    expect(night.state().instrumental).toBe(false);
    expect(night.state().current?.detail).toContain('vocals still audible');
  });

  it('a finished song leaves the queue and the next turn loads', async () => {
    const { decks, deck, slot } = fakeDecks();
    deck.load.mockImplementation(async () => {
      Object.assign(slot, staged({ lanes: ['vocals', 'drums'], gains: [1, 1] }));
      return { ok: true, message: 'loaded' };
    });
    const night = new KaraokeNight({ decks, onState: () => {}, watchMs: 10 });
    night.openNight();
    night.add('Ana', 'web:ana', 'One');
    await vi.waitFor(() => expect(deck.play).toHaveBeenCalledTimes(1));
    night.add('Ben', 'web:ben', 'Two');

    slot.ended = true;
    await vi.waitFor(() => expect(deck.play).toHaveBeenCalledTimes(2), { timeout: 2000 });
    const entries = night.state().entries;
    expect(entries.map((e) => e.singer)).toEqual(['Ben']);
    night.dispose();
  });

  it('a skip keeps the singer in line', async () => {
    const { decks, deck, slot } = fakeDecks();
    deck.load.mockImplementation(async () => {
      Object.assign(slot, staged({ lanes: ['vocals'], gains: [1] }));
      return { ok: true, message: 'loaded' };
    });
    const night = new KaraokeNight({ decks, onState: () => {} });
    night.openNight();
    night.add('Ana', 'web:ana', 'One');
    await vi.waitFor(() => expect(deck.play).toHaveBeenCalled());
    night.skip();
    await vi.waitFor(() => expect(deck.play).toHaveBeenCalledTimes(2));
    expect(night.state().entries.map((e) => e.singer)).toEqual(['Ana']);
  });

  it('closing the night empties the queue and stops watching', () => {
    const { decks } = fakeDecks();
    const night = new KaraokeNight({ decks, onState: () => {} });
    night.openNight();
    night.add('Ana', 'web:ana', 'One');
    expect(night.closeNight().open).toBe(false);
    expect(night.state().entries).toHaveLength(0);
  });

  it('one song per singer, and the host can override', () => {
    const { decks } = fakeDecks();
    const night = new KaraokeNight({ decks, onState: () => {} });
    night.openNight();
    expect(night.add('Ana', 'web:ana', 'One')).toContain('is in the queue');
    expect(night.add('Ana', 'web:ana', 'Two')).toContain('one song at a time');
  });

  it('moving the stage deck is reported in state', () => {
    const { decks } = fakeDecks();
    const night = new KaraokeNight({ decks, onState: () => {}, deck: 'a' as DeckId });
    night.setDeck('b');
    expect(night.state().deck).toBe('b');
  });

  it('prepares stems for a queued song while the previous turn plays', async () => {
    const { decks, deck, slot } = fakeDecks();
    deck.load.mockImplementation(async () => {
      Object.assign(slot, staged(null, 'Live take'));
      return { ok: true, message: 'loaded' };
    });
    const prepare = vi.fn(async () => 'ready' as const);
    const night = new KaraokeNight({ decks, onState: () => {}, prepare });
    night.openNight();
    night.add('Ana', 'web:ana', 'One');
    await vi.waitFor(() => expect(deck.play).toHaveBeenCalled());
    expect(prepare).toHaveBeenCalledWith('One');
  });

  it('prefetches a song queued while somebody is already singing', async () => {
    const { decks, deck, slot } = fakeDecks();
    deck.load.mockImplementation(async () => {
      Object.assign(slot, staged({ lanes: ['vocals'], gains: [1] }));
      return { ok: true, message: 'loaded' };
    });
    const prefetch = vi.fn(async () => null);
    const night = new KaraokeNight({ decks, onState: () => {}, prefetch });
    night.openNight();
    night.add('Ana', 'web:ana', 'One');
    await vi.waitFor(() => expect(deck.play).toHaveBeenCalled());
    night.add('Ben', 'web:ben', 'Two');
    await vi.waitFor(() => expect(prefetch).toHaveBeenCalledWith('Two'));
  });

  it('will not move the night onto a deck the plan does not cover', () => {
    const { decks } = fakeDecks();
    const night = new KaraokeNight({
      decks,
      onState: () => {},
      deck: 'a' as DeckId,
      deckAllowed: (d) => d === 'a' || d === 'b',
    });
    expect(night.setDeck('c')).toContain('paid plan');
    expect(night.state().deck).toBe('a');
    expect(night.setDeck('b')).toContain('deck B');
    expect(night.state().deck).toBe('b');
  });

  it('drops a song that fails to load twice', async () => {
    const { decks, deck } = fakeDecks();
    deck.load.mockImplementation(async () => ({ ok: false, message: 'no stream' }));
    const announce = vi.fn();
    const night = new KaraokeNight({ decks, onState: () => {}, announce });
    night.openNight();
    night.add('Ana', 'web:ana', 'Dead link');
    await vi.waitFor(() => expect(night.state().entries).toHaveLength(0), { timeout: 3000 });
    expect(announce.mock.calls.join('\n')).toContain('dropped');
  });

  it('applies the night key to each turn', async () => {
    const { decks, deck, slot } = fakeDecks();
    deck.load.mockImplementation(async () => {
      Object.assign(slot, staged({ lanes: ['vocals'], gains: [1] }));
      return { ok: true, message: 'loaded' };
    });
    const night = new KaraokeNight({ decks, onState: () => {} });
    night.openNight();
    expect(night.setTranspose(-2)).toContain('-2');
    night.add('Ana', 'web:ana', 'One');
    await vi.waitFor(() => expect(deck.transpose).toHaveBeenCalledWith('a', -2));
    expect(night.state().transpose).toBe(-2);
  });

  it('resumes a saved night from the front of the queue', async () => {
    const { decks, deck, slot } = fakeDecks();
    deck.load.mockImplementation(async () => {
      Object.assign(slot, staged({ lanes: ['vocals'], gains: [1] }));
      return { ok: true, message: 'loaded' };
    });
    const saved = {
      open: true,
      transpose: 0,
      instrumental: false,
      current: null,
      deck: 'a' as DeckId,
      entries: [
        {
          id: 'k1',
          singer: 'Ana',
          singerId: 'web:ana',
          title: 'One',
          status: 'queued' as const,
          deck: null,
          addedAt: 1,
        },
      ],
    };
    const night = new KaraokeNight({ decks, onState: () => {} });
    night.restore(saved);
    expect(night.isOpen()).toBe(true);
    await night.advance();
    expect(deck.load).toHaveBeenCalledWith('a', 'One');
  });
});
