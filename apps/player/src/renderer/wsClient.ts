import type { ClientRole, InboundMessage, OutboundMessage } from '@vaporzr/shared';

export interface WsClientOptions {
  port: number;
  role: ClientRole;
  name?: string;
  onMessage: (msg: OutboundMessage) => void;
  onOpen?: () => void;
  onClose?: () => void;
}

export class WsClient {
  private ws: WebSocket | null = null;
  private retryTimer: number | null = null;
  private opts: WsClientOptions;

  constructor(opts: WsClientOptions) {
    this.opts = opts;
    this.connect();
  }

  connect(): void {
    try {
      this.ws = new WebSocket(`ws://127.0.0.1:${this.opts.port}/ws`);
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.send({ type: 'hello', role: this.opts.role, name: this.opts.name });
      this.opts.onOpen?.();
    };

    this.ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as OutboundMessage;
        this.opts.onMessage(msg);
      } catch {
        /* ignore malformed */
      }
    };

    this.ws.onclose = () => {
      this.opts.onClose?.();
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      this.ws?.close();
    };
  }

  private scheduleReconnect(): void {
    if (this.retryTimer) return;
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, 3000);
  }

  send(msg: InboundMessage | OutboundMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  close(): void {
    if (this.retryTimer) window.clearTimeout(this.retryTimer);
    this.ws?.close();
  }
}
