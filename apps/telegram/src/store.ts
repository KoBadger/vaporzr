/**
 * Small on-disk state for the Telegram front end.
 *
 * Only two things need to survive a restart:
 *   - the update offset, so a redeploy does not replay every pending update;
 *   - which chat holds which now-playing card, so the card is edited in place
 *     instead of a new one appearing every time the bot restarts.
 *
 * Writes are debounced and atomic (write-temp + rename): this runs inside a
 * container whose filesystem can disappear mid-write, and a half-written JSON
 * file would silently reset both.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface ChatState {
  /** Message id of the live now-playing card, if one has been posted. */
  cardMessageId?: number;
  /** The bot has seen proof that this group delivers every message. */
  open?: boolean;
}

interface Persisted {
  offset: number;
  chats: Record<string, ChatState>;
}

export class Store {
  private data: Persisted = { offset: 0, chats: {} };
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.path, 'utf8');
      const parsed = JSON.parse(raw) as Partial<Persisted>;
      this.data = {
        offset: Number(parsed.offset ?? 0) || 0,
        chats: parsed.chats && typeof parsed.chats === 'object' ? parsed.chats : {},
      };
    } catch {
      // Missing or unreadable state is not fatal: the worst case is one
      // replayed update and a second copy of the card.
      this.data = { offset: 0, chats: {} };
    }
  }

  get offset(): number {
    return this.data.offset;
  }

  set offset(value: number) {
    this.data.offset = value;
    this.schedule();
  }

  chat(chatId: number): ChatState {
    const key = String(chatId);
    this.data.chats[key] ??= {};
    return this.data.chats[key];
  }

  setCard(chatId: number, messageId: number | undefined): void {
    const chat = this.chat(chatId);
    if (messageId == null) delete chat.cardMessageId;
    else chat.cardMessageId = messageId;
    this.schedule();
  }

  setOpen(chatId: number, open: boolean): void {
    this.chat(chatId).open = open;
    this.schedule();
  }

  /** Chats likely to hold a live card — the ones worth refreshing on a tick. */
  trackedChats(): number[] {
    return Object.entries(this.data.chats)
      .filter(([, state]) => state.cardMessageId != null)
      .map(([id]) => Number(id))
      .filter((id) => Number.isFinite(id));
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, 1000);
    this.timer.unref?.();
  }

  async flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.write().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async write(): Promise<void> {
    const body = `${JSON.stringify(this.data, null, 2)}\n`;
    const tmp = `${this.path}.tmp`;
    try {
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(tmp, body, 'utf8');
      await rename(tmp, this.path);
    } catch (err) {
      // Losing the card id costs one duplicate message; crashing over it would
      // take the whole front end down.
      console.warn(`[telegram] could not save state: ${err instanceof Error ? err.message : err}`);
    }
  }
}
