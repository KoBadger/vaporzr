export type PermissionLevel = 'user' | 'mod' | 'admin';

export interface TrackInfo {
  uri: string;
  name: string;
  artists: string[];
  album: string;
  durationMs: number;
  image?: string;
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
  volume: 100,
  shuffle: false,
  repeat: false,
  updatedAt: 0,
});

export type ClientRole = 'player' | 'panel' | 'visualizer';

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
  | 'playAt';

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
}

export type InboundMessage =
  | { type: 'hello'; role: ClientRole; name?: string }
  | { type: 'player:ready'; deviceId?: string; deviceName?: string }
  | { type: 'player:state'; state: PlaybackState }
  | { type: 'player:error'; message: string }
  | { type: 'visuals:frame'; data: string }
  | { type: 'visuals:toggle'; enabled: boolean }
  | { type: 'state:request' }
  | { type: 'panel:subscribe'; channels: Array<'state' | 'queue' | 'visuals'> }
  | CommandMessage;

export type OutboundMessage =
  | { type: 'snapshot'; state: PlaybackState; queue: QueueSnapshot; permissions?: PermissionSnapshot }
  | { type: 'state:update'; state: PlaybackState }
  | { type: 'queue:update'; queue: QueueSnapshot }
  | { type: 'perm:update'; permissions: PermissionSnapshot }
  | { type: 'visuals:frame'; data: string }
  | { type: 'visuals:enabled'; enabled: boolean }
  | { type: 'ready'; ok: boolean }
  | { type: 'error'; message: string }
  | CommandMessage;
