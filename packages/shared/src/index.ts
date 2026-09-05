export type PermissionLevel = 'user' | 'mod' | 'admin';

export type MediaSource = 'spotify' | 'youtube' | 'local' | 'suno' | 'soundcloud' | 'apple';

/** A named visual mood that re-skins the bot, player overlay, and panel. */
export interface VaporzrTheme {
  id: string;
  name: string;
  /** Primary accent hex. */
  accent: string;
  /** Secondary accent hex. */
  accent2: string;
  /** Glow color (css color) used to tint the visualizer. */
  glow: string;
  /** Discord embed color. */
  embedColor: number;
}

export interface TrackInfo {
  uri: string;
  name: string;
  artists: string[];
  album: string;
  durationMs: number;
  image?: string;
  source?: MediaSource;
  streamUrl?: string;
  /** Absolute path for locally-uploaded files (source: 'local'). */
  filePath?: string;
  addedBy: string;
  addedById?: string;
  addedAt: number;
}

export interface PlaybackState {
  deviceId?: string;
  deviceName?: string;
  playing: boolean;
  track?: TrackInfo;
  positionMs: number;
  durationMs: number;
  volume: number;
  shuffle: boolean;
  repeat: boolean;
  /** Session tempo factor (1 = normal; 1.25 = Nightcore; 0.85 = slowed). */
  speed?: number;
  /** Bass-boost gain in dB (0 = off). */
  bassBoost?: number;
  source?: MediaSource;
  updatedAt: number;
}

export interface QueueSnapshot {
  tracks: TrackInfo[];
  currentIndex: number;
}

export interface GuildPermissions {
  roles: Record<PermissionLevel, string[]>;
  commandLevels: Record<string, PermissionLevel>;
}

export interface PermissionSnapshot {
  adminRoles: string[];
  modRoles: string[];
  userRoles: string[];
  commandLevels: Record<string, PermissionLevel>;
}

export const emptyState = (): PlaybackState => ({
  playing: false,
  positionMs: 0,
  durationMs: 0,
  volume: 50,
  shuffle: false,
  repeat: false,
  updatedAt: 0,
});

export type ClientRole = 'panel' | 'visualizer';

export type CommandName =
  | 'play'
  | 'pause'
  | 'resume'
  | 'toggle'
  | 'next'
  | 'previous'
  | 'seek'
  | 'volume'
  | 'shuffle'
  | 'repeat'
  | 'remove'
  | 'clear'
  | 'playAt'
  | 'prime'
  | 'preload'
  | 'stop'
  | 'sfx'
  | 'dj'
  | 'endlesswave'
  | 'openVisuals'
  | 'switchGuild'
  | 'sensitivity'
  | 'theme'
  | 'move'
  | 'playSearch';

export interface CommandMessage {
  type: 'cmd';
  command: CommandName;
  uris?: string[];
  positionMs?: number;
  volume?: number;
  shuffle?: boolean;
  repeat?: boolean;
  index?: number;
  requester?: string;
  source?: MediaSource;
  streamUrl?: string;
  title?: string;
  image?: string;
  /** Sound effect id for command: 'sfx'. */
  sfxId?: string;
  /** DJ soundboard enabled state for command: 'dj'. */
  djEnabled?: boolean;
  /** Endless Wave enabled state for command: 'endlesswave'. */
  active?: boolean;
  /** Guild to switch to for command: 'switchGuild'. */
  guildId?: string;
  /** Beat-reactivity multiplier (0.5–1.5) for command: 'sensitivity'. */
  sensitivity?: number;
  /** Theme id for command: 'theme'. */
  themeId?: string;
  /** Destination position for command: 'move' (with index = source). */
  to?: number;
  /** Search text for command: 'playSearch'. */
  query?: string;
  /** For 'playSearch': false = add to queue only, true = start playing now. */
  now?: boolean;
}

export type InboundMessage =
  | { type: 'hello'; role: ClientRole; name?: string; guildId?: string }
  | { type: 'player:ready'; deviceId?: string; deviceName?: string }
  | { type: 'player:state'; state: PlaybackState }
  | { type: 'player:error'; message: string }
  | { type: 'visuals:frame'; data: string; guildId?: string }
  | { type: 'visuals:toggle'; enabled: boolean }
  | { type: 'audio:chunk'; data: string }
  | { type: 'audio:pcm'; guildId: string; data: string }
  | { type: 'visuals:sensitivity'; multiplier: number }
  | { type: 'state:request' }
  | { type: 'panel:subscribe'; channels: Array<'state' | 'queue' | 'visuals' | 'pcm'>; guildId?: string }
  /** Base64-encoded WebM clip captured by a visualizer window (/burst). */
  | { type: 'burst:data'; data: string }
  | CommandMessage;

export type OutboundMessage =
  | { type: 'snapshot'; state: PlaybackState; queue: QueueSnapshot; permissions?: PermissionSnapshot; voice?: { joined: boolean; channelId?: string }; theme?: VaporzrTheme; djEnabled?: boolean; primaryGuildId?: string; guilds?: Array<{ id: string; name: string }>; sensitivity?: number; guest?: boolean; endlesswave?: boolean }
  | { type: 'state:update'; state: PlaybackState; guildId?: string }
  | { type: 'queue:update'; queue: QueueSnapshot }
  | { type: 'perm:update'; permissions: PermissionSnapshot }
  | { type: 'dj:update'; enabled: boolean }
  | { type: 'visuals:frame'; data: string; guildId?: string }
  | { type: 'visuals:bars'; bars: number[]; guildId?: string }
  | { type: 'visuals:enabled'; enabled: boolean }
  | { type: 'visuals:sensitivity'; multiplier: number }
  | { type: 'audio:forward'; enabled: boolean }
  | { type: 'audio:pcm'; guildId: string; data: string }
  | { type: 'guilds:list'; guilds: Array<{ id: string; name: string }> }
  | { type: 'voice:update'; joined: boolean; channelId?: string }
  | { type: 'theme'; theme: VaporzrTheme }
  /** Toast-style feedback for panel users (search results, errors, etc.). */
  | { type: 'panel:notice'; level: 'info' | 'success' | 'error'; text: string }
  /** Asks a visualizer window to capture a short clip and return burst:data. */
  | { type: 'burst:start'; durationMs?: number }
  | { type: 'endlesswave'; active: boolean; generated: number }
  | { type: 'ready'; ok: boolean }
  | { type: 'error'; message: string }
  | CommandMessage;
