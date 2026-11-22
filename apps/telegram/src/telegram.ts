/**
 * Minimal Telegram Bot API client.
 *
 * Deliberately framework-free: this bot needs eight methods, and every Telegram
 * framework brings its own update dispatch, session and middleware model that
 * would have to be reconciled with the real state living in the Vaporzr bot.
 * JSON POSTs plus a long-poll loop are the whole transport.
 *
 * Bot API notes that shape the code:
 *   - every method accepts a JSON body, so parameters nest naturally;
 *   - `getUpdates` is long polling: the request hangs for `timeout` seconds;
 *   - 429 carries `parameters.retry_after` — honour it instead of hammering;
 *   - editing a message with unchanged text returns 400 "message is not
 *     modified", which is not an error worth logging.
 */

const DEFAULT_BASE = 'https://api.telegram.org';

export class TelegramError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    readonly description: string,
    readonly retryAfter?: number,
  ) {
    super(`${method}: ${code || 'network'} ${description}`);
    this.name = 'TelegramError';
  }

  /** 400s that mean "nothing to change / already gone", not "we are broken". */
  get benign(): boolean {
    return (
      this.code === 400 &&
      /message is not modified|message to edit not found|message can't be edited|message to delete not found/i.test(
        this.description,
      )
    );
  }
}

export interface TgUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TgChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
  is_forum?: boolean;
}

export interface TgMessage {
  message_id: number;
  date: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
  reply_to_message?: TgMessage;
  /** Present when a group was upgraded to a supergroup. */
  migrate_to_chat_id?: number;
  new_chat_members?: TgUser[];
  left_chat_member?: TgUser;
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  data?: string;
  message?: TgMessage;
}

export interface TgChatMember {
  status: 'creator' | 'administrator' | 'member' | 'restricted' | 'left' | 'kicked';
  user: TgUser;
}

export interface TgChatMemberUpdated {
  chat: TgChat;
  from: TgUser;
  old_chat_member: TgChatMember;
  new_chat_member: TgChatMember;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  callback_query?: TgCallbackQuery;
  my_chat_member?: TgChatMemberUpdated;
}

export interface TgInlineKeyboard {
  inline_keyboard: Array<Array<{ text: string; callback_data?: string; url?: string }>>;
}

export interface SendOptions {
  keyboard?: TgInlineKeyboard;
  /** Reply to a specific message (the force-reply workaround for groups). */
  replyTo?: number;
  silent?: boolean;
}

interface Envelope<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export class TelegramApi {
  constructor(
    private readonly token: string,
    private readonly baseUrl: string = DEFAULT_BASE,
  ) {}

  private url(method: string): string {
    return `${this.baseUrl}/bot${this.token}/${method}`;
  }

  private async call<T>(
    method: string,
    payload: Record<string, unknown> = {},
    opts: { timeoutMs?: number; retries?: number } = {},
  ): Promise<T> {
    const retries = opts.retries ?? 1;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(this.url(method), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
        });
      } catch (err) {
        throw new TelegramError(method, 0, err instanceof Error ? err.message : String(err));
      }
      let body: Envelope<T> | null = null;
      try {
        body = (await res.json()) as Envelope<T>;
      } catch {
        body = null;
      }
      if (res.ok && body?.ok) return body.result as T;
      const code = body?.error_code ?? res.status;
      const description = body?.description ?? res.statusText;
      const retryAfter = body?.parameters?.retry_after;
      // A 429 or a 5xx is worth one bounded retry; anything else is the
      // caller's problem (bad chat id, bot removed from the group, ...).
      if (attempt < retries && (code === 429 || code >= 500)) {
        await sleep(retryAfter ? retryAfter * 1000 : 1500 * (attempt + 1));
        continue;
      }
      throw new TelegramError(method, code, description, retryAfter);
    }
  }

  getMe(): Promise<TgUser> {
    return this.call<TgUser>('getMe');
  }

  getUpdates(offset: number, timeoutSec: number, allowedUpdates: string[]): Promise<TgUpdate[]> {
    return this.call<TgUpdate[]>(
      'getUpdates',
      { offset, timeout: timeoutSec, allowed_updates: allowedUpdates },
      // Leave headroom over the server-side hold, otherwise the abort always
      // wins and every poll looks like a network failure.
      { timeoutMs: (timeoutSec + 15) * 1000, retries: 0 },
    );
  }

  sendMessage(chatId: number | string, text: string, opts: SendOptions = {}): Promise<TgMessage> {
    const payload: Record<string, unknown> = {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    };
    if (opts.keyboard) payload.reply_markup = opts.keyboard;
    if (opts.replyTo != null)
      payload.reply_parameters = { message_id: opts.replyTo, allow_sending_without_reply: true };
    if (opts.silent) payload.disable_notification = true;
    return this.call<TgMessage>('sendMessage', payload);
  }

  async editMessageText(
    chatId: number | string,
    messageId: number,
    text: string,
    keyboard?: TgInlineKeyboard,
  ): Promise<void> {
    try {
      await this.call('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...(keyboard ? { reply_markup: keyboard } : {}),
      });
    } catch (err) {
      if (err instanceof TelegramError && err.benign) return;
      throw err;
    }
  }

  answerCallbackQuery(id: string, text?: string): Promise<boolean> {
    return this.call<boolean>(
      'answerCallbackQuery',
      { callback_query_id: id, ...(text ? { text } : {}) },
      { retries: 0 },
    );
  }

  sendChatAction(chatId: number | string, action = 'typing'): Promise<boolean> {
    return this.call<boolean>('sendChatAction', { chat_id: chatId, action }, { retries: 0 });
  }

  setMyCommands(commands: Array<{ command: string; description: string }>): Promise<boolean> {
    return this.call<boolean>('setMyCommands', { commands });
  }

  setChatMenuButton(button: Record<string, unknown>): Promise<boolean> {
    return this.call<boolean>('setChatMenuButton', { menu_button: button });
  }

  getChatMember(chatId: number | string, userId: number | string): Promise<TgChatMember> {
    return this.call<TgChatMember>('getChatMember', { chat_id: chatId, user_id: userId }, { retries: 0 });
  }
}
