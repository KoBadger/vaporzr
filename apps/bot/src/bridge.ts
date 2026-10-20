import type http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { WebSocket, WebSocketServer } from 'ws';
import {
  emptyState,
  type InboundMessage,
  type OutboundMessage,
  type PlaybackState,
  type QueueSnapshot,
  type PermissionSnapshot,
  type VaporzrTheme,
  type MediaSource,
} from '@vaporzr/shared';
import { QueueManager, trackKey } from '@vaporzr/core/queue';
import { PlaybackController } from '@vaporzr/core/playback';
import { PermissionsManager } from './permissions.js';
import { writeJsonAtomicSync } from './jsonFile.js';
import { VoiceManager } from './voice.js';
import { LibrespotManager, type SpotifyBackend } from '@vaporzr/core/librespot';
import { GoLibrespotManager } from '@vaporzr/core/golibrespot';
import { Session, SessionManager } from './session.js';
import { config } from '@vaporzr/core/config';
import { DEFAULT_THEME, themeById } from './themes.js';
import { analyzer } from '@vaporzr/core/analyzer';
import { searchAndResolveYoutube } from '@vaporzr/core/youtube';
import type { ResolvedTrack } from '@vaporzr/core/spotify';
import { secretEquals, socketHasShareKey } from './secretCompare.js';
import { playlistStore } from '@vaporzr/core/playlists';

/** The jam page's guest URL: built from the LOW-privilege request key, not the
 *  share key — a jam link grants exactly "add a song" and nothing else.
 *  `joinUrl` stays undefined until JAM_PUBLIC_BASE names a reachable public
 *  host: the bot is loopback-bound behind the reverse proxy, so a client-derived
 *  address only resolves on the machine holding the tunnel. */
export function jamJoinLinks(): { joinPath: string; joinUrl: string | undefined } {
  const joinPath = config.requestKey ? `/jam?key=${encodeURIComponent(config.requestKey)}` : '/jam';
  return { joinPath, joinUrl: config.jamPublicBase ? config.jamPublicBase + joinPath : undefined };
}

/** One row of the public jam queue. Plain strings — the page is dumb HTML. */
interface JamQueueTrack {
  name: string;
  artists: string;
  album: string;
  addedBy: string;
  durationMs: number;
  image?: string;
  /** Source key for the row's colour dot / art fallback glyph. */
  source?: string;
}

/** Queue origins that are plumbing rather than people. The jam roster drops
 *  them, and the public jam page must not credit "panel" as if it were a
 *  person who asked for the song. */
const QUEUE_ORIGINS = new Set(['request', 'panel', 'endless-wave', 'autoplay', 'vibe', 'bulk']);

interface Client {
  socket: WebSocket;
  role: 'panel' | 'visualizer';
  name: string;
  subscribedVisuals: boolean;
  /** Panels that want raw PCM (browser-side MilkDrop/analyser rendering). */
  subscribedPcm: boolean;
  /** Guild this client is interested in (undefined = primary / all). */
  guildId?: string;
  /** Names this client reports for the jam (the Activity lists its instance). */
  roster?: string[];
}

export class Bridge {
  private wss: WebSocketServer;
  private panels = new Set<Client>();
  private visualizers = new Set<Client>();
  private lastState: PlaybackState = emptyState();
  private lastQueue: QueueSnapshot = { tracks: [], currentIndex: -1 };
  private theme: VaporzrTheme = DEFAULT_THEME;
  private sensitivity = 1.0;
  /** Seconds each visual preset dwells before auto-advancing (panel-controlled). */
  private presetCycleSec = 45;
  /** Canonical preset list + cursor. The bridge owns the choice so every
   *  visualizer shows the same preset, instead of each advancing its own pool
   *  on its own timer — which is what let the player and the Activity drift. */
  private presetNames: string[] = [];
  private presetIdx = -1;
  private presetNamesTried = false;
  private presetTimer: ReturnType<typeof setInterval> | null = null;
  onBurstData: ((data: string) => void) | null = null;
  librespot: SpotifyBackend;
  /** Routed to the Discord layer when the panel changes autoplay mode. */
  private endlessWaveToggle: ((guildId: string, mode: 'off' | 'basic' | 'smart') => void) | null = null;
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

  /** Let the Discord layer handle panel-initiated autoplay mode changes. */
  setEndlessWaveToggle(fn: (guildId: string, mode: 'off' | 'basic' | 'smart') => void): void {
    this.endlessWaveToggle = fn;
  }

  constructor(
    private sessions: SessionManager,
    private perms: PermissionsManager,
    server: http.Server,
  ) {
    this.wss = new WebSocketServer({ server });

    try {
      const saved = JSON.parse(fs.readFileSync(path.join(config.dataDir, 'theme.json'), 'utf8')) as VaporzrTheme;
      if (saved && typeof saved.accent === 'string') this.theme = saved;
    } catch {
      /* no saved theme yet */
    }

    try {
      const s = JSON.parse(fs.readFileSync(path.join(config.dataDir, 'sensitivity.json'), 'utf8')) as {
        multiplier: number;
      };
      if (s && typeof s.multiplier === 'number') this.sensitivity = s.multiplier;
    } catch {
      /* no saved sensitivity yet */
    }

    try {
      const c = JSON.parse(fs.readFileSync(path.join(config.dataDir, 'preset-cycle.json'), 'utf8')) as {
        seconds: number;
      };
      if (c && typeof c.seconds === 'number') this.presetCycleSec = Math.max(5, Math.min(600, Math.round(c.seconds)));
    } catch {
      /* no saved preset cycle yet */
    }

    // Preset ownership: load the canonical list now so an early joiner gets the
    // current preset in its first snapshot, and start the shared pace timer.
    this.ensurePresetNames();
    this.startPresetTimer();

    // Backend selection: go-librespot (soloist) or librespot-org (default).
    this.librespot =
      config.spotifyBackend === 'soloist' || config.spotifyBackend === 'go' || config.spotifyBackend === 'golibrespot'
        ? new GoLibrespotManager()
        : new LibrespotManager();
    this.sessions.attachLibrespot(this.librespot);

    this.sessions.onPrimaryChanged(() => this.syncPrimary());
    this.sessions.onSessionCreated(() => this.syncQueueSubscriptions());

    this.wss.on('connection', (socket, req) => {
      // Share-key auth: keyed sockets get full control; keyless sockets connect
      // as guests — they can watch (snapshots, visuals) but commands are ignored.
      if (config.shareKey) {
        // Accept the key from the cookie OR the ?key= query param — see
        // socketHasShareKey for why both are required.
        const authed = socketHasShareKey(req.url, req.headers.cookie, config.shareKey);
        this.socketAuthed.set(socket, authed);
        if (!authed) {
          // Don't let a guest look like a working panel: say so immediately, on
          // the socket, so the UI can switch to view-only instead of swallowing
          // every press in silence.
          try {
            socket.send(
              JSON.stringify({
                type: 'panel:notice',
                level: 'error',
                notice: 'guest',
                auth: false,
                text: 'View-only: this panel is not authorised. Open the /key give link to control playback.',
              }),
            );
          } catch {
            /* socket already gone */
          }
        }
      } else {
        this.socketAuthed.set(socket, true);
      }
      socket.on('message', (data) => this.handleMessage(socket, data));
      socket.on('close', () => this.handleClose(socket));
      socket.on('error', () => {
        // Guard: set a flag so any in-flight message handlers can check it.
        (socket as any).__vz_closing = true;
        this.handleClose(socket);
      });
    });
  }

  private fallback = new Session('__fallback__', null);

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
    for (const other of this.sessions.all()) {
      other.setAnalyzer(false);
      other.setVisualizerSink(() => {});
      other.setPcmSink(() => {});
    }
    const s = this.sessions.primary;
    if (!s) return;
    s.setAnalyzer(true);
    s.setVisualizerSink((msg) => this.broadcastVisualizers(msg));
    const gid = this.primaryGuildId || '__primary__';
    s.setPcmSink((data: Buffer) => {
      const hasPcmPanels = [...this.panels].some((p) => p.subscribedPcm);
      if (this.visualizers.size === 0 && !hasPcmPanels) return; // nobody listening — skip base64 work entirely
      const b64 = data.toString('base64');
      this.broadcastPcm(gid, b64);
    });
    // Every session gets its own subscription (below) so a panel can mirror any
    // server; the primary keeps the visualizer/analyzer/PCM taps set above.
    this.syncQueueSubscriptions();
  }

  /** Guilds that already have a queue subscription + their unsubscribe fn. */
  private queueSubs = new Map<string, () => void>();

  /**
   * Subscribe every session's queue/state/voice once, tagging each broadcast
   * with its guild so panels only apply the server they are viewing. Called on
   * boot, on session creation, and when the primary changes (idempotent).
   */
  private syncQueueSubscriptions(): void {
    for (const s of this.sessions.all()) {
      if (this.queueSubs.has(s.guildId)) continue;
      const q = s.queue;
      const gid = s.guildId;
      const onQueueChanged = (): void => {
        const snap = q.getSnapshot();
        const queue = { tracks: snap.tracks, currentIndex: snap.currentIndex };
        this.broadcastPanels({ type: 'queue:update', queue, guildId: gid }, gid);
        if (gid === this.sessions.guildId) {
          // The desktop player (role 'visualizer') mirrors the primary server.
          this.broadcastVisualizers({ type: 'queue:update', queue });
          // New credits on the queue mean new jam contributors.
          this.broadcastPresence();
        }
      };
      const onStateChanged = (state: PlaybackState): void => {
        this.broadcastPanels({ type: 'state:update', state, guildId: gid }, gid);
        if (gid === this.sessions.guildId) this.broadcastVisualizers({ type: 'state:update', state });
      };
      q.subscribe({ onQueueChanged, onStateChanged });
      s.voice.setOnVoiceChange((joined, channelId) => {
        this.broadcastPanels({ type: 'voice:update', joined, channelId: channelId ?? undefined }, gid);
        // Joining starts a fresh jam. The roster belongs to the session, and the
        // pill was carrying names over from the previous one.
        if (gid === this.sessions.guildId && joined) this.resetJamPresence();
      });
      onQueueChanged();
      onStateChanged(q.getState());
      this.queueSubs.set(gid, () => {
        q.unsubscribe({ onQueueChanged, onStateChanged });
        s.voice.setOnVoiceChange(() => {});
      });
    }
  }

  private handleClose(socket: WebSocket): void {
    this.socketAuthed.delete(socket);
    this.cmdBudget.delete(socket);
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
    // Someone left the jam — update the roster for everyone still watching.
    this.broadcastPresence();
  }

  private handleMessage(socket: WebSocket, raw: WebSocket.RawData): void {
    if ((socket as any).__vz_closing) return;
    let msg: InboundMessage;
    try {
      msg = JSON.parse(raw.toString()) as InboundMessage;
    } catch {
      return;
    }

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
        console.log(
          `[bridge] panel connected${client.guildId ? ` (guild ${client.guildId})` : ''}${guest ? ' [guest]' : ''}`,
        );
        this.sendSnapshot(socket);
      }
      // A new viewer changes the jam roster — tell everyone.
      this.broadcastPresence();
      return;
    }

    // The Activity reports who is connected to its instance. This is identity,
    // not a command, so guests may send it too — the same trust level as the
    // name in `hello`. Sanitised the same way: control characters stripped,
    // length capped, and the renderers only ever draw it as text.
    if (msg.type === 'jam:roster') {
      const client = this.clientOf(socket);
      if (client) {
        client.roster = (Array.isArray(msg.names) ? msg.names : [])
          .filter((n): n is string => typeof n === 'string')
          .map((n) =>
            n
              .replace(/[\u0000-\u001f\u007f]/g, '')
              .trim()
              .slice(0, 32),
          )
          .filter(Boolean)
          .slice(0, 50);
        this.broadcastPresence();
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

  /** Per-socket command token bucket: ~30 burst, refilled at 3/s. Keeps a keyed
   *  panel (or a hijacked socket) from flooding the bot with commands. */
  private cmdBudget = new Map<WebSocket, { tokens: number; last: number; warnedAt: number }>();

  /** Guests may nudge the preset — a visual-only action on the shared canvas —
   *  because the Activity (always a guest) is where the prev/next/shuffle
   *  buttons live. Every other command still requires the key. */
  private guestMaySend(msg: InboundMessage & { type: 'cmd' }): boolean {
    return msg.command === 'preset' && typeof msg.presetAction === 'string' && typeof msg.presetCycle !== 'number';
  }

  private allowCommand(socket: WebSocket): boolean {
    const now = Date.now();
    const CAP = 30;
    const REFILL_PER_MS = 3 / 1000;
    const b = this.cmdBudget.get(socket) ?? { tokens: CAP, last: now, warnedAt: 0 };
    b.tokens = Math.min(CAP, b.tokens + (now - b.last) * REFILL_PER_MS);
    b.last = now;
    if (b.tokens < 1) {
      if (now - b.warnedAt > 2000) {
        b.warnedAt = now;
        this.cmdBudget.set(socket, b);
        this.sendToSocket(socket, { type: 'panel:notice', level: 'error', text: 'Slow down a moment.' });
      } else {
        this.cmdBudget.set(socket, b);
      }
      return false;
    }
    b.tokens -= 1;
    this.cmdBudget.set(socket, b);
    return true;
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
      case 'visuals:preset':
        // A visualizer moved to a new preset — mirror it to every panel.
        this.broadcastPanels({
          type: 'visuals:preset',
          name: msg.name,
          index: msg.index,
          total: msg.total,
          guildId: msg.guildId,
        });
        break;
      case 'cmd':
        if (!this.isAuthed(socket) && !this.guestMaySend(msg)) return;
        if (!this.allowCommand(socket)) return;
        this.handlePanelCommand(socket, msg, this.clientGuildId(socket));
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
        if (!this.isAuthed(socket) && !this.guestMaySend(msg)) return;
        if (!this.allowCommand(socket)) return;
        this.handlePanelCommand(socket, msg, this.clientGuildId(socket));
        break;
      case 'state:request':
        this.sendSnapshot(socket);
        break;
      default:
        break;
    }
  }

  /** Existing session for the guild a panel is viewing — never creates one. */
  private sessionFor(guildId?: string): Session {
    if (guildId) {
      const s = this.sessions.all().find((x) => x.guildId === guildId);
      if (s) return s;
    }
    return this.sessions.primary ?? this.fallback;
  }

  /** Panel commands that need the bot in a voice channel first. Without this the
   *  play/resume buttons simply failed with "I'm not in a voice channel" — which
   *  is what made the panel look dead once the bot had been made to leave. The
   *  client's own guild is preferred, so a busier guild elsewhere cannot win. */
  private async ensureVoice(guildId?: string): Promise<boolean> {
    const v = this.sessionFor(guildId).voice;
    // Only a Ready link can carry audio — isJoined() also accepts a dead
    // Disconnected/Connecting link, which silently skipped the rejoin and made
    // the panel's play button do nothing while claiming success.
    if (v.isConnectionReady()) return true;
    if (!this.onEnsureJoined) return false;
    try {
      await this.onEnsureJoined(guildId);
    } catch (err) {
      console.warn(`[bridge] auto-join failed: ${err instanceof Error ? err.message : err}`);
    }
    if (v.isConnectionReady()) return true;
    this.notice('error', "Couldn't join a voice channel — join one in Discord, then press play.");
    return false;
  }

  /** Guild the client behind this socket is looking at (panels subscribe per
   *  guild; visualizers may not). */
  private clientGuildId(socket: WebSocket): string | undefined {
    for (const c of [...this.panels, ...this.visualizers]) {
      if (c.socket === socket) return c.guildId;
    }
    return undefined;
  }

  private handlePanelCommand(socket: WebSocket, msg: InboundMessage & { type: 'cmd' }, guildId?: string): void {
    // Playback commands act on the server this viewer is looking at (keyed
    // panels can switch servers); global settings below stay global.
    const s = this.sessionFor(guildId);
    switch (msg.command) {
      case 'play':
        if (msg.uris && msg.uris.length > 0) {
          for (const uri of msg.uris) {
            const source = uri.startsWith('youtube:') ? 'youtube' : 'spotify';
            s.queue.enqueue({ uri, name: uri, artists: [], album: '', durationMs: 0, source }, 'panel');
          }
          // Remember where we were. If the requested track cannot start, the
          // cursor must not be left parked on a track that never played — the
          // playback layer then treats it as current while the audio is still on
          // the old track, which silently disables every advance path.
          const before = s.queue.getState().track?.uri ?? '';
          // focusUri moves the cursor in either direction; the old next() walk
          // could only go forward, so re-playing an earlier track (the standard
          // way to recover a stuck queue) silently did nothing.
          s.queue.focusUri(msg.uris[0]);
          void (async () => {
            // Join first: a panel play is refused outright when the bot is not
            // in a voice channel, and the panel cannot supply one itself.
            if (!(await this.ensureVoice(guildId))) {
              if (before) s.queue.focusUri(before);
              return;
            }
            try {
              await s.playback.play();
            } catch (err) {
              console.error('[bridge] play failed:', err instanceof Error ? err.message : String(err));
              if (before) s.queue.focusUri(before);
            }
          })();
        }
        break;
      case 'pause':
        s.playback.pause();
        break;
      case 'resume':
        void (async () => {
          if (!(await this.ensureVoice(guildId))) return;
          void s.playback.resume();
        })();
        break;
      case 'toggle':
        void (async () => {
          if (!(await this.ensureVoice(guildId))) return;
          void s.playback.toggle();
        })();
        break;
      case 'next':
        s.playback.next();
        break;
      case 'previous':
        s.playback.previous();
        break;
      case 'seek':
        if (msg.positionMs != null) s.playback.seek(msg.positionMs);
        break;
      case 'share-jam': {
        void (async () => {
          if (!this.onShareJam) {
            this.notice('error', 'Sharing is not available on this instance.');
            return;
          }
          const r = await this.onShareJam(guildId).catch((err): { ok: boolean; where?: string; error?: string } => ({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }));
          if (r.ok)
            this.notice('success', `📱 Jam card posted${r.where ? ` in ${r.where}` : ''} — scan or tap to join.`);
          else this.notice('error', r.error ?? 'Could not post the jam card.');
        })();
        break;
      }
      case 'volume':
        if (msg.volume != null) s.playback.volume(msg.volume);
        break;
      case 'shuffle':
        if (msg.shuffle != null) s.playback.shuffle(msg.shuffle);
        break;
      case 'repeat':
        if (msg.repeat != null) s.playback.setRepeat(msg.repeat);
        break;
      case 'clear':
        s.playback.stopAll();
        s.queue.clear();
        break;
      case 'remove':
        if (msg.index != null) s.removeFromQueue(msg.index);
        break;
      case 'playAt':
        if (msg.index != null) s.playback.playAt(msg.index);
        break;
      case 'queuePlay': {
        // V@qa "play": jump to this track and drop everything queued before it.
        if (msg.index != null) {
          const track = s.queue.getSnapshot().tracks[msg.index];
          if (track) {
            s.queue.removeUpTo(msg.index);
            s.playback.next();
          }
        }
        break;
      }
      case 'sfx':
        if (msg.sfxId) void s.playback.playSoundEffect(msg.sfxId);
        break;
      case 'dj':
        if (msg.djEnabled != null && s.guildId) {
          s.playback.setDjEnabled(s.guildId, msg.djEnabled);
          this.notifyDj();
        }
        break;
      case 'endlesswave': {
        // Prefer an explicit mode; fall back to the legacy boolean toggle.
        const mode = msg.mode ?? (msg.active != null ? (msg.active ? 'smart' : 'off') : null);
        if (mode && s.guildId && this.endlessWaveToggle) {
          this.endlessWaveToggle(s.guildId, mode);
        }
        break;
      }
      case 'bass':
        if (msg.db != null) s.playback.setBassBoost(Math.max(0, Math.min(12, msg.db)));
        break;
      case 'speed':
        if (msg.factor != null && msg.factor > 0) s.playback.setSpeed(msg.factor);
        break;
      case 'ambient': {
        if (msg.ambient != null && s.guildId) {
          this.perms.setAmbient(s.guildId, Boolean(msg.ambient));
          // Play the pad right away if the queue is already idle.
          if (msg.ambient && s.voice.isJoined() && !s.queue.getState().playing) {
            void s.playback.startAmbient();
          }
          for (const vis of this.visualizers) this.sendSnapshot(vis.socket);
          for (const panel of this.panels) this.sendSnapshot(panel.socket);
        }
        break;
      }
      case 'voteskip':
        if (msg.voteSkip != null && s.guildId) {
          this.perms.setVoteSkip(s.guildId, Boolean(msg.voteSkip));
        }
        break;
      case 'dedupe':
        s.queue.dedupe();
        break;
      case 'skipto':
        // Jump to a future queued track, dropping everything it skips.
        if (msg.index != null) {
          s.queue.removeUpTo(msg.index);
          s.playback.next();
        }
        break;
      case 'switchGuild':
        // Keyed panels may look at any server. This is per-client: the bot's own
        // primary (audio, visuals, jam) is untouched, so one viewer switching
        // never yanks another viewer's view.
        if (msg.guildId && this.isAuthed(socket)) {
          const client = this.clientOf(socket);
          if (client) {
            client.guildId = msg.guildId;
            console.log(`[bridge] panel switched to guild ${msg.guildId}`);
            this.sendSnapshot(socket);
          }
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
      case 'preset': {
        // Presets live in each visualizer (the desktop player ships its own pack,
        // the web viz streams the curated library), so relay the *intent* and let
        // every visualizer advance its own pool.
        if (typeof msg.presetCycle === 'number') {
          this.setPresetCycle(msg.presetCycle);
          console.log(`[bridge] preset dwell set to ${this.presetCycleSec}s via panel`);
          break;
        }
        const action = msg.presetAction ?? 'next';
        this.showPreset(action);
        console.log(`[bridge] preset ${action} via panel`);
        break;
      }
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
          if (!s.queue.move(msg.index, msg.to)) {
            this.notice('error', 'Could not move that track.');
          }
        }
        break;
      case 'playSearch': {
        const q = (msg.query ?? '').trim();
        if (!q) break;
        void this.playSearch(q, msg.now !== false, guildId, socket, msg.insert === true);
        break;
      }
      case 'bulkSearch':
        void this.bulkSearch(msg.queries, guildId, socket);
        break;
      case 'saveVibe': {
        const name = (msg.name ?? '').trim();
        if (!name) {
          this.notice('error', 'Name the vibe first.');
          break;
        }
        const tracks = s.queue.getSnapshot().tracks.map((t) => ({
          uri: t.uri,
          name: t.name,
          artists: t.artists,
          album: t.album,
          durationMs: t.durationMs,
          source: (t.source ?? 'youtube') as string,
          image: t.image,
        }));
        const res = playlistStore.save(s.guildId, name, tracks);
        this.notice(
          res.ok ? 'success' : 'error',
          res.ok ? `Saved vibe "${name}" (${res.tracks} tracks)` : (res.error ?? 'Save failed.'),
        );
        break;
      }
      case 'loadVibe': {
        const name = (msg.name ?? '').trim();
        if (!name) {
          this.notice('error', 'Pick a saved vibe first.');
          break;
        }
        const pl = playlistStore.get(s.guildId, name);
        if (!pl) {
          this.notice('error', `No saved vibe "${name}".`);
          break;
        }
        // Loading a vibe that is (partly) already queued must not stack a
        // second copy of everything — same duplicate rule as the add paths.
        const fresh = s.queue.filterNew(
          pl.tracks.map((t) => ({
            uri: t.uri,
            name: t.name,
            artists: t.artists,
            album: t.album,
            durationMs: t.durationMs,
            source: t.source as MediaSource,
            image: t.image,
          })),
        );
        if (fresh.length === 0) {
          this.notice('info', `"${pl.name}" is already in the queue.`);
          break;
        }
        s.queue.enqueueMany(fresh, 'vibe');
        const dropped = pl.tracks.length - fresh.length;
        this.notice(
          'success',
          `Loaded "${pl.name}" (${fresh.length} track${fresh.length === 1 ? '' : 's'}` +
            `${dropped > 0 ? ` · ${dropped} already queued` : ''})`,
        );
        break;
      }
      default:
        break;
    }
  }

  /** The panel's search box: the same input surface as V@p and the jam page —
   *  direct links (YouTube, Spotify, SoundCloud, Apple, Suno…), playlists and
   *  plain searches — through the resolver the bot wires in at startup, with
   *  YouTube search kept as the fallback so the bridge still works on its own.
   *  "Play now" starts the first fresh track; anything else a playlist-style
   *  resolve produced queues behind it. */
  private async playSearch(
    q: string,
    playNow: boolean,
    guildId?: string,
    requester?: WebSocket,
    insert = false,
  ): Promise<void> {
    // Panel commands act on the server this viewer is looking at, not on the
    // globally-selected primary.
    const session = this.sessionFor(guildId);
    const queue = session.queue;
    try {
      let tracks: ResolvedTrack[];
      if (this.onResolveRequest) {
        tracks = await this.onResolveRequest(q);
      } else {
        const video = await searchAndResolveYoutube(q);
        tracks = video
          ? [
              {
                uri: video.uri,
                name: video.name,
                artists: video.artists,
                album: video.album,
                durationMs: video.durationMs,
                image: video.image,
                source: 'youtube' as const,
              },
            ]
          : [];
      }
      if (!tracks.length) {
        this.noticeTo(
          requester,
          'error',
          `No match for "${q}" — try a link (YouTube, Spotify, Suno…) or different words.`,
        );
        return;
      }
      // A playlist link can resolve to many tracks; cap it the same way the
      // jam page does, so one paste cannot flood the queue.
      const capped = tracks.slice(0, 25);
      const fresh = queue.filterNew(capped);
      if (fresh.length === 0) {
        // Already waiting — never stack a second copy. A "play now" for a
        // duplicate plays the copy that is already there (matching by uri or
        // the normalised title|artist key).
        const label = capped.length === 1 ? `"${capped[0].name}" is` : 'Those tracks are';
        this.noticeTo(requester, 'info', `${label} already in the queue.`);
        if (playNow) {
          const existing = queue
            .getSnapshot()
            .tracks.find((t) =>
              capped.some((c) => t.uri === c.uri || (trackKey(t) !== '' && trackKey(t) === trackKey(c))),
            );
          if (existing && (await this.ensureVoice(guildId))) {
            const before = queue.getState().track?.uri ?? '';
            queue.focusUri(existing.uri);
            void session.playback.play().catch((err) => {
              console.error('[bridge] playSearch playback failed:', err instanceof Error ? err.message : err);
              this.noticeTo(requester, 'error', `Playback failed: ${err instanceof Error ? err.message : err}`);
              if (before) queue.focusUri(before);
            });
          }
        }
        return;
      }
      const skipped = capped.length - fresh.length;
      const extra = tracks.length - capped.length;
      const label =
        fresh.length === 1
          ? fresh[0].name
          : `${fresh.length} tracks${extra > 0 ? ` (+${extra} more not queued)` : ''}` +
            (skipped > 0 ? ` · ${skipped} already queued` : '');
      if (insert) {
        // Play-next: land the resolved batch right after the current track
        // instead of at the end. Duplicate handling matches the add path.
        queue.insertAfterCurrent(fresh, 'panel');
        this.noticeTo(requester, 'success', `Playing next: ${label}`);
        if (!queue.getState().playing && (await this.ensureVoice(guildId))) {
          void session.playback.play().catch((err) => {
            console.error('[bridge] insert playback failed:', err instanceof Error ? err.message : err);
            this.noticeTo(requester, 'error', `Playback failed: ${err instanceof Error ? err.message : err}`);
          });
        }
        return;
      }
      // One placement decision for the whole batch (the same rule the Discord
      // bulk add uses), so the resolve's internal order survives shuffle state.
      queue.enqueueMany(fresh, 'panel');
      this.noticeTo(requester, 'success', `${playNow ? 'Now playing' : 'Added'}: ${label}`);
      if (playNow) {
        // Join first: without a voice channel the play is refused outright,
        // which is what made the panel's search-and-play look broken.
        if (!(await this.ensureVoice(guildId))) return;
        // Point the cursor at the first fresh track, then start. If it cannot
        // start, put the cursor back so it never diverges from the audio that
        // is actually playing.
        const before = queue.getState().track?.uri ?? '';
        queue.focusUri(fresh[0].uri);
        void session.playback.play().catch((err) => {
          console.error('[bridge] playSearch playback failed:', err instanceof Error ? err.message : err);
          this.noticeTo(requester, 'error', `Playback failed: ${err instanceof Error ? err.message : err}`);
          if (before) queue.focusUri(before);
        });
      }
    } catch (err) {
      console.error('[bridge] playSearch failed:', err);
      this.noticeTo(requester, 'error', `Search failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Panel bulk add: resolve every pasted query in turn and queue the matches as
   * one batch (mirrors `/bulk`: max 25 entries, duplicates dropped, partial
   * failures reported). Never starts playback — the panel owns the Play button.
   */
  private async bulkSearch(queries: string[] | undefined, guildId?: string, requester?: WebSocket): Promise<void> {
    const list = (Array.isArray(queries) ? queries : [])
      .map((q) => (typeof q === 'string' ? q.trim() : ''))
      .filter(Boolean)
      .slice(0, 25);
    if (list.length === 0) {
      this.noticeTo(requester, 'error', 'Paste at least one song or link.');
      return;
    }
    const queue = this.sessionFor(guildId).queue;
    const resolved: ResolvedTrack[] = [];
    const failed: string[] = [];
    for (const query of list) {
      try {
        let found: ResolvedTrack[];
        if (this.onResolveRequest) {
          found = await this.onResolveRequest(query);
        } else {
          const video = await searchAndResolveYoutube(query);
          found = video
            ? [
                {
                  uri: video.uri,
                  name: video.name,
                  artists: video.artists,
                  album: video.album,
                  durationMs: video.durationMs,
                  image: video.image,
                  source: 'youtube' as const,
                },
              ]
            : [];
        }
        if (found.length === 0) failed.push(query);
        else resolved.push(...found);
      } catch {
        failed.push(query);
      }
    }
    if (resolved.length === 0) {
      this.noticeTo(
        requester,
        'error',
        `Nothing found for ${list.length === 1 ? `"${list[0]}"` : `${list.length} entries`}.`,
      );
      return;
    }
    const capped = resolved.slice(0, 25);
    const fresh = queue.filterNew(capped);
    if (fresh.length === 0) {
      this.noticeTo(requester, 'info', 'Those tracks are already in the queue.');
      return;
    }
    queue.enqueueMany(fresh, 'panel');
    const already = capped.length - fresh.length;
    this.noticeTo(
      requester,
      'success',
      `Bulk added ${fresh.length} track${fresh.length === 1 ? '' : 's'}` +
        (already > 0 ? ` · ${already} already queued` : '') +
        (failed.length > 0 ? ` · ${failed.length} not found` : ''),
    );
  }

  /** Wired by the bot at startup to the full V@p resolver. A hook rather than an
   *  import: discord.ts already imports the bridge, and a cycle back would make
   *  module init order matter. */
  onResolveRequest: ((query: string) => Promise<ResolvedTrack[]>) | null = null;

  /** Wired by the bot at startup: put the bot in a voice channel before a panel
   *  command that needs one. The panel has no channel of its own, so the bot
   *  joins wherever the listeners are. */
  onEnsureJoined: ((guildId?: string) => Promise<boolean>) | null = null;

  /** Wired by the bot at startup: post the jam invite card (link + QR) into the
   *  panel's text channel. A hook rather than an import for the same reason as
   *  onEnsureJoined — everything channel-facing lives in discord.ts. */
  onShareJam: ((guildId?: string) => Promise<{ ok: boolean; where?: string; error?: string }>) | null = null;

  /** Used by the public /request page: resolve a query and queue it (no playback).
   *  `who` is the guest's display name, so a jam credit reads as a person rather
   *  than the `request` origin. Untrusted input: length-capped and stripped of
   *  control characters. Every renderer draws it as text (textContent / canvas),
   *  never as HTML. */
  async requestTrack(query: string, who?: string): Promise<{ ok: boolean; name?: string; error?: string }> {
    const q = query.trim();
    if (!q) return { ok: false, error: 'Type a song to request.' };
    const credit =
      (who ?? '')
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .trim()
        .slice(0, 24) || 'request';
    try {
      // Same input surface as V@p — direct links, playlists, Spotify, Suno,
      // Apple Music, SoundCloud, plain searches — when the bot has wired its
      // resolver in. YouTube search stays as the fallback so the page also works
      // on its own.
      let tracks: ResolvedTrack[];
      if (this.onResolveRequest) {
        tracks = await this.onResolveRequest(q);
      } else {
        const video = await searchAndResolveYoutube(q);
        tracks = video
          ? [
              {
                uri: video.uri,
                name: video.name,
                artists: video.artists,
                album: video.album,
                durationMs: video.durationMs,
                image: video.image,
                source: 'youtube' as const,
              },
            ]
          : [];
      }
      if (!tracks.length) return { ok: false, error: `No match for "${q}".` };
      // A playlist link can resolve to many tracks; cap it so one link cannot
      // flood the queue, and say so when the cap bites.
      const capped = tracks.slice(0, 25);
      const s = this.sessions.primary ?? this.fallback;
      // Never stack a song that's already waiting. The Discord add paths refuse
      // duplicates, and the jam page has the highest chance of them: several
      // guests ask for the same song, or one guest double-taps a slow resolve.
      // Without this filter every repeat landed as another queue entry.
      const fresh = s.queue.filterNew(capped);
      if (fresh.length === 0) {
        const label = capped.length === 1 ? `"${capped[0].name}" is` : 'Those tracks are';
        return { ok: false, error: `${label} already in the queue.` };
      }
      const skipped = capped.length - fresh.length;
      // One placement decision for the whole batch (same rule the Discord bulk
      // add uses), so the request's internal order survives whatever the
      // shuffle state is.
      s.queue.enqueueMany(fresh, credit);
      const extra = tracks.length - capped.length;
      const name =
        fresh.length === 1
          ? fresh[0].name
          : `${fresh.length} tracks${extra > 0 ? ` (+${extra} more not queued)` : ''}` +
            (skipped > 0 ? ` · ${skipped} already queued` : '');
      return { ok: true, name };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Read-only view of the queue for the public jam page: what is on now and
   *  what is next, with who asked for each. Deliberately small and free of
   *  internal ids — it is served to key-holding guests on a phone.
   *
   *  `playing` is the row at the cursor, which exists even while playback is
   *  idle ("starts with this"), so it is NOT the same as audio actually
   *  coming out. `playingNow` carries the truthful flag — the page must not
   *  print "NOW PLAYING" over a silent queue. The progress fields describe the
   *  cursor row too; the page interpolates `positionMs` from its LOCAL receipt
   *  time, so client/server clock skew cannot bend the bar. */
  jamQueue(): {
    playing: JamQueueTrack | null;
    playingNow: boolean;
    ended: boolean;
    positionMs: number;
    durationMs: number;
    updatedAt: number;
    queueTotal: number;
    tracks: JamQueueTrack[];
  } {
    const snap = this.queue.getSnapshot();
    const map = (t: {
      name?: string;
      artists?: string[];
      album?: string;
      addedBy?: string;
      durationMs?: number;
      image?: string;
      source?: string;
    }): JamQueueTrack => ({
      name: t.name || 'Unknown',
      artists: (t.artists ?? []).join(', '),
      album: t.album || '',
      addedBy: t.addedBy && !QUEUE_ORIGINS.has(t.addedBy) ? t.addedBy : '',
      durationMs: t.durationMs ?? 0,
      image: t.image,
      source: t.source,
    });
    const cur = snap.currentIndex;
    const current = cur >= 0 ? snap.tracks[cur] : undefined;
    // The current track lives in the list too, so "up next" starts after it.
    const start = cur >= 0 ? cur + 1 : 0;
    return {
      playing: current ? map(current) : null,
      playingNow: cur >= 0 && snap.state.playing === true,
      ended: this.queue.isPlayedThrough(),
      // Raw position, playing or not: a PAUSED track renders its frozen bar
      // from it. A leftover position on an ended queue is handled by the page
      // (it checks `ended` first and never animates from a stale value).
      positionMs: snap.state.positionMs ?? 0,
      durationMs: snap.state.durationMs || current?.durationMs || 0,
      updatedAt: snap.state.updatedAt ?? 0,
      queueTotal: snap.tracks.length,
      tracks: snap.tracks.slice(start, start + 30).map(map),
    };
  }

  private primaryGuildId: string | null = null;

  /** Cut-off for jam attribution, reset when the bot joins a voice channel, so
   *  the roster describes the session in progress rather than the last one. */
  private jamEpoch = 0;

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

  /** Toast panels, plus a direct copy to the socket that asked: the desktop
   *  player connects as a visualizer, so a panels-only broadcast would leave
   *  its add box silent on successes and failures alike. */
  private noticeTo(requester: WebSocket | undefined, level: 'info' | 'success' | 'error', text: string): void {
    this.notice(level, text);
    if (!requester) return;
    for (const p of this.panels) if (p.socket === requester) return; // already toasted
    this.sendToSocket(requester, { type: 'panel:notice', level, text });
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

  getTheme(): VaporzrTheme {
    return this.theme;
  }

  setTheme(theme: VaporzrTheme): void {
    this.theme = theme;
    try {
      writeJsonAtomicSync(path.join(config.dataDir, 'theme.json'), theme);
    } catch {
      /* non-fatal */
    }
    const msg: OutboundMessage = { type: 'theme', theme };
    this.broadcastPanels(msg);
    this.broadcastVisualizers(msg);
  }

  getPresetCycle(): number {
    return this.presetCycleSec;
  }

  /** How long a visual preset stays up. Persisted like sensitivity so a fresh
   *  viewer (or the Activity) picks up the same pace on connect. */
  setPresetCycle(seconds: number): void {
    const secs = Math.max(5, Math.min(600, Math.round(seconds)));
    this.presetCycleSec = secs;
    try {
      writeJsonAtomicSync(path.join(config.dataDir, 'preset-cycle.json'), { seconds: secs });
    } catch {
      /* non-fatal */
    }
    this.broadcast({ type: 'preset:cycle', seconds: secs, guildId: this.primaryGuildId ?? undefined });
    // The pace moved to the bridge with the preset choice: restart the timer so
    // every surface turns the page together.
    this.startPresetTimer();
  }

  /** Every preset name the browser packs expose, in a stable order. Read once
   *  from the same npm packs the visualizers stream — they are UMD builds and
   *  butterchurn-presets declares no "exports" map, so Node can require them. */
  private ensurePresetNames(): string[] {
    if (this.presetNames.length || this.presetNamesTried) return this.presetNames;
    this.presetNamesTried = true;
    try {
      const req = createRequire(import.meta.url);
      const packs = [
        'butterchurn-presets/lib/butterchurnPresets.min.js',
        'butterchurn-presets/lib/butterchurnPresetsExtra.min.js',
        'butterchurn-presets/lib/butterchurnPresetsExtra2.min.js',
      ];
      const seen = new Set<string>();
      for (const p of packs) {
        const mod = req(p) as { getPresets?: () => Record<string, unknown> };
        const got = mod && typeof mod.getPresets === 'function' ? mod.getPresets() : {};
        for (const n of Object.keys(got)) {
          if (!seen.has(n)) {
            seen.add(n);
            this.presetNames.push(n);
          }
        }
      }
      // The bundled "baron" pack — 762 curated Cream-of-the-Crop presets that
      // were sitting unused in the image. It is what the visualizers now merge.
      for (const n of this.baronPresetNames()) {
        if (!seen.has(n)) {
          seen.add(n);
          this.presetNames.push(n);
        }
      }
      console.log(`[bridge] preset library: ${this.presetNames.length} presets`);
    } catch (err) {
      console.warn(`[bridge] preset library unavailable: ${err instanceof Error ? err.message : err}`);
    }
    return this.presetNames;
  }

  /** Names of the bundled "baron" pack (762 Cream-of-the-Crop presets). It is not
   *  a UMD module — it assigns window.butterchurnPresetsBaron — so it is evaluated
   *  against a throwaway window. Its presets are keyed by bare id and carry no
   *  name, so they are labelled "Baron #<id>": the same string the visualizers
   *  build, which is what lets the sync name them. */
  private baronPresetNames(): string[] {
    try {
      // ESM has no __dirname: derive the bot root from this module's own URL.
      const here = path.dirname(fileURLToPath(import.meta.url));
      const file = path.join(here, '..', 'public', 'vendor', 'butterchurnPresetsBaron.min.js');
      const sandbox: { window: Record<string, unknown> } = { window: {} };
      vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox, { timeout: 10_000 });
      const pack = sandbox.window.butterchurnPresetsBaron as { getPresets?: () => Record<string, unknown> } | undefined;
      const got = pack && typeof pack.getPresets === 'function' ? pack.getPresets() : {};
      return Object.keys(got).map((k) => `Baron #${k}`);
    } catch (err) {
      console.warn(`[bridge] baron pack unavailable: ${err instanceof Error ? err.message : err}`);
      return [];
    }
  }

  /** Pick a preset and name it to every visualizer. With no list (packs
   *  unreadable) it falls back to relaying the bare intent — the old,
   *  unsynchronised behaviour, so this can never be worse than before. */
  private showPreset(action: 'next' | 'prev' | 'shuffle' = 'next'): void {
    const names = this.ensurePresetNames();
    if (!names.length) {
      this.broadcast({ type: 'preset:nav', action, guildId: this.primaryGuildId ?? undefined });
      return;
    }
    if (this.presetIdx < 0) this.presetIdx = 0;
    else if (action === 'shuffle') this.presetIdx = Math.floor(Math.random() * names.length);
    else if (action === 'prev') this.presetIdx = (this.presetIdx - 1 + names.length) % names.length;
    else this.presetIdx = (this.presetIdx + 1) % names.length;
    const name = names[this.presetIdx];
    this.broadcast({
      type: 'preset:show',
      name,
      index: this.presetIdx,
      guildId: this.primaryGuildId ?? undefined,
    });
  }

  /** The pace timer lives here now, so every surface advances together instead
   *  of each counting its own seconds. Idles when nobody is watching. */
  private startPresetTimer(): void {
    if (this.presetTimer) clearInterval(this.presetTimer);
    this.presetTimer = null;
    if (this.presetCycleSec <= 0) return;
    this.presetTimer = setInterval(() => {
      if (this.visualizers.size === 0) return;
      this.showPreset('next');
    }, this.presetCycleSec * 1000);
  }

  getSensitivity(): number {
    return this.sensitivity;
  }

  setSensitivity(multiplier: number): void {
    this.sensitivity = multiplier;
    try {
      writeJsonAtomicSync(path.join(config.dataDir, 'sensitivity.json'), { multiplier });
    } catch {
      /* non-fatal */
    }
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
    const client = this.clientOf(socket);
    // Which server this client is looking at: its own selection (set by the
    // switcher), else the primary one.
    const selectedId = client?.guildId || this.primaryGuildId || undefined;
    const s = this.sessionFor(selectedId);
    const state = s.queue.getState();
    const snap = s.queue.getSnapshot();
    const queue = { tracks: snap.tracks, currentIndex: snap.currentIndex };
    if (s === this.sessions.primary) {
      this.lastState = state;
      this.lastQueue = queue;
    }
    // Privacy: guests (and anonymous /viz viewers) only ever see the server they
    // are looking at, labelled generically. Key-authed panels — the people the
    // owner handed a /key give link — get the full switcher list.
    const allGuilds =
      this.guildList.length > 0
        ? this.guildList
        : this.sessions
            .all()
            .filter((x) => x.guildId !== '__fallback__')
            .map((x) => ({ id: x.guildId, name: x.guildId }));
    const authed = this.isAuthed(socket);
    const selected =
      allGuilds.find((g) => g.id === selectedId) ?? (selectedId ? { id: selectedId, name: selectedId } : undefined);
    const guildsForClient = authed ? allGuilds : selected ? [{ id: selected.id, name: 'Server' }] : [];
    const ew = s.endlessWave;
    const out: OutboundMessage = {
      type: 'snapshot',
      state,
      queue,
      voice: {
        joined: s.voice.isJoined(),
        channelId: s.voice.getChannelId() ?? undefined,
      },
      theme: this.theme,
      djEnabled: s.guildId ? s.playback.isDjEnabled(s.guildId) : false,
      primaryGuildId: selectedId ?? undefined,
      guilds: guildsForClient.length > 0 ? guildsForClient : undefined,
      sensitivity: this.sensitivity,
      presetCycle: this.presetCycleSec,
      preset:
        this.presetIdx >= 0 && this.presetNames[this.presetIdx]
          ? { name: this.presetNames[this.presetIdx], index: this.presetIdx }
          : undefined,
      guest: config.shareKey ? !authed : undefined,
      endlesswave: ew ? ew.active : undefined,
      endlesswaveMode: ew ? (ew.active ? 'smart' : ew.basic ? 'basic' : 'off') : undefined,
      ambient: s.guildId ? this.perms.getAmbient(s.guildId) : undefined,
      voteSkip: s.guildId ? this.perms.getVoteSkip(s.guildId) : undefined,
      skipForward: s.guildId ? this.perms.getSkipForward(s.guildId) : undefined,
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
      const hasConsumers = this.visualizers.size > 0 || [...this.panels].some((p) => p.subscribedVisuals);
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

  private broadcastPanels(msg: OutboundMessage, guildId?: string): void {
    for (const panel of this.panels) {
      // A panel with no explicit selection mirrors the primary server; a panel
      // that has switched gets only that server's updates.
      if (guildId && (panel.guildId ?? this.primaryGuildId ?? guildId) !== guildId) continue;
      this.sendToSocket(panel.socket, msg);
    }
  }

  /**
   * Who is in the jam. Two sources, both already present:
   *  - connected clients that identify themselves with a real name (the Activity
   *    sends the Discord display name; generic client names are plumbing),
   *  - the names already credited on the queue via `addedBy`.
   * `request`/`panel` are queue origins, not people, so they are dropped.
   */
  private presence(): { names: string[]; count: number; contributors: string[]; joinPath: string; joinUrl?: string } {
    const isPerson = (n: string): boolean => !!n && !/^web-viz-|^vaporzr-/.test(n) && !/^vz-/.test(n);
    /** Queue origins that are plumbing rather than people. */
    const ORIGINS = QUEUE_ORIGINS;
    const people = new Set<string>();
    for (const c of [...this.panels, ...this.visualizers]) {
      if (isPerson(c.name)) people.add(c.name);
      // The Activity reports its whole instance, so one client can name several.
      for (const n of c.roster ?? []) if (isPerson(n)) people.add(n);
    }
    const contributors = new Set<string>();
    for (const t of this.queue.getSnapshot().tracks) {
      const by = (t as { addedBy?: string }).addedBy;
      // Ignore anything credited before the current voice session began.
      const at = (t as { addedAt?: number }).addedAt ?? 0;
      if (by && !ORIGINS.has(by) && at >= this.jamEpoch) contributors.add(by);
    }
    const names = [...people].sort();
    // The low-privilege request key, not the share key: a jam link grants
    // exactly "add a song" and nothing else. `joinUrl` needs a configured
    // public base — a client-derived address only resolves where that address
    // means something (the tunnel's 127.0.0.1 resolves on a phone to the phone
    // itself, which is why the QR "never loaded").
    const { joinPath, joinUrl } = jamJoinLinks();
    return { names, count: names.length, contributors: [...contributors].sort(), joinPath, joinUrl };
  }

  /** Broadcast the jam roster. Called on connect, disconnect and queue change. */
  private broadcastPresence(): void {
    this.broadcast({ type: 'jam:presence', ...this.presence() });
  }

  /** Forget who was in the jam. Called when the bot joins a voice channel: the
   *  client rosters are dropped and the attribution cut-off moves, so the pill
   *  shows this session rather than the last one. Viewers re-announce themselves
   *  (the Activity re-reports its participants every 30s). */
  private resetJamPresence(): void {
    this.jamEpoch = Date.now();
    for (const c of [...this.panels, ...this.visualizers]) c.roster = undefined;
    console.log('[bridge] jam roster reset (joined a voice channel)');
    this.broadcastPresence();
  }

  sendToSocket(socket: WebSocket, msg: OutboundMessage | (InboundMessage & { type: 'cmd' })): void {
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
