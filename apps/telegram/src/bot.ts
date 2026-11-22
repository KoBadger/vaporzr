/**
 * The Telegram front end.
 *
 * It owns no playback state: every action is forwarded to the running Vaporzr
 * bot over the same HTTP + WebSocket control surface the web panel uses, so a
 * request made here lands in the same queue the Discord room is listening to.
 * That also means this process can be restarted on its own without interrupting
 * the music.
 *
 * Three things are Telegram-specific and worth knowing before editing:
 *   - privacy mode decides which messages arrive at all (see privacy.ts);
 *   - a message can be edited, so there is one now-playing card per chat that
 *     is updated in place rather than a new card per track;
 *   - callback data is capped at 64 bytes, so buttons address tracks by hash.
 */

import {
  TelegramApi,
  TelegramError,
  type TgCallbackQuery,
  type TgChatMemberUpdated,
  type TgMessage,
  type TgUpdate,
} from './telegram.js';
import { VaporzrClient, type Notice } from './vaporzr.js';
import {
  cardKeyboard,
  esc,
  fingerprint,
  indexOfHash,
  parseCallback,
  renderCard,
  renderQueue,
  type JamQueue,
} from './card.js';
import { isGroupChat, privacyHint, provesOpenChat, routeText, type ChatKind } from './privacy.js';
import { Store } from './store.js';
import type { Config } from './config.js';

/** How often a live card is re-rendered while nothing is being typed at it. */
const CARD_TICK_MS = 20_000;

const HELP = [
  '<b>Vaporzr</b> — same queue, same voice room as the Discord bot.',
  '',
  '<b>Play</b>',
  '/play &lt;song or link&gt; — queue something',
  '/queue — what is up next',
  '/now — the now-playing card',
  '',
  '<b>Control</b>',
  '/skip · /pause · /resume — the usual',
  '',
  '<b>Notes</b>',
  'In a group, plain text only reaches me when I am an admin or privacy mode is off.',
  'Replying to the now-playing card or typing @me also works everywhere.',
].join('\n');

function displayName(message: TgMessage): string {
  const from = message.from;
  if (!from) return 'someone';
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ');
  return from.username ? `${name} (@${from.username})` : name || 'someone';
}

function plainName(message: TgMessage): string {
  const from = message.from;
  if (!from) return 'someone';
  return [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || 'someone';
}

export interface BotDeps {
  api: TelegramApi;
  client: VaporzrClient;
  store: Store;
  config: Config;
  /** Resolved bot username (without @), used for @mention routing. */
  username: string;
  log?: (line: string) => void;
}

export class TelegramBot {
  private readonly api: TelegramApi;
  private readonly client: VaporzrClient;
  private readonly store: Store;
  private readonly config: Config;
  private readonly log: (line: string) => void;
  private username: string;
  private stopped = false;
  /** Last rendered fingerprint per chat, so an unchanged card is not re-sent. */
  private readonly rendered = new Map<number, string>();
  private tickTimer: NodeJS.Timeout | null = null;

  constructor(deps: BotDeps) {
    this.api = deps.api;
    this.client = deps.client;
    this.store = deps.store;
    this.config = deps.config;
    this.username = deps.username;
    this.log = deps.log ?? ((line) => console.log(line));
  }

  /** Poll until `signal` aborts. Never rejects: the loop logs and keeps going. */
  async run(signal: AbortSignal): Promise<void> {
    this.startCardTicker();
    signal.addEventListener('abort', () => {
      this.stopped = true;
      this.stopCardTicker();
    });
    // allowed_updates is explicit: Telegram then holds back the heavy update
    // types we do not subscribe to instead of streaming them to us.
    const allowed = ['message', 'callback_query', 'my_chat_member'];
    while (!this.stopped && !signal.aborted) {
      let updates: TgUpdate[] = [];
      try {
        updates = await this.api.getUpdates(this.store.offset, this.config.pollSeconds, allowed);
      } catch (err) {
        // Long polling fails routinely across a redeploy or a network blip;
        // a short pause avoids a hot loop while it recovers.
        this.log(`[telegram] poll failed: ${err instanceof Error ? err.message : err}`);
        await this.sleep(2000);
        continue;
      }
      for (const update of updates) {
        if (this.stopped) break;
        // Advance before handling: a handler that throws must not make the same
        // update arrive again forever.
        this.store.offset = update.update_id + 1;
        try {
          await this.handleUpdate(update);
        } catch (err) {
          this.log(`[telegram] update ${update.update_id} failed: ${err instanceof Error ? err.message : err}`);
        }
      }
    }
  }

  async handleUpdate(update: TgUpdate): Promise<void> {
    if (update.callback_query) {
      await this.onCallback(update.callback_query);
      return;
    }
    if (update.my_chat_member) {
      await this.onMembership(update.my_chat_member);
      return;
    }
    const message = update.message ?? update.edited_message;
    if (message) await this.onMessage(message);
  }

  // ---------------------------------------------------------------- messages

  private async onMessage(message: TgMessage): Promise<void> {
    const chat = message.chat;
    if (!this.allowed(chat.id)) {
      this.log(`[telegram] ignoring chat ${chat.id} (${chat.type}) — not in TELEGRAM_ALLOWED_CHATS`);
      await this.reply(chat.id, 'This chat is not on my allow-list.', message.message_id).catch(() => {});
      return;
    }
    // Another bot talking is never a request, and answering would let two bots
    // ping-pong forever.
    if (message.from?.is_bot) return;
    if (message.new_chat_members?.some((u) => u.is_bot && u.username === this.username)) {
      await this.onAdded(chat.id, chat.type);
      return;
    }

    const text = message.text;
    if (!text) return;
    const input = {
      chatType: chat.type as ChatKind,
      text,
      replyToBot: message.reply_to_message?.from?.username === this.username,
      botUsername: this.username,
    };

    // A group message with no command, mention or reply reached us only because
    // the chat is open (admin bot, or privacy mode off) — remember that so the
    // hint is not repeated on every quiet message.
    if (provesOpenChat(input)) this.store.setOpen(chat.id, true);

    const routed = routeText(input);
    if (routed.kind === 'ignore') {
      if (routed.why === 'privacy' && !this.store.chat(chat.id).open) {
        // Only explain once per chat: a hint on every unaddressed message would
        // be worse than silence.
        if (this.store.chat(chat.id).open === undefined) {
          this.store.setOpen(chat.id, false);
          await this.reply(chat.id, privacyHint(), message.message_id);
        }
      }
      return;
    }
    if (routed.kind === 'request') {
      await this.requestSong(chat.id, routed.text, message);
      return;
    }
    await this.onCommand(chat.id, routed.command, routed.args, message);
  }

  private async onCommand(chatId: number, command: string, args: string, message: TgMessage): Promise<void> {
    switch (command) {
      case 'start':
        // Deep link payload (`t.me/bot?start=<payload>`): a share link carries
        // the song to queue, so /start with an argument is a request.
        if (args) {
          await this.requestSong(chatId, args, message);
          return;
        }
        await this.reply(chatId, HELP, message.message_id);
        return;
      case 'help':
        await this.reply(chatId, HELP, message.message_id);
        return;
      case 'play':
      case 'p':
      case 'q':
      case 'request':
        if (!args) {
          await this.reply(chatId, 'Usage: <code>/play song name or link</code>', message.message_id);
          return;
        }
        await this.requestSong(chatId, args, message);
        return;
      case 'queue':
        await this.sendQueue(chatId, message.message_id);
        return;
      case 'now':
      case 'np':
      case 'card':
        await this.refreshCard(chatId, { force: true });
        return;
      case 'skip':
      case 'next':
        await this.playback(chatId, 'next', 'Skipped.', message);
        return;
      case 'previous':
      case 'prev':
        await this.playback(chatId, 'previous', 'Back one track.', message);
        return;
      case 'pause':
        await this.playback(chatId, 'pause', 'Paused.', message);
        return;
      case 'resume':
      case 'unpause':
        await this.playback(chatId, 'resume', 'Resumed.', message);
        return;
      case 'toggle':
        await this.playback(chatId, 'toggle', 'Toggled playback.', message);
        return;
      case 'id':
        // Useful when filling TELEGRAM_ALLOWED_CHATS.
        await this.reply(chatId, `Chat id: <code>${chatId}</code>`, message.message_id);
        return;
      default:
        // Unknown commands stay silent in groups (other bots share the slash
        // namespace) but get a nudge in private chats.
        if (message.chat.type === 'private') {
          await this.reply(chatId, `Unknown command <code>/${esc(command)}</code>.\n\n${HELP}`, message.message_id);
        }
    }
  }

  private async requestSong(chatId: number, query: string, message: TgMessage): Promise<void> {
    const text = query.trim();
    if (!text) return;
    await this.api.sendChatAction(chatId, 'typing').catch(() => {});
    const result = await this.client.request(text, plainName(message));
    if (!result.ok) {
      await this.reply(chatId, `⚠️ ${esc(result.error ?? 'That request did not go through.')}`, message.message_id);
      return;
    }
    const label = result.name ? `<b>${esc(result.name)}</b>` : 'That track';
    await this.reply(
      chatId,
      result.pending ? `🕓 ${label} is waiting for host approval.` : `✅ Queued ${label}.`,
      message.message_id,
      true,
    );
    await this.refreshCard(chatId);
  }

  private async playback(chatId: number, command: string, toast: string, message?: TgMessage): Promise<void> {
    const sent = this.client.command(command);
    if (!sent) {
      await this.reply(chatId, '🔌 Not connected to the music bot right now.', message?.message_id);
      return;
    }
    if (message) await this.api.sendChatAction(chatId, 'typing').catch(() => {});
    this.log(`[telegram] chat ${chatId}: ${command} (${toast})`);
    // The card is the acknowledgement in groups; a reply would double the noise.
    if (message && message.chat.type === 'private') {
      await this.reply(chatId, toast, message.message_id, true);
    }
    // Playback state is applied asynchronously by the bot; give it a moment so
    // the card does not show the old state.
    setTimeout(() => void this.refreshCard(chatId).catch(() => {}), 700).unref?.();
  }

  // --------------------------------------------------------------- callbacks

  private async onCallback(query: TgCallbackQuery): Promise<void> {
    const chatId = query.message?.chat.id;
    const action = parseCallback(query.data);
    if (chatId == null || action.kind === 'unknown') {
      await this.api.answerCallbackQuery(query.id).catch(() => {});
      return;
    }
    if (!this.allowed(chatId)) {
      await this.api.answerCallbackQuery(query.id, 'This chat is not on my allow-list.').catch(() => {});
      return;
    }

    try {
      switch (action.kind) {
        case 'toggle':
          this.client.command('toggle');
          await this.api.answerCallbackQuery(query.id, 'Toggled');
          break;
        case 'next':
          this.client.command('next');
          await this.api.answerCallbackQuery(query.id, 'Skipped');
          break;
        case 'refresh':
          await this.api.answerCallbackQuery(query.id);
          break;
        case 'queue': {
          const q = await this.client.queue();
          await this.api.answerCallbackQuery(query.id);
          await this.api.sendMessage(chatId, renderQueue(q), { silent: true });
          break;
        }
        case 'remove': {
          const q = await this.client.queue();
          const found = indexOfHash(q, action.hash);
          if (!found) {
            await this.api.answerCallbackQuery(query.id, 'That track already left the queue.');
            break;
          }
          // Address the track by URI, not index: indexes shift under a busy
          // queue, and a remove that lands on the wrong row is worse than none.
          const sent = this.client.command('remove', { uri: found.uri, index: found.index });
          await this.api.answerCallbackQuery(query.id, sent ? 'Removed' : 'Not connected');
          break;
        }
      }
    } catch (err) {
      this.log(`[telegram] callback failed: ${err instanceof Error ? err.message : err}`);
      await this.api.answerCallbackQuery(query.id, 'That did not work.').catch(() => {});
    }
    // Every button ends with a fresh card, except a failed remove which just
    // explained itself.
    await this.refreshCard(chatId).catch(() => {});
  }

  // -------------------------------------------------------------- membership

  private async onMembership(update: TgChatMemberUpdated): Promise<void> {
    const mine = update.new_chat_member.user.username === this.username;
    if (!mine) return;
    const status = update.new_chat_member.status;
    const chat = update.chat;
    if (status === 'member' || status === 'administrator' || status === 'creator') {
      // Administrator means every message reaches us — no privacy caveats.
      if (status !== 'member') this.store.setOpen(chat.id, true);
      await this.sendWelcome(chat.id, chat.type);
      return;
    }
    if (status === 'left' || status === 'kicked') {
      this.store.setCard(chat.id, undefined);
    }
  }

  private async onAdded(chatId: number, chatType: ChatKind): Promise<void> {
    await this.sendWelcome(chatId, chatType);
  }

  private async sendWelcome(chatId: number, chatType: ChatKind): Promise<void> {
    if (!this.allowed(chatId)) return;
    const intro = isGroupChat(chatType)
      ? [
          '👋 <b>Vaporzr</b> here — I share the queue with the Discord room.',
          '',
          'Try <code>/play song name</code>, or tap the buttons on the now-playing card.',
          '',
          this.store.chat(chatId).open
            ? 'I can see everything in this chat, so plain song names work too.'
            : privacyHint(),
        ]
      : ['👋 <b>Vaporzr</b> here.', '', 'Send me a song name, or use /help.'];
    await this.api.sendMessage(chatId, intro.join('\n')).catch((err: unknown) => {
      this.log(`[telegram] welcome failed: ${err instanceof Error ? err.message : err}`);
    });
  }

  // ------------------------------------------------------------------- cards

  private startCardTicker(): void {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => {
      void this.tick().catch(() => {});
    }, CARD_TICK_MS);
    this.tickTimer.unref?.();
  }

  private stopCardTicker(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
  }

  /** One queue read, shared by every chat holding a card. */
  private async tick(): Promise<void> {
    const chats = this.store.trackedChats();
    if (chats.length === 0) return;
    let q: JamQueue;
    try {
      q = await this.client.queue();
    } catch {
      return;
    }
    const stamp = fingerprint(q);
    for (const chatId of chats) {
      if (this.rendered.get(chatId) === stamp) continue;
      await this.refreshCard(chatId, { queue: q }).catch(() => {});
    }
  }

  /**
   * Render and deliver the now-playing card. Edits the tracked message when
   * there is one, otherwise posts a new card and remembers it.
   */
  private async refreshCard(
    chatId: number,
    opts: { force?: boolean; queue?: JamQueue; replyTo?: number } = {},
  ): Promise<void> {
    const q = opts.queue ?? (await this.client.queue());
    const stamp = fingerprint(q);
    if (!opts.force && this.rendered.get(chatId) === stamp) return;

    const text = renderCard(q, { panel: Boolean(this.config.panelUrl) });
    const keyboard = cardKeyboard(q, this.config.panelUrl || undefined);
    const existing = this.store.chat(chatId).cardMessageId;
    if (existing != null) {
      try {
        await this.api.editMessageText(chatId, existing, text, keyboard);
        this.rendered.set(chatId, stamp);
        return;
      } catch (err) {
        // The message was deleted, or the chat was cleared. Fall through and
        // post a fresh one rather than losing the card for good.
        if (!(err instanceof TelegramError)) throw err;
        this.store.setCard(chatId, undefined);
      }
    }
    const sent = await this.api.sendMessage(chatId, text, { keyboard, replyTo: opts.replyTo });
    this.store.setCard(chatId, sent.message_id);
    this.rendered.set(chatId, stamp);
  }

  private async sendQueue(chatId: number, replyTo?: number): Promise<void> {
    const q = await this.client.queue();
    await this.api.sendMessage(chatId, renderQueue(q), { replyTo, silent: true });
  }

  // ------------------------------------------------------------------ notices

  /** Bot-side events (a request was refused, a stream died) forwarded to chats. */
  async onNotice(notice: Notice): Promise<void> {
    if (notice.level === 'info') return;
    const prefix = notice.level === 'error' ? '⚠️' : '✅';
    const text = `${prefix} ${esc(notice.text)}`;
    for (const chatId of this.store.trackedChats()) {
      await this.api.sendMessage(chatId, text, { silent: true }).catch(() => {});
    }
  }

  // ------------------------------------------------------------------ helpers

  private allowed(chatId: number): boolean {
    return this.config.allowedChats.size === 0 || this.config.allowedChats.has(chatId);
  }

  private async reply(chatId: number, text: string, replyTo?: number, silent = false): Promise<void> {
    await this.api.sendMessage(chatId, text, { replyTo, silent }).catch((err: unknown) => {
      this.log(`[telegram] send failed: ${err instanceof Error ? err.message : err}`);
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    });
  }
}
