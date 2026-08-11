import type { PlaybackState, InboundMessage } from '@vaporzr/shared';
import { WsClient } from './wsClient';

declare global {
  interface Window {
    onSpotifyWebPlaybackSDKReady: () => void;
    Spotify: {
      Player: new (opts: {
        name: string;
        getOAuthToken: (cb: (token: string) => void) => void;
        volume?: number;
      }) => SpotifyPlayer;
    };
  }
}

interface SpotifyPlayer {
  connect: () => Promise<boolean>;
  disconnect: () => Promise<void>;
  addListener: (ev: 'ready' | 'not_ready' | 'player_state_changed' | 'initialization_error', cb: (arg: unknown) => void) => void;
  getCurrentState: () => Promise<SpotifyState | null>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  next: () => Promise<void>;
  previous: () => Promise<void>;
  seek: (pos: number) => Promise<void>;
  setVolume: (vol: number) => Promise<void>;
}

interface SpotifyTrack {
  uri: string;
  id: string;
  name: string;
  artists: { name: string }[];
  album: { name: string; images?: { url: string }[] };
  duration_ms: number;
}

interface SpotifyState {
  paused: boolean;
  position_ms: number;
  duration_ms: number;
  shuffle: boolean;
  repeat_mode: number;
  track_window: { current_track: SpotifyTrack };
}

const port = Number(new URLSearchParams(window.location.search).get('port') ?? '4876');
const botUrl = `http://127.0.0.1:${port}`;

let token: string | null = null;
let deviceId: string | null = null;
let deviceName = 'Vaporzr Player';
let player: SpotifyPlayer | null = null;
let volume = 1;

let client: WsClient | null = null;

function log(...args: unknown[]): void {
  console.log('[vaporzr-player]', ...args);
}

async function getToken(): Promise<string> {
  if (token) return token;
  const res = await fetch(`${botUrl}/api/token`);
  if (!res.ok) throw new Error(`token endpoint returned ${res.status}`);
  const data = (await res.json()) as { token: string };
  token = data.token;
  return token;
}

async function spotifyApi<T>(path: string, method: string, body?: unknown): Promise<T> {
  const tok = await getToken();
  const res = await fetch(`https://api.spotify.com/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Spotify API ${method} ${path} -> ${res.status}`);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

function stateToPlayback(s: SpotifyState): PlaybackState {
  const t = s.track_window.current_track;
  return {
    deviceId: deviceId ?? undefined,
    deviceName,
    playing: !s.paused,
    track: t
      ? {
          uri: t.uri,
          name: t.name,
          artists: t.artists.map((a) => a.name),
          album: t.album.name,
          durationMs: t.duration_ms,
          image: t.album.images?.[0]?.url,
          addedBy: '',
          addedAt: 0,
        }
      : undefined,
    positionMs: s.position_ms,
    durationMs: s.duration_ms,
    volume: Math.round(volume * 100),
    shuffle: s.shuffle,
    repeat: s.repeat_mode !== 0,
    updatedAt: Date.now(),
  };
}

function reportState(): void {
  if (!player) return;
  void player.getCurrentState().then((s) => {
    if (s && client) client.send({ type: 'player:state', state: stateToPlayback(s) });
  });
}

function handleCommand(msg: InboundMessage & { type: 'cmd' }): void {
  if (!player) return;
  switch (msg.command) {
    case 'play':
      if (msg.uris && msg.uris.length > 0) {
        void spotifyApi(`/me/player/play?device_id=${encodeURIComponent(deviceId ?? '')}`, 'PUT', { uris: msg.uris }).then(reportState);
      } else {
        void player.resume().then(reportState);
      }
      break;
    case 'pause':
      void player.pause().then(reportState);
      break;
    case 'resume':
      void player.resume().then(reportState);
      break;
    case 'next':
      void player.next().then(reportState);
      break;
    case 'previous':
      void player.previous().then(reportState);
      break;
    case 'seek':
      if (msg.positionMs != null) void player.seek(msg.positionMs).then(reportState);
      break;
    case 'volume':
      if (msg.volume != null) {
        volume = msg.volume / 100;
        void player.setVolume(volume);
      }
      break;
    case 'shuffle':
      if (msg.shuffle != null) {
        void spotifyApi('/me/player/shuffle', 'PUT', { state: msg.shuffle });
      }
      break;
    case 'toggle':
      void player.getCurrentState().then((s) => (s?.paused ? player?.resume() : player?.pause())).then(reportState);
      break;
  }
}

function initPlayer(): void {
  void getToken()
    .then((tok) => {
      player = new window.Spotify.Player({
        name: deviceName,
        getOAuthToken: (cb) => cb(tok),
        volume,
      });

      player.addListener('ready', (arg) => {
        const { device_id } = arg as { device_id: string };
        deviceId = device_id;
        log('ready on device', device_id);
        client?.send({ type: 'player:ready', deviceId: device_id, deviceName });
      });

      player.addListener('not_ready', () => {
        log('not ready');
      });

      player.addListener('player_state_changed', (s) => {
        if (s) client?.send({ type: 'player:state', state: stateToPlayback(s as SpotifyState) });
      });

      player.addListener('initialization_error', (arg) => {
        const { message } = arg as { message: string };
        log('initialization error', message);
        client?.send({ type: 'player:error', message });
      });

      void player.connect().then((ok) => {
        if (!ok) log('player connect failed');
      });
    })
    .catch((e) => {
      log('token fetch failed', e);
    });
}

function boot(): void {
  client = new WsClient({
    port,
    role: 'player',
    name: 'vaporzr-player',
    onOpen: () => {
      log('connected to bot bridge');
      client?.send({ type: 'state:request' });
    },
    onMessage: (msg) => {
      if (msg.type === 'cmd') handleCommand(msg);
    },
  });

  const retry = (): void => {
    setTimeout(() => {
      void getToken()
        .then(() => {
          if (!window.Spotify) retry();
          else initPlayer();
        })
        .catch(retry);
    }, 2000);
  };

  if (window.Spotify) {
    initPlayer();
  } else {
    window.onSpotifyWebPlaybackSDKReady = () => initPlayer();
    const s = document.createElement('script');
    s.src = 'https://sdk.scdn.co/spotify-player.js';
    s.async = true;
    document.body.appendChild(s);
    setTimeout(retry, 8000);
  }
}

window.addEventListener('DOMContentLoaded', boot);
