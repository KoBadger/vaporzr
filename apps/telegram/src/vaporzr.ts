/**
 * Client for the running Vaporzr bot.
 *
 * The Telegram side owns no playback state of its own: it talks to the same
 * control surface the web panel uses, so there is exactly one queue and one
 * voice session no matter how many front ends are attached. That is why this
 * deploy can be restarted independently without touching the music.
 *
 * Two channels:
 *   - HTTP for reads and song requests (`/api/queue`, `/api/request`);
 *   - the panel WebSocket for playback commands and their toasts.
 *
 * Both authenticate with `?key=` carrying a control credential; the socket
 * additionally requires no `Origin` header, which is true of any non-browser
 * client (the bridge only gates browser origins against CSWSH).
 */

import { WebSocket } from 'ws';
import type { JamQueue } from './card.js';

export interface RequestResult {
  ok: boolean;
  name?: string;
  error?: string;
  pending?: boolean;
}

export interface Notice {
  level: 'info' | 'success' | 'error';
  text: string;
}

export class VaporzrError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'VaporzrError';
  }
}

export class VaporzrClient {
  private socket: WebSocket | null = null;
  private opened = false;
  private attempt = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private readonly noticeHandlers = new Set<(notice: Notice) => void>();

  constructor(
    private readonly baseUrl: string,
    private readonly key: string,
  ) {}

  get connected(): boolean {
    return this.opened;
  }

  private httpUrl(path: string): string {
    const sep = path.includes('?') ? '&' : '?';
    return `${this.baseUrl}${path}${sep}key=${encodeURIComponent(this.key)}`;
  }

  private socketUrl(): string {
    const ws = this.baseUrl.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
    return `${ws}/ws?key=${encodeURIComponent(this.key)}`;
  }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.httpUrl(path), {
        ...init,
        headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new VaporzrError(0, err instanceof Error ? err.message : String(err));
    }
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (!res.ok) {
      const detail = (body as { error?: string } | null)?.error;
      throw new VaporzrError(res.status, detail || `HTTP ${res.status}`);
    }
    return body as T;
  }

  async queue(): Promise<JamQueue> {
    const body = await this.json<Partial<JamQueue>>('/api/queue');
    return {
      playing: body?.playing ?? null,
      playingNow: body?.playingNow === true,
      ended: body?.ended === true,
      positionMs: Number(body?.positionMs ?? 0),
      durationMs: Number(body?.durationMs ?? 0),
      updatedAt: Number(body?.updatedAt ?? 0),
      queueTotal: Number(body?.queueTotal ?? 0),
      tracks: Array.isArray(body?.tracks) ? body.tracks : [],
    };
  }

  /**
   * Ask the bot to queue a song. This is the jam-request path, not the control
   * path, so it honours the host's jam policy (locked / approval / cooldown /
   * per-guest cap) and credits the requester.
   */
  async request(query: string, who: string): Promise<RequestResult> {
    try {
      const body = await this.json<RequestResult>('/api/request', {
        method: 'POST',
        body: JSON.stringify({ query, name: who }),
      });
      return body && typeof body.ok === 'boolean'
        ? body
        : { ok: false, error: 'The bot returned an unexpected reply.' };
    } catch (err) {
      if (err instanceof VaporzrError && err.status === 503) {
        return { ok: false, error: 'The music bot is offline right now.' };
      }
      if (err instanceof VaporzrError && (err.status === 429 || err.status === 403)) {
        return { ok: false, error: err.message };
      }
      throw err;
    }
  }

  async buildId(): Promise<string> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(8000) });
      const body = (await res.json()) as { build?: string };
      return String(body?.build ?? 'unknown');
    } catch {
      return 'unreachable';
    }
  }

  onNotice(handler: (notice: Notice) => void): () => void {
    this.noticeHandlers.add(handler);
    return () => this.noticeHandlers.delete(handler);
  }

  /** Send a playback command. False means "not connected right now". */
  command(command: string, extra: Record<string, unknown> = {}): boolean {
    const socket = this.socket;
    if (!socket || !this.opened) return false;
    try {
      socket.send(JSON.stringify({ type: 'cmd', command, ...extra }));
      return true;
    } catch {
      return false;
    }
  }

  connect(): void {
    this.stopped = false;
    if (this.socket) return;
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.socketUrl());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.on('open', () => {
      this.opened = true;
      this.attempt = 0;
      try {
        socket.send(JSON.stringify({ type: 'hello', role: 'panel', name: 'telegram' }));
      } catch {
        /* closing already */
      }
    });

    socket.on('message', (raw) => {
      let msg: { type?: string; level?: string; text?: string };
      try {
        msg = JSON.parse(raw.toString()) as typeof msg;
      } catch {
        return;
      }
      if (msg.type !== 'panel:notice' || typeof msg.text !== 'string') return;
      const level = msg.level === 'error' || msg.level === 'success' ? msg.level : 'info';
      for (const handler of this.noticeHandlers) handler({ level, text: msg.text });
    });

    const drop = (): void => {
      this.opened = false;
      this.socket = null;
      if (!this.stopped) this.scheduleReconnect();
    };
    socket.on('close', drop);
    socket.on('error', () => {
      try {
        socket.terminate();
      } catch {
        /* already gone */
      }
      drop();
    });
  }

  private scheduleReconnect(): void {
    if (this.retryTimer || this.stopped) return;
    // 1s, 2s, 4s … capped at 30s: a bot redeploy is a handful of seconds, and a
    // long outage should not turn into a reconnect storm.
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(5, this.attempt++));
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
    this.retryTimer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.opened = false;
    const socket = this.socket;
    this.socket = null;
    try {
      socket?.close();
    } catch {
      /* already closed */
    }
  }
}
