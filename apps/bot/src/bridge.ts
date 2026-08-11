import type http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import {
  emptyState,
  type InboundMessage,
  type OutboundMessage,
  type PlaybackState,
  type QueueSnapshot,
  type PermissionSnapshot,
} from '@vaporzr/shared';
import { QueueManager } from './queue.js';
import { PlaybackController } from './playback.js';
import { PermissionsManager } from './permissions.js';

interface Client {
  socket: WebSocket;
  role: 'player' | 'panel' | 'visualizer';
  name: string;
  subscribedVisuals: boolean;
}

export class Bridge {
  private wss: WebSocketServer;
  private player: Client | null = null;
  private panels = new Set<Client>();
  private visualizers = new Set<Client>();
  private lastState: PlaybackState = emptyState();
  private lastQueue: QueueSnapshot = { tracks: [], currentIndex: -1 };

  playback: PlaybackController;

  constructor(
    private queue: QueueManager,
    private perms: PermissionsManager,
    server: http.Server,
  ) {
    this.wss = new WebSocketServer({ server });

    this.playback = new PlaybackController(queue, (msg) => this.sendToPlayer(msg));

    queue.subscribe({
      onQueueChanged: () => {
        this.lastQueue = { tracks: queue.getSnapshot().tracks, currentIndex: queue.getSnapshot().currentIndex };
        this.broadcastPanels({ type: 'queue:update', queue: this.lastQueue });
      },
      onStateChanged: (state) => {
        this.lastState = state;
        this.broadcastPanels({ type: 'state:update', state });
      },
    });

    this.wss.on('connection', (socket) => {
      socket.on('message', (data) => this.handleMessage(socket, data));
      socket.on('close', () => this.handleClose(socket));
      socket.on('error', () => this.handleClose(socket));
    });
  }

  isPlayerConnected(): boolean {
    return this.player !== null;
  }

  private handleClose(socket: WebSocket): void {
    if (this.player?.socket === socket) {
      this.player = null;
      console.log('[bridge] player disconnected');
      this.queue.setState({ deviceId: undefined, deviceName: undefined });
    }
    for (const panel of this.panels) {
      if (panel.socket === socket) {
        this.panels.delete(panel);
        console.log('[bridge] panel disconnected');
        break;
      }
    }
    for (const vis of this.visualizers) {
      if (vis.socket === socket) {
        this.visualizers.delete(vis);
        console.log('[bridge] visualizer disconnected');
        break;
      }
    }
  }

  private handleMessage(socket: WebSocket, raw: WebSocket.RawData): void {
    let msg: InboundMessage;
    try {
      msg = JSON.parse(raw.toString()) as InboundMessage;
    } catch {
      return;
    }

    if (msg.type === 'hello') {
      const client: Client = { socket, role: msg.role, name: msg.name ?? '', subscribedVisuals: false };
      if (msg.role === 'player') {
        this.player = client;
        console.log('[bridge] player connected');
        this.sendToSocket(socket, { type: 'ready', ok: true });
        this.sendSnapshot(socket);
      } else if (msg.role === 'visualizer') {
        this.visualizers.add(client);
        console.log('[bridge] visualizer connected');
        this.sendToSocket(socket, { type: 'visuals:enabled', enabled: this.visualsSubscribed() });
      } else {
        this.panels.add(client);
        console.log('[bridge] panel connected');
        this.sendSnapshot(socket);
      }
      return;
    }

    const role = this.roleOf(socket);
    if (!role) return;

    if (role === 'player') {
      this.handlePlayerMessage(socket, msg);
    } else if (role === 'visualizer') {
      if (msg.type === 'visuals:frame') this.broadcastVisuals(msg.data);
    } else {
      this.handlePanelMessage(socket, msg);
    }
  }

  private roleOf(socket: WebSocket): 'player' | 'panel' | 'visualizer' | null {
    if (this.player?.socket === socket) return 'player';
    if ([...this.panels].some((p) => p.socket === socket)) return 'panel';
    if ([...this.visualizers].some((v) => v.socket === socket)) return 'visualizer';
    return null;
  }

  private handlePlayerMessage(socket: WebSocket, msg: InboundMessage): void {
    switch (msg.type) {
      case 'player:ready':
        this.playback.onPlayerReady(msg.deviceId, msg.deviceName);
        break;
      case 'player:state':
        this.playback.onPlayerState(msg.state);
        break;
      case 'player:error':
        console.error('[bridge] player error:', msg.message);
        break;
      case 'visuals:frame':
        this.broadcastVisuals(msg.data);
        break;
      default:
        break;
    }
  }

  private handlePanelMessage(socket: WebSocket, msg: InboundMessage): void {
    switch (msg.type) {
      case 'panel:subscribe': {
        let client: Client | null = null;
        for (const p of this.panels) {
          if (p.socket === socket) {
            client = p;
            break;
          }
        }
        if (client) {
          client.subscribedVisuals = msg.channels.includes('visuals');
          this.sendToSocket(socket, {
            type: 'visuals:enabled',
            enabled: this.visualsSubscribed(),
          });
          for (const vis of this.visualizers) {
            this.sendToSocket(vis.socket, { type: 'visuals:enabled', enabled: this.visualsSubscribed() });
          }
        }
        this.sendSnapshot(socket);
        break;
      }
      case 'cmd':
        // The panel lives on the owner's machine and gets full control.
        this.handlePanelCommand(msg);
        break;
      case 'state:request':
        this.sendSnapshot(socket);
        break;
      default:
        break;
    }
  }

  private handlePanelCommand(msg: InboundMessage & { type: 'cmd' }): void {
    const queueOpcodes = new Set(['remove', 'clear', 'playAt']);
    if (!queueOpcodes.has(msg.command)) {
      this.sendToPlayer(msg);
      return;
    }
    switch (msg.command) {
      case 'clear':
        this.queue.clear();
        break;
      case 'remove':
        if (msg.index != null) this.queue.remove(msg.index);
        break;
      case 'playAt':
        if (msg.index != null) this.playback.playAt(msg.index);
        break;
      default:
        break;
    }
  }

  private visualsSubscribed(): boolean {
    for (const p of this.panels) if (p.subscribedVisuals) return true;
    return false;
  }

  private sendSnapshot(socket: WebSocket): void {
    this.lastState = this.queue.getState();
    this.lastQueue = {
      tracks: this.queue.getSnapshot().tracks,
      currentIndex: this.queue.getSnapshot().currentIndex,
    };
    const out: OutboundMessage = {
      type: 'snapshot',
      state: this.lastState,
      queue: this.lastQueue,
    };
    this.sendToSocket(socket, out);
  }

  private broadcastVisuals(data: string): void {
    const msg: OutboundMessage = { type: 'visuals:frame', data };
    for (const panel of this.panels) {
      if (panel.subscribedVisuals) this.sendToSocket(panel.socket, msg);
    }
  }

  private broadcastPanels(msg: OutboundMessage): void {
    for (const panel of this.panels) this.sendToSocket(panel.socket, msg);
  }

  sendToPlayer(msg: OutboundMessage | (InboundMessage & { type: 'cmd' })): void {
    if (this.player) this.sendToSocket(this.player.socket, msg);
  }

  private sendToSocket(
    socket: WebSocket,
    msg: OutboundMessage | (InboundMessage & { type: 'cmd' }),
  ): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(msg));
    }
  }

  broadcastPermission(guildId: string): void {
    const snapshot: PermissionSnapshot = {
      adminRoles: this.perms.snapshot(guildId).adminRoles,
      modRoles: this.perms.snapshot(guildId).modRoles,
      userRoles: this.perms.snapshot(guildId).userRoles,
      commandLevels: this.perms.snapshot(guildId).commandLevels,
    };
    this.broadcastPanels({ type: 'perm:update', permissions: snapshot });
  }
}
