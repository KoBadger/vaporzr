import type { DeckId, KaraokeEntry, KaraokeState } from '@vaporzr/shared';
import { KaraokeQueue } from '@vaporzr/core/karaoke';
import type { DeckController } from './decks.js';

/**
 * Karaoke night, bot side.
 *
 * The queue itself is `@vaporzr/core/karaoke` (pure list + rotation rules).
 * This class is the part that touches the room: it loads the singer's track
 * onto a deck, drops the vocal lane when the track has separated stems, and
 * advances when the deck runs out.
 *
 * Why a deck rather than the normal queue? Because karaoke needs the stem
 * lanes, and those only exist on the deck mixer. A turn is just a deck load
 * with the vocal lane at zero — the same switch the deck page's KARAOKE button
 * uses, so what the room hears and what the screen shows can never disagree.
 */

export interface KaraokeNightOptions {
  decks: DeckController;
  /** Deck turns are loaded on. A is the default; the host can move it. */
  deck?: DeckId;
  /** State push for the stage screen and the panel. */
  onState: (state: KaraokeState) => void;
  /** One-line room announcements (Discord channel or panel toast). */
  announce?: (text: string) => void;
  /** How often the end-of-turn watcher runs. */
  watchMs?: number;
}

/** A turn is over this long before the file ends, so the next load is ready. */
const TURN_TAIL_MS = 2500;

export class KaraokeNight {
  private readonly opts: KaraokeNightOptions;
  private readonly queue = new KaraokeQueue();
  private open = false;
  private deck: DeckId;
  private instrumental = false;
  private watch: ReturnType<typeof setInterval> | null = null;
  /** Guards against two loads in flight when a skip lands mid-prepare. */
  private loading = false;

  constructor(opts: KaraokeNightOptions) {
    this.opts = opts;
    this.deck = opts.deck ?? 'a';
  }

  isOpen(): boolean {
    return this.open;
  }

  state(): KaraokeState {
    return this.queue.state({ open: this.open, instrumental: this.instrumental, deck: this.deck });
  }

  openNight(): KaraokeState {
    if (!this.open) {
      this.open = true;
      this.startWatch();
      this.opts.announce?.('🎤 Karaoke is open — add a song and take a turn.');
    }
    this.push();
    return this.state();
  }

  closeNight(): KaraokeState {
    this.open = false;
    this.stopWatch();
    this.queue.clear();
    this.opts.announce?.('🎤 Karaoke is closed. Thanks for singing.');
    this.push();
    return this.state();
  }

  /** Queue a song for someone. Returns the room-facing message. */
  add(singer: string, singerId: string, query: string): string {
    if (!this.open) return 'Karaoke is not running — the host can open it with `V@karaoke open`.';
    const result = this.queue.add({ singer, singerId, title: query });
    if (!result.ok) return result.message;
    this.push();
    // An empty stage should not sit empty while people wait: if nothing is
    // loaded on the stage deck, this new song is up now. A deck that is already
    // playing is left alone, so queueing never hijacks a running set.
    const slot = this.opts.decks.state()[this.deck];
    if (!slot.source || slot.ended) void this.advance();
    return result.message;
  }

  /** Drop an entry (host action, or a singer withdrawing). */
  remove(id: string): string {
    const cur = this.queue.current();
    const gone = this.queue.remove(id);
    if (!gone) return 'That turn is already gone.';
    if (cur && cur.id === gone.id) {
      this.opts.decks.stop();
      void this.advance();
    }
    this.push();
    return `Removed **${gone.singer}** — **${gone.title}**.`;
  }

  /**
   * End the current turn early. The singer keeps their place in their own line
   * rather than being dropped, so a botched load does not cost them the night.
   */
  skip(): string {
    const cur = this.queue.current();
    if (!cur) return 'Nobody is on stage right now.';
    this.queue.requeue(cur.id);
    void this.advance(`Skipped **${cur.singer}**.`);
    return `Skipped **${cur.singer}** — **${cur.title}**.`;
  }

  clear(): string {
    this.queue.clear();
    this.opts.decks.stop();
    this.push();
    return 'Sing queue cleared.';
  }

  /** Move the stage deck (the host's "play this on deck B" switch). */
  setDeck(deck: DeckId): void {
    this.deck = deck;
    this.push();
  }

  /** Load the next turn, if the stage is free. */
  async advance(reason?: string): Promise<string> {
    if (!this.open || this.loading) return '';
    if (!this.queue.current()) {
      this.push();
    }
    const turn = this.queue.next();
    if (!turn) {
      this.push();
      return reason ?? 'Nobody left in the sing queue.';
    }
    this.loading = true;
    this.queue.update(turn.id, { status: 'preparing', deck: this.deck, detail: 'loading' });
    this.push();
    try {
      const result = await this.opts.decks.load(
        this.deck,
        turn.uri || `${turn.title}${turn.artist ? ` ${turn.artist}` : ''}`,
      );
      if (!result.ok) {
        this.queue.update(turn.id, { status: 'failed', detail: result.message });
        this.opts.announce?.(`Couldn't load **${turn.title}** for ${turn.singer} — moving on.`);
        this.queue.requeue(turn.id);
        this.push();
        return result.message;
      }
      const slot = this.opts.decks.state()[this.deck];
      const stems = slot.stems;
      const vocals = stems ? stems.lanes.indexOf('vocals') : -1;
      this.instrumental = vocals >= 0;
      if (vocals >= 0) this.opts.decks.stemGain(this.deck, 'vocals', 0);
      const title = slot.source?.title ?? turn.title;
      const artist = slot.source?.artist ?? turn.artist;
      this.queue.update(turn.id, {
        status: 'ready',
        title,
        artist,
        deck: this.deck,
        durationMs: slot.durationMs || turn.durationMs,
        detail: this.instrumental ? undefined : 'no separated stems — vocals still audible',
      });
      this.opts.decks.play(this.deck);
      this.opts.announce?.(
        `🎤 **${turn.singer}** — **${title}**${artist ? ` (${artist})` : ''}` +
          (this.instrumental ? '' : '\n> ⚠️ No instrumental for this one — it plays with the vocals.'),
      );
      this.push();
      return result.message;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.queue.update(turn.id, { status: 'failed', detail: message });
      this.opts.announce?.(`Karaoke load failed: ${message}`);
      this.push();
      return message;
    } finally {
      this.loading = false;
    }
  }

  /** Stop the watcher (bot shutdown / guild teardown). */
  dispose(): void {
    this.stopWatch();
    this.open = false;
  }

  private startWatch(): void {
    if (this.watch) return;
    this.watch = setInterval(() => this.checkTurn(), this.opts.watchMs ?? 1000);
    this.watch.unref?.();
  }

  private stopWatch(): void {
    if (this.watch) clearInterval(this.watch);
    this.watch = null;
  }

  /**
   * End-of-turn detection. The mixer's `ended` flag is authoritative when the
   * file runs out; the position check covers a deck that was left paused on the
   * last few seconds (a skip, a drop-out, a browser that stopped pulling PCM).
   */
  private checkTurn(): void {
    if (!this.open || this.loading) return;
    const cur = this.queue.current();
    if (!cur || cur.status !== 'ready') return;
    const slot = this.opts.decks.state()[this.deck];
    if (!slot.source) return;
    const nearEnd = slot.durationMs > 0 && slot.positionMs >= slot.durationMs - TURN_TAIL_MS;
    if (slot.ended || nearEnd) {
      // A finished turn leaves the queue. Without this the singer who just sang
      // would still be first in line the next time anyone looked. (An explicit
      // skip requeues instead, because a broken load should not cost a turn.)
      this.queue.remove(cur.id);
      void this.advance();
    }
  }

  private push(): void {
    this.opts.onState(this.state());
  }
}

/** Announce helper: the queue as a chat list. */
export function karaokeQueueText(state: KaraokeState, max = 10): string {
  if (state.entries.length === 0) return 'The sing queue is empty.';
  const lines = state.entries.slice(0, max).map((e: KaraokeEntry, i: number) => {
    const badge = e.id === state.current?.id ? '🎤' : `${i + 1}.`;
    const artist = e.artist ? ` — ${e.artist}` : '';
    const note = e.status === 'failed' ? ' (failed — will be skipped)' : '';
    return `${badge} **${e.singer}**: ${e.title}${artist}${note}`;
  });
  const rest = state.entries.length - max;
  if (rest > 0) lines.push(`…and ${rest} more.`);
  return lines.join('\n');
}
