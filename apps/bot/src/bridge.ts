import type http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import {
  emptyState,
  type InboundMessage,
  type OutboundMessage,
  type PlaybackState,
  type QueueSnapshot,
  type PermissionSnapshot,
  type VaporzrTheme,
} from '@vaporzr/shared';
import { QueueManager } from './queue.js';
import { PlaybackController } from './playback.js';
import { PermissionsManager } from './permissions.js';
import { VoiceManager } from './voice.js';
import { LibrespotManager } from './librespot.js';
import { Session, SessionManager } from './session.js';
import { config } from './config.js';
import { DEFAULT_THEME, themeById } from './themes.js';
import { analyzer } from './analyzer.js';
import { searchAndResolveYoutube } from './youtube.js';

interface Client {
  socket: WebSocket;
  role: 'panel' | 'visualizer';
  name: string;
  subscribedVisuals: boolean;
  /** Panels that want raw PCM (browser-side MilkDrop/analyser rendering). */
  subscribedPcm: boolean;
  /** Guild this client is interested in (undefined = primary / all). */
  guildId?: string;
}

export class Bridge {
  private wss: WebSocketServer;
  private panels = new Set<Client>();
  private visualizers = new Set<Client>();
  private lastState: PlaybackState = emptyState();
  private lastQueue: QueueSnapshot = { tracks: [], currentIndex: -1 };
  private theme: VaporzrTheme = DEFAULT_THEME;
  private sensitivity = 1.0;
  onBurstData: ((data: string) => void) | null = null;
  librespot: LibrespotManager;
  /** Per-socket auth state: true = key holder (full control), false = guest (view-only). */
  private socketAuthed = new Map<WebSocket, boolean>();
  /** Human-readable guild list for the panel/visualizer guild switcher. */
  private guildList: Array<{ id: string; name: string }> = [];

  get guildCount(): number {
    return this.guildList.length;
  }

  setGuildList(list: Array<{ id: string; name: string }>): void {
    this.guildList = list;
    for (const vis of this.visualizers) this.sendSnapshot(vis.socket);
    for (const panel of this.panels) this.sendSnapshot(panel.socket);
  }

  constructor(
    private sessions: SessionManager,
    private perms: PermissionsManager,
    server: http.Server,
  ) {
    this.wss = new WebSocketServer({ server });

    try {
      const saved = JSON.parse(
        fs.readFileSync(path.join(config.dataDir, 'theme.json'), 'utf8'),
      ) as VaporzrTheme;
      if (saved && typeof saved.accent === 'string') this.theme = saved;
    } catch { /* no saved theme yet */ }

    try {
      const s = JSON.parse(
        fs.readFileSync(path.join(config.dataDir, 'sensitivity.json'), 'utf8'),
      ) as { multiplier: number };
      if (s && typeof s.multiplier === 'number') this.sensitivity = s.multiplier;
    } catch { /* no saved sensitivity yet */ }

    this.librespot = new LibrespotManager();
    this.sessions.attachLibrespot(this.librespot);

    this.sessions.onPrimaryChanged(() => this.syncPrimary());
    this.sessions.onSessionCreated((s) => {
      if (s.guildId === this.sessions.guildId) this.syncPrimary();
    });

    this.wss.on('connection', (socket, req) => {
      // Share-key auth: keyed sockets get full control; keyless sockets connect
      // as guests — they can watch (snapshots, visuals) but commands are ignored.
      if (config.shareKey) {
        const cookie = req.headers.cookie ?? '';
        const m = /(?:^|;\s*)vz_key=([^;]+)/.exec(cookie);
        this.socketAuthed.set(socket, !!m && m[1] === config.shareKey);
      } else {
        this.socketAuthed.set(socket, true);
      }
      socket.on('message', (data) => this.handleMessage(socket, data));
      socket.on('close', () => this.handleClose(socket));
      socket.on('error', () => this.handleClose(socket));
    });
  }

  private fallback = new Session('__fallback__', null);
  private unsubscribePrimary: (() => void) | null = null;

  get queue(): QueueManager {
    return (this.sessions.primary ?? this.fallback).queue;
  }

  get playback(): PlaybackController {
    return (this.sessions.primary ?? this.fallback).playback;
  }

  get voice(): VoiceManager {
    return (this.sessions.primary ?? this.fallback).voice;
  }

  private resolveGuildId(requested?: string): string | undefined {
    return requested || this.primaryGuildId || undefined;
  }

  /** Start librespot AFTER the HTTP port has bound, so a duplicate instance
   *  that fails to bind never reaches killStale() and nukes the running bot. */
  startLibrespot(): void {
    void this.librespot.start();
  }

  private syncPrimary(): void {
    this.unsubscribePrimary?.();
    this.unsubscribePrimary = null;
    for (const other of this.sessions.all()) {
      other.setAnalyzer(false);
      other.setVisualizerSink(() => {});
      other.voice.setOnVoiceChange(() => {});
      other.setPcmSink(() => {});
    }
    const s = this.sessions.primary;
    if (!s) return;
    s.setAnalyzer(true);
    s.setVisualizerSink((msg) => this.broadcastVisualizers(msg));
    s.voice.setOnVoiceChange((joined, channelId) => {
      this.broadcastPanels({ type: 'voice:update', joined, channelId: channelId ?? undefined });
    });
    const gid = this.primaryGuildId || '__primary__';
    s.setPcmSink((data: Buffer) => {
      const hasPcmPanels = [...this.panels].some((p) => p.subscribedPcm);
      if (this.visualizers.size === 0 && !hasPcmPanels) return; // nobody listening — skip base64 work entirely
      const b64 = data.toString('base64');
      this.broadcastPcm(gid, b64);
    });
    const q = s.queue;
    const onQueueChanged = (): void => {
      this.lastQueue = { tracks: q.getSnapshot().tracks, currentIndex: q.getSnapshot().currentIndex };
      this.broadcastPanels({ type: 'queue:update', queue: this.lastQueue });
    };
    const onStateChanged = (state: PlaybackState): void => {
      this.lastState = state;
      this.broadcastPanels({ type: 'state:update', state, guildId: this.primaryGuildId ?? undefined });
      this.broadcastVisualizers({ type: 'state:update', state });
    };
    q.subscribe({ onQueueChanged, onStateChanged });
    onQueueChanged();
    onStateChanged(q.getState());
    this.unsubscribePrimary = () => {
      q.unsubscribe({ onQueueChanged, onStateChanged });
      s.voice.setOnVoiceChange(() => {});
      s.setPcmSink(() => {});
    };
  }

  private handleClose(socket: WebSocket): void {
    this.socketAuthed.delete(socket);
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
    } catch { return; }

    if (msg.type === 'hello') {
      const client: Client = {
        socket,
        role: msg.role,
        name: msg.name ?? '',
        subscribedVisuals: false,
        subscribedPcm: false,
        guildId: msg.guildId || undefined,
      };
      if (msg.role === 'visualizer') {
        this.visualizers.add(client);
        console.log(`[bridge] visualizer connected${client.guildId ? ` (guild ${client.guildId})` : ''}`);
        this.sendToSocket(socket, { type: 'visuals:enabled', enabled: this.visualsSubscribed(client.guildId) });
        this.sendToSocket(socket, { type: 'audio:forward', enabled: false });
        this.notifyDj();
        // Full snapshot on connect (state, theme, sensitivity, current guild)
        // so a fresh visualizer immediately renders the server + playback state
        // instead of waiting for the next setGuildList()/state change.
        this.sendSnapshot(socket);
        this.ensureBarsTicker();
      } else {
        this.panels.add(client);
        const guest = config.shareKey && !this.isAuthed(socket);
        console.log(`[bridge] panel connected${client.guildId ? ` (guild ${client.guildId})` : ''}${guest ? ' [guest]' : ''}`);
        this.sendSnapshot(socket);
      }
      return;
    }

    const role = this.roleOf(socket);
    if (!role) return;
    if (role === 'visualizer') this.handleVisualizerMessage(socket, msg);
    else this.handlePanelMessage(socket, msg);
  }

  private roleOf(socket: WebSocket): 'panel' | 'visualizer' | null {
    for (const p of this.panels) if (p.socket === socket) return 'panel';
    for (const v of this.visualizers) if (v.socket === socket) return 'visualizer';
    return null;
  }

  private isAuthed(socket: WebSocket): boolean {
    return this.socketAuthed.get(socket) ?? true;
  }

  private clientOf(socket: WebSocket): Client | null {
    for (const p of this.panels) if (p.socket === socket) return p;
    for (const v of this.visualizers) if (v.socket === socket) return v;
    return null;
  }

  private handleVisualizerMessage(socket: WebSocket, msg: InboundMessage): void {
    switch (msg.type) {
      case 'visuals:frame': {
        const vis = this.clientOf(socket);
        const gid = this.resolveGuildId(msg.guildId || vis?.guildId);
        this.broadcastVisuals(msg.data, gid);
        break;
      }
      case 'audio:chunk':
        break;
      case 'burst:data':
        if (!this.isAuthed(socket)) return;
        this.onBurstData?.(msg.data);
        break;
      case 'cmd':
        if (!this.isAuthed(socket)) return;
        this.handlePanelCommand(msg);
        break;
      default:
        break;
    }
  }

  private handlePanelMessage(socket: WebSocket, msg: InboundMessage): void {
    switch (msg.type) {
      case 'burst:data':
        // Web visualizers (panel role) capture their own canvas clips.
        if (!this.isAuthed(socket)) return;
        this.onBurstData?.(msg.data);
        break;
      case 'panel:subscribe': {
        const client = this.clientOf(socket);
        if (client) {
          client.subscribedVisuals = msg.channels.includes('visuals');
          client.subscribedPcm = msg.channels.includes('pcm');
          if (msg.guildId) client.guildId = msg.guildId;
          const gid = client.guildId;
          this.sendToSocket(socket, {
            type: 'visuals:enabled',
            enabled: this.visualsSubscribed(gid),
          });
          for (const vis of this.visualizers) {
            this.sendToSocket(vis.socket, {
              type: 'visuals:enabled',
              enabled: this.visualsSubscribed(vis.guildId),
            });
          }
          if (client.subscribedVisuals) {
            this.ensureBarsTicker();
          }
        }
        this.sendSnapshot(socket);
        break;
      }
      case 'cmd':
        if (!this.isAuthed(socket)) return;
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
    switch (msg.command) {
      case 'play':
        if (msg.uris && msg.uris.length > 0) {
          for (const uri of msg.uris) {
            const source = uri.startsWith('youtube:') ? 'youtube' : 'spotify';
            this.queue.enqueue({ uri, name: uri, artists: [], album: '', durationMs: 0, source }, 'panel');
          }
          while (this.queue.getCurrentTrack()?.uri !== msg.uris[0]) {
            if (!this.queue.next()) break;
          }
        }
        void this.playback.play().catch((err) => {
          console.error('[bridge] play failed:', err instanceof Error ? err.message : String(err));
        });
        break;
      case 'pause':
        this.playback.pause();
        break;
      case 'resume':
        void this.playback.resume();
        break;
      case 'toggle':
        void this.playback.toggle();
        break;
      case 'next':
        this.playback.next();
        break;
      case 'previous':
        this.playback.previous();
        break;
      case 'seek':
        if (msg.positionMs != null) this.playback.seek(msg.positionMs);
        break;
      case 'volume':
        if (msg.volume != null) this.playback.volume(msg.volume);
        break;
      case 'shuffle':
        if (msg.shuffle != null) this.playback.shuffle(msg.shuffle);
        break;
      case 'repeat':
        if (msg.repeat != null) this.playback.setRepeat(msg.repeat);
        break;
      case 'clear':
        this.playback.stopAll();
        this.queue.clear();
        break;
      case 'remove':
        if (msg.index != null) this.queue.remove(msg.index);
        break;
      case 'playAt':
        if (msg.index != null) this.playback.playAt(msg.index);
        break;
      case 'sfx':
        if (msg.sfxId) void this.playback.playSoundEffect(msg.sfxId);
        break;
      case 'dj':
        if (msg.djEnabled != null && this.primaryGuildId) {
          this.playback.setDjEnabled(this.primaryGuildId, msg.djEnabled);
          this.notifyDj();
        }
        break;
      case 'switchGuild':
        if (msg.guildId) {
          console.log(`[bridge] switching primary guild to ${msg.guildId}`);
          this.setPrimaryGuildId(msg.guildId);
        }
        break;
      case 'sensitivity':
        // Same global, persisted setting as the /sensitivity slash command.
        if (msg.sensitivity != null) {
          const v = Math.max(0.5, Math.min(1.5, msg.sensitivity));
          this.setSensitivity(v);
          console.log(`[bridge] sensitivity set to ${v}x via panel`);
        }
        break;
      case 'theme':
        if (msg.themeId) {
          const t = themeById(msg.themeId);
          if (t) {
            this.setTheme(t);
            console.log(`[bridge] theme set to "${t.name}" via panel`);
          }
        }
        break;
      case 'move':
        if (msg.index != null && msg.to != null) {
          if (!this.queue.move(msg.index, msg.to)) {
            this.notice('error', 'Could not move that track.');
          }
        }
        break;
      case 'playSearch': {
        const q = (msg.query ?? '').trim();
        if (!q) break;
        const playNow = msg.now !== false;
        void (async () => {
          try {
            const video = await searchAndResolveYoutube(q);
            if (!video) {
              this.notice('error', `No YouTube match for "${q}"`);
              return;
            }
            this.queue.enqueue(
              {
                uri: video.uri,
                name: video.name,
                artists: video.artists,
                album: video.album,
                durationMs: video.durationMs,
                image: video.image,
                source: 'youtube',
              },
              'panel',
            );
            this.notice('success', `${playNow ? 'Now playing' : 'Added'}: ${video.name}`);
            if (playNow) {
              // Point the cursor at the fresh track when idle, then start.
              while (this.queue.getCurrentTrack()?.uri !== video.uri) {
                if (!this.queue.next()) break;
              }
              void this.playback.play().catch((err) => {
                console.error('[bridge] playSearch playback failed:', err instanceof Error ? err.message : err);
                this.notice('error', `Playback failed: ${err instanceof Error ? err.message : err}`);
              });
            }
          } catch (err) {
            console.error('[bridge] playSearch failed:', err);
            this.notice('error', `Search failed: ${err instanceof Error ? err.message : err}`);
          }
        })();
        break;
      }
      default:
        break;
    }
  }

  private primaryGuildId: string | null = null;

  getPrimaryGuildId(): string | null {
    return this.primaryGuildId;
  }

  setPrimaryGuildId(guildId: string | null): void {
    this.primaryGuildId = guildId;
    this.sessions.setPrimary(guildId);
  }

  notifyDj(): void {
    const enabled = this.primaryGuildId ? this.playback.isDjEnabled(this.primaryGuildId) : false;
    const msg: OutboundMessage = { type: 'dj:update', enabled };
    this.broadcastPanels(msg);
    this.broadcastVisualizers(msg);
  }

  /** Toast-style feedback to every connected panel. */
  notice(level: 'info' | 'success' | 'error', text: string): void {
    this.broadcastPanels({ type: 'panel:notice', level, text });
  }

  /** Broadcast a message to all connected panels and visualizers. */
  broadcast(msg: OutboundMessage): void {
    this.broadcastPanels(msg);
    this.broadcastVisualizers(msg);
  }

  private visualsSubscribed(guildId?: string): boolean {
    for (const p of this.panels) {
      if (!p.subscribedVisuals) continue;
      if (!guildId || !p.guildId || p.guildId === guildId) return true;
    }
    return false;
  }

  getTheme(): VaporzrTheme { return this.theme; }

  setTheme(theme: VaporzrTheme): void {
    this.theme = theme;
    try {
      fs.mkdirSync(config.dataDir, { recursive: true });
      fs.writeFileSync(path.join(config.dataDir, 'theme.json'), JSON.stringify(theme, null, 2), 'utf8');
    } catch { /* non-fatal */ }
    const msg: OutboundMessage = { type: 'theme', theme };
    this.broadcastPanels(msg);
    this.broadcastVisualizers(msg);
  }

  getSensitivity(): number { return this.sensitivity; }

  setSensitivity(multiplier: number): void {
    this.sensitivity = multiplier;
    try {
      fs.mkdirSync(config.dataDir, { recursive: true });
      fs.writeFileSync(path.join(config.dataDir, 'sensitivity.json'), JSON.stringify({ multiplier }, null, 2), 'utf8');
    } catch { /* non-fatal */ }
    const msg: OutboundMessage = { type: 'visuals:sensitivity', multiplier };
    this.broadcastVisualizers(msg);
    this.broadcastPanels(msg);
  }

  hasVisualizers(): boolean {
    return this.visualizers.size > 0;
  }

  /** True when anything can produce a burst: a desktop visualizer or a web viewer. */
  hasBurstSources(): boolean {
    if (this.visualizers.size > 0) return true;
    return [...this.panels].some((p) => p.subscribedVisuals);
  }

  requestBurst(durationMs = 3000): void {
    const msg: OutboundMessage = { type: 'burst:start', durationMs };
    for (const vis of this.visualizers) this.sendToSocket(vis.socket, msg);
  }

  private sendSnapshot(socket: WebSocket): void {
    this.lastState = this.queue.getState();
    this.lastQueue = {
      tracks: this.queue.getSnapshot().tracks,
      currentIndex: this.queue.getSnapshot().currentIndex,
    };
    // Privacy: only the CURRENT (primary) server is ever exposed to web
    // clients — even key-authed users. Other servers' names (and existence)
    // are never sent, so multi-server lists are hidden from every viewer.
    const primaryId = this.primaryGuildId;
    const guildList = this.guildList.length > 0
      ? this.guildList
      : this.sessions.all()
          .filter((s) => s.guildId !== '__fallback__')
          .map((s) => ({ id: s.guildId, name: s.guildId }));
    const current = guildList.find((g) => g.id === primaryId) ??
      (primaryId ? { id: primaryId, name: primaryId } : undefined);
    // Anonymous /viz viewers (viewing is deliberately keyless) still get a
    // generic label — the id stays so the guild switcher keeps working.
    const authed = this.isAuthed(socket);
    const guildsForClient = current
      ? [authed ? current : { id: current.id, name: 'Server' }]
      : [];
    const out: OutboundMessage = {
      type: 'snapshot',
      state: this.lastState,
      queue: this.lastQueue,
      voice: {
        joined: this.voice.isJoined(),
        channelId: this.voice.getChannelId() ?? undefined,
      },
      theme: this.theme,
      djEnabled: this.primaryGuildId ? this.playback.isDjEnabled(this.primaryGuildId) : false,
      primaryGuildId: this.primaryGuildId ?? undefined,
      guilds: guildsForClient.length > 0 ? guildsForClient : undefined,
      sensitivity: this.sensitivity,
      guest: config.shareKey ? !authed : undefined,
      endlesswave: this.primaryGuildId ? this.sessions.get(this.primaryGuildId)?.endlessWave.active : undefined,
    };
    this.sendToSocket(socket, out);
  }

  private framesSeen = 0;
  private lastFrameLog = 0;
  private lastFrameSentAt = 0;
  private barsTicker: NodeJS.Timeout | null = null;

  /**
   * Lightweight 8 fps spectrum broadcast for standalone web visualizers.
   * ~150 bytes/message vs multi-KB rendered frames — the web /viz page draws
   * its own bars from this, so it never needs the desktop player running.
   */
  private ensureBarsTicker(): void {
    if (this.barsTicker) return;
    this.barsTicker = setInterval(() => {
      const hasConsumers =
        this.visualizers.size > 0 || [...this.panels].some((p) => p.subscribedVisuals);
      if (!hasConsumers || !analyzer.hasData()) return;
      const msg: OutboundMessage = { type: 'visuals:bars', bars: analyzer.currentBars() };
      for (const panel of this.panels) {
        if (panel.subscribedVisuals) this.sendToSocket(panel.socket, msg);
      }
      for (const vis of this.visualizers) this.sendToSocket(vis.socket, msg);
    }, 125);
    this.barsTicker.unref?.();
  }

  private broadcastVisuals(data: string, guildId?: string): void {
    this.framesSeen++;
    const now = Date.now();
    if (now - this.lastFrameLog > 5000) {
      this.lastFrameLog = now;
      const n = [...this.panels].filter((p) => p.subscribedVisuals && this.panelMatchesGuild(p, guildId)).length;
      console.log(`[bridge] visuals:frame x${this.framesSeen} received, ${n} panel(s) for guild ${guildId ?? 'all'}`);
      this.framesSeen = 0;
    }
    // Cap forwarded frame rate at ~25 fps — producers can burst faster and
    // flooding slow clients (phones on the tunnel) compounds into lag.
    if (now - this.lastFrameSentAt < 40) return;
    this.lastFrameSentAt = now;
    const msg: OutboundMessage = { type: 'visuals:frame', data, guildId };
    for (const panel of this.panels) {
      if (panel.subscribedVisuals && this.panelMatchesGuild(panel, guildId)) {
        this.sendToSocket(panel.socket, msg);
      }
    }
  }

  private panelMatchesGuild(panel: Client, guildId?: string): boolean {
    if (!guildId) return true;
    if (!panel.guildId) return true;
    return panel.guildId === guildId;
  }

  private broadcastPcm(guildId: string, data: string): void {
    const msg: OutboundMessage = { type: 'audio:pcm', guildId, data };
    for (const vis of this.visualizers) {
      if (!vis.guildId || vis.guildId === guildId) {
        this.sendToSocket(vis.socket, msg);
      }
    }
    for (const panel of this.panels) {
      if (panel.subscribedPcm && (!guildId || !panel.guildId || panel.guildId === guildId)) {
        this.sendToSocket(panel.socket, msg);
      }
    }
  }

  private broadcastVisualizers(msg: OutboundMessage): void {
    for (const vis of this.visualizers) this.sendToSocket(vis.socket, msg);
  }

  private broadcastPanels(msg: OutboundMessage): void {
    for (const panel of this.panels) this.sendToSocket(panel.socket, msg);
  }

  sendToSocket(
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
