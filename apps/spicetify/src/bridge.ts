import type { OutboundMessage, InboundMessage, TrackInfo, QueueSnapshot } from '@vaporzr/shared';

const DEFAULT_PORT = 4876;

export interface BridgeState {
  connected: boolean;
  playback: {
    playing: boolean;
    track?: TrackInfo;
    positionMs: number;
    durationMs: number;
    volume: number;
    shuffle: boolean;
  } | null;
  queue: TrackInfo[];
  currentIndex: number;
  visualsFrame: string | null;
}

export class BridgeClient {
  private ws: WebSocket | null = null;
  private port = DEFAULT_PORT;
  private retryTimer: number | null = null;

  onState: (s: BridgeState['playback']) => void = () => {};
  onQueue: (q: TrackInfo[], idx: number) => void = () => {};
  onVisuals: (frame: string) => void = () => {};
  onConnection: (connected: boolean) => void = () => {};

  playback: BridgeState['playback'] = null;
  queue: TrackInfo[] = [];
  currentIndex = -1;

  constructor() {
    const stored = localStorage.getItem('vaporzr:port');
    if (stored) this.port = Number(stored);
    this.connect();
  }

  setPort(port: number): void {
    this.port = port;
    localStorage.setItem('vaporzr:port', String(port));
    this.ws?.close();
    this.connect();
  }

  connect(): void {
    try {
      this.ws = new WebSocket(`ws://127.0.0.1:${this.port}/ws`);
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.onConnection(true);
      this.send({
        type: 'hello',
        role: 'panel',
        name: 'vaporzr-spicetify',
      });
      this.send({ type: 'panel:subscribe', channels: ['state', 'queue', 'visuals'] });
      this.send({ type: 'state:request' });
    };

    this.ws.onmessage = (ev) => {
      let msg: OutboundMessage;
      try {
        msg = JSON.parse(ev.data as string) as OutboundMessage;
      } catch {
        return;
      }
      this.handleMessage(msg);
    };

    this.ws.onclose = () => {
      this.onConnection(false);
      this.scheduleReconnect();
    };

    this.ws.onerror = () => this.ws?.close();
  }

  private scheduleReconnect(): void {
    if (this.retryTimer) return;
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, 3000);
  }

  private handleMessage(msg: OutboundMessage): void {
    switch (msg.type) {
      case 'snapshot': {
        this.playback = msg.state
          ? {
              playing: msg.state.playing,
              track: msg.state.track,
              positionMs: msg.state.positionMs,
              durationMs: msg.state.durationMs,
              volume: msg.state.volume,
              shuffle: msg.state.shuffle,
            }
          : null;
        this.queue = msg.queue.tracks;
        this.currentIndex = msg.queue.currentIndex;
        this.onState(this.playback);
        this.onQueue(this.queue, this.currentIndex);
        break;
      }
      case 'state:update': {
        this.playback = {
          playing: msg.state.playing,
          track: msg.state.track,
          positionMs: msg.state.positionMs,
          durationMs: msg.state.durationMs,
          volume: msg.state.volume,
          shuffle: msg.state.shuffle,
        };
        this.onState(this.playback);
        break;
      }
      case 'queue:update': {
        this.queue = msg.queue.tracks;
        this.currentIndex = msg.queue.currentIndex;
        this.onQueue(this.queue, this.currentIndex);
        break;
      }
      case 'visuals:frame':
        this.onVisuals(msg.data);
        break;
      default:
        break;
    }
  }

  send(msg: InboundMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  cmd(msg: InboundMessage & { type: 'cmd' }): void {
    this.send(msg);
  }

  seekTo(pct: number): void {
    const d = this.playback?.durationMs ?? 0;
    if (d > 0) this.cmd({ type: 'cmd', command: 'seek', positionMs: Math.floor((pct / 100) * d) });
  }
}
