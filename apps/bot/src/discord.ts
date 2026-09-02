import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ActionRowBuilder,
  ActivityType,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildBasedChannel,
  type GuildTextBasedChannel,
  type Interaction,
  type Message,
  type MessageComponentInteraction,
} from 'discord.js';
import { config } from './config.js';
import { resolveTracks, SpotifyError, type ResolvedTrack } from './spotify.js';
import { THEMES, themeById } from './themes.js';
import {
  isYoutubePlaylistUrl,
  isYoutubeUrl,
  resolveYoutubePlaylist,
  resolveYoutubeVideo,
  searchAndResolveYoutube,
  YoutubeError,
} from './youtube.js';
import { isSunoUrl, resolveSuno } from './suno.js';
import { isAppleMusicUrl, resolveAppleMusicUrl } from './apple.js';
import {
  isSoundcloudSetUrl,
  isSoundcloudUrl,
  resolveSoundcloudSet,
  resolveSoundcloudVideo,
  SoundcloudError,
} from './soundcloud.js';
import { Session, SessionManager } from './session.js';
import { PermissionsManager } from './permissions.js';
import { analyzer } from './analyzer.js';
import { vizTunnel } from './tunnel.js';
import { renderPanelIconPng, PANEL_ICON_FALLBACKS } from './panelIcons.js';
import type { Bridge } from './bridge.js';
import type { PermissionLevel, TrackInfo, PlaybackState } from '@vaporzr/shared';
import * as EW from './endlesswave.js';

/** First non-internal IPv4 address of this machine — reachable from the LAN. */
function localIp(): string {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const iface of list ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

/** Map resolver/playback errors to user-friendly one-liners. */
function friendlyPlayError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (err instanceof SoundcloudError) {
    if (/DRM/i.test(msg)) return 'That SoundCloud track is DRM-protected — no playable stream available.';
    if (/empty|unavailable/i.test(msg)) return 'That SoundCloud set appears to be empty or unavailable.';
    if (/extract/i.test(msg)) return 'Could not extract audio from that SoundCloud link.';
    return `SoundCloud error: ${msg}`;
  }
  if (err instanceof YoutubeError) {
    if (/search failed/i.test(msg)) return 'Could not find that on YouTube.';
    if (/yt-dlp failed/i.test(msg)) return 'YouTube extraction failed — the video may be private or region-locked.';
    return `YouTube error: ${msg}`;
  }
  if (err instanceof SpotifyError) {
    if (/rate.limit/i.test(msg) || /429/i.test(msg)) return 'Spotify rate-limited — try again in a minute.';
    if (/not found/i.test(msg)) return 'Could not find that track on Spotify.';
    return `Spotify error: ${msg}`;
  }
  if (/not in a voice channel/i.test(msg)) return 'Join a voice channel first, then try again.';
  if (/DRM/i.test(msg)) return 'That track is DRM-protected — no playable stream available.';
  if (/rate.limit|429/i.test(msg)) return 'Rate-limited — try again in a moment.';
  if (/timed out|ETIMEDOUT/i.test(msg)) return 'Connection timed out — check your network and try again.';
  if (/private|unavailable|not found/i.test(msg)) return 'That track is private or unavailable.';
  return msg;
}

/**
 * Hostname advertised in `/viz`, `/panel`, and `/help` links. Defaults to the
 * LAN IP (works for anyone on the same network); set PUBLIC_HOST in .env to
 * advertise a custom domain instead (e.g. behind port forwarding or DNS).
 */
function vizHost(): string {
  return config.publicHost || localIp();
}

const COMMANDS = [
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Search for a track or paste a Spotify/YouTube link to queue it')
    .addStringOption((o) => o.setName('query').setDescription('Track name or Spotify/YouTube URL').setRequired(true)),
  new SlashCommandBuilder()
    .setName('insert')
    .setDescription('Search for a track and add it to play right after the current one')
    .addStringOption((o) => o.setName('query').setDescription('Track name or Spotify/YouTube URL').setRequired(true)),
  new SlashCommandBuilder()
    .setName('yt')
    .setDescription('Search YouTube and queue a video')
    .addStringOption((o) => o.setName('query').setDescription('YouTube URL or search query').setRequired(true)),
  new SlashCommandBuilder().setName('queue').setDescription('Show the current queue'),
  new SlashCommandBuilder().setName('skip').setDescription('Skip to the next track'),
  new SlashCommandBuilder().setName('pause').setDescription('Pause playback'),
    new SlashCommandBuilder().setName('resume').setDescription('Resume or refresh stalled playback'),
  new SlashCommandBuilder().setName('clear').setDescription('Clear the queue'),
  new SlashCommandBuilder()
    .setName('remove')
    .setDescription('Remove a track from the queue')
    .addIntegerOption((o) => o.setName('index').setDescription('1-based index into the queue').setRequired(true)),
  new SlashCommandBuilder()
    .setName('volume')
    .setDescription('Check the current volume, or set it with a level')
    .addIntegerOption((o) => o.setName('level').setDescription('0-100 (omit to just check the current volume)')),
  new SlashCommandBuilder().setName('nowplaying').setDescription('Show the currently playing track'),
  new SlashCommandBuilder().setName('join').setDescription('Join your voice channel and stream audio to it'),
  new SlashCommandBuilder().setName('leave').setDescription('Leave the voice channel'),
  new SlashCommandBuilder()
    .setName('shuffle')
    .setDescription('Toggle shuffle')
    .addBooleanOption((o) => o.setName('enabled').setDescription('On or off').setRequired(true)),
    new SlashCommandBuilder().setName('panel').setDescription('Post (or refresh) the live control panel with buttons'),
    new SlashCommandBuilder()
      .setName('key')
      .setDescription('Web panel/visualizer access links (trusted users)')
      .addSubcommand((sc) => sc.setName('give').setDescription('Get your pre-authorized panel + visualizer links'))
      .addSubcommand((sc) => sc.setName('rotate').setDescription('Owner: issue a new key — all old links stop working')),
    new SlashCommandBuilder()
      .setName('endwav')
      .setDescription('Endless Wave — AI-powered autoplay that evolves with your vibe')
      .addSubcommand((sc) => sc.setName('on').setDescription('Activate Endless Wave'))
      .addSubcommand((sc) => sc.setName('off').setDescription('Deactivate Endless Wave'))
      .addSubcommand((sc) => sc.setName('status').setDescription('Show Endless Wave status')),
    new SlashCommandBuilder()
      .setName('nickname')
      .setDescription('🥚 Rename me in THIS server (unlocked by key activation)')
      .addSubcommand((sc) =>
        sc
          .setName('set')
          .setDescription('Set my server nickname (max 2 words, ends in -rzr / -orzr / -porzr)')
          .addStringOption((o) => o.setName('name').setDescription('e.g. Neon-rzr, Bass Drop-orzr, Vapor-porzr').setRequired(true).setMaxLength(100)),
      )
      .addSubcommand((sc) => sc.setName('clear').setDescription('Reset my server nickname')),
  new SlashCommandBuilder()
    .setName('screensaver')
    .setDescription('Fullscreen the visualizer like a milkdrop screensaver on this machine'),
  new SlashCommandBuilder()
    .setName('viz')
    .setDescription('Open the web visualizer in your browser'),
  new SlashCommandBuilder()
    .setName('theme')
    .setDescription('Set the visual mood / color theme (no arg lists themes)')
    .addStringOption((o) =>
      o
        .setName('name')
        .setDescription('Theme name')
        .setRequired(false)
        .addChoices(...THEMES.map((t) => ({ name: t.name, value: t.id }))),
    ),
  new SlashCommandBuilder().setName('wave').setDescription('Post a waveform/spectrum animation of the current audio'),
  new SlashCommandBuilder().setName('burst').setDescription('Capture a short animated clip of the visualizer window'),
  new SlashCommandBuilder()
    .setName('wav')
    .setDescription('Play an uploaded audio/video file (wav, mp3, mp4, flac, …)')
    .addAttachmentOption((o) => o.setName('file').setDescription('The file to play').setRequired(true)),
  new SlashCommandBuilder()
    .setName('perms')
    .setDescription('Manage permissions (admin only)')
    .addSubcommand((s) => s.setName('view').setDescription('View current permissions'))
    .addSubcommand((s) =>
      s
        .setName('set')
        .setDescription('Set the minimum level for a command')
        .addStringOption((o) => o.setName('command').setDescription('Command name').setRequired(true))
        .addStringOption((o) =>
          o
            .setName('level')
            .setDescription('Required level')
            .setRequired(true)
            .addChoices(
              { name: 'user', value: 'user' },
              { name: 'mod', value: 'mod' },
              { name: 'admin', value: 'admin' },
            ),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('role')
        .setDescription('Grant/revoke a role at a level')
        .addStringOption((o) =>
          o
            .setName('action')
            .setDescription('add or remove')
            .setRequired(true)
            .addChoices({ name: 'add', value: 'add' }, { name: 'remove', value: 'remove' }),
        )
        .addStringOption((o) =>
          o
            .setName('level')
            .setDescription('Level to change')
            .setRequired(true)
            .addChoices(
              { name: 'user', value: 'user' },
              { name: 'mod', value: 'mod' },
              { name: 'admin', value: 'admin' },
            ),
        )
        .addRoleOption((o) => o.setName('role').setDescription('The role').setRequired(true)),
    ),
  new SlashCommandBuilder()
    .setName('dj')
    .setDescription('Toggle DJ sound effects for the server (mod only)')
    .addBooleanOption((o) => o.setName('enabled').setDescription('On or off (omit to check)')),
  new SlashCommandBuilder()
    .setName('sfx')
    .setDescription('Play a DJ sound effect over the music')
    .addStringOption((o) => o.setName('sound').setDescription('The effect to play (omit to list)')),
  new SlashCommandBuilder().setName('help').setDescription('Show how to use Vaporzr'),
  new SlashCommandBuilder().setName('invite').setDescription('Get a link to add Vaporzr to your server'),
  new SlashCommandBuilder().setName('stats').setDescription('Show bot statistics'),
  new SlashCommandBuilder()
    .setName('sensitivity')
    .setDescription('Set beat-reactivity sensitivity for the visualizer')
    .addNumberOption((o) =>
      o
        .setName('multiplier')
        .setDescription('Sensitivity multiplier')
        .setRequired(true)
        .addChoices(
          { name: '1.0x (default)', value: 1.0 },
          { name: '1.10x (slightly more reactive)', value: 1.10 },
          { name: '1.15x (moderately reactive)', value: 1.15 },
          { name: '1.25x (noticeably snappy)', value: 1.25 },
          { name: '1.50x (very reactive)', value: 1.50 },
        ),
    ),
];

function fmtMs(ms: number): string {
  if (!ms || ms < 0) return '0:00';
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** True when an edit failure means the target message no longer exists
 *  (deleted, or the channel it lived in is gone). Anything else — missing
 *  permissions, rate limits, network blips — should keep the registration
 *  so the panel self-heals once access is restored. */
function isMessageGone(err: unknown): boolean {
  const e = err as { status?: number; code?: number; message?: string } | null;
  if (!e) return false;
  if (e.status === 404 || e.code === 10008) return true; // Unknown Message
  if (e.code === 10003) return true; // Unknown Channel
  return false;
}

export class DiscordBot {
  private client: Client;
  private rest: REST;
  /** guildId -> in-flight Endless Wave auto-queue, so overlapping track-end
   *  callbacks (rapid skips) can't double-enqueue or race each other. */
  private ewBusy = new Set<string>();
  /** Debounced topUp timers per guild — collapsed so rapid queue changes
   *  (skip + manual add back-to-back) trigger only one refill pass. */
  private ewTopUpTimers = new Map<string, NodeJS.Timeout>();
  /** Prevent a no-candidate EW pass from hammering Spotify/YouTube every 700ms. */
  private ewRetryAfter = new Map<string, number>();
  /** URI of the most recently started track per guild, so markPlayed is only
   *  called once per track (on start) instead of on every queue/state change. */
  private ewStartedUri = new Map<string, string>();
  /** guildId -> panel message location. */
  private panels = new Map<string, { channelId: string; messageId: string }>();
  private npMessages = new Map<string, { channelId: string; messageId: string }>();
  /** guildId -> last text channel a command ran in (mini now-playing posts there). */
  private lastTextChannel = new Map<string, string>();
  /** guildId -> auto-posted mini now-playing message (always-on, self-updating). */
  private miniNp = new Map<string, { channelId: string; messageId: string }>();
  /** guildId -> track uri the mini strip currently represents (for re-anchoring). */
  private miniTrackUri = new Map<string, string>();
  private panelRefreshQueued = false;

  // ---- persisted panel registrations (survive restarts) ----
  private panelSaveTimer: NodeJS.Timeout | null = null;

  private panelsFile(): string {
    return path.join(config.dataDir, 'panels.json');
  }

  private async loadPanelRegistrations(): Promise<void> {
    try {
      const raw = await fs.readFile(this.panelsFile(), 'utf8');
      const d = JSON.parse(raw) as {
        panels?: Record<string, { channelId: string; messageId: string }>;
        npMessages?: Record<string, { channelId: string; messageId: string }>;
        miniNp?: Record<string, { channelId: string; messageId: string }>;
        miniTrackUri?: Record<string, string>;
        lastTextChannel?: Record<string, string>;
      };
      for (const [k, v] of Object.entries(d.panels ?? {})) this.panels.set(k, v);
      for (const [k, v] of Object.entries(d.npMessages ?? {})) this.npMessages.set(k, v);
      for (const [k, v] of Object.entries(d.miniNp ?? {})) this.miniNp.set(k, v);
      for (const [k, v] of Object.entries(d.miniTrackUri ?? {})) this.miniTrackUri.set(k, v);
      for (const [k, v] of Object.entries(d.lastTextChannel ?? {})) this.lastTextChannel.set(k, v);
      const n = this.panels.size + this.npMessages.size + this.miniNp.size;
      if (n) console.log(`[vaporzr] restored ${n} panel/now-playing registration(s) from disk`);
    } catch { /* none yet */ }
  }

  private scheduleSavePanels(): void {
    if (this.panelSaveTimer) return;
    this.panelSaveTimer = setTimeout(() => {
      this.panelSaveTimer = null;
      void this.savePanelRegistrations();
    }, 500);
    this.panelSaveTimer.unref?.();
  }

  private async savePanelRegistrations(): Promise<void> {
    try {
      const obj = {
        panels: Object.fromEntries(this.panels),
        npMessages: Object.fromEntries(this.npMessages),
        miniNp: Object.fromEntries(this.miniNp),
        miniTrackUri: Object.fromEntries(this.miniTrackUri),
        lastTextChannel: Object.fromEntries(this.lastTextChannel),
      };
      await fs.mkdir(config.dataDir, { recursive: true });
      await fs.writeFile(this.panelsFile(), JSON.stringify(obj), 'utf8');
    } catch (err) {
      console.warn('[discord] panel registration save failed:', err instanceof Error ? err.message : err);
    }
  }
  /** Beat-reactive presence equalizer state. */
  private presenceTimer: NodeJS.Timeout | null = null;
  private lastPresence = '';
  /** Per-user-per-command rate limiting (key: `${userId}:${command}` -> last use). */
  private cooldowns = new Map<string, number>();
  private readonly COMMAND_COOLDOWN_MS = 2000;
  /** Commands that never trigger the cooldown (read-only / informational). */
  private static readonly NO_COOLDOWN = new Set(['help', 'stats', 'queue', 'nowplaying', 'perms', 'viz', 'invite']);
  /** Since this bot process started. */
  private startedAt = Date.now();
  /** Cumulative slash + prefix commands handled. */
  private commandsRun = 0;

  constructor(
    private sessions: SessionManager,
    private perms: PermissionsManager,
    private bridge: Bridge,
  ) {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });
    this.rest = new REST({ version: '10' });
    // Every per-guild session refreshes that server's control panel on changes.
    sessions.onSessionCreated((s) => {
      s.queue.subscribe({
        onQueueChanged: () => this.schedulePanelRefresh(),
        onStateChanged: (st) => {
          this.schedulePanelRefresh();
          // Follow playback: mirror whatever guild is actually playing.
          if (st.playing && s.guildId && s.guildId !== bridge.getPrimaryGuildId()) {
            console.log(`[discord] playback active in guild ${s.guildId} - panels/visualizer now mirror it`);
            bridge.setPrimaryGuildId(s.guildId);
          }
          // Always-on mini now-playing: post once per session, self-updates after.
          void this.maybeAutoMiniNp(s.guildId, st);
        },
      });
      // Endless Wave: keep a 2-track lookahead buffer topped up on any queue
      // or state change — skips, manual adds and natural ends all trigger a
      // refill, so EW behaves like a normal extension of the queue.
      s.queue.subscribe({
        onQueueChanged: () => this.scheduleWaveTopUp(s),
        onStateChanged: (st) => {
          if (st.playing && st.track) this.markWaveStarted(s, st.track);
          this.scheduleWaveTopUp(s);
        },
      });
      s.playback.onTrackEnd = (ended) => {
        if (!s.endlessWave.active) return;
        void this.waveTrackEnded(s, ended).catch((err) => {
          console.warn(`[endlesswave] on-end failed: ${err instanceof Error ? err.message : err}`);
        });
      };
    });
  }

  /** Resolve the isolated playback session for a guild (DMs share one session). */
  private sessionFor(guildId: string | null | undefined): Session {
    return this.sessions.get(guildId ?? '__dm__');
  }

  async start(): Promise<void> {
    this.client.on('clientReady', async () => {
      console.log(`[vaporzr] logged in as ${this.client.user?.tag}`);
      void this.loadPanelRegistrations();
      if (!config.ownerId) {// Auto-detect owner from the application record. This fetch can fail
        // on a flaky network at boot, so retry with backoff, then keep
        // re-checking periodically — owner rank must never silently vanish.
        let attempts = 0;
        const detect = async (): Promise<void> => {
          if (this.perms.hasOwner) return;
          attempts++;
          try {
            const app = await this.client.application?.fetch();
            const owner = app?.owner;
            const ownerId = owner
              ? 'ownerId' in owner
                ? (owner as { ownerId?: string }).ownerId
                : (owner as { id: string }).id
              : null;
            if (ownerId) {
              this.perms.setOwner(ownerId);
              console.log(`[vaporzr] auto-detected owner: ${ownerId} (set OWNER_ID in .env to pin it)`);
              return;
            }
            throw new Error('no owner in application record');
          } catch (err) {
            console.warn(`[vaporzr] owner auto-detect attempt ${attempts} failed:`, err instanceof Error ? err.message : err);
            if (attempts < 6) setTimeout(() => void detect(), 5000 * attempts);
            else {
              // Slow periodic re-check until it sticks.
              const t = setInterval(() => {
                if (this.perms.hasOwner) { clearInterval(t); return; }
                void detect();
              }, 15 * 60 * 1000);
              t.unref?.();
            }
          }
        };
        void detect();
      }
      const guilds = await this.client.guilds.fetch();
      console.log(
        `[vaporzr] in ${guilds.size} guild(s): ${guilds.map((g) => `${g.name} (${g.id})`).join(', ') || 'none'}`,
      );
      this.syncPrimaryGuild();
      void this.registerCommands();
      void this.ensurePanelEmojis();
      void this.syncBotAvatar();
      void this.loadKeyedGuilds();
    });
    this.client.on('interactionCreate', (i) => void this.onInteraction(i));
    this.client.on('messageCreate', (m) => void this.handleMessageCommand(m));
    this.client.on('guildCreate', () => void this.registerCommands());
    this.client.on('guildCreate', () => this.syncPrimaryGuild());
    this.client.on('guildCreate', (g) => void this.handleGuildCreate(g));
    this.client.on('guildDelete', () => this.syncPrimaryGuild());
    await this.client.login(config.discordToken);
    this.startPresenceTicker();
  }

  /** Keep the bridge's primary guild (used by desktop/browser panels) in sync. */
  private syncPrimaryGuild(): void {
    void this.client.guilds.fetch().then((guilds) => {
      this.bridge.setPrimaryGuildId(guilds.first()?.id ?? null);
      this.bridge.setGuildList(guilds.map((g) => ({ id: g.id, name: g.name })));
    });
  }

  /**
   * Auto-setup when the bot joins a server: register commands (already handled
   * by a sibling listener), then post a welcome embed. The server owner is an
   * admin automatically (permissions.ts) and /help covers the rest, so this is
   * just onboarding, not configuration.
   */
  private async handleGuildCreate(guild: Guild): Promise<void> {
    const channel = await this.welcomeChannel(guild);
    if (!channel) {
      console.warn(`[vaporzr] no writable channel to welcome ${guild.name}`);
      return;
    }
    try {
      await channel.send({ embeds: [this.welcomeEmbed(guild)] });
      console.log(`[vaporzr] sent welcome to ${guild.name} in #${channel.name}`);
    } catch (err) {
      console.warn(
        `[vaporzr] could not send welcome to ${guild.name}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  /** The system channel, or the first text channel the bot can post embeds in. */
  private async welcomeChannel(guild: Guild): Promise<GuildTextBasedChannel | null> {
    try {
      await guild.channels.fetch();
    } catch {
      /* cache may already be warm */
    }
    const me = guild.members.me;
    const canWrite = (ch: GuildBasedChannel | null | undefined): ch is GuildTextBasedChannel => {
      if (!ch || !ch.isTextBased()) return false;
      if (!me) return true;
      const perms = ch.permissionsFor(me);
      return (
        perms?.has(PermissionFlagsBits.SendMessages) === true &&
        perms.has(PermissionFlagsBits.EmbedLinks) === true
      );
    };
    if (canWrite(guild.systemChannel)) return guild.systemChannel;
    return guild.channels.cache.find((c): c is GuildTextBasedChannel => canWrite(c)) ?? null;
  }

  private welcomeEmbed(guild: Guild): EmbedBuilder {
    return new EmbedBuilder()
      .setTitle(`🎧 Hello, ${guild.name}!`)
      .setDescription(
        "I'm **Vaporzr** — a music & visualizer bot, all set up. Quick start:\n\n" +
          '`/play <song or link>` — queue a track (Spotify, YouTube, SoundCloud, Suno)\n' +
          '`V@p <song or link>` — same thing, quick prefix\n' +
          '`/panel` — live control panel with buttons (server admins)\n' +
          '`/join` — join your VC and start streaming\n\n' +
          'The server owner is **admin** here automatically — use `/perms` to grant roles. Every server has its own isolated queue and the queue clears automatically when the bot joins or leaves a voice channel.',
      )
      .setColor(this.themeColor())
      .setFooter({ text: 'See /help for the full command list' });
  }

  private async registerCommands(): Promise<void> {
    this.rest.setToken(config.discordToken);
    const guilds = await this.client.guilds.fetch();
    for (const g of guilds.values()) {
      try {
        await this.rest.put(Routes.applicationGuildCommands(this.client.user!.id, g.id), {
          body: COMMANDS.map((c) => c.toJSON()),
        });
      } catch (e) {
        console.error(`[vaporzr] failed to register commands for ${g.id}:`, e);
      }
    }
  }

  private async onInteraction(interaction: Interaction): Promise<void> {
    if (interaction.isButton()) {
      await this.handleButton(interaction);
      return;
    }
    if (interaction.isStringSelectMenu()) {
      if (interaction.customId === 'queue_page') {
        const s = this.sessionFor(interaction.guildId);
        const start = parseInt(interaction.values[0] ?? '0', 10);
        const { embeds, components } = this.queuePage(s, Number.isFinite(start) ? start : 0);
        await interaction.update({ embeds, components }).catch(() => {});
      }
      return;
    }
    if (!interaction.isChatInputCommand()) return;
    try {
      await this.handleCommand(interaction);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[discord] command "/${interaction.commandName}" failed in guild ${interaction.guildId ?? 'DM'}: ${msg}`);
      const friendly = friendlyPlayError(err);
      if (interaction.deferred) await interaction.followUp({ content: `⚠️ ${friendly}`, flags: MessageFlags.Ephemeral });
      else await interaction.reply({ content: `⚠️ ${friendly}`, flags: MessageFlags.Ephemeral });
    }
  }

  private requireLevel(command: string, interaction: ChatInputCommandInteraction): boolean {
    if (!interaction.inGuild()) return true;
    const member = interaction.member;
    if (!member || !('roles' in member)) return true;
    return this.perms.can(
      command,
      interaction.guild!,
      member as unknown as { id: string; roles: { cache: ReadonlyMap<string, unknown> } },
    );
  }

  /**
   * Enforce a per-user per-command cooldown. Returns ms still to wait, or 0 if
   * the command may run. Records the timestamp for a fresh allowed call.
   */
  private cooldownRemaining(userId: string, command: string): number {
    if (DiscordBot.NO_COOLDOWN.has(command)) return 0;
    const key = `${userId}:${command}`;
    const last = this.cooldowns.get(key) ?? 0;
    const remaining = last + this.COMMAND_COOLDOWN_MS - Date.now();
    if (remaining > 0) return remaining;
    this.cooldowns.set(key, Date.now());
    if (this.cooldowns.size > 2000) {
      const cutoff = Date.now() - 60_000;
      for (const [k, at] of this.cooldowns) {
        if (at < cutoff) this.cooldowns.delete(k);
      }
    }
    return 0;
  }

  private canUse(command: string, interaction: MessageComponentInteraction): boolean {
    if (!interaction.inGuild()) return true;
    const member = interaction.member;
    if (!member || !('roles' in member)) return true;
    return this.perms.can(
      command,
      interaction.guild!,
      member as unknown as { id: string; roles: { cache: ReadonlyMap<string, unknown> } },
    );
  }

  /**
   * Gate for commands that spawn windows on the machine hosting the bot.
   * Owner-only (OWNER_ID or auto-detected app owner); otherwise falls back to admin.
   */
  private requireWindowOwner(userId: string, guild: Guild | null, member: unknown): boolean {
    if (this.perms.isOwner(userId)) return true;
    if (this.perms.hasOwner) return false;
    if (guild && member && typeof member === 'object' && 'roles' in member) {
      return (
        this.perms.getLevel(guild, member as { id: string; roles: { cache: ReadonlyMap<string, unknown> } }) === 'admin'
      );
    }
    return false;
  }

  private async handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const name = interaction.commandName;
    const s = this.sessionFor(interaction.guildId);
    if (interaction.guildId && interaction.channelId) {
      this.lastTextChannel.set(interaction.guildId, interaction.channelId);
      this.scheduleSavePanels();
    }

    const wait = this.cooldownRemaining(interaction.user.id, name);
    if (wait > 0) {
      await interaction.reply({
        content: `⏳ Slow down — you can use \`/${name}\` again in ${Math.ceil(wait / 1000)}s.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    switch (name) {
      case 'play': {
        const query = interaction.options.getString('query', true);
        await interaction.deferReply();
        const tracks = await resolvePlayInput(query);
        await this.addToQueue(interaction, tracks);
        break;
      }

      case 'insert': {
        const query = interaction.options.getString('query', true);
        await interaction.deferReply();
        const tracks = await resolvePlayInput(query);
        await this.insertToQueue(interaction, tracks);
        break;
      }

      case 'yt': {
        const query = interaction.options.getString('query', true);
        await interaction.deferReply();
        let tracks: ResolvedTrack[];
        if (isYoutubePlaylistUrl(query)) {
          tracks = await resolveYoutubePlaylist(query);
        } else if (isYoutubeUrl(query)) {
          tracks = [await resolveYoutubeVideo(query)];
        } else {
          const hit = await searchAndResolveYoutube(query);
          tracks = hit ? [hit] : [];
        }
        await this.addToQueue(interaction, tracks);
        break;
      }

      case 'queue': {
        const snap = s.queue.getSnapshot();
        if (snap.tracks.length === 0) {
          await interaction.reply('The queue is empty.');
          return;
        }
         const { embeds, components } = this.queuePage(s);
        await interaction.reply({ embeds, components });
        break;
      }

      case 'skip': {
        if (!this.requireLevel('skip', interaction)) return this.deny(interaction);
        s.playback.next();
        const np = this.nowPlayingEmbed(s, '⏭️ Skipped');
        if (np) await interaction.reply({ embeds: [np] });
        else await interaction.reply('⏭️ Skipped — queue ended');
        break;
      }

      case 'pause':
        if (!this.requireLevel('pause', interaction)) return this.deny(interaction);
        s.playback.pause();
        await interaction.reply('⏸️ Paused');
        break;

      case 'resume':
        if (!this.requireLevel('resume', interaction)) return this.deny(interaction);
        await s.playback.resume();
        await interaction.reply('▶️ Resumed');
        break;

      case 'clear':
        if (!this.requireLevel('clear', interaction)) return this.deny(interaction);
        s.playback.stopAll();
        s.queue.clear();
        await interaction.reply('🗑️ Queue cleared');
        break;

      case 'remove': {
        const index = interaction.options.getInteger('index', true);
        if (!this.requireLevel('remove', interaction)) return this.deny(interaction);
        const removed = s.queue.remove(index - 1);
        await interaction.reply(removed ? `Removed **${removed.name}**` : 'Index out of range.');
        break;
      }

      case 'volume': {
        if (!this.requireLevel('volume', interaction)) return this.deny(interaction);
        const level = interaction.options.getInteger('level');
        if (level === null) {
          await interaction.reply(`🔊 Current volume is **${s.queue.getState().volume}%**`);
          break;
        }
        s.playback.volume(level);
        await interaction.reply(`🔊 Volume set to ${level}%`);
        break;
      }

      case 'join': {
        if (!this.requireLevel('join', interaction)) return this.deny(interaction);
        if (!interaction.inGuild()) {
          await interaction.reply({ content: 'Must be used inside a server.', flags: MessageFlags.Ephemeral });
          return;
        }
        const guild = interaction.guild!;
        const member = interaction.member;
        if (!member || !('voice' in member)) {
          await interaction.reply({ content: 'Voice state unavailable.', flags: MessageFlags.Ephemeral });
          return;
        }
        const channel = member.voice.channel;
        if (!channel) {
          await interaction.reply({ content: 'You must be in a voice channel first.', flags: MessageFlags.Ephemeral });
          return;
        }
        await interaction.deferReply();
        try {
          s.playback.stopAll();
          s.queue.clear();
          await s.voice.join(guild.id, channel.id, guild.voiceAdapterCreator);
          await interaction.editReply(`🔊 Joined **${channel.name}** — queue cleared, ready to stream.`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await interaction.editReply(`❌ Could not join: ${msg}`);
        }
        break;
      }

      case 'leave':
        if (!this.requireLevel('leave', interaction)) return this.deny(interaction);
        s.playback.stopAll();
        s.queue.clear();
        s.voice.leave();
        await interaction.reply('👋 Left the voice channel. Queue cleared.');
        break;

      case 'nowplaying': {
        if (!interaction.inGuild()) {
          await interaction.reply({ content: 'Must be used inside a server.', flags: MessageFlags.Ephemeral });
          return;
        }
        const guildId = interaction.guildId!;
        // Repost at the bottom instead of refreshing a scrolled-up old message.
        const existing = this.npMessages.get(guildId);
        if (existing) {
          await this.deleteNp(existing.channelId, existing.messageId);
          this.npMessages.delete(guildId);
        }
        const channel = interaction.channel;
        if (!channel || !('send' in channel)) {
          await interaction.reply({ content: 'Cannot post here.', flags: MessageFlags.Ephemeral });
          break;
        }
        const msg = await channel.send({ embeds: [this.npPayload(s)] });
        this.npMessages.set(guildId, { channelId: interaction.channelId, messageId: msg.id });
        this.scheduleSavePanels();
        await interaction.reply({ content: '🔴 Live now-playing message posted right here — it updates itself.', flags: MessageFlags.Ephemeral });
        break;
      }

      case 'shuffle': {
        if (!this.requireLevel('shuffle', interaction)) return this.deny(interaction);
        const on = interaction.options.getBoolean('enabled', true);
        s.playback.shuffle(on);
        await interaction.reply(on ? '🔀 Shuffle on' : '🔂 Shuffle off');
        break;
      }

      case 'panel': {
        if (!interaction.inGuild()) {
          await interaction.reply({ content: 'Must be used inside a server.', flags: MessageFlags.Ephemeral });
          return;
        }
        if (!this.isAdminMember(interaction.user.id, interaction.guild, interaction.member)) {
          await interaction.reply({
            content: '⛔ Admins only — server admins can post the panel (or use `/perms` to grant admin to a role).',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        if (!this.requireLevel('panel', interaction)) return this.deny(interaction);
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        // Always re-post at the bottom of the channel (old copy deleted) so the
        // panel lands where you're looking instead of scrolled up from before.
        await this.repostPanel(interaction.guildId!, interaction.channel as GuildTextBasedChannel | null);
        await interaction.editReply({ content: '🎛️ Control panel posted right here.' });
        break;
      }

      case 'screensaver': {
        // Desktop screensaver retired — the web visualizer is the fullscreen
        // experience now (tap ⛶ there).
        const vl = vizTunnel.vizLink();
        await interaction.reply({
          content: `🎬 Fullscreen visuals live in the browser now:\n${vl.url}\n\nOpen it and tap ⛶ (or F) for fullscreen.`,
          flags: MessageFlags.Ephemeral,
        });
        break;
      }

      case 'viz': {
        const admin = this.isAdminMember(interaction.user.id, interaction.guild, interaction.member);
        await interaction.reply({ embeds: [this.vizEmbed(admin)], flags: MessageFlags.Ephemeral });
        break;
      }

      case 'key': {
        const sub = interaction.options.getSubcommand();
        if (sub === 'rotate') {
          if (!this.perms.isOwner(interaction.user.id)) return this.deny(interaction);
          const newKey = randomBytes(12).toString('base64url');
          config.shareKey = newKey; // live immediately
          try {
            const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
            let env = '';
            try {
              env = await fs.readFile(envPath, 'utf8');
            } catch {
              /* new file */
            }
            if (/^SHARE_KEY=.*$/m.test(env)) env = env.replace(/^SHARE_KEY=.*$/m, `SHARE_KEY=${newKey}`);
            else env += (env.endsWith('\n') ? '' : '\n') + `SHARE_KEY=${newKey}\n`;
            await fs.writeFile(envPath, env, 'utf8');
          } catch (err) {
            console.warn(`[discord] could not persist SHARE_KEY: ${err instanceof Error ? err.message : err}`);
          }
          const pl = vizTunnel.panelLink();
          const linkLine = pl.secure ? `${pl.url}?key=${newKey}` : `(links appear once PUBLIC_BASE_URL or a tunnel is up)`;
          await interaction.reply({
            content: `🔑 New key issued — all previous links and remembered devices are dead.\n${linkLine}`,
            flags: MessageFlags.Ephemeral,
          });
          break;
        }
        // give
        if (!this.requireLevel('key', interaction)) return this.deny(interaction);
        if (!config.shareKey) {
          await interaction.reply({ content: 'No share key is configured — the web panel is open access.', flags: MessageFlags.Ephemeral });
          break;
        }
        const pl = vizTunnel.panelLink();
        const vl = vizTunnel.vizLink();
        if (interaction.guildId) await this.markKeyedGuild(interaction.guildId);
        await interaction.reply({
          embeds: [
            new EmbedBuilder()
              .setTitle('🔑 Web access links')
              .setDescription(
                `Pre-authorized for you — opens once, then that device is remembered.\n\n` +
                  `🎛️ **Control panel:** <${pl.url}?key=${config.shareKey}>\n` +
                  `🌈 **Visualizer:** <${vl.url}?key=${config.shareKey}>` +
                  `\n\n🥚 *Psst… this server can now rename me — try* \`/nickname set\``,
              )
              .setColor(this.themeColor())
              .setFooter({ text: 'Keep these links private — anyone holding them gets in · /key rotate to revoke all' }),
          ],
          flags: MessageFlags.Ephemeral,
        });
        break;
      }

      case 'endwav': {
        if (!this.requireLevel('endwav', interaction)) return this.deny(interaction);
        if (!interaction.guildId) return void (await interaction.reply({ content: 'Must be used in a server.', flags: MessageFlags.Ephemeral }));
        const s = this.sessionFor(interaction.guildId);
        const sub = interaction.options.getSubcommand();
        if (sub === 'on') {
          if (s.endlessWave.active) {
            await interaction.reply({ content: '🌊 Endless Wave is already active.', flags: MessageFlags.Ephemeral });
            break;
          }
          EW.activate(s.endlessWave);
          // Seed the played-set with the current track (synchronous, cheap) so
          // EW doesn't immediately re-pick it.
          const current = s.queue.getCurrentTrack();
          if (current) {
            EW.markPlayed(s.endlessWave, current.uri, current.name, current.artists);
          }
          this.bridge.broadcast({ type: 'endlesswave', active: true, generated: 0 });
          // Reply FIRST so we never breach Discord's 3s interaction window, then
          // enrich EW's audio-feature context in the background.
          const ewOnMsg = '🌊 **Endless Wave activated** — I\'ll keep the vibes flowing with AI-curated tracks that evolve with your session.';
          await interaction.reply({
            content: current ? ewOnMsg : `${ewOnMsg}\nQueue up a track to set the vibe — I'll take it from there.`,
            flags: MessageFlags.Ephemeral,
          });
          if (current) {
            void EW.fetchFeatures(current)
                .then((af) => { if (af) EW.recordFeatures(s.endlessWave, af); })
              .catch(() => {});
          }
          // Immediately fill the lookahead buffer so the wave has tracks queued
          // from the start, not just after the first song ends.
          void this.topUpWave(s).catch((err) => {
            console.warn(`[endlesswave] initial top-up failed: ${err instanceof Error ? err.message : err}`);
          });
        } else if (sub === 'off') {
          if (!s.endlessWave.active) {
            await interaction.reply({ content: 'Endless Wave isn\'t active right now.', flags: MessageFlags.Ephemeral });
            break;
          }
          EW.deactivate(s.endlessWave);
          const t = this.ewTopUpTimers.get(interaction.guildId!);
          if (t) clearTimeout(t);
          this.ewTopUpTimers.delete(interaction.guildId!);
          this.ewStartedUri.delete(interaction.guildId!);
          this.bridge.broadcast({ type: 'endlesswave', active: false, generated: s.endlessWave.generated });
          await interaction.reply({
            content: `🌊 **Endless Wave deactivated** — ${s.endlessWave.generated} tracks were auto-curated this session.`,
            flags: MessageFlags.Ephemeral,
          });
        } else {
          const snap = EW.snapshot(s.endlessWave);
          await interaction.reply({
            content: snap.active
              ? `🌊 **Endless Wave is active** — ${snap.generated} tracks generated, ${snap.playedCount} unique tracks played.`
              : 'Endless Wave is not active. Use `/endwav on` to start.',
            flags: MessageFlags.Ephemeral,
          });
        }
        break;
      }

      case 'sensitivity': {
        if (!this.requireLevel('sensitivity', interaction)) return this.deny(interaction);
        const multiplier = interaction.options.getNumber('multiplier', true);
        this.bridge.setSensitivity(multiplier);
        const current = this.bridge.getSensitivity();
        const desc =
          multiplier === 1.0
            ? 'Reset to default — smooth, relaxed visuals.'
            : multiplier <= 1.15
              ? 'Slightly more reactive — beats will pulse a bit harder.'
              : multiplier <= 1.25
                ? 'Noticeably snappy — the visualizer will jump on every kick.'
                : 'Maximum reactivity — the visualizer goes wild.';
        await interaction.reply({
          embeds: [
            new EmbedBuilder()
              .setTitle('🎛️ Beat Sensitivity')
              .setDescription(`**${current.toFixed(2)}x** — ${desc}`)
              .setColor(this.themeColor())
              .setFooter({ text: 'Lower smoothing = faster visual response' }),
          ],
        });
        break;
      }

      case 'theme': {
        if (!this.requireLevel('theme', interaction)) return this.deny(interaction);
        const name = interaction.options.getString('name');
        if (!name) {
          const current = this.bridge.getTheme();
          const lines = THEMES.map((t) => `${t.id === current.id ? '▶' : '•'} **${t.name}** (\`${t.id}\`)`).join('\n');
          await interaction.reply({
            embeds: [new EmbedBuilder().setTitle('Visual themes').setDescription(lines).setColor(this.themeColor())],
          });
          break;
        }
        const theme = themeById(name.toLowerCase());
        if (!theme) {
          await interaction.reply(`Unknown theme \`${name}\`. Try ${THEMES.map((t) => `\`${t.id}\``).join(', ')}.`);
          break;
        }
        this.bridge.setTheme(theme);
        await interaction.reply(`🎨 Theme set to **${theme.name}** — panel, player, and embeds re-skinned.`);
        break;
      }

      case 'wave': {
        await interaction.deferReply();
        const gif = analyzer.renderGif();
        if (!gif) {
          await interaction.editReply('Nothing playing, or the audio is too quiet for a waveform right now.');
          break;
        }
        await interaction.editReply({
          content: '📊 Waveform — last ~2.4s:',
          files: [new AttachmentBuilder(gif, { name: 'vaporzr-wave.gif' })],
        });
        break;
      }

      case 'burst': {
        if (!this.requireLevel('burst', interaction)) return this.deny(interaction);
        await interaction.deferReply();
        await this.handleBurst(interaction);
        break;
      }

      case 'wav': {
        if (!this.requireLevel('wav', interaction)) return this.deny(interaction);
        const file = interaction.options.getAttachment('file');
        if (!file) {
          await interaction.reply({ content: 'No file attached.', flags: MessageFlags.Ephemeral });
          break;
        }
        await interaction.deferReply();
        await this.playUploadedFile(
          s,
          { name: file.name, url: file.url },
          interaction.member?.user.username ?? 'unknown',
          () => this.ensureJoinedForPlayback(interaction, s),
          async (embed) => interaction.editReply({ embeds: [embed] }),
        );
        break;
      }

      case 'perms':
        await this.handlePerms(interaction);
        break;

      case 'dj': {
        if (!this.requireLevel('dj', interaction)) return this.deny(interaction);
        if (!interaction.guildId) {
          await interaction.reply({ content: 'Must be used inside a server.', flags: MessageFlags.Ephemeral });
          break;
        }
        const enabled = interaction.options.getBoolean('enabled');
        if (enabled === null) {
          await interaction.reply(
            s.playback.isDjEnabled(interaction.guildId)
              ? '🎛️ DJ effects are **on** for this server.'
              : '🎛️ DJ effects are **off** for this server. A mod can enable them with `/dj on`.',
          );
          break;
        }
        s.playback.setDjEnabled(interaction.guildId, enabled);
        this.bridge.notifyDj();
        await this.refreshAllPanels();
        await interaction.reply(
          enabled
            ? '🎛️ DJ effects **enabled** — soundboard buttons added to the control panel.'
            : '🎛️ DJ effects **disabled** — clean listening sessions restored.',
        );
        break;
      }

      case 'sfx': {
        if (!this.requireLevel('sfx', interaction)) return this.deny(interaction);
        if (!interaction.guildId) {
          await interaction.reply({ content: 'Must be used inside a server.', flags: MessageFlags.Ephemeral });
          break;
        }
        if (!s.playback.isDjEnabled(interaction.guildId)) {
          await interaction.reply({ content: '🎛️ DJ effects are off for this server. A mod can enable them with `/dj on`.', flags: MessageFlags.Ephemeral });
          break;
        }
        const sound = interaction.options.getString('sound');
        if (!sound) {
          const sounds = s.playback.listSoundEffects();
          await interaction.reply({
            content: `🎛️ **Soundboard** — ${sounds.map((snd) => `${snd.emoji} \`${snd.id}\``).join('  ')}\nPlay one with \`/sfx <sound>\` or the panel buttons.`,
            flags: MessageFlags.Ephemeral,
          });
          break;
        }
        const ok = await s.playback.playSoundEffect(sound);
        await interaction.reply(
          ok
            ? `${s.playback.listSoundEffects().find((snd) => snd.id === sound)?.emoji ?? ''} **${sound}**! 🎧`
            : `Unknown sound \`${sound}\`. Try ${s.playback.listSoundEffects().map((snd) => `\`${snd.id}\``).join(', ')}.`,
        );
        break;
      }

      case 'help': {
        await interaction.reply({ embeds: [this.helpEmbed()], flags: MessageFlags.Ephemeral });
        break;
      }

      case 'invite': {
        const appId = this.client.user!.id;
        const perms = (1n << 11n) | (1n << 14n) | (1n << 15n) | (1n << 20n) | (1n << 31n) | (1n << 52n);
        const url = `https://discord.com/oauth2/authorize?client_id=${appId}&permissions=${perms}&scope=bot+applications.commands`;
        await interaction.reply({
          content: '➕ **Add Vaporzr to a server** — pick the server in the dropdown, hit Authorize, done.',
          components: [
            new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder().setLabel('➕ Add to your server').setStyle(ButtonStyle.Link).setURL(url),
            ),
          ],
          flags: MessageFlags.Ephemeral,
        });
        break;
      }

      case 'stats': {
        await interaction.reply({ embeds: [this.statsEmbed()], flags: MessageFlags.Ephemeral });
        break;
      }

      default:
        await interaction.reply('Unknown command.');
    }
    this.commandsRun++;
  }

  // ---- Prefix commands (V@…) ----

  private async handleMessageCommand(message: Message): Promise<void> {
    if (message.author.bot) return;
    if (!message.content.startsWith('v@') && !message.content.startsWith('V@')) return;
    if (message.guildId && message.channelId) {
      this.lastTextChannel.set(message.guildId, message.channelId);
      this.scheduleSavePanels();
    }

    const rest = message.content.slice(2).trimStart();
    if (!rest) {
      await message.reply('Vaporzr commands — try `V@p <link or search>`, `V@s`, `V@i <link or search>`, `V@q`, or `V@help`.');
      return;
    }
    const [rawCmd, ...rawArgs] = rest.split(/\s+/);
    const cmd = rawCmd.toLowerCase();
    const args = rawArgs.join(' ');
    const s = this.sessionFor(message.guildId);

    const canUse = (c: string): boolean => {
      if (!message.inGuild() || !message.member) return true;
      return this.perms.can(c, message.guild!, message.member);
    };
    const canWindow = (): boolean => this.requireWindowOwner(message.author.id, message.guild, message.member);
    const deny = async (): Promise<never> => {
      await message.reply('⛔ You don\'t have permission to do that.');
      throw new Error('denied');
    };

    // Rate limit prefix commands against the same bucket as their / command.
    const alias: Record<string, string> = {
      p: 'play', play: 'play',
      i: 'insert', insert: 'insert',
      s: 'skip', skip: 'skip',
      pau: 'pause', pause: 'pause',
      r: 'resume', resume: 'resume',
      t: 'toggle', toggle: 'toggle',
      v: 'volume', vol: 'volume', volume: 'volume',
      q: 'queue', queue: 'queue',
      np: 'nowplaying', nowplaying: 'nowplaying',
      c: 'clear', clear: 'clear', stop: 'clear',
      rem: 'remove', remove: 'remove',
      sh: 'shuffle', shuffle: 'shuffle',
      j: 'join', join: 'join',
      l: 'leave', leave: 'leave',
      wav: 'wav', file: 'wav',
      pan: 'panel', panel: 'panel', key: 'key',
      sc: 'screensaver', screensaver: 'screensaver',
      th: 'theme', theme: 'theme',
      wave: 'wave',
      burst: 'burst',
      player: 'player', open: 'player',
      dj: 'dj',
      sfx: 'sfx',
      sens: 'sensitivity', sensitivity: 'sensitivity',
      ew: 'endwav', endwav: 'endwav',
      help: 'help',
    };
    const canonical = alias[cmd];
    if (canonical) {
      const wait = this.cooldownRemaining(message.author.id, canonical);
      if (wait > 0) {
        await message.reply(`⏳ Slow down — try again in ${Math.ceil(wait / 1000)}s.`);
        return;
      }
    }

    try {
      switch (cmd) {
        case 'p':
        case 'play': {
          if (!args) return void (await message.reply('Usage: `V@p <track name or link>`'));
          const tracks = await resolvePlayInput(args);
          await this.addToQueueMsg(message, tracks);
          break;
        }

        case 'wav':
        case 'file': {
          if (!canUse('wav')) return void (await deny());
          const attachment = message.attachments.first();
          if (!attachment) {
            return void (await message.reply('Attach a file to your message — e.g. `V@wav` with a .wav/.mp4 attached.'));
          }
          await this.playUploadedFile(
            s,
            { name: attachment.name ?? 'file', url: attachment.url },
            message.author.username,
            () => this.ensureJoinedForMessage(message, s),
            async (embed) => message.reply({ embeds: [embed] }),
          );
          break;
        }

        case 'i':
        case 'insert': {
          if (!args) return void (await message.reply('Usage: `V@i <track name or link>`'));
          const tracks = await resolvePlayInput(args);
          await this.insertToQueueMsg(message, tracks);
          break;
        }

        case 's':
        case 'skip': {
          if (!canUse('skip')) return void (await deny());
          s.playback.next();
          this.scheduleWaveTopUp(s);
          const np = this.nowPlayingEmbed(s, '⏭️ Skipped');
          if (np) await message.reply({ embeds: [np] });
          else await message.reply('⏭️ Skipped — queue ended');
          break;
        }

        case 'pau':
        case 'pause': {
          if (!canUse('pause')) return void (await deny());
          s.playback.pause();
          await message.reply('⏸️ Paused');
          break;
        }

        case 'r':
        case 'resume': {
          if (!canUse('resume')) return void (await deny());
          await s.playback.resume();
          await message.reply('▶️ Resumed');
          break;
        }

        case 't':
        case 'toggle': {
          if (!canUse('pause')) return void (await deny());
          await s.playback.toggle();
          await message.reply(s.queue.getState().playing ? '▶️ Resumed' : '⏸️ Paused');
          break;
        }

        case 'v':
        case 'vol':
        case 'volume': {
          if (!canUse('volume')) return void (await deny());
          const n = Number(args);
          if (!args || Number.isNaN(n)) {
            await message.reply(`🔊 Current volume is **${s.queue.getState().volume}%**`);
            break;
          }
          s.playback.volume(Math.max(0, Math.min(100, n)));
          await message.reply(`🔊 Volume set to ${n}%`);
          break;
        }

        case 'q':
        case 'queue': {
          const snap = s.queue.getSnapshot();
          if (snap.tracks.length === 0) {
            await message.reply('The queue is empty.');
            break;
          }
          const { embeds, components } = this.queuePage(s);
          await message.reply({ embeds, components });
          break;
        }

        case 'np':
        case 'nowplaying': {
          if (!message.inGuild()) return void (await message.reply('Must be used inside a server.'));
          const guildId = message.guildId!;
          // Repost at the bottom instead of refreshing a scrolled-up old message.
          const existing = this.npMessages.get(guildId);
          if (existing) {
            await this.deleteNp(existing.channelId, existing.messageId);
            this.npMessages.delete(guildId);
          }
          if (!('send' in message.channel)) return void (await message.reply('Cannot post here.'));
          const sent = await message.channel.send({ embeds: [this.npPayload(s)] });
          this.npMessages.set(guildId, { channelId: message.channelId, messageId: sent.id });
          this.scheduleSavePanels();
          await message.reply('🔴 Live now-playing message posted right here — it updates itself.');
          break;
        }

        case 'c':
        case 'clear':
        case 'stop': {
          if (!canUse('clear')) return void (await deny());
          s.playback.stopAll();
          s.queue.clear();
          await message.reply('🗑️ Queue cleared');
          break;
        }

        case 'rem':
        case 'remove': {
          if (!canUse('remove')) return void (await deny());
          const n = Number(args);
          if (!args || Number.isNaN(n)) return void (await message.reply('Usage: `V@remove <queue number>`'));
          const removed = s.queue.remove(n - 1);
          await message.reply(removed ? `Removed **${removed.name}**` : 'Index out of range.');
          break;
        }

        case 'sh':
        case 'shuffle': {
          if (!canUse('shuffle')) return void (await deny());
          const next = !s.queue.getState().shuffle;
          s.playback.shuffle(next);
          await message.reply(next ? '🔀 Shuffle on' : '🔂 Shuffle off');
          break;
        }

        case 'j':
        case 'join': {
          if (!canUse('join')) return void (await deny());
          if (!message.inGuild()) return void (await message.reply('Must be used inside a server.'));
          const channel = message.member?.voice?.channel;
          if (!channel) return void (await message.reply('You must be in a voice channel first.'));
          try {
            s.playback.stopAll();
            s.queue.clear();
            await s.voice.join(message.guild!.id, channel.id, message.guild!.voiceAdapterCreator);
            await message.reply(`🔊 Joined **${channel.name}** — queue cleared, ready to stream.`);
          } catch (err) {
            await message.reply(`❌ Could not join: ${err instanceof Error ? err.message : String(err)}`);
          }
          break;
        }

        case 'l':
        case 'leave': {
          if (!canUse('leave')) return void (await deny());
          s.playback.stopAll();
          s.queue.clear();
          s.voice.leave();
          await message.reply('👋 Left the voice channel. Queue cleared.');
          break;
        }

        case 'dj': {
          if (!canUse('dj')) return void (await deny());
          if (!message.guildId) return void (await message.reply('Must be used inside a server.'));
          if (args) {
            const on = args.toLowerCase() === 'on' || args.toLowerCase() === 'true';
            s.playback.setDjEnabled(message.guildId, on);
            this.bridge.notifyDj();
            await message.reply(on ? '🎛️ DJ effects enabled.' : '🎛️ DJ effects disabled.');
          } else {
            await message.reply(
              s.playback.isDjEnabled(message.guildId)
                ? '🎛️ DJ effects are **on**. `V@dj off` to disable.'
                : '🎛️ DJ effects are **off**. A mod can enable them with `V@dj on`.',
            );
          }
          await this.refreshAllPanels();
          break;
        }

        case 'sfx': {
          if (!canUse('sfx')) return void (await deny());
          if (!message.guildId) return void (await message.reply('Must be used inside a server.'));
          if (!s.playback.isDjEnabled(message.guildId)) {
            await message.reply('🎛️ DJ effects are off for this server. A mod can enable them with `V@dj on`.');
            break;
          }
          if (!args) {
            const sounds = s.playback.listSoundEffects();
            await message.reply(
              `🎛️ **Soundboard** — ${sounds.map((snd) => `${snd.emoji} \`${snd.id}\``).join('  ')}\nTry e.g. \`V@sfx drop\`.`,
            );
            break;
          }
          const id = args.trim().split(/\s+/)[0].toLowerCase();
          const ok = await s.playback.playSoundEffect(id);
          await message.reply(
            ok
              ? `${s.playback.listSoundEffects().find((snd) => snd.id === id)?.emoji ?? ''} **${id}**! 🎧`
              : `Unknown sound \`${id}\`. Try ${s.playback.listSoundEffects().map((snd) => `\`${snd.id}\``).join(', ')}.`,
          );
          break;
        }

        case 'sens':
        case 'sensitivity': {
          if (!canUse('sensitivity')) return void (await deny());
          const val = args ? parseFloat(args) : NaN;
          const valid = [1.0, 1.10, 1.15, 1.25, 1.50];
          if (!args || isNaN(val) || !valid.includes(val)) {
            const current = this.bridge.getSensitivity();
            await message.reply(
              `🎛️ **Beat Sensitivity:** \`${current.toFixed(2)}x\`\nUsage: \`V@sens <multiplier>\`\nOptions: ${valid.map((v) => `\`${v}\``).join(', ')}`,
            );
            break;
          }
          this.bridge.setSensitivity(val);
          await message.reply(`🎛️ Sensitivity set to **${val.toFixed(2)}x**`);
          break;
        }

        case 'pan':
        case 'panel': {
          if (!this.isAdminMember(message.author.id, message.guild, message.member)) {
            await message.reply('⛔ Admins only — server admins can post the panel (or `/perms` grant admin to a role).');
            return;
          }
          if (!canUse('panel')) return void (await deny());
          if (!message.inGuild()) return void (await message.reply('Must be used inside a server.'));
          const guildId = message.guildId!;
          await message.reply('🎛️ Bringing the control panel down to you.');
          // Re-post at the bottom of the channel (old copy deleted) so it's
          // visible without scrolling back up.
          await this.repostPanel(guildId, message.channel as GuildTextBasedChannel);
          break;
        }

        case 'key': {
          const wantsRotate = (message.content.trim().split(/\s+/)[2] ?? '') === 'rotate';
          if (wantsRotate) {
            if (!this.perms.isOwner(message.author.id)) return void (await deny());
            const newKey = randomBytes(12).toString('base64url');
            config.shareKey = newKey; // live immediately
            try {
              const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
              let env = '';
              try {
                env = await fs.readFile(envPath, 'utf8');
              } catch {
                /* new file */
              }
              if (/^SHARE_KEY=.*$/m.test(env)) env = env.replace(/^SHARE_KEY=.*$/m, `SHARE_KEY=${newKey}`);
              else env += (env.endsWith('\n') ? '' : '\n') + `SHARE_KEY=${newKey}\n`;
              await fs.writeFile(envPath, env, 'utf8');
            } catch (err) {
              console.warn(`[discord] could not persist SHARE_KEY: ${err instanceof Error ? err.message : err}`);
            }
            const pl = vizTunnel.panelLink();
            const linkLine = pl.secure ? `${pl.url}?key=${newKey}` : `(links appear once PUBLIC_BASE_URL or a tunnel is up)`;
            await message.reply(`🔑 New key issued — all previous links and remembered devices are dead.\n${linkLine}`);
            break;
          }
          if (!canUse('key')) return void (await deny());
          if (!config.shareKey) {
            await message.reply('No share key is configured — the web panel is open access.');
            break;
          }
          const kpl = vizTunnel.panelLink();
          const kvl = vizTunnel.vizLink();
          await message.reply({
            embeds: [
              new EmbedBuilder()
                .setTitle('🔑 Web access links')
                .setDescription(
                  `Pre-authorized — opens once, then that device is remembered.\n\n` +
                    `🎛️ **Control panel:** <${kpl.url}?key=${config.shareKey}>\n` +
                    `🌈 **Visualizer:** <${kvl.url}?key=${config.shareKey}>` +
                    `\n\n🥚 *Psst… this server can now rename me — try* \`V@nick Neon-rzr\``,
                )
                .setColor(this.themeColor())
                .setFooter({ text: 'Keep these links private — anyone holding them gets in · V@key rotate to revoke all' }),
            ],
          });
          if (message.guildId) await this.markKeyedGuild(message.guildId);
          break;
        }

        case 'sc':
        case 'screensaver': {
          const svl = vizTunnel.vizLink();
          await message.reply(`🎬 Fullscreen visuals live in the browser now:\n${svl.url}\n\nOpen it and tap ⛶ (or F) for fullscreen.`);
          break;
        }

        case 'ew':
        case 'endwav': {
          if (!canUse('endwav')) return void (await deny());
          if (!message.guildId) return void (await message.reply('Must be used in a server.'));
          const ewS = this.sessionFor(message.guildId);
          const subCmd = (args || 'status').toLowerCase();
          if (subCmd === 'on' || subCmd === 'activate') {
            if (ewS.endlessWave.active) return void (await message.reply('🌊 Endless Wave is already active.'));
            EW.activate(ewS.endlessWave);
            this.ewRetryAfter.delete(message.guildId);
            const cur = ewS.queue.getCurrentTrack();
            if (cur) EW.markPlayed(ewS.endlessWave, cur.uri, cur.name, cur.artists);
            this.bridge.broadcast({ type: 'endlesswave', active: true, generated: 0 });
            const ewPrefixMsg = '🌊 **Endless Wave activated** — I\'ll keep the vibes flowing with AI-curated tracks that evolve with your session.';
            await message.reply(cur ? ewPrefixMsg : `${ewPrefixMsg}\nQueue up a track to set the vibe — I'll take it from there.`);
            if (cur) {
              void EW.fetchFeatures(cur)
                .then((af) => { if (af) EW.recordFeatures(ewS.endlessWave, af); })
                .catch(() => {});
            }
            void this.topUpWave(ewS).catch((err) => {
              console.warn(`[endlesswave] initial top-up failed: ${err instanceof Error ? err.message : err}`);
            });
          } else if (subCmd === 'off' || subCmd === 'deactivate') {
            if (!ewS.endlessWave.active) return void (await message.reply('Endless Wave isn\'t active right now.'));
            EW.deactivate(ewS.endlessWave);
            this.ewRetryAfter.delete(message.guildId);
            const t = this.ewTopUpTimers.get(message.guildId!);
            if (t) clearTimeout(t);
            this.ewTopUpTimers.delete(message.guildId!);
            this.ewStartedUri.delete(message.guildId!);
            this.bridge.broadcast({ type: 'endlesswave', active: false, generated: ewS.endlessWave.generated });
            await message.reply(`🌊 **Endless Wave deactivated** — ${ewS.endlessWave.generated} tracks were auto-curated this session.`);
          } else {
            const snap = EW.snapshot(ewS.endlessWave);
            await message.reply(snap.active
              ? `🌊 **Endless Wave is active** — ${snap.generated} tracks generated, ${snap.playedCount} unique tracks played.`
              : 'Endless Wave is not active. Use `V@ew on` to start.');
          }
          break;
        }

        case 'th':
        case 'theme': {
          if (!canUse('theme')) return void (await deny());
          if (!args) {
            const current = this.bridge.getTheme();
            const lines = THEMES.map((t) => `${t.id === current.id ? '▶' : '•'} **${t.name}** (\`${t.id}\`)`).join('\n');
            await message.reply({
              embeds: [new EmbedBuilder().setTitle('Visual themes').setDescription(lines).setColor(this.themeColor())],
            });
            break;
          }
          const theme = themeById(args.toLowerCase());
          if (!theme) {
            await message.reply(`Unknown theme \`${args}\`. Try ${THEMES.map((t) => `\`${t.id}\``).join(', ')}.`);
            break;
          }
          this.bridge.setTheme(theme);
          await message.reply(`🎨 Theme set to **${theme.name}** — panel, player, and embeds re-skinned.`);
          break;
        }

        case 'wave': {
          const gif = analyzer.renderGif();
          if (!gif) {
            await message.reply("Nothing playing, or the audio is too quiet for a waveform right now.");
            break;
          }
          if ('send' in message.channel) {
            await message.channel.send({ content: '📊 Waveform — last ~2.4s:', files: [new AttachmentBuilder(gif, { name: 'vaporzr-wave.gif' })] });
          }
          break;
        }

        case 'burst': {
          if (!canUse('burst')) return void (await deny());
          if (!this.bridge.hasVisualizers()) {
            await message.reply("The visualizer isn't running. Open the player window (V@player) first.");
            break;
          }
          const data = await this.captureBurst();
          if (!data) {
            await message.reply('No clip captured — is something playing?');
            break;
          }
          const gif = await webmToGif(data);
          if (!gif) {
            await message.reply('Could not convert the clip.');
            break;
          }
          if ('send' in message.channel) {
            await message.channel.send({ content: '🎞 Visual burst:', files: [new AttachmentBuilder(gif, { name: 'vaporzr-burst.gif' })] });
          }
          break;
        }

        case 'player':
        case 'open': {
          const vl = vizTunnel.vizLink();
          await message.reply(`🚀 The player lives in your browser now:\n${vl.url}\n\nTap ⛶ there for fullscreen.`);
          break;
        }

        case 'viz': {
          const admin = this.isAdminMember(message.author.id, message.guild, message.member);
          await message.reply({ embeds: [this.vizEmbed(admin)] });
          break;
        }

        case 'help': {
          await message.reply({ embeds: [this.helpEmbed()] });
          break;
        }

        case 'invite': {
          const appId = this.client.user!.id;
          const perms = (1n << 11n) | (1n << 14n) | (1n << 15n) | (1n << 20n) | (1n << 31n) | (1n << 52n);
          const url = `https://discord.com/oauth2/authorize?client_id=${appId}&permissions=${perms}&scope=bot+applications.commands`;
          await message.reply({
            content: '➕ **Add Vaporzr to a server** — pick the server in the dropdown, hit Authorize, done.',
            components: [
              new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder().setLabel('➕ Add to your server').setStyle(ButtonStyle.Link).setURL(url),
              ),
            ],
          });
          break;
        }

        default:
          await message.reply(`Unknown command \`V@${cmd}\`. Try \`V@help\`.`);
      }
    } catch (err) {
      if (err instanceof Error && err.message === 'denied') return;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[discord] V@ command error: ${msg}`);
      await message.reply(`⚠️ ${friendlyPlayError(err)}`);
    }
    this.commandsRun++;
  }

  private async addToQueueMsg(message: Message, tracks: ResolvedTrack[]): Promise<void> {
    const s = this.sessionFor(message.guildId);
    const first = tracks[0];
    const requestedBy = message.author.username;
    s.queue.enqueueMany(tracks, requestedBy);
    if (first) s.playback.prefetchStream(first);
    let playbackFailed: string | null = null;
    try {
      await this.ensureJoinedForMessage(message, s);
      if (!s.queue.getState().playing) {
        await s.playback.play();
      }
    } catch (err) {
      playbackFailed = err instanceof Error ? err.message : String(err);
      console.warn(`[discord] queued but couldn't start playback: ${playbackFailed}`);
    }
    const embed = new EmbedBuilder()
      .setTitle('Inserted to play next')
      .setDescription(
        `${srcEmoji(first.source)} **${first.name}** — ${truncate(first.artists.join(', '), 80)}` +
          (playbackFailed ? `\n⚠️ Couldn't start playback yet: ${playbackFailed}` : ''),
      )
      .setThumbnail(first.image ?? '')
      .setFooter({ text: `${tracks.length} track${tracks.length > 1 ? 's' : ''} · ${s.queue.getSnapshot().tracks.length} in queue` })
      .setColor(this.themeColor());
    await message.reply({ embeds: [embed] });
  }

  /** Download a Discord attachment and queue it as a locally-streamed track. */
  private async playUploadedFile(
    s: Session,
    file: { name: string; url: string },
    requester: string,
    ensureJoined: () => Promise<boolean>,
    reply: (embed: EmbedBuilder) => Promise<unknown>,
  ): Promise<void> {
    const dir = path.join(config.dataDir, 'uploads');
    await fs.mkdir(dir, { recursive: true });
    const safe = file.name.replace(/[^A-Za-z0-9._-]+/g, '_');
    const filePath = path.join(dir, `${Date.now()}-${safe}`);
    const res = await fetch(file.url);
    if (!res.ok) throw new Error(`Could not download the attachment (HTTP ${res.status}).`);
    const buf = Buffer.from(await res.arrayBuffer());
    await fs.writeFile(filePath, buf);
    const track: Omit<TrackInfo, 'addedBy' | 'addedAt'> = {
      uri: `local:${Date.now()}:${safe}`,
      name: file.name.replace(/\.[^.]+$/, ''),
      artists: ['Local file'],
      album: 'Uploads',
      durationMs: 0,
      source: 'local',
      filePath,
    };
    s.queue.enqueue(track, requester);
    let playbackFailed: string | null = null;
    try {
      await ensureJoined();
      if (!s.queue.getState().playing) {
        await s.playback.play();
      }
    } catch (err) {
      playbackFailed = err instanceof Error ? err.message : String(err);
      console.warn(`[discord] queued but couldn't start playback: ${playbackFailed}`);
    }
    const embed = new EmbedBuilder()
      .setTitle('Added to queue')
      .setDescription(
        `📂 **${track.name}** — local file` +
          (playbackFailed ? `\n⚠️ Couldn't start playback yet: ${playbackFailed}` : ''),
      )
      .setFooter({ text: `${s.queue.getSnapshot().tracks.length} in queue` })
      .setColor(this.themeColor());
    await reply(embed);
  }

  private async insertToQueueMsg(message: Message, tracks: ResolvedTrack[]): Promise<void> {
    const s = this.sessionFor(message.guildId);
    const first = tracks[0];
    const requestedBy = message.author.username;
    s.queue.insertAfterCurrent(tracks, requestedBy);
    if (first) s.playback.prefetchStream(first);
    let playbackFailed: string | null = null;
    try {
      await this.ensureJoinedForMessage(message, s);
      if (!s.queue.getState().playing) {
        await s.playback.play();
      }
    } catch (err) {
      playbackFailed = err instanceof Error ? err.message : String(err);
      console.warn(`[discord] queued but couldn't start playback: ${playbackFailed}`);
    }
    const embed = new EmbedBuilder()
      .setTitle('Inserted to play next')
      .setDescription(
        `${srcEmoji(first.source)} **${first.name}** — ${first.artists.join(', ')}` +
          (playbackFailed ? `\n⚠️ Couldn't start playback yet: ${playbackFailed}` : ''),
      )
      .setThumbnail(first.image ?? '')
      .setFooter({ text: `${tracks.length} track${tracks.length > 1 ? 's' : ''} · ${s.queue.getSnapshot().tracks.length} in queue` })
      .setColor(this.themeColor());
    await message.reply({ embeds: [embed] });
  }

  /** Auto-join the author's voice channel before playback (message-command variant). */
  private async ensureJoinedForMessage(message: Message, s: Session): Promise<boolean> {
    if (s.voice.isJoined()) return true;
    if (!message.inGuild()) return false;
    const channel = message.member?.voice?.channel;
    if (!channel) return false;
    try {
      await s.voice.join(message.guild!.id, channel.id, message.guild!.voiceAdapterCreator);
    } catch (err) {
      // Joins can time out transiently (voice gateway hiccup); the internal
      // retry usually lands seconds later — auto-resume queued playback then.
      this.scheduleAutoResume(s);
      throw err;
    }
    const state = s.queue.getState();
    if (state.playing) s.voice.startStream();
    console.log('[discord] auto-joined voice channel');
    return true;
  }

  private autoResumeTimers = new Map<string, NodeJS.Timeout>();

  /** Resume queued playback automatically once voice recovers from a join timeout. */
  private scheduleAutoResume(s: Session): void {
    const key = s.guildId || '__dm__';
    if (this.autoResumeTimers.has(key)) return;
    let waited = 0;
    const t: NodeJS.Timeout = setInterval(() => {
      waited += 1500;
      if (!s.voice.isJoined()) {
        if (waited >= 30000) {
          clearInterval(t);
          this.autoResumeTimers.delete(key);
          console.warn('[discord] auto-resume gave up — voice never recovered within 30s');
        }
        return;
      }
      clearInterval(t);
      this.autoResumeTimers.delete(key);
      const st = s.queue.getState();
      if (!st.playing && st.track) {
        console.log('[discord] voice recovered — auto-resuming queued track');
        void s.playback.play().catch((err) => {
          console.warn(`[discord] auto-resume failed: ${err instanceof Error ? err.message : err}`);
        });
      }
    }, 1500);
    t.unref?.();
    this.autoResumeTimers.set(key, t);
  }

  private async insertToQueue(interaction: ChatInputCommandInteraction, tracks: ResolvedTrack[]): Promise<void> {
    const s = this.sessionFor(interaction.guildId);
    const first = tracks[0];
    const requestedBy = interaction.member?.user.username ?? 'unknown';
    s.queue.insertAfterCurrent(tracks, requestedBy);
    if (first) s.playback.prefetchStream(first);
    let playbackFailed: string | null = null;
    try {
      await this.ensureJoinedForPlayback(interaction, s);
      if (!s.queue.getState().playing) {
        await s.playback.play();
      }
    } catch (err) {
      playbackFailed = err instanceof Error ? err.message : String(err);
      console.warn(`[discord] queued but couldn't start playback: ${playbackFailed}`);
    }
    const embed = new EmbedBuilder()
      .setTitle('Inserted to play next')
      .setDescription(
        `${srcEmoji(first.source)} **${first.name}** — ${truncate(first.artists.join(', '), 80)}` +
          (playbackFailed ? `\n⚠️ Couldn't start playback yet: ${playbackFailed}` : ''),
      )
      .setThumbnail(first.image ?? '')
      .setFooter({ text: `${tracks.length} track${tracks.length > 1 ? 's' : ''} · ${s.queue.getSnapshot().tracks.length} in queue` })
      .setColor(this.themeColor());
    await interaction.editReply({ embeds: [embed] });
  }

  private async addToQueue(interaction: ChatInputCommandInteraction, tracks: ResolvedTrack[]): Promise<void> {
    const s = this.sessionFor(interaction.guildId);
    const first = tracks[0];
    const requestedBy = interaction.member?.user.username ?? 'unknown';
    s.queue.enqueueMany(tracks, requestedBy);
    // Warm the stream resolve while the voice-channel join is in flight so
    // playback starts as soon as the join completes instead of serially after.
    if (first) s.playback.prefetchStream(first);
    let playbackFailed: string | null = null;
    try {
      await this.ensureJoinedForPlayback(interaction, s);
      if (!s.queue.getState().playing) {
        await s.playback.play();
      }
    } catch (err) {
      playbackFailed = err instanceof Error ? err.message : String(err);
      console.warn(`[discord] queued but couldn't start playback: ${playbackFailed}`);
    }
    const embed = new EmbedBuilder()
      .setTitle('Added to queue')
      .setDescription(
        `${srcEmoji(first.source)} **${first.name}** — ${truncate(first.artists.join(', '), 80)}` +
          (playbackFailed ? `\n⚠️ Couldn't start playback yet: ${playbackFailed}` : ''),
      )
      .setThumbnail(first.image ?? '')
      .setFooter({ text: `${tracks.length} track${tracks.length > 1 ? 's' : ''} · ${s.queue.getSnapshot().tracks.length} in queue` })
      .setColor(this.themeColor());
    await interaction.editReply({ embeds: [embed] });
  }

  private async deny(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.reply({ content: '⛔ You don\'t have permission to do that.', flags: MessageFlags.Ephemeral });
  }

  /** Auto-join the author's voice channel before playback, Luna/Jockie-style. */
  private async ensureJoinedForPlayback(interaction: ChatInputCommandInteraction, s: Session): Promise<boolean> {
    if (s.voice.isJoined()) return true;
    if (!interaction.inGuild()) return false;
    const member = interaction.member;
    if (!member || !('voice' in member)) return false;
    const channel = member.voice.channel;
    if (!channel) return false;
    await s.voice.join(interaction.guild!.id, channel.id, interaction.guild!.voiceAdapterCreator);
    const state = s.queue.getState();
    if (state.playing) s.voice.startStream();
    console.log('[discord] auto-joined voice channel');
    return true;
  }

  private async handlePerms(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!this.requireLevel('perms', interaction)) return this.deny(interaction);
    const guild = interaction.guild!;
    const sub = interaction.options.getSubcommand();

    if (sub === 'view') {
      const snap = this.perms.snapshot(guild.id);
      const fmt = (ids: string[], level: PermissionLevel) => {
        if (ids.length === 0) return `no ${level} roles set (everyone is ${level === 'user' ? 'allowed' : level})`;
        return ids.map((id) => `<@&${id}>`).join(', ');
      };
      const lines = [
        `**Admin roles:** ${fmt(snap.adminRoles, 'admin')}`,
        `**Mod roles:** ${fmt(snap.modRoles, 'mod')}`,
        `**Command overrides:** ${
          Object.keys(snap.commandLevels).length ? Object.entries(snap.commandLevels).map(([c, l]) => `\`${c}\` → ${l}`).join(', ') : 'none'
        }`,
      ];
      await interaction.reply({ embeds: [new EmbedBuilder().setTitle('Permissions').setDescription(lines.join('\n')).setColor(this.themeColor())] });
      return;
    }

    if (sub === 'set') {
      const command = interaction.options.getString('command', true);
      const level = interaction.options.getString('level', true) as PermissionLevel;
      this.perms.setCommandLevel(guild.id, command, level);
      this.bridge.broadcastPermission(guild.id);
      await interaction.reply(`Set \`${command}\` to require **${level}**.`);
      return;
    }

    if (sub === 'role') {
      const action = interaction.options.getString('action', true);
      const level = interaction.options.getString('level', true) as PermissionLevel;
      const role = interaction.options.getRole('role', true);
      if (action === 'add') this.perms.addRole(guild.id, level, role.id);
      else this.perms.removeRole(guild.id, level, role.id);
      this.bridge.broadcastPermission(guild.id);
      await interaction.reply(`**${action === 'add' ? 'Granted' : 'Revoked'}** ${role.name} at ${level} level.`);
      return;
    }
  }

  // ---- Control panel ----

  private schedulePanelRefresh(): void {
    if (this.panelRefreshQueued) return;
    this.panelRefreshQueued = true;
    setTimeout(() => {
      this.panelRefreshQueued = false;
      void this.refreshAllPanels();
    }, 800);
  }

  private async refreshAllPanels(): Promise<void> {
    for (const [guildId, panel] of this.panels) {
      if (!(await this.editPanel(panel.channelId, panel.messageId, guildId))) {
        this.panels.delete(guildId);
      }
    }
    // Live "PLAYING NOW" messages ride the same refresh cycle.
    for (const [guildId, np] of this.npMessages) {
      if (!(await this.editNp(np.channelId, np.messageId, guildId))) {
        this.npMessages.delete(guildId);
      }
    }
    // Always-on mini now-playing — same cycle, compact embed.
    for (const [guildId, mini] of this.miniNp) {
      if (!(await this.editMiniNp(mini.channelId, mini.messageId, guildId))) {
        this.miniNp.delete(guildId);
        this.miniTrackUri.delete(guildId);
      }
    }
    this.scheduleSavePanels();
  }

  /**
   * Posts the always-on mini now-playing message the first time a guild starts
   * playing — in whatever channel was last used for commands. After that it
   * updates in place on every queue/state change via refreshAllPanels, and
   * re-anchors to the bottom of the channel whenever the track changes so it
   * never gets buried by chat.
   */
  private async maybeAutoMiniNp(guildId: string | undefined, st: PlaybackState): Promise<void> {
    if (!guildId || !st.track) return;
    const channelId = this.lastTextChannel.get(guildId);
    if (!channelId) return;
    const uri = st.track.uri;
    if (this.miniTrackUri.get(guildId) === uri && this.miniNp.has(guildId)) return;
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !('send' in channel)) return;
      const existing = this.miniNp.get(guildId);
      if (existing) {
        // Re-anchor: delete the old strip so the fresh one sits at the bottom.
        try {
          const old = await channel.messages.fetch(existing.messageId);
          await old.delete();
        } catch { /* already gone */ }
      }
      const msg = await channel.send({ embeds: [this.miniNpPayload(this.sessionFor(guildId))] });
      this.miniNp.set(guildId, { channelId, messageId: msg.id });
      this.miniTrackUri.set(guildId, uri);
      this.scheduleSavePanels();
    } catch {
      /* no access to that channel — will retry on next state change */
    }
  }

  private async editMiniNp(channelId: string, messageId: string, guildId: string): Promise<boolean> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel?.isTextBased()) return false;
      const msg = await channel.messages.fetch(messageId);
      await msg.edit({ embeds: [this.miniNpPayload(this.sessionFor(guildId))] });
      return true;
    } catch (err) {
      return !isMessageGone(err);
    }
  }

  /** Compact always-on now-playing strip — the panel's small sibling. */
  private miniNpPayload(s: Session): EmbedBuilder {
    const st = s.queue.getState();
    const track = st.track;
    if (!track) {
      return new EmbedBuilder()
        .setColor(this.themeColor())
        .setDescription('⏸️ **Idle** — queue something with `/play` or `V@p`');
    }
    const dur = st.durationMs || track.durationMs || 0;
    const livePos = st.positionMs + (st.playing ? Math.max(0, Date.now() - (st.updatedAt || Date.now())) : 0);
    const pos = dur > 0 ? Math.min(livePos, dur) : st.positionMs;
    const slots = 10;
    const filled = dur ? Math.min(slots, Math.max(0, Math.round((pos / dur) * slots))) : 0;
    const bar = '▰'.repeat(filled) + '▱'.repeat(Math.max(0, slots - filled));
    const status = st.playing ? '▶️' : '⏸';
    const snap = s.queue.getSnapshot();
    const upNext = snap.tracks.find((x, i) => i > snap.tracks.findIndex((y) => y.current));
    const embed = new EmbedBuilder()
      .setColor(this.themeColor())
      .setDescription(
        `${status} ${srcEmoji(track.source)} **${truncate(track.name, 60)}**\n` +
          `${truncate((track.artists ?? []).join(', ') || track.album, 80)}\n` +
          `\`${bar}\` \`${fmtMs(pos)}\`/\`${fmtMs(dur)}\`` +
          (upNext ? `\n⏭ ${truncate(upNext.name, 42)}` : ''),
      );
    if (track.image) embed.setThumbnail(track.image);
    return embed;
  }

  private async editPanel(channelId: string, messageId: string, guildId: string): Promise<boolean> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel?.isTextBased()) return false;
      const msg = await channel.messages.fetch(messageId);
      await msg.edit(this.panelPayload(this.sessionFor(guildId)));
      return true;
    } catch (err) {
      // Only forget the panel when the message is truly gone. Permission or
      // network hiccups keep the registration so it self-heals once access
      // is restored (e.g. after a roles fix) — no need to re-run /panel.
      return !isMessageGone(err);
    }
  }

  private async editNp(channelId: string, messageId: string, guildId: string): Promise<boolean> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel?.isTextBased()) return false;
      const msg = await channel.messages.fetch(messageId);
      await msg.edit({ embeds: [this.npPayload(this.sessionFor(guildId))] });
      return true;
    } catch (err) {
      return !isMessageGone(err);
    }
  }

  /** Delete a previously-posted now-playing message so /nowplaying can re-anchor it
   *  at the bottom of the channel instead of refreshing a scrolled-up copy. */
  private async deleteNp(channelId: string, messageId: string): Promise<void> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel?.isTextBased()) return;
      const msg = await channel.messages.fetch(messageId);
      await msg.delete();
    } catch {
      /* already gone */
    }
  }

  /** Compact, self-updating "PLAYING NOW" embed for the dedicated /nowplaying message. */
  private npPayload(s: Session): EmbedBuilder {
    const st = s.queue.getState();
    const track = st.track;
    const dur = st.durationMs || track?.durationMs || 0;
    const livePos = st.positionMs + (st.playing ? Math.max(0, Date.now() - (st.updatedAt || Date.now())) : 0);
    const pos = dur > 0 ? Math.min(livePos, dur) : st.positionMs;
    const slots = 16;
    const filled = dur ? Math.min(slots, Math.max(0, Math.round((pos / dur) * slots))) : 0;
    const bar = '━'.repeat(filled) + (filled < slots ? '⬤' : '━') + '─'.repeat(Math.max(0, slots - filled - 1));
    const statusIcon = st.playing ? '▶️' : '⏸';
    const embed = new EmbedBuilder()
      .setColor(this.themeColor())
      .setTimestamp();
    if (this.client.user) {
      embed.setAuthor({ name: st.playing ? 'PLAYING NOW' : 'PAUSED', iconURL: this.client.user.displayAvatarURL() });
    }
    if (track) {
      const snap = s.queue.getSnapshot();
      const idx = snap.tracks.findIndex((x) => x.current) + 1;
      const upNext = snap.tracks.find((x, i) => i > snap.tracks.findIndex((y) => y.current));
      embed
        .setTitle(`${srcEmoji(track.source)} ${track.name}`)
        .setDescription(
          `${truncate((track.artists ?? []).join(', '), 80)}\n\n\`${bar}\`\n${statusIcon} \`${fmtMs(pos)} / ${fmtMs(dur)}\`` +
            (upNext ? `\n\n⏭️ **Up next:** ${upNext.name}` : ''),
        );
      if (track.image) embed.setThumbnail(track.image);
      embed.addFields([{ name: '📜 Queue', value: `${snap.tracks.length}${idx ? ` · #${idx} now` : ''}`, inline: true }]);
    } else {
      embed.setTitle('Nothing playing').setDescription('Queue something with /play — this message updates itself.');
    }
    embed.setFooter({ text: `${this.client.user?.username ?? 'Vaporzr'} · this message updates itself` });
    return embed;
  }

  private panelEmojis = new Map<string, { id: string; name: string }>();

  // ---- 🥚 nickname easter egg: unlocked per-guild by key activation ----
  private keyedGuilds = new Set<string>();
  private keyedGuildsLoaded = false;

  private async loadKeyedGuilds(): Promise<void> {
    if (this.keyedGuildsLoaded) return;
    try {
      const raw = await fs.readFile(path.join(config.dataDir, 'keyed-guilds.json'), 'utf8');
      const arr = JSON.parse(raw) as string[];
      if (Array.isArray(arr)) arr.forEach((g) => this.keyedGuilds.add(String(g)));
    } catch {
      /* none yet */
    }
    this.keyedGuildsLoaded = true;
  }

  private async markKeyedGuild(guildId: string): Promise<void> {
    await this.loadKeyedGuilds();
    if (this.keyedGuilds.has(guildId)) return;
    this.keyedGuilds.add(guildId);
    await fs.mkdir(config.dataDir, { recursive: true });
    await fs.writeFile(
      path.join(config.dataDir, 'keyed-guilds.json'),
      JSON.stringify([...this.keyedGuilds], null, 2),
      'utf8',
    );
  }

  /** Validate the easter-egg nickname: 1-2 words, ends in -rzr / -orzr / -porzr. */
  private validateVzName(raw: string): { ok: true; name: string } | { ok: false; reason: string } {
    const name = raw.trim().replace(/\s+/g, ' ');
    if (!name) return { ok: false, reason: 'Give me a name!' };
    if (name.length > 32) return { ok: false, reason: 'Max 32 characters (Discord nickname limit).' };
    if (name.split(' ').length > 2) return { ok: false, reason: 'Max 2 words.' };
    const lower = name.toLowerCase();
    if (!['-rzr', '-orzr', '-porzr'].some((sfx) => lower.endsWith(sfx))) {
      return { ok: false, reason: 'Must end with `-rzr`, `-orzr`, or `-porzr`.' };
    }
    return { ok: true, name };
  }

  /** Bump when panel icon art changes — stale uploaded emojis get replaced. */
  private static readonly PANEL_ICON_VERSION = 2;

  /**
   * Keep the bot's Discord avatar in sync with the generated brand logo.
   * Discord rate-limits avatar changes hard (2/hour), so only update when the
   * logo bytes actually changed (hash tracked in the data dir).
   */
  private async syncBotAvatar(): Promise<void> {
    try {
      const logoPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'logo.png');
      const logo = await fs.readFile(logoPath);
      const hash = createHash('sha256').update(logo).digest('hex');
      const hashFile = path.join(config.dataDir, 'avatar.hash');
      let last = '';
      try {
        last = (await fs.readFile(hashFile, 'utf8')).trim();
      } catch {
        /* first run */
      }
      if (last === hash) return;
      await this.client.user?.setAvatar(logo);
      await fs.mkdir(config.dataDir, { recursive: true });
      await fs.writeFile(hashFile, hash);
      console.log('[discord] bot avatar updated to brand logo');
    } catch (err) {
      console.warn(`[discord] avatar sync skipped: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Upload the generated Vaporzr panel icons as custom emojis (once) so the
   * Discord panel buttons use real icon art instead of Unicode glyphs.
   * Any failure falls back to Unicode per-button.
   */
  private async ensurePanelEmojis(): Promise<void> {
    try {
      const guild =
        this.client.guilds.cache.find((g) => g.members.me?.permissions.has(PermissionFlagsBits.ManageGuild)) ??
        this.client.guilds.cache.first();
      if (!guild) return;
      const existing = new Map(guild.emojis.cache.map((e) => [e.name!, e.id]));
      const versionFile = path.join(config.dataDir, 'panel-icons.version');
      let version = 0;
      try {
        version = Number((await fs.readFile(versionFile, 'utf8')).trim()) || 0;
      } catch {
        /* first run */
      }
      const stale = version !== DiscordBot.PANEL_ICON_VERSION;
      let created = 0;
      for (const name of Object.keys(PANEL_ICON_FALLBACKS)) {
        try {
          let id = existing.get(name);
          if (id && stale) {
            // Icon art changed — replace the uploaded emoji with the new render.
            // If we can't delete (no permission), keep the existing emoji:
            // old art beats no art.
            try {
              await guild.emojis.delete(id);
              id = undefined;
            } catch {
              /* keep existing */
            }
          }
          if (!id) {
            const emoji = await guild.emojis.create({ attachment: renderPanelIconPng(name), name });
            id = emoji.id;
            created++;
          }
          if (id) this.panelEmojis.set(name, { id, name });
        } catch (err) {
          console.warn(
            `[discord] panel emoji "${name}" unavailable (${err instanceof Error ? err.message : err}) — using Unicode`,
          );
        }
      }
      if (created > 0) console.log(`[discord] uploaded ${created} panel icons to "${guild.name}"`);
      if (this.panelEmojis.size > 0) console.log(`[discord] panel icons active: ${this.panelEmojis.size}`);
      if (stale) {
        await fs.mkdir(config.dataDir, { recursive: true });
        await fs.writeFile(versionFile, String(DiscordBot.PANEL_ICON_VERSION));
      }
    } catch (err) {
      console.warn(`[discord] panel icon setup failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Custom panel emoji when available, Unicode shape otherwise. */
  private vzE(name: string, fallback: string): { id?: string; name: string } {
    const e = this.panelEmojis.get(name);
    return e ? { id: e.id, name: e.name } : { name: fallback };
  }

  /** "NOW PLAYING" confirmation after a track change (skip/previous). */
  private nowPlayingEmbed(s: Session, action: string): EmbedBuilder | null {
    const st = s.queue.getState();
    const t = st.track;
    if (!t) return null;
    const dur = st.durationMs || t.durationMs || 0;
    const slots = 16;
    const bar = '⬤' + '─'.repeat(slots - 1);
    const embed = new EmbedBuilder()
      .setColor(this.themeColor())
      .setAuthor({ name: 'NOW PLAYING', iconURL: this.client.user?.displayAvatarURL() })
      .setTitle(`${srcEmoji(t.source)} ${t.name}`)
      .setDescription(`${truncate((t.artists ?? []).join(', '), 80)}\n\n\`${bar}\`\n▶️ \`0:00 / ${fmtMs(dur)}\``)
      .setFooter({ text: `${action} · this panel updates itself` });
    if (t.image) embed.setThumbnail(t.image);
    return embed;
  }

  private panelPayload(s: Session): { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] } {
    const st = s.queue.getState();
    const track = st.track;
    const dur = st.durationMs || track?.durationMs || 0;
    const livePos = st.positionMs + (st.playing ? Math.max(0, Date.now() - (st.updatedAt || Date.now())) : 0);
    const pos = dur > 0 ? Math.min(livePos, dur) : st.positionMs;

    // Vaporzr-branded progress bar: monospace track with a glowing playhead knob.
    const slots = 16;
    const filled = dur ? Math.min(slots, Math.max(0, Math.round((pos / dur) * slots))) : 0;
    const bar = '━'.repeat(filled) + (filled < slots ? '⬤' : '━') + '─'.repeat(Math.max(0, slots - filled - 1));
    const statusIcon = st.playing ? '▶️' : '⏸';
    const djEnabled = s.playback.isDjEnabled(s.guildId);

    const embed = new EmbedBuilder().setColor(this.themeColor()).setTimestamp();
    if (this.client.user) {
      embed.setAuthor({ name: 'VAPORZR', iconURL: this.client.user.displayAvatarURL() });
    }
    if (track) {
      embed
        .setTitle(`${srcEmoji(track.source)} ${track.name}`)
        .setDescription(
          `${truncate(track.artists.join(', '), 80)}\n\n\`${bar}\`\n${statusIcon} \`${fmtMs(pos)} / ${fmtMs(dur)}\``,
        );
      if (track.image) embed.setThumbnail(track.image);
    } else {
      embed.setTitle('Nothing playing').setDescription('Queue something with /play — this panel updates live.');
    }
    const snap = s.queue.getSnapshot();
    const posIdx = snap.tracks.findIndex((t) => t.current) + 1;
    embed.addFields([
      { name: '📜 Queue', value: `${snap.tracks.length}${posIdx ? ` · #${posIdx} now` : ''}`, inline: true },
      { name: '🔀 Shuffle', value: st.shuffle ? 'on' : 'off', inline: true },
      { name: '🔁 Repeat', value: st.repeat ? 'on' : 'off', inline: true },
      { name: '🔊 Volume', value: `${st.volume}%`, inline: true },
      { name: '🎙️ Voice', value: s.voice.isJoined() ? 'streaming' : 'not in VC', inline: true },
      { name: '🎛️ DJ', value: djEnabled ? 'on' : 'off', inline: true },
    ]);
    embed.setFooter({ text: `${this.client.user?.username ?? 'Vaporzr'} · this panel updates itself` });

    const rows: ActionRowBuilder<ButtonBuilder>[] = [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('vz:prev').setEmoji(this.vzE('vz_prev', '⏮')).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('vz:toggle')
          .setEmoji(this.vzE(st.playing ? 'vz_pause' : 'vz_play', st.playing ? '⏸' : '▶'))
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('vz:next').setEmoji(this.vzE('vz_next', '⏭')).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('vz:repeat')
          .setEmoji(this.vzE('vz_repeat', '🔁'))
          .setStyle(st.repeat ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('vz:shuffle')
          .setEmoji(this.vzE('vz_shuffle', '🔀'))
          .setStyle(st.shuffle ? ButtonStyle.Success : ButtonStyle.Secondary),
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('vz:back10').setLabel('10s').setEmoji(this.vzE('vz_back10', '⏪')).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('vz:fwd10').setLabel('10s').setEmoji(this.vzE('vz_fwd10', '⏩')).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('vz:vol-down').setEmoji(this.vzE('vz_voldown', '🔉')).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('vz:vol-up').setEmoji(this.vzE('vz_volup', '🔊')).setStyle(ButtonStyle.Secondary),
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('vz:dj').setLabel('DJ').setEmoji(this.vzE('vz_dj', '🎛️')).setStyle(djEnabled ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('vz:stop').setEmoji(this.vzE('vz_stop', '⏹')).setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('vz:leave').setEmoji(this.vzE('vz_eject', '📤')).setStyle(ButtonStyle.Secondary),
      ),
    ];
    const djRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('vz:sfx:airhorn').setLabel('📣').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('vz:sfx:drop').setLabel('💥').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('vz:sfx:riser').setLabel('📈').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('vz:sfx:reverse').setLabel('↩️').setStyle(ButtonStyle.Primary),
    );
    if (djEnabled) {
      rows.push(djRow);
    }
    // Discord only allows https URLs on link buttons — surface the web panel
    // and visualizer whenever the secure tunnel is up.
    const plink = vizTunnel.panelLink();
    const vlink = vizTunnel.vizLink();
    if (plink.secure && vlink.secure) {
      rows.push(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setLabel('🌐 Full control panel').setStyle(ButtonStyle.Link).setURL(plink.url),
          new ButtonBuilder().setLabel('🌈 Visualizer').setStyle(ButtonStyle.Link).setURL(vlink.url),
        ),
      );
    }
    return { embeds: [embed], components: rows };
  }

  private async handleButton(interaction: MessageComponentInteraction): Promise<void> {
    if (!interaction.customId.startsWith('vz:')) return;
    const action = interaction.customId.slice(3);
    const permissionCommand: Record<string, string> = {
      prev: 'previous',
      toggle: 'pause',
      next: 'skip',
      shuffle: 'shuffle',
      repeat: 'shuffle',
      back10: 'seek',
      fwd10: 'seek',
      'vol-down': 'volume',
      'vol-up': 'volume',
      stop: 'clear',
      leave: 'leave',
    };
    const req = permissionCommand[action];
    const requiresSfx = action.startsWith('sfx:');
    if ((req || requiresSfx) && !this.canUse(requiresSfx ? 'sfx' : req, interaction)) {
      await interaction.reply({ content: '⛔ You don\'t have permission to do that.', flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.deferUpdate();
    const s = this.sessionFor(interaction.guildId);
    const st = s.queue.getState();

    switch (action) {
      case 'prev': {
        s.playback.previous();
        const np = this.nowPlayingEmbed(s, '⏮️ Previous');
        if (np) void interaction.followUp({ embeds: [np], flags: MessageFlags.Ephemeral }).catch(() => {});
        break;
      }
      case 'toggle':
        await s.playback.toggle();
        break;
      case 'next': {
        s.playback.next();
        const np = this.nowPlayingEmbed(s, '⏭️ Skipped');
        if (np) void interaction.followUp({ embeds: [np], flags: MessageFlags.Ephemeral }).catch(() => {});
        break;
      }
      case 'shuffle': {
        s.playback.shuffle(!st.shuffle);
        void interaction
          .followUp({ content: st.shuffle ? '🔀 Shuffle off' : '🔀 Shuffle on', flags: MessageFlags.Ephemeral })
          .catch(() => {});
        break;
      }
      case 'repeat': {
        s.playback.setRepeat(!st.repeat);
        void interaction
          .followUp({ content: st.repeat ? '🔁 Repeat off' : '🔁 Repeat on — track replays at its end', flags: MessageFlags.Ephemeral })
          .catch(() => {});
        break;
      }
      case 'back10':
      case 'fwd10': {
        const pos = st.positionMs + (st.playing ? Math.max(0, Date.now() - (st.updatedAt || Date.now())) : 0);
        const dur = st.durationMs || st.track?.durationMs || 0;
        const target = Math.max(0, pos + (action === 'back10' ? -10000 : 10000));
        s.playback.seek(dur > 0 ? Math.min(target, dur - 500) : target);
        void interaction
          .followUp({
            content: `${action === 'back10' ? '⏪' : '⏩'} ${fmtMs(Math.max(0, target))}${dur ? ` / ${fmtMs(dur)}` : ''}`,
            flags: MessageFlags.Ephemeral,
          })
          .catch(() => {});
        break;
      }
      case 'vol-down':
      case 'vol-up': {
        const v = action === 'vol-down' ? Math.max(0, st.volume - 10) : Math.min(100, st.volume + 10);
        s.playback.volume(v);
        void interaction.followUp({ content: `🔊 Volume ${v}%`, flags: MessageFlags.Ephemeral }).catch(() => {});
        break;
      }
      case 'stop':
        s.playback.stopAll();
        s.queue.clear();
        break;
      case 'leave':
        s.voice.leave();
        break;
      case 'dj': {
        if (interaction.guildId) {
          s.playback.setDjEnabled(interaction.guildId, !s.playback.isDjEnabled(interaction.guildId));
          this.bridge.notifyDj();
        }
        break;
      }
      default:
        if (action.startsWith('sfx:')) {
          const id = action.slice(4);
          void s.playback.playSoundEffect(id);
          const sfx = s.playback.listSoundEffects().find((snd) => snd.id === id);
          void interaction.followUp({ content: `🔊 ${sfx ? `${sfx.emoji} ${sfx.name}` : id}`, flags: MessageFlags.Ephemeral }).catch(() => {});
        }
        break;
    }

    if (interaction.guildId) {
      const panel = this.panels.get(interaction.guildId);
      if (panel) await this.editPanel(panel.channelId, panel.messageId, interaction.guildId);
    }
  }

  // ---- Themes, windows, visuals ----

  private themeColor(): number {
    return this.bridge.getTheme().embedColor;
  }

  private static readonly QUEUE_PAGE = 15;

  /** Build the queue embed for one 15-song page plus a jump-to dropdown for
   *  the rest — a single message even for 200-track playlists, instead of a
   *  wall of follow-up chunks. */
  private queuePage(s: Session, start?: number): {
    embeds: EmbedBuilder[];
    components: ActionRowBuilder<StringSelectMenuBuilder>[];
  } {
    const snap = s.queue.getSnapshot();
    const tracks = snap.tracks;
    const PAGE = DiscordBot.QUEUE_PAGE;
    // Default the view to the upcoming tracks (right after the current one),
    // not the very beginning of the queue, so users see what will play next.
    const defaultStart = Math.max(0, Math.min(snap.currentIndex, Math.max(0, tracks.length - 1)));
    const safeStart = start !== undefined && Number.isFinite(start) ? start : defaultStart;
    const startIdx = Math.max(0, Math.min(safeStart, Math.max(0, tracks.length - 1)));
    const end = Math.min(tracks.length, startIdx + PAGE);
    const lines: string[] = [];
    for (let i = startIdx; i < end; i++) {
      const t = tracks[i];
      const cur = i === snap.currentIndex ? '▶ ' : `${i + 1}. `;
      lines.push(`${cur}${srcEmoji(t.source)} **${t.name}** — ${truncate(t.artists.join(', '), 80)}`);
    }
    const embed = new EmbedBuilder()
      .setTitle(`Queue (${tracks.length}) — showing ${startIdx + 1}–${end}`)
      .setDescription(lines.join('\n') || 'Nothing here yet.')
      .setColor(this.themeColor());
    const components: ActionRowBuilder<StringSelectMenuBuilder>[] = [];
    if (tracks.length > PAGE) {
      const menu = new StringSelectMenuBuilder()
        .setCustomId('queue_page')
        .setPlaceholder('Jump to another stretch of the queue…');
      const opts: StringSelectMenuOptionBuilder[] = [];
      for (let p = 0; p < tracks.length && opts.length < 25; p += PAGE) {
        const e = Math.min(tracks.length, p + PAGE);
        opts.push(
          new StringSelectMenuOptionBuilder()
            .setLabel(`${p + 1}–${e}`)
            .setValue(String(p))
            .setDefault(p === startIdx),
        );
      }
      menu.addOptions(opts);
      components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu));
    }
    return { embeds: [embed], components };
  }

  /** Re-post the control panel at the CURRENT bottom of the channel: the old
   *  message is deleted first, so V@pan//panel brings the panel down to you
   *  instead of leaving it scrolled up where nobody sees it. */
  private async repostPanel(guildId: string, channel: GuildTextBasedChannel | null): Promise<void> {
    const existing = this.panels.get(guildId);
    if (existing) {
      try {
        const ch = await this.client.channels.fetch(existing.channelId);
        if (ch && ch.isTextBased()) {
          const msg = await ch.messages.fetch(existing.messageId).catch(() => null);
          await msg?.delete();
        }
      } catch {
        /* old panel already gone or we lack manage-messages — just re-post */
      }
      this.panels.delete(guildId);
    }
    if (!channel) return;
    const s = this.sessionFor(guildId);
    const sent = await channel.send(this.panelPayload(s));
    this.panels.set(guildId, { channelId: sent.channelId, messageId: sent.id });
    this.scheduleSavePanels();
  }

  /** Shared reference for both `/viz` and `V@viz`. Secure link first when the tunnel is up. */
  private vizEmbed(isAdmin: boolean): EmbedBuilder {
    const link = vizTunnel.vizLink();
    const host = vizHost();
    const lines: string[] = [];
    if (link.secure) lines.push(`🔒 **Secure link — share this one:**\n<${link.url}>`);
    if (isAdmin) lines.push(`🛠️ **Local network (admin):**\n<http://${host}:${config.port}/viz>`);
    let desc: string;
    if (link.secure) {
      desc = `${lines.join('\n\n')}\n\nRenders live in any browser — encrypted, standalone, no player app needed. Visuals start automatically with playback.`;
    } else if (isAdmin) {
      desc = `${lines.join('\n\n')}\n\n⚠️ Secure tunnel is offline — it restarts itself; retry shortly.`;
    } else {
      desc = '🔒 The secure visualizer link is starting up — run this command again in ~30 seconds.';
    }
    return new EmbedBuilder()
      .setTitle('🌐 Web Visualizer')
      .setDescription(desc)
      .setColor(this.themeColor())
      .setFooter({
        text: link.secure ? 'HTTPS keeps links trusted · works great on phones' : 'Secure link reconnects automatically',
      });
  }

  private isAdminMember(userId: string, guild: Guild | null, member: unknown): boolean {
    if (this.perms.isOwner(userId)) return true;
    if (!guild || !member) return false;
    const m = member as { id: string; roles: { cache: ReadonlyMap<string, unknown> } };
    try {
      return this.perms.getLevel(guild, m) === 'admin';
    } catch {
      return false;
    }
  }

  /** Shared reference for both `/help` and `V@help`. */
  private helpEmbed(): EmbedBuilder {
    const link = vizTunnel.vizLink();
    // Public embed: secure link only — the LAN address stays an admin-only detail.
    const vizLine = link.secure
      ? `**Web visualizer:** <${link.url}> 🔒`
      : '**Web visualizer:** run `/viz` for the secure link';
    return new EmbedBuilder()
      .setTitle('🎧 Vaporzr')
      .setDescription(`Music & visualizer bot — play, queue, and vibe.\n\n${vizLine}`)
      .setColor(this.themeColor())
      .addFields(
        {
          name: '▶️ Playback',
          value: '`/play` `/insert` `/yt` `/skip` `/pause` `/resume` `/toggle` `/queue` `/nowplaying` `/clear` `/remove` `/volume` `/shuffle` `/join` `/leave`',
        },
        {
          name: '🎨 Visuals',
          value: '`/panel` — control panel · `/viz` — browser visualizer (MilkDrop) · `/theme` — color moods · `/wave` — waveform snapshot · `/burst` — animated clip · `/sensitivity` — beat reactivity',
        },
        {
          name: '🎛️ DJ',
          value: '`/sfx` — play a sound effect · `/dj` — enable the soundboard (mod)',
        },
        {
          name: '🔧 Admin',
          value: '`/perms` — view / set command levels and roles · `/stats` — bot statistics · `/key rotate` — reissue web access · `/invite` — get the invite link',
        },
        {
          name: '⌨️ Quick (prefix)',
          value: '`V@p` play · `V@i` insert · `V@s` skip · `V@t` toggle · `V@sh` shuffle · `V@v` volume · `V@q` queue · `V@np` now playing · `V@c` clear · `V@rem` remove · `V@j` join · `V@l` leave · `V@wav` play file · `V@pan` panel · `V@viz` visualizer · `V@th` theme · `V@sens` sensitivity · `V@dj` dj · `V@sfx` effect · `V@key` access links · `V@invite` invite · `V@help` this',
        },
      )
      .setFooter({ text: 'Try /play with a song name or a Spotify/YouTube link' });
  }

  private statsEmbed(): EmbedBuilder {
    const sessions = this.sessions.all();
    const tracksQueued = sessions.reduce((n, s) => n + s.queue.totalEnqueued, 0);
    const tracksPlayed = sessions.reduce((n, s) => n + s.playback.tracksPlayed, 0);
    const queuedNow = sessions.reduce((n, s) => n + s.queue.getSnapshot().tracks.length, 0);
    const playingGuilds = sessions.filter((s) => s.queue.getState().playing).length;
    const uptime = Date.now() - this.startedAt;
    const uMin = Math.floor(uptime / 60000);
    const hours = Math.floor(uMin / 60);
    const mins = uMin % 60;
    const uptimeStr = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
    const embed = new EmbedBuilder()
      .setTitle('📊 Vaporzr Stats')
      .setColor(this.themeColor())
      .setDescription(
        `🟢 Online for **${uptimeStr}**\n` +
          `🎵 **${tracksPlayed}** tracks played\n` +
          `➕ **${tracksQueued}** tracks queued\n` +
          `📝 **${this.commandsRun}** commands run\n` +
          `🗒️ **${queuedNow}** tracks currently queued\n` +
          `🔊 **${playingGuilds}** of ${sessions.length} server${sessions.length === 1 ? '' : 's'} playing right now`,
      );
    if (sessions.length > 1) {
      const lines = sessions.map((s) => {
        const st = s.queue.getState();
        const name = this.client.guilds.cache.get(s.guildId)?.name ?? s.guildId;
        const icon = st.playing ? '▶' : st.track ? '⏸' : '·';
        const queued = s.queue.getSnapshot().tracks.length;
        const now = st.track ? `\`${truncate(st.track.name, 40)}\`` : 'idle';
        return `${icon} **${name}** — ${now} · ${queued} queued`;
      });
      return embed.addFields({ name: 'Servers', value: lines.join('\n') });
    }
    return embed;
  }

  /** Beat-reactive presence: an equalizer built from the live PCM tap. */
  private startPresenceTicker(): void {
    if (this.presenceTimer) return;
    this.presenceTimer = setInterval(() => void this.tickPresence(), 1200);
    this.presenceTimer.unref?.();
  }

  private async tickPresence(): Promise<void> {
    const user = this.client.user;
    if (!user) return;
    const q = this.sessions.primary?.queue;
    const st = q ? q.getState() : null;
    let text: string;
    if (!st || !st.track) {
      text = 'Idle — V@help';
    } else if (st.playing) {
      text = `${barsToEq(analyzer.currentBars(), 10)} ${st.track.name}`;
    } else {
      text = `⏸ ${st.track.name}`;
    }
    if (text === this.lastPresence) return;
    this.lastPresence = text;
    try {
      await user.setActivity(text, { type: ActivityType.Listening });
    } catch {
      /* presence rate-limited; retry next tick */
    }
  }

  /** Capture a short WebM clip from a visualizer window, then post it as a GIF. */
  private async handleBurst(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!this.bridge.hasBurstSources()) {
      await interaction.editReply('No visualizer viewer found. Open the web visualizer first (`/viz`), then run `/burst` again.');
      return;
    }
    await new Promise((r) => setTimeout(r, 250));
    const data = await this.captureBurst();
    if (!data) {
      await interaction.editReply('No clip captured — is something playing?');
      return;
    }
    const gif = await webmToGif(data);
    if (!gif) {
      await interaction.editReply('Could not convert the clip.');
      return;
    }
    await interaction.editReply({
      content: '🎞 Visual burst:',
      files: [new AttachmentBuilder(gif, { name: 'vaporzr-burst.gif' })],
    });
  }

  /** One-shot wait for a visualizer's burst:data reply. */
  private captureBurst(timeoutMs = 8000): Promise<string | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.bridge.onBurstData = null;
        resolve(null);
      }, timeoutMs);
      this.bridge.onBurstData = (data: string) => {
        clearTimeout(timer);
        this.bridge.onBurstData = null;
        resolve(data);
      };
      this.bridge.requestBurst(3000);
    });
  }

  /** Endless Wave: record features for the ended track and refill the buffer. */
  private async waveTrackEnded(s: Session, ended: TrackInfo): Promise<void> {
    if (!s.endlessWave.active) return;
    const features = await EW.fetchFeatures(ended);
    if (features) EW.recordFeatures(s.endlessWave, features);
    EW.markPlayed(s.endlessWave, ended.uri, ended.name, ended.artists);
    await this.topUpWave(s);
  }

  /** Mark a track as played as soon as it starts (not on end) so EW's dedup
   *  immediately excludes it from future picks — critical for the lookahead
   *  buffer to not re-pick the currently playing song's variants. */
  private markWaveStarted(s: Session, track: TrackInfo): void {
    if (!s.endlessWave.active) return;
    if (this.ewStartedUri.get(s.guildId) === track.uri) return;
    this.ewStartedUri.set(s.guildId, track.uri);
    EW.markPlayed(s.endlessWave, track.uri, track.name, track.artists);
  }

  /** Debounced trigger for topUpWave — fires 700ms after any queue/state change
   *  so rapid skips or manual adds collapse into a single refill pass. */
  private scheduleWaveTopUp(s: Session): void {
    if (!s.endlessWave.active) return;
    const t = this.ewTopUpTimers.get(s.guildId);
    if (t) clearTimeout(t);
    this.ewTopUpTimers.set(
      s.guildId,
      setTimeout(() => {
        this.ewTopUpTimers.delete(s.guildId);
        void this.topUpWave(s).catch((err) =>
          console.warn(`[endlesswave] top-up failed: ${err instanceof Error ? err.message : err}`),
        );
      }, 700),
    );
  }

  /** Keep a lookahead buffer of 2 EW-picked tracks at the tail of the queue.
   *  They're ordinary queue entries, so skips/manual adds interleave naturally;
   *  any queue or state change re-tops the buffer. */
  private async topUpWave(s: Session): Promise<void> {
    if (!s.endlessWave.active) return;
    if ((this.ewRetryAfter.get(s.guildId) ?? 0) > Date.now()) return;
    if (this.ewBusy.has(s.guildId)) return;
    this.ewBusy.add(s.guildId);
    try {
      const AHEAD = 2;
      for (;;) {
        if (!s.endlessWave.active) return;
        const snap = s.queue.getSnapshot();
        const upcoming = snap.tracks.slice(snap.currentIndex + 1);
        let ahead = 0;
        for (const t of upcoming) if (t.addedBy === 'endless-wave') ahead++;
        if (ahead >= AHEAD) return;

        // Context window around the current position: up to 3 recently played
        // tracks (seeds) + the next 6 upcoming (so the lookahead buffer and
        // any user-queued tracks are included as seeds and dedup targets).
        const recent = EW.pickContext(snap.tracks, snap.currentIndex, 3, 6);
        const failed = new Set<string>();
        let resolved: TrackInfo | null = null;
        for (let attempt = 0; attempt < 3 && !resolved; attempt++) {
          if (!s.endlessWave.active) return;
          const candidate = await EW.pickNextTrack(s.endlessWave, recent, failed, upcoming);
          if (!candidate) break;
          failed.add(candidate.uri);
          resolved = await EW.resolveCandidate(candidate);
          if (!resolved) console.log(`[endlesswave] could not resolve "${candidate.name}" — trying another`);
        }
        if (!resolved) {
          console.warn('[endlesswave] no suitable candidate right now — staying armed');
          this.ewRetryAfter.set(s.guildId, Date.now() + 15_000);
          return;
        }
        s.queue.enqueue(resolved, 'endless-wave');
        s.endlessWave.generated++;
        this.bridge.broadcast({ type: 'endlesswave', active: true, generated: s.endlessWave.generated });
        console.log(`[endlesswave] queued: "${resolved.name}" — ${truncate(resolved.artists.join(', '), 80)} (#${s.endlessWave.generated})`);
        this.ewRetryAfter.delete(s.guildId);
      }
    } finally {
      this.ewBusy.delete(s.guildId);
      // Kick playback only for a *new* EW track. After skip/end the cursor still
      // sits on the just-finished song — starting that again is the same-song loop.
      const st = s.queue.getState();
      const cur = s.queue.getCurrentTrack();
      if (
        s.endlessWave.active &&
        !st.playing &&
        cur &&
        s.voice.isJoined() &&
        !EW.isDuplicate(s.endlessWave, cur.uri) &&
        !EW.isRemixOrCover(s.endlessWave, cur.name, cur.artists)
      ) {
        void s.playback.play().catch(() => {});
      }
    }
  }
}

const EQ_CHARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

/** Turn analyzer bars (0..1) into a compact equalizer glyph row. */
function barsToEq(bars: number[], n: number): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const v = Math.max(0, Math.min(1, bars[i] ?? 0));
    out.push(EQ_CHARS[Math.min(EQ_CHARS.length - 1, Math.floor(v * EQ_CHARS.length))]);
  }
  return out.join('');
}

/** Convert a base64 WebM clip to an animated GIF using the bundled ffmpeg. */
async function webmToGif(base64: string): Promise<Buffer | null> {
  const tmpDir = path.join(config.dataDir, 'tmp');
  await fs.mkdir(tmpDir, { recursive: true });
  const stamp = Date.now();
  const inFile = path.join(tmpDir, `burst-${stamp}.webm`);
  const outFile = path.join(tmpDir, `burst-${stamp}.gif`);
  try {
    await fs.writeFile(inFile, Buffer.from(base64, 'base64'));
    const ok = await runFfmpeg([
      '-y',
      '-loglevel',
      'error',
      '-i',
      inFile,
      '-vf',
      'fps=12,scale=480:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=64[p];[b][p]paletteuse=dither=bayer:bayer_scale=5',
      outFile,
    ]);
    if (!ok) return null;
    const buf = await fs.readFile(outFile).catch(() => null);
    return buf;
  } finally {
    void fs.rm(inFile, { force: true }).catch(() => {});
    void fs.rm(outFile, { force: true }).catch(() => {});
  }
}

function runFfmpeg(args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(config.ffmpegPath, args, { windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
      resolve(false);
    }, 15000);
    proc.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
    proc.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

function srcEmoji(source: string | undefined): string {
  if (source === 'youtube') return '▶️';
  if (source === 'local') return '📂';
  if (source === 'suno') return '✨';
  if (source === 'soundcloud') return '🎧';
  if (source === 'apple') return '🍎';
  return '🎵';
}

async function resolvePlayInput(query: string): Promise<ResolvedTrack[]> {
  if (isYoutubePlaylistUrl(query)) {
    return resolveYoutubePlaylist(query);
  }
  if (isYoutubeUrl(query)) {
    return [await resolveYoutubeVideo(query)];
  }
  if (isSunoUrl(query)) {
    return [await resolveSuno(query)];
  }
  if (isAppleMusicUrl(query)) {
    return resolveAppleMusicUrl(query);
  }
  if (isSoundcloudSetUrl(query)) {
    return resolveSoundcloudSet(query);
  }
  if (isSoundcloudUrl(query)) {
    return [await resolveSoundcloudVideo(query)];
  }
  try {
    return await resolveTracks(query);
  } catch (err) {
    // Spotify's Developer Mode quota can be locked for hours. Keep ordinary
    // free-text play usable through YouTube instead of surfacing a hard 429.
    if (err instanceof SpotifyError && err.status === 429 && !/^(spotify:|https?:\/\/(open\.)?spotify\.com\/)/i.test(query)) {
      const hit = await searchAndResolveYoutube(query);
      if (hit) return [hit];
    }
    if (err instanceof SpotifyError) throw err;
    throw new YoutubeError(err instanceof Error ? err.message : String(err));
  }
}
