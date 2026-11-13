import type { DeckId, KaraokeEntry, KaraokeState } from '@vaporzr/shared';
import { KaraokeQueue } from '@vaporzr/core/karaoke';
import { replicateStemsEnabled } from '@vaporzr/core/stemSeparation';
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
  /**
   * Separate a queued song's stems ahead of its turn. Omitted when no stem
   * backend is configured (see `stemBackendAvailable`), in which case a turn
   * simply plays with the vocals still in.
   */
  prepare?: (query: string) => Promise<'ready' | 'none'>;
  /** Resolve + download a query now, so its turn starts instantly. */
  prefetch?: (query: string) => Promise<unknown>;
  /** Deck entitlement check — karaoke must not be a way around the paywall. */
  deckAllowed?: (deck: DeckId) => boolean;
  /** Persist the night, so a deploy does not wipe the lineup. */
  onSave?: (state: KaraokeState) => void;
}

/** A turn is over this long before the file ends, so the next load is ready. */
const TURN_TAIL_MS = 2500;

/**
 * Is there a stem backend that can separate a song *before* its turn?
 *
 * Hosted Demucs is ~80 s per song, which a queue easily absorbs. The local CPU
 * run is ~29 min per song, so it is only used when explicitly asked for: a
 * preparation step that cannot finish in time is worse than none.
 */
export function stemBackendAvailable(): boolean {
  return replicateStemsEnabled() || process.env.STEMS_LOCAL_DEMUCS === '1';
}

/** Two strikes: a dead link should not haunt the queue all night. */
const MAX_ATTEMPTS = 2;

export class KaraokeNight {
  private readonly opts: KaraokeNightOptions;
  private readonly queue = new KaraokeQueue();
  private open = false;
  private deck: DeckId;
  private instrumental = false;
  private transpose = 0;
  private watch: ReturnType<typeof setInterval> | null = null;
  /** Guards against two loads in flight when a skip lands mid-prepare. */
  private loading = false;
  /** Turn ids already sent for separation, so a re-render never re-queues one. */
  private readonly preparing = new Set<string>();

  constructor(opts: KaraokeNightOptions) {
    this.opts = opts;
    this.deck = opts.deck ?? 'a';
  }

  isOpen(): boolean {
    return this.open;
  }

  state(): KaraokeState {
    return this.queue.state({
      open: this.open,
      instrumental: this.instrumental,
      deck: this.deck,
      transpose: this.transpose,
    });
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
    this.preparing.clear();
    this.opts.announce?.('🎤 Karaoke is closed. Thanks for singing.');
    this.push();
    return this.state();
  }

  /**
   * Bring a night back after a restart. The deck is empty and nothing is
   * "on stage", so the queue resumes from the front.
   */
  restore(saved: KaraokeState): KaraokeState {
    if (saved.entries.length === 0 && !saved.open) return this.state();
    this.queue.restore(saved);
    this.open = saved.open;
    this.transpose = Math.max(-6, Math.min(6, Math.round(saved.transpose ?? 0)));
    if (saved.deck && this.opts.deckAllowed?.(saved.deck) !== false) this.deck = saved.deck;
    if (this.open) {
      this.startWatch();
      this.opts.announce?.(`🎤 Karaoke is back — ${saved.entries.length} in the queue.`);
    }
    this.push();
    return this.state();
  }

  /** Queue a song for someone. Returns the room-facing message. */
  add(singer: string, singerId: string, query: string): string {
    if (!this.open) return 'Karaoke is not running — the host can open it with `V@karaoke`.';
    const result = this.queue.add({ singer, singerId, title: query });
    if (!result.ok) return result.message;
    const entry = result.entry;
    if (entry) {
      // Stems first, in the background: a queued song has the length of the
      // previous singer's turn to become a real karaoke track.
      this.prepareStems(entry);
      this.queue.update(entry.id, { stems: this.opts.prepare ? 'preparing' : 'unknown' });
    }
    this.push();
    // An empty stage should not sit empty while people wait: if nothing is
    // loaded on the stage deck, this new song is up now. A deck that is already
    // playing is left alone, so queueing never hijacks a running set.
    const slot = this.opts.decks.state()[this.deck];
    if (!slot.source || slot.ended) void this.advance();
    else if (entry) this.prefetchEntry(entry);
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
    this.preparing.clear();
    this.opts.decks.stop();
    this.push();
    return 'Sing queue cleared.';
  }

  /** Move the stage deck (the host's "play this on deck B" switch). */
  setDeck(deck: DeckId): string {
    if (this.opts.deckAllowed?.(deck) === false) {
      return `Deck ${deck.toUpperCase()} needs a paid plan — karaoke stays on ${this.deck.toUpperCase()}.`;
    }
    this.deck = deck;
    this.push();
    return `Karaoke turns now load on deck ${deck.toUpperCase()}.`;
  }

  /**
   * Key change for the night, in semitones. Applied to every turn after it is
   * loaded, and carried into the next one.
   */
  setTranspose(semitones: number): string {
    const st = Math.max(-6, Math.min(6, Math.round(Number.isFinite(semitones) ? semitones : 0)));
    this.transpose = st;
    const slot = this.opts.decks.state()[this.deck];
    if (slot.source) this.opts.decks.transpose(this.deck, st);
    this.push();
    return st === 0 ? 'Karaoke back at the original key.' : `Karaoke key: ${st > 0 ? '+' : ''}${st} semitones.`;
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
      const query = turn.uri || `${turn.title}${turn.artist ? ` ${turn.artist}` : ''}`;
      const result = await this.opts.decks.load(this.deck, query);
      if (!result.ok) {
        this.fail(turn, result.message);
        return result.message;
      }
      const slot = this.opts.decks.state()[this.deck];
      const stems = slot.stems;
      const vocals = stems ? stems.lanes.indexOf('vocals') : -1;
      this.instrumental = vocals >= 0;
      if (vocals >= 0) this.opts.decks.stemGain(this.deck, 'vocals', 0);
      if (this.transpose !== 0) this.opts.decks.transpose(this.deck, this.transpose);
      const title = slot.source?.title ?? turn.title;
      const artist = slot.source?.artist ?? turn.artist;
      this.queue.update(turn.id, {
        status: 'ready',
        title,
        artist,
        deck: this.deck,
        durationMs: slot.durationMs || turn.durationMs,
        stems: this.instrumental ? 'ready' : (turn.stems ?? 'none'),
        attempts: 0,
        detail: this.instrumental ? undefined : 'no separated stems — vocals still audible',
      });
      this.opts.decks.play(this.deck);
      this.opts.announce?.(
        `🎤 **${turn.singer}** — **${title}**${artist ? ` (${artist})` : ''}` +
          (this.instrumental ? '' : '\n> ⚠️ No instrumental for this one — it plays with the vocals.'),
      );
      this.push();
      this.prefetchNext();
      return result.message;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.fail(turn, message);
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

  /**
   * A turn that will not load is retried once — a link can be transient — and
   * dropped on the second failure instead of resurfacing every rotation.
   */
  private fail(turn: KaraokeEntry, message: string): void {
    const attempts = (turn.attempts ?? 0) + 1;
    if (attempts >= MAX_ATTEMPTS) {
      this.queue.remove(turn.id);
      this.opts.announce?.(`Couldn't load **${turn.title}** for ${turn.singer} — dropped from the queue.`);
    } else {
      this.queue.update(turn.id, { status: 'failed', attempts, detail: message });
      this.opts.announce?.(`Couldn't load **${turn.title}** for ${turn.singer} — moving on.`);
    }
    this.push();
    // Keep the night rolling after the finally block clears `loading`.
    setTimeout(() => {
      if (this.open) void this.advance();
    }, 500).unref?.();
  }

  /** Warm the following turn while this one plays. */
  private prefetchNext(): void {
    const cur = this.queue.current();
    const next = this.queue.list().find((e) => e.id !== cur?.id);
    if (next) this.prefetchEntry(next);
  }

  /** Resolve and download one entry now, so its turn does not wait on the network. */
  private prefetchEntry(entry: KaraokeEntry): void {
    if (!this.opts.prefetch) return;
    const query = entry.uri || `${entry.title}${entry.artist ? ` ${entry.artist}` : ''}`;
    void this.opts.prefetch(query).catch(() => {});
  }

  /** Background separation: a queued song becomes a karaoke song while it waits. */
  private prepareStems(entry: KaraokeEntry): void {
    const prepare = this.opts.prepare;
    if (!prepare || this.preparing.has(entry.id)) return;
    this.preparing.add(entry.id);
    const query = entry.uri || `${entry.title}${entry.artist ? ` ${entry.artist}` : ''}`;
    void prepare(query)
      .then((outcome) => {
        if (this.queue.current()?.id === entry.id) return;
        this.queue.update(entry.id, { stems: outcome });
        this.push();
      })
      .catch(() => {
        this.queue.update(entry.id, { stems: 'none' });
        this.push();
      })
      .finally(() => this.preparing.delete(entry.id));
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
    const state = this.state();
    this.opts.onState(state);
    this.opts.onSave?.(state);
  }
}

/** Announce helper: the queue as a chat list. */
export function karaokeQueueText(state: KaraokeState, max = 10): string {
  if (state.entries.length === 0) return 'The sing queue is empty.';
  const lines = state.entries.slice(0, max).map((e: KaraokeEntry, i: number) => {
    const badge = e.id === state.current?.id ? '🎤' : `${i + 1}.`;
    const artist = e.artist ? ` — ${e.artist}` : '';
    const note =
      e.status === 'failed' ? ' (will be skipped)' : e.stems === 'preparing' ? ' (preparing instrumental…)' : '';
    return `${badge} **${e.singer}**: ${e.title}${artist}${note}`;
  });
  const rest = state.entries.length - max;
  if (rest > 0) lines.push(`…and ${rest} more.`);
  return lines.join('\n');
}
