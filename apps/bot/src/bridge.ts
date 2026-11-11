import type http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { WebSocket, WebSocketServer } from 'ws';
import {
  emptyState,
  type DeckId,
  type DeckMixerState,
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
import { secretEquals, keyFromCookieHeader, masterPasswordEquals } from './secretCompare.js';
import {
  authThrottle,
  consumeInvite,
  mintInvite,
  noteAuthFailure,
  resolveSession,
  tokenFromCookieHeader,
  type AccessScope,
} from './access.js';
import { fetchLyrics } from '@vaporzr/core/lyrics';
import { playlistStore } from '@vaporzr/core/playlists';
import { getCrossfadeMs, setCrossfadeMs } from './crossfadeStore.js';
import { getJamPolicy, setJamPolicy, type JamPolicy } from './jamPolicy.js';
import { codeFor } from './jamLinks.js';
import { featureAllowed } from './billing.js';
import { mintVideoToken } from './videoToken.js';
import { CrowdVote } from './crowdSkip.js';

/** The jam page's guest URL: built from the LOW-privilege request key, not the
 *  share key — a jam link grants exactly "add a song" and nothing else.
 *  `joinUrl` stays undefined until JAM_PUBLIC_BASE names a reachable public
 *  host: the bot is loopback-bound behind the reverse proxy, so a client-derived
 *  address only resolves on the machine holding the tunnel. */
let jamInviteCache: { token: string; expiresAt: number } | null = null;

export function jamJoinLinks(): {
  joinPath: string;
  joinUrl: string | undefined;
  /** The read-only panel (same request invite, guest socket). */
  crowdPath: string;
  crowdUrl: string | undefined;
} {
  // A posted jam card has to keep working for the whole party, so this is a
  // reusable "request" invite that rotates hourly - expiring and revocable,
  // unlike the static REQUEST_KEY QR code it replaces.
  let joinPath = '/jam';
  let crowdPath = '/crowd';
  if (config.shareKey || config.requestKey) {
    const now = Date.now();
    if (!jamInviteCache || jamInviteCache.expiresAt - now < 60 * 60 * 1000) {
      const minted = mintInvite('request', 'jam card', 6 * 60 * 60 * 1000, now, 0);
      jamInviteCache = { token: minted.token, expiresAt: minted.invite.expiresAt };
    }
    joinPath = `/jam?invite=${encodeURIComponent(jamInviteCache.token)}`;
    // Short-link form when the code store is alive: /j/<code> is ~21 characters
    // instead of ~70, so the QR on the posted card prints far larger — and the
    // /j page itself unfurls a proper invite card wherever the link is pasted.
    const jamCode = codeFor(jamInviteCache.token, jamInviteCache.expiresAt, now);
    if (jamCode) {
      joinPath = `/j/${jamCode}`;
      crowdPath = `/c/${jamCode}`;
    }
  }
  const base = config.jamPublicBase;
  return {
    joinPath,
    joinUrl: base ? base + joinPath : undefined,
    crowdPath,
    crowdUrl: base ? base + crowdPath : undefined,
  };
}

/** One row of the public jam queue. Plain strings — the page is dumb HTML. */
interface JamQueueTrack {
  uri: string;
  name: string;
  artists: string;
  album: string;
  addedBy: string;
  durationMs: number;
  votes: number;
  image?: string;
  /** Source key for the row's colour dot / art fallback glyph. */
  source?: string;
}

/** Queue origins that are plumbing rather than people. The jam roster drops
 *  them, and the public jam page must not credit "panel" as if it were a
 *  person who asked for the song. */
const QUEUE_ORIGINS = new Set(['request', 'panel', 'endless-wave', 'autoplay', 'vibe', 'bulk']);

/** Commands a per-person DJ link may run. Deliberately excludes settings,
 *  visual themes, server switching, recording and access management. */
const DJ_COMMANDS = new Set([
  'play',
  'pause',
  'resume',
  'toggle',
  'next',
  'previous',
  'seek',
  'volume',
  'shuffle',
  'repeat',
  'remove',
  'clear',
  'playAt',
  'queuePlay',
  'move',
  'dedupe',
  'skipto',
  'crossfade',
  'bass',
  'speed',
  'sfx',
]);

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

interface PendingRequest {
  id: string;
  guildId: string;
  query: string;
  who: string;
  createdAt: number;
}

export class Bridge {
  private wss: WebSocketServer;
  /** Requests waiting for host approval, keyed by a short random id. */
  private pendingRequests = new Map<string, PendingRequest>();
  /** Per-guild, per-guest request counters (not persisted; one party). */
  private requestStats = new Map<string, Map<string, { count: number; last: number }>>();
  /** Per-guild track upvotes: uri → set of guest names (one vote each). */
  private trackVotes = new Map<string, Map<string, Set<string>>>();
  /** One crowd skip vote, reset on track change and consumed on success. */
  private readonly crowdSkip = new CrowdVote(() => this.presence().count);
  private panels = new Set<Client>();
  private visualizers = new Set<Client>();
  private lastState: PlaybackState = emptyState();
  /** Track uri → official video id, mirrored into every state broadcast. */
  private trackVideo: { uri: string | null; id: string | null; official: boolean } = {
    uri: null,
    id: null,
    official: false,
  };
  private lastQueue: QueueSnapshot = { tracks: [], currentIndex: -1 };
  private theme: VaporzrTheme = DEFAULT_THEME;
  private sensitivity = 1.0;
  /** Seconds each visual preset dwells before auto-advancing (panel-controlled). */
  private presetCycleSec = 45;
  /** Cached control invite behind `deckLink()` (rotates monthly). */
  private deckInvite: { token: string; expiresAt: number } | null = null;
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
  /**
   * Live-deck control. The bridge owns the socket and the guild context; the
   * Discord layer owns the mixer (per guild, next to the queue), so deck
   * messages are forwarded rather than handled here.
   */
  onDeckAction:
    | ((
        guildId: string | undefined,
        msg: (InboundMessage & { type: 'deck:load' }) | (InboundMessage & { type: 'deck:control' }),
      ) => void)
    | null = null;
  /** Current deck state for a guild, or null when that guild has no decks. */
  deckStateProvider: ((guildId?: string) => DeckMixerState | null) | null = null;
  /**
   * HTTP uploads from the deck page: a one-shot for the sample bank, and an
   * audio file dropped straight onto a deck. Both live here because the bot
   * owns the mixers while the HTTP server only sees the bridge.
   */
  onSampleUpload:
    ((name: string, data: Buffer) => Promise<{ ok: boolean; message?: string; samples?: string[] }>) | null = null;
  /** Sample library + saved layouts, for the deck page's library panel. */
  onSampleBank:
    | ((
        action: 'list' | 'save' | 'apply' | 'delete' | 'reset' | 'fill',
        name?: string,
      ) => {
        ok: boolean;
        library?: Array<{ file: string; name: string; category: string }>;
        pads?: Array<string | null>;
        setups?: string[];
        message?: string;
      })
    | null = null;
  onDeckFileUpload:
    | ((
        guildId: string | undefined,
        deck: DeckId,
        file: string,
        name: string,
      ) => Promise<{ ok: boolean; message?: string }>)
    | null = null;
  /**
   * Song search for the type-ahead used by the deck page, panel, request page
   * and the Discord Activity. The bot owns the Spotify/YouTube credentials.
   */
  onSearch:
    | ((
        query: string,
        limit: number,
      ) => Promise<
        Array<{
          title: string;
          artist: string;
          durationMs: number;
          source: string;
          uri: string;
        }>
      >)
    | null = null;
  /** Per-socket auth state: true = key holder (full control), false = guest (view-only). */
  /** Per-socket credential level: control (panel), view (watch/listen) or guest (Activity). */
  private socketScope = new Map<WebSocket, AccessScope | 'guest'>();
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
      // Cross-site WebSocket hijacking guard: browsers always send Origin on
      // the upgrade. A mismatch means some other page is opening sockets with
      // the visitor's cookies, so refuse before any data is sent.
      const origin = req.headers.origin;
      if (origin) {
        const fileOrigin = /^file:\/\//i.test(origin);
        if (fileOrigin) {
          // The desktop Electron visualizer loads from file:// and authenticates
          // via ?key=. Strip any ambient cookie header so a local file can never
          // ride a browser session.
          delete req.headers.cookie;
        }
        let originHost = '';
        try {
          originHost = new URL(origin).host;
        } catch {
          originHost = '';
        }
        const hostname = originHost.split(':')[0] ?? '';
        // Same origin, a Discord surface that hosts the Activity iframe, or the
        // local Electron visualizer (file://). A Discord origin is still only a
        // guest socket (no cookie), so it can receive bars but never PCM or commands.
        const sameSite = originHost === (req.headers.host ?? '');
        const discordSurface = /^(discord\.com|([a-z0-9-]+\.)*discordsays\.com|([a-z0-9-]+\.)*discordapp\.com)$/i.test(
          hostname,
        );
        if (!sameSite && !discordSurface && !fileOrigin) {
          socket.close(1008, 'origin');
          return;
        }
      }

      const scope = this.scopeForUpgrade(req);
      this.socketScope.set(socket, scope);
      if (scope === 'guest') {
        // Guests (e.g. the Discord Activity, which cannot carry a cookie) get
        // visuals only: no PCM, no commands. Say so so the UI can adapt.
        try {
          socket.send(
            JSON.stringify({
              type: 'panel:notice',
              level: 'error',
              notice: 'guest',
              auth: false,
              text: 'View-only: no session on this socket. Open a /key give link to control playback.',
            }),
          );
        } catch {
          /* socket already gone */
        }
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

  /** YouTube ids the bot will download a picture for right now.
   *
   *  `/api/video/<id>` must stay credential-free (the Discord Activity iframe
   *  cannot carry a cookie), so the id has to be constrained instead: only what
   *  is playing — or just played — may start a download. Without this the
   *  endpoint was an open yt-dlp trigger on metered proxy traffic.
   */
  videoAllowList(): Set<string> {
    const ids = new Set<string>();
    for (const s of this.sessions.all()) {
      const id = s.playback.currentYoutubeId();
      if (id) ids.add(id);
    }
    return ids;
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
      const hasViewer = [...this.visualizers].some((v) => this.scopeOf(v.socket) !== 'guest');
      const hasPcmPanels = [...this.panels].some((p) => p.subscribedPcm && this.scopeOf(p.socket) !== 'guest');
      if (!hasViewer && !hasPcmPanels) return; // nobody authorised — skip base64 work entirely
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
        const enriched = this.withVideo(state);
        this.broadcastPanels({ type: 'state:update', state: enriched, guildId: gid }, gid);
        this.pushLyrics(gid, state);
        if (gid === this.sessions.guildId) this.broadcastVisualizers({ type: 'state:update', state: enriched });
      };
      q.subscribe({ onQueueChanged, onStateChanged });
      s.voice.setOnVoiceChange((joined, channelId) => {
        this.broadcastPanels({ type: 'voice:update', joined, channelId: channelId ?? undefined }, gid);
        // Joining starts a fresh jam. The roster belongs to the session, and the
        // pill was carrying names over from the previous one.
        if (gid === this.sessions.guildId && joined) this.resetJamPresence();
      });
      // A channel we cannot raise caps what every listener hears. Say it in the
      // panel once per join, with the number that fixes it, instead of leaving
      // someone to wonder why the bot sounds worse in this server.
      s.voice.setOnQualityWarning((q) => {
        this.notice(
          'info',
          `This voice channel is ${q.channelKbps} kbps but the server allows ${q.ceilingKbps} kbps. ` +
            'Give Vaporzr "Manage Channels", or raise the channel bitrate in its settings, to hear it properly.',
        );
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
    this.socketScope.delete(socket);
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
        const guest = this.scopeOf(socket) === 'guest';
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

  private scopeOf(socket: WebSocket): AccessScope | 'guest' {
    return this.socketScope.get(socket) ?? 'control';
  }

  /** True when this socket has the full control scope (decks, settings, keys). */
  private isAuthed(socket: WebSocket): boolean {
    return this.scopeOf(socket) === 'control';
  }

  /** Playback commands: control gets everything, a DJ link gets the allowlist. */
  private mayRunCommand(socket: WebSocket, command: (InboundMessage & { type: 'cmd' })['command']): boolean {
    const scope = this.scopeOf(socket);
    if (scope === 'control') return true;
    if (scope === 'dj') return DJ_COMMANDS.has(command);
    return false;
  }

  /**
   * Resolve the credential for a new socket. Priority: session cookie, legacy
   * raw-key cookie, ?key= master key, ?invite= (or ?key= invite code), guest.
   * A guest never receives PCM - the raw audio is the whole point of /listen.
   */
  private scopeForUpgrade(req: http.IncomingMessage): AccessScope | 'guest' {
    if (!config.shareKey && !config.masterPassword) return 'control';
    const ip = req.socket.remoteAddress ?? 'unknown';
    const sess = resolveSession(tokenFromCookieHeader(req.headers.cookie));
    if (sess) return sess.scope === 'request' ? 'guest' : sess.scope;
    const cookieKey = keyFromCookieHeader(req.headers.cookie);
    if (
      (config.shareKey && secretEquals(cookieKey, config.shareKey)) ||
      masterPasswordEquals(cookieKey, config.masterPassword)
    ) {
      return 'control';
    }
    let qKey: string | null = null;
    let qInvite: string | null = null;
    try {
      const url = new URL(req.url ?? '/ws', 'http://localhost');
      qKey = url.searchParams.get('key');
      qInvite = url.searchParams.get('invite');
    } catch {
      /* malformed query: treat as keyless */
    }
    if (
      qKey &&
      ((config.shareKey && secretEquals(qKey, config.shareKey)) || masterPasswordEquals(qKey, config.masterPassword))
    ) {
      return 'control';
    }
    const inviteToken =
      qInvite ??
      (qKey &&
      !(config.shareKey && secretEquals(qKey, config.shareKey)) &&
      !masterPasswordEquals(qKey, config.masterPassword)
        ? qKey
        : null);
    if (!inviteToken) return 'guest';
    if (!authThrottle(ip).allowed) return 'guest';
    const used = consumeInvite(inviteToken);
    if (used) return used.session.scope === 'request' ? 'guest' : used.session.scope;
    noteAuthFailure(ip);
    return 'guest';
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
        if (!this.mayRunCommand(socket, msg.command) && !this.guestMaySend(msg)) return;
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
        if (!this.mayRunCommand(socket, msg.command) && !this.guestMaySend(msg)) return;
        if (!this.allowCommand(socket)) return;
        this.handlePanelCommand(socket, msg, this.clientGuildId(socket));
        break;
      case 'state:request':
        this.sendSnapshot(socket);
        break;
      case 'skipvote': {
        // A jam guest asks to skip. The host and DJ links skip outright; a guest
        // needs a majority of the room (the CrowdVote handles dedup and reset).
        const isHost = this.scopeOf(socket) !== 'guest';
        const client = this.clientOf(socket);
        const result = this.voteToSkip(client?.name, isHost);
        if (result.ok) {
          this.broadcast({
            type: 'jam:skipvote',
            votes: result.votes,
            needed: result.needed,
            guildId: client?.guildId,
          });
        }
        break;
      }
      case 'deck:load':
      case 'deck:control':
        // Decks change what the whole channel hears — control scope only, and
        // never a guest/Activity socket.
        if (!this.isAuthed(socket)) {
          this.notice('error', 'Live decks need the control key.');
          return;
        }
        if (!this.allowCommand(socket)) return;
        this.onDeckAction?.(this.clientGuildId(socket), msg);
        break;
      case 'deck:request': {
        const state = this.deckStateProvider?.(this.clientGuildId(socket));
        if (state) this.sendToSocket(socket, { type: 'deck:state', state });
        break;
      }
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
      case 'shoutout': {
        const text = String(msg.query ?? '')
          .replace(/[\u0000-\u001f\u007f]/g, '')
          .trim()
          .slice(0, 200);
        if (!text) break;
        if (!this.onShoutout) {
          this.notice('error', 'Shoutouts are not available on this instance.');
          break;
        }
        void this.onShoutout(guildId, text)
          .then((r) =>
            this.notice(r.ok ? 'success' : 'error', r.ok ? '📣 Shoutout posted' : (r.error ?? 'Could not post')),
          )
          .catch(() => this.notice('error', 'Could not post that shoutout'));
        break;
      }
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
      case 'crossfade': {
        // Same persisted store as V@crossfade; the panel toggle is just a
        // shortcut. 0 = off, otherwise overlap + tail fade in ms.
        if (msg.ms != null && s.guildId) {
          const ms = setCrossfadeMs(s.guildId, Number(msg.ms));
          this.notice('success', ms > 0 ? `Crossfade ${ms / 1000}s` : 'Crossfade off');
          for (const panel of this.panels)
            if (this.clientOf(panel.socket)?.guildId === s.guildId) this.sendSnapshot(panel.socket);
        }
        break;
      }
      case 'shuffle':
        if (msg.shuffle != null) s.playback.shuffle(msg.shuffle);
        break;
      case 'repeat':
        if (msg.repeat != null) s.playback.setRepeat(msg.repeat);
        break;
      case 'clear': {
        // Keep the current track playing; only the upcoming list is dropped.
        const removed = s.queue.clearUpcoming();
        this.notice(
          'info',
          removed > 0 ? `Cleared ${removed} upcoming track${removed === 1 ? '' : 's'}` : 'Nothing queued ahead',
        );
        break;
      }
      case 'remember': {
        if (msg.index == null) break;
        const t = s.queue.getSnapshot().tracks[msg.index];
        const gid = s.guildId;
        if (!t || !gid) break;
        const name = 'Remembered';
        const existing = playlistStore.get(gid, name);
        const tracks = existing ? existing.tracks.slice() : [];
        if (tracks.some((x) => x.uri === t.uri)) {
          this.notice('info', `Already in "Remembered": ${t.name}`);
          break;
        }
        tracks.push({
          uri: t.uri,
          name: t.name,
          artists: t.artists ?? [],
          album: t.album ?? '',
          durationMs: t.durationMs ?? 0,
          source: t.source ?? '',
          image: (t as { image?: string }).image,
        });
        const res = playlistStore.save(gid, name, tracks);
        this.notice(
          res.ok ? 'success' : 'error',
          res.ok
            ? `Remembered: ${t.name} · in the "Remembered" playlist`
            : (res.error ?? 'Could not remember that track'),
        );
        break;
      }
      case 'remove':
        if (msg.index != null) s.removeFromQueue(msg.index);
        break;
      case 'playAt':
        if (msg.index != null) {
          const at = msg.index;
          void (async () => {
            if (!(await this.ensureVoice(guildId))) return;
            s.playback.playAt(at);
          })();
        }
        break;
      case 'queuePlay': {
        // V@qa "play": jump to this track and drop everything queued before it.
        if (msg.index != null) {
          const at = msg.index;
          void (async () => {
            if (!(await this.ensureVoice(guildId))) return;
            if (s.queue.getSnapshot().tracks[at]) {
              s.queue.removeUpTo(at);
              s.playback.next();
            }
          })();
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
            // Themes are a paid feature. With billing disabled featureAllowed()
            // always says yes, so a deployment that never sold a plan is
            // unchanged; with it on, a free guild gets one clear refusal rather
            // than a silent no-op.
            const guildId = this.getPrimaryGuildId();
            if (guildId && !featureAllowed(guildId, 'themes')) {
              this.notice('error', 'Themes are part of Vaporzr Plus — run /upgrade in Discord to unlock them.');
              break;
            }
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
        if (res.ok) playlistStore.setCrossfade(s.guildId, name, getCrossfadeMs(s.guildId));
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
        // A vibe can carry its own mix setting; apply it when the set loads.
        if (pl.crossfadeMs != null && s.guildId) setCrossfadeMs(s.guildId, pl.crossfadeMs);
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

  private statsFor(guildId: string, guest: string): { count: number; last: number } {
    // Unit tests construct a prototype-level fake, so tolerate an uninitialised
    // field just like the real constructor would have set.
    if (!this.requestStats) this.requestStats = new Map();
    let byGuest = this.requestStats.get(guildId);
    if (!byGuest) {
      byGuest = new Map();
      this.requestStats.set(guildId, byGuest);
    }
    return byGuest.get(guest) ?? { count: 0, last: 0 };
  }

  private bumpRequestStat(guildId: string, guest: string): void {
    const stat = this.statsFor(guildId, guest);
    stat.count += 1;
    stat.last = Date.now();
    this.requestStats.get(guildId)?.set(guest, stat);
  }

  /** Host-side jam policy and pending approvals. */
  jamPolicy(guildId: string | undefined): JamPolicy {
    return getJamPolicy(guildId);
  }

  setJamPolicy(guildId: string | undefined, patch: Partial<JamPolicy>): JamPolicy | null {
    if (!guildId) return null;
    const next = setJamPolicy(guildId, patch);
    if (patch.mute !== undefined) {
      // Unmuting should clear the per-session counter too, so a guest who was
      // muted for spam gets a clean slate.
      const muted = new Set(next.mute.map((n) => n.toLowerCase()));
      const byGuest = this.requestStats.get(guildId);
      if (byGuest) for (const key of byGuest.keys()) if (!muted.has(key)) byGuest.delete(key);
    }
    return next;
  }

  private votesFor(guildId: string, uri: string): number {
    if (!this.trackVotes) this.trackVotes = new Map();
    return this.trackVotes.get(guildId)?.get(uri)?.size ?? 0;
  }

  /**
   * A crowd "skip" vote. The host and DJ links skip outright; a guest needs a
   * majority of the room (floored at two), keyed like the upvotes and reset when
   * the track changes. Returns the live tally for the progress broadcast.
   */
  voteToSkip(who?: string, isHost = false): { ok: boolean; votes: number; needed: number; skipped: boolean } {
    const s = this.sessions.primary ?? this.fallback;
    const gid = s.guildId ?? '';
    if (!gid) return { ok: false, votes: 0, needed: 0, skipped: false };
    if (isHost) {
      s.playback.next();
      return { ok: true, votes: 1, needed: 1, skipped: true };
    }
    const track = s.queue.getCurrentTrack();
    if (!track) return { ok: false, votes: 0, needed: 0, skipped: false };
    const result = this.crowdSkip.vote(who ?? 'guest', track.uri);
    if (result.skipped) {
      s.playback.next();
      this.notice('info', `Skipped by crowd vote (${result.votes}/${result.needed}).`);
    }
    return { ok: true, votes: result.votes, needed: result.needed, skipped: result.skipped };
  }

  /** Upvote a queued track. Three distinct guests move it to play next. */
  voteTrack(uri: string, who?: string): { ok: boolean; votes: number; promoted: boolean; error?: string } {
    const s = this.sessions.primary ?? this.fallback;
    const gid = s.guildId ?? '';
    if (!gid || !uri) return { ok: false, votes: 0, promoted: false, error: 'Nothing to vote for.' };
    const voter =
      (who ?? '')
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .trim()
        .slice(0, 24)
        .toLowerCase() || 'guest';
    if (!this.trackVotes) this.trackVotes = new Map();
    let byUri = this.trackVotes.get(gid);
    if (!byUri) {
      byUri = new Map();
      this.trackVotes.set(gid, byUri);
    }
    let voters = byUri.get(uri);
    if (!voters) {
      voters = new Set();
      byUri.set(uri, voters);
    }
    voters.add(voter);
    const votes = voters.size;
    let promoted = false;
    if (votes >= 3) {
      const snap = s.queue.getSnapshot();
      const from = snap.tracks.findIndex((t) => t.uri === uri);
      const cur = snap.currentIndex;
      const to = cur >= 0 ? cur + 1 : 0;
      if (from >= 0 && from !== to && from !== cur) {
        promoted = s.queue.move(from, to);
        if (promoted) voters.clear(); // a promotion consumes the votes
      }
    }
    return { ok: true, votes: promoted ? 0 : votes, promoted };
  }

  /** Who has asked for the most this session (owner-side leaderboard/audit). */
  jamGuests(guildId: string | undefined): { name: string; count: number }[] {
    if (!guildId) return [];
    const byGuest = this.requestStats.get(guildId);
    if (!byGuest) return [];
    return [...byGuest.entries()]
      .filter(([, v]) => v.count > 0)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 12)
      .map(([name, v]) => ({ name, count: v.count }));
  }

  jamPending(guildId: string | undefined): PendingRequest[] {
    const now = Date.now();
    for (const [id, p] of this.pendingRequests) if (now - p.createdAt > 30 * 60 * 1000) this.pendingRequests.delete(id);
    return [...this.pendingRequests.values()]
      .filter((p) => !guildId || p.guildId === guildId)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  async approveJamRequest(id: string): Promise<{ ok: boolean; name?: string; error?: string }> {
    const p = this.pendingRequests.get(id);
    if (!p) return { ok: false, error: 'That request expired.' };
    this.pendingRequests.delete(id);
    return this.requestTrack(p.query, p.who, true);
  }

  denyJamRequest(id: string): boolean {
    return this.pendingRequests.delete(id);
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

  /** Wired by the bot at startup: post a short host announcement in the
   *  panel's text channel. */
  onShoutout: ((guildId: string | undefined, text: string) => Promise<{ ok: boolean; error?: string }>) | null = null;

  /** Used by the public /request page: resolve a query and queue it (no playback).
   *  `who` is the guest's display name, so a jam credit reads as a person rather
   *  than the `request` origin. Untrusted input: length-capped and stripped of
   *  control characters. Every renderer draws it as text (textContent / canvas),
   *  never as HTML. */
  async requestTrack(
    query: string,
    who?: string,
    bypassApproval = false,
  ): Promise<{ ok: boolean; name?: string; error?: string; pending?: boolean }> {
    const q = query.trim();
    if (!q) return { ok: false, error: 'Type a song to request.' };
    const credit =
      (who ?? '')
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .trim()
        .slice(0, 24) || 'request';
    const session = this.sessions.primary ?? this.fallback;
    const gid = session.guildId ?? '';
    const policy = getJamPolicy(gid);
    const guestKey = credit.toLowerCase();
    if (!bypassApproval) {
      if (policy.locked) return { ok: false, error: 'Requests are locked by the host right now.' };
      if (policy.mute.some((n) => n.toLowerCase() === guestKey))
        return { ok: false, error: 'The host muted your requests for this session.' };
      const stat = this.statsFor(gid, guestKey);
      if (policy.cooldownSec > 0 && stat.last > 0 && Date.now() - stat.last < policy.cooldownSec * 1000) {
        const wait = Math.ceil((policy.cooldownSec * 1000 - (Date.now() - stat.last)) / 1000);
        return { ok: false, error: `One request every ${policy.cooldownSec}s — try again in ${wait}s.` };
      }
      if (policy.maxPerGuest > 0 && stat.count >= policy.maxPerGuest) {
        return { ok: false, error: `You have reached the ${policy.maxPerGuest}-request limit for this session.` };
      }
      if (policy.approval) {
        const id = crypto.randomUUID();
        this.pendingRequests.set(id, { id, guildId: gid, query: q, who: credit, createdAt: Date.now() });
        return { ok: true, pending: true, name: 'Sent to the host for approval.' };
      }
    }
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
      const s = session;
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
      this.bumpRequestStat(gid, guestKey);
      const extra = tracks.length - capped.length;
      const name =
        fresh.length === 1
          ? fresh[0].name
          : `${fresh.length} tracks${extra > 0 ? ` (+${extra} more not queued)` : ''}` +
            (skipped > 0 ? ` · ${skipped} already queued` : '');
      return { ok: true, name };
    } catch (err) {
      // This message is returned to the public jam page, so it must not carry
      // the exception text — resolver failures quote upstream URLs and paths
      // (CodeQL js/stack-trace-exposure). Log it, answer generically.
      console.error('[bridge] request resolve failed:', err);
      return { ok: false, error: 'Could not resolve that request — try a different link or search.' };
    }
  }

  /** Saved vibes for the public jam page: names and track counts only. */
  jamVibes(): { name: string; tracks: number }[] {
    const s = this.sessions.primary ?? this.fallback;
    if (!s.guildId) return [];
    return playlistStore.list(s.guildId).map((p) => ({ name: p.name, tracks: p.tracks.length }));
  }

  /** Read-only preview of one vibe, so a shared /jam?vibe= link can show what
   *  it contains before a guest requests the whole thing. */
  jamVibe(name: string): { ok: boolean; name?: string; tracks?: { name: string; artists: string }[]; error?: string } {
    const s = this.sessions.primary ?? this.fallback;
    if (!s.guildId) return { ok: false, error: 'No active server.' };
    const vibe = playlistStore.get(s.guildId, name.trim());
    if (!vibe) return { ok: false, error: 'That vibe no longer exists.' };
    return {
      ok: true,
      name: vibe.name,
      tracks: vibe.tracks.slice(0, 25).map((t) => ({
        name: t.name,
        artists: (t.artists ?? []).join(', '),
      })),
    };
  }

  /** Add a saved vibe to the queue on behalf of a guest. This is the request
   *  path, not the control path: one bulk add, capped and deduped exactly like
   *  a pasted playlist link. */
  async requestVibe(name: string, who?: string): Promise<{ ok: boolean; name?: string; error?: string }> {
    const s = this.sessions.primary ?? this.fallback;
    if (!s.guildId) return { ok: false, error: 'No active server.' };
    const vibe = playlistStore.get(s.guildId, name.trim());
    if (!vibe || !vibe.tracks.length) return { ok: false, error: 'That vibe no longer exists.' };
    const credit =
      (who ?? '')
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .trim()
        .slice(0, 24) || 'request';
    const policy = getJamPolicy(s.guildId);
    const guestKey = credit.toLowerCase();
    if (policy.locked) return { ok: false, error: 'Requests are locked by the host right now.' };
    if (policy.mute.some((n) => n.toLowerCase() === guestKey))
      return { ok: false, error: 'The host muted your requests for this session.' };
    const stat = this.statsFor(s.guildId, guestKey);
    if (policy.cooldownSec > 0 && stat.last > 0 && Date.now() - stat.last < policy.cooldownSec * 1000)
      return { ok: false, error: `One request every ${policy.cooldownSec}s.` };
    if (policy.maxPerGuest > 0 && stat.count >= policy.maxPerGuest)
      return { ok: false, error: `You have reached the ${policy.maxPerGuest}-request limit for this session.` };
    const tracks = vibe.tracks.slice(0, 25).map((t) => ({
      uri: t.uri,
      name: t.name,
      artists: t.artists ?? [],
      album: t.album ?? '',
      durationMs: t.durationMs ?? 0,
      source: (t.source || undefined) as MediaSource | undefined,
      image: t.image,
    }));
    const fresh = s.queue.filterNew(tracks);
    if (!fresh.length) return { ok: false, error: 'That whole vibe is already queued.' };
    s.queue.enqueueMany(fresh, credit);
    this.bumpRequestStat(s.guildId, guestKey);
    return {
      ok: true,
      name: `${fresh.length} track${fresh.length === 1 ? '' : 's'} from "${vibe.name}"`,
    };
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
    const voteGid = this.sessions?.primary?.guildId ?? this.fallback?.guildId ?? '';
    const map = (t: {
      uri?: string;
      name?: string;
      artists?: string[];
      album?: string;
      addedBy?: string;
      durationMs?: number;
      image?: string;
      source?: string;
    }): JamQueueTrack => ({
      uri: t.uri ?? '',
      name: t.name || 'Unknown',
      artists: (t.artists ?? []).join(', '),
      album: t.album || '',
      addedBy: t.addedBy && !QUEUE_ORIGINS.has(t.addedBy) ? t.addedBy : '',
      durationMs: t.durationMs ?? 0,
      votes: t.uri ? this.votesFor(voteGid, t.uri) : 0,
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

  /**
   * Remember the official video for the current track and push it out at once —
   * the lookup lands a beat after the state broadcast, so without this the
   * visualizer would only pick the video up on the next track.
   */
  setTrackVideo(uri: string, id: string | null, official = false): void {
    if (!uri) return;
    this.trackVideo = { uri, id: id || null, official: official && !!id };
    if (this.lastState.track?.uri !== uri) return;
    const enriched = this.withVideo(this.lastState);
    this.broadcastVisualizers({ type: 'state:update', state: enriched });
    const gid = this.sessions.guildId;
    if (gid) this.broadcastPanels({ type: 'state:update', state: enriched, guildId: gid }, gid);
  }

  /** Attach the video id when the state is describing the cached track. */
  private withVideo(state: PlaybackState): PlaybackState {
    const same = !!state.track?.uri && this.trackVideo.uri === state.track.uri;
    const id = same ? this.trackVideo.id : null;
    if (!id) return state;
    return {
      ...state,
      videoId: id,
      videoOfficial: same ? this.trackVideo.official : false,
      // A grant the media route can check without a cookie (the Activity iframe
      // has none). Null when no secret is configured, so the field is simply
      // absent and the server falls back to its current-track allowlist.
      videoToken: mintVideoToken(id) ?? undefined,
    };
  }

  /** Push live-deck state to every control surface (panels filter by guild). */
  broadcastDeck(state: DeckMixerState, guildId?: string): void {
    const msg = { type: 'deck:state' as const, state, guildId };
    this.broadcastPanels(msg);
    // Visualizers draw an "on air" strip from the same payload, so the desktop
    // player shows the decks instead of the idle queue.
    this.broadcastVisualizers(msg);
  }

  /** Push a freshly decoded waveform to the deck page. */
  broadcastDeckWaveform(guildId: string, deck: DeckId, peaks: number[], durationMs: number): void {
    this.broadcastPanels({ type: 'deck:waveform', deck, peaks, durationMs, guildId });
  }

  /**
   * Shareable deck link for surfaces that have no session cookie (the desktop
   * app opens it in the system browser, and `V@deck` posts it into chat). The
   * token is a long-lived, multi-use *control invite*, not the master key — so a
   * leaked link stops working when it rotates instead of exposing the key.
   */
  deckLink(): string {
    const base = config.staticBaseUrl ? config.staticBaseUrl.replace(/\/+$/, '') : '';
    if (!config.shareKey && !config.masterPassword) return `${base}/deck`;
    const now = Date.now();
    if (!this.deckInvite || this.deckInvite.expiresAt - now < 24 * 60 * 60 * 1000) {
      const minted = mintInvite('control', 'deck link', 30 * 24 * 60 * 60 * 1000, now, 0);
      this.deckInvite = { token: minted.token, expiresAt: minted.invite.expiresAt };
    }
    return `${base}/deck?invite=${encodeURIComponent(this.deckInvite.token)}`;
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
    // Any manual change restarts the dwell clock: without this, switching a
    // visual 2 s before the interval fires immediately advances again, which
    // reads as "the timer setting is ignored".
    this.startPresetTimer();
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

  /** Last track per guild whose lyrics were sent, and guilds with a lookup in flight. */
  private lyricsSent = new Map<string, string>();
  private lyricsBusy = new Set<string>();

  /**
   * Push synced/plain lyrics to the panels of one guild whenever the track
   * changes. LRCLIB is keyless and the lookup caches for 30 minutes, so this is
   * cheap; failures still send an empty result so the card can say "none found"
   * instead of silently keeping the previous song's words on screen.
   */
  private pushLyrics(gid: string, state: PlaybackState): void {
    const track = state.track;
    const stamp = track ? track.uri : '';
    if ((this.lyricsSent.get(gid) ?? '<init>') === stamp) return;
    this.lyricsSent.set(gid, stamp);
    if (!track) {
      this.broadcastPanels({ type: 'lyrics', guildId: gid, title: '', artist: '', lines: [] }, gid);
      return;
    }
    if (this.lyricsBusy.has(gid)) return;
    this.lyricsBusy.add(gid);
    const title = track.name;
    const artist = (track.artists ?? []).join(', ');
    void (async () => {
      try {
        const r = await fetchLyrics({
          name: track.name,
          artists: track.artists ?? [],
          album: track.album ?? '',
          durationMs: track.durationMs ?? 0,
        });
        const lines = r?.syncedLines ?? [];
        this.broadcastPanels(
          {
            type: 'lyrics',
            guildId: gid,
            title,
            artist,
            lines,
            plain: lines.length === 0 ? (r?.lyrics ?? '') : undefined,
          },
          gid,
        );
      } catch {
        this.broadcastPanels({ type: 'lyrics', guildId: gid, title, artist, lines: [] }, gid);
      } finally {
        this.lyricsBusy.delete(gid);
      }
    })();
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
    const guestSocket = this.scopeOf(socket) === 'guest';
    const selected =
      allGuilds.find((g) => g.id === selectedId) ?? (selectedId ? { id: selectedId, name: selectedId } : undefined);
    // Guests never receive the server list at all: a crowd panel is for one
    // room, and the names of the operator's other servers are not its business.
    // DJ links are also locked to the room they were created for.
    const noSwitcher = guestSocket || this.scopeOf(socket) === 'dj';
    const guildsForClient = noSwitcher ? [] : allGuilds;
    const ew = s.endlessWave;
    const out: OutboundMessage = {
      type: 'snapshot',
      state: this.withVideo(state),
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
      crossfadeMs: s.guildId ? getCrossfadeMs(s.guildId) : 0,
      presetCycle: this.presetCycleSec,
      deckUrl: this.deckLink(),
      preset:
        this.presetIdx >= 0 && this.presetNames[this.presetIdx]
          ? { name: this.presetNames[this.presetIdx], index: this.presetIdx }
          : undefined,
      guest: guestSocket || undefined,
      scope: guestSocket ? 'guest' : (this.scopeOf(socket) as 'control' | 'view' | 'dj'),
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
    const msg: OutboundMessage = { type: 'audio:pcm', guildId, data, ts: Date.now() };
    for (const vis of this.visualizers) {
      if (this.scopeOf(vis.socket) === 'guest') continue; // guests: bars only, never audio
      if (!vis.guildId || vis.guildId === guildId) {
        this.sendToSocket(vis.socket, msg);
      }
    }
    for (const panel of this.panels) {
      if (this.scopeOf(panel.socket) === 'guest') continue;
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
  private presence(): {
    names: string[];
    count: number;
    contributors: string[];
    joinPath: string;
    joinUrl?: string;
    crowdPath: string;
    crowdUrl?: string;
  } {
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
    const { joinPath, joinUrl, crowdPath, crowdUrl } = jamJoinLinks();
    return {
      names,
      count: names.length,
      contributors: [...contributors].sort(),
      joinPath,
      joinUrl,
      crowdPath,
      crowdUrl,
    };
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
