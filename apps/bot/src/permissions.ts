import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import type { PermissionLevel } from '@vaporzr/shared';
import type { Guild } from 'discord.js';

interface GuildConfig {
  roles: Record<PermissionLevel, string[]>;
  commandLevels: Record<string, PermissionLevel>;
}

const DEFAULT_COMMAND_LEVELS: Record<string, PermissionLevel> = {
  play: 'user',
  insert: 'user',
  yt: 'user',
  queue: 'user',
  nowplaying: 'user',
  volume: 'user',
  pause: 'user',
  resume: 'user',
  previous: 'user',
  join: 'user',
  leave: 'user',
  panel: 'user',
  key: 'admin',
  player: 'admin',
  screensaver: 'admin',
  theme: 'user',
  wave: 'user',
  burst: 'user',
  wav: 'user',
  lyrics: 'user',
  skip: 'user',
  remove: 'user',
  clear: 'user',
  shuffle: 'user',
  dj: 'mod',
  sfx: 'user',
  endwav: 'user',
  perms: 'admin',
};

const LEVEL_RANK: Record<PermissionLevel, number> = { user: 0, mod: 1, admin: 2 };

function defaultGuildConfig(): GuildConfig {
  return { roles: { user: [], mod: [], admin: [] }, commandLevels: {} };
}

export class PermissionsManager {
  private cache = new Map<string, GuildConfig>();
  /** Runtime owner id, auto-detected from the Discord application owner. */
  private ownerOverride: string | null = null;

  /** Pin the owner at runtime (used when OWNER_ID is not set in .env). */
  setOwner(userId: string | null): void {
    this.ownerOverride = userId;
  }

  /** True once an owner is known (from OWNER_ID or auto-detection). */
  get hasOwner(): boolean {
    return Boolean(this.ownerOverride ?? config.ownerId);
  }

  private fileFor(guildId: string): string {
    return path.join(config.dataDir, 'guilds', `${guildId}.json`);
  }

  private load(guildId: string): GuildConfig {
    let existing = this.cache.get(guildId);
    if (!existing) {
      try {
        existing = JSON.parse(fs.readFileSync(this.fileFor(guildId), 'utf8')) as GuildConfig;
      } catch {
        existing = defaultGuildConfig();
      }
      this.cache.set(guildId, existing);
    }
    return existing;
  }

  private save(guildId: string): void {
    const cfg = this.cache.get(guildId) ?? defaultGuildConfig();
    fs.mkdirSync(path.dirname(this.fileFor(guildId)), { recursive: true });
    fs.writeFileSync(this.fileFor(guildId), JSON.stringify(cfg, null, 2), 'utf8');
  }

  requiredLevel(command: string, guildId: string): PermissionLevel {
    const cfg = this.load(guildId);
    return cfg.commandLevels[command] ?? DEFAULT_COMMAND_LEVELS[command] ?? 'mod';
  }

  hasRole(guildId: string, level: PermissionLevel, memberRoles: string[]): boolean {
    const cfg = this.load(guildId);
    return cfg.roles[level].some((r) => memberRoles.includes(r));
  }

  setCommandLevel(guildId: string, command: string, level: PermissionLevel): void {
    const cfg = this.load(guildId);
    cfg.commandLevels[command] = level;
    this.save(guildId);
  }

  addRole(guildId: string, level: PermissionLevel, roleId: string): void {
    const cfg = this.load(guildId);
    if (!cfg.roles[level].includes(roleId)) {
      cfg.roles[level].push(roleId);
      this.save(guildId);
    }
  }

  removeRole(guildId: string, level: PermissionLevel, roleId: string): void {
    const cfg = this.load(guildId);
    cfg.roles[level] = cfg.roles[level].filter((r) => r !== roleId);
    this.save(guildId);
  }

  getLevel(
    guild: Guild,
    member: { id: string; roles: { cache: ReadonlyMap<string, unknown> } },
  ): PermissionLevel {
    // The bot's owner outranks everyone in every server — no role setup needed.
    const owner = this.ownerOverride ?? config.ownerId;
    if (owner && member.id === owner) return 'admin';
    if (member.id === guild.ownerId) return 'admin';
    const roleIds = [...member.roles.cache.keys()];
    if (this.hasRole(guild.id, 'admin', roleIds)) return 'admin';
    if (this.hasRole(guild.id, 'mod', roleIds)) return 'mod';
    return 'user';
  }

  can(
    command: string,
    guild: Guild,
    member: { id: string; roles: { cache: ReadonlyMap<string, unknown> } },
  ): boolean {
    const required = this.requiredLevel(command, guild.id);
    const level = this.getLevel(guild, member);
    return LEVEL_RANK[level] >= LEVEL_RANK[required];
  }

  /** True for the bot owner (OWNER_ID or auto-detected app owner). Returns false if unknown. */
  isOwner(userId: string): boolean {
    const owner = this.ownerOverride ?? config.ownerId;
    return Boolean(owner) && userId === owner;
  }

  snapshot(guildId: string) {
    const cfg = this.load(guildId);
    return {
      adminRoles: cfg.roles.admin,
      modRoles: cfg.roles.mod,
      userRoles: cfg.roles.user,
      commandLevels: cfg.commandLevels,
    };
  }
}
