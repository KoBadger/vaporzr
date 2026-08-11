import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Interaction,
  EmbedBuilder,
} from 'discord.js';
import { config } from './config.js';
import { resolveTracks, SpotifyError } from './spotify.js';
import type { QueueManager } from './queue.js';
import type { PlaybackController } from './playback.js';
import { PermissionsManager } from './permissions.js';
import type { Bridge } from './bridge.js';
import type { PermissionLevel } from '@vaporzr/shared';

const COMMANDS = [
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Search for a track or paste a Spotify URL to queue it')
    .addStringOption((o) => o.setName('query').setDescription('Track name or Spotify URL').setRequired(true)),
  new SlashCommandBuilder().setName('queue').setDescription('Show the current queue'),
  new SlashCommandBuilder().setName('skip').setDescription('Skip to the next track'),
  new SlashCommandBuilder().setName('pause').setDescription('Pause playback'),
  new SlashCommandBuilder().setName('resume').setDescription('Resume playback'),
  new SlashCommandBuilder().setName('clear').setDescription('Clear the queue'),
  new SlashCommandBuilder()
    .setName('remove')
    .setDescription('Remove a track from the queue')
    .addIntegerOption((o) => o.setName('index').setDescription('1-based index into the queue').setRequired(true)),
  new SlashCommandBuilder()
    .setName('volume')
    .setDescription('Set the volume')
    .addIntegerOption((o) => o.setName('level').setDescription('0-100').setRequired(true)),
  new SlashCommandBuilder().setName('nowplaying').setDescription('Show the currently playing track'),
  new SlashCommandBuilder()
    .setName('shuffle')
    .setDescription('Toggle shuffle')
    .addBooleanOption((o) => o.setName('enabled').setDescription('On or off').setRequired(true)),
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
];

function fmtMs(ms: number): string {
  if (!ms || ms < 0) return '0:00';
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export class DiscordBot {
  private client: Client;
  private rest: REST;

  constructor(
    private queue: QueueManager,
    private playback: PlaybackController,
    private perms: PermissionsManager,
    private bridge: Bridge,
  ) {
    this.client = new Client({ intents: [GatewayIntentBits.Guilds] });
    this.rest = new REST({ version: '10' });
  }

  async start(): Promise<void> {
    this.client.on('ready', () => {
      console.log(`[vaporzr] logged in as ${this.client.user?.tag}`);
      void this.registerCommands();
    });
    this.client.on('interactionCreate', (i) => void this.onInteraction(i));
    this.client.on('guildCreate', () => void this.registerCommands());
    await this.client.login(config.discordToken);
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
    if (!interaction.isChatInputCommand()) return;
    try {
      await this.handleCommand(interaction);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const reply = { content: `⚠️ ${msg}`, ephemeral: true };
      if (interaction.deferred) await interaction.followUp(reply);
      else await interaction.reply(reply);
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

  private async handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const name = interaction.commandName;

    switch (name) {
      case 'play': {
        const query = interaction.options.getString('query', true);
        await interaction.deferReply();
        const tracks = await resolveTracks(query);
        const first = tracks[0];
        const requestedBy = interaction.member?.user.username ?? 'unknown';
        this.queue.enqueueMany(tracks, requestedBy);
        if (!this.queue.getState().playing && this.bridge.isPlayerConnected()) {
          this.playback.play();
        }
        const embed = new EmbedBuilder()
          .setTitle('Added to queue')
          .setDescription(`**${first.name}** — ${first.artists.join(', ')}`)
          .setThumbnail(first.image ?? '')
          .setFooter({ text: `${tracks.length} track${tracks.length > 1 ? 's' : ''} · ${this.queue.getSnapshot().tracks.length} in queue` })
          .setColor(0x8a7dff);
        await interaction.editReply({ embeds: [embed] });
        break;
      }

      case 'queue': {
        const snap = this.queue.getSnapshot();
        if (snap.tracks.length === 0) {
          await interaction.reply('The queue is empty.');
          return;
        }
        const lines = snap.tracks.map((t, i) => {
          const cur = i === snap.currentIndex ? '▶ ' : `${i + 1}. `;
          return `${cur}**${t.name}** — ${t.artists.join(', ')}`;
        });
        const chunks: string[] = [];
        let chunk = '';
        for (const line of lines) {
          if (chunk.length + line.length > 1900) {
            chunks.push(chunk);
            chunk = line;
          } else {
            chunk += (chunk ? '\n' : '') + line;
          }
        }
        if (chunk) chunks.push(chunk);
        await interaction.reply({
          embeds: [new EmbedBuilder().setTitle(`Queue (${snap.tracks.length})`).setDescription(chunks[0]).setColor(0x8a7dff)],
        });
        for (let i = 1; i < chunks.length; i++) {
          await interaction.followUp({ embeds: [new EmbedBuilder().setDescription(chunks[i]).setColor(0x8a7dff)] });
        }
        break;
      }

      case 'skip':
        if (!this.requireLevel('skip', interaction)) return this.deny(interaction);
        this.playback.next();
        await interaction.reply('⏭️ Skipping…');
        break;

      case 'pause':
        if (!this.requireLevel('pause', interaction)) return this.deny(interaction);
        this.playback.pause();
        await interaction.reply('⏸️ Paused');
        break;

      case 'resume':
        if (!this.requireLevel('resume', interaction)) return this.deny(interaction);
        this.playback.resume();
        await interaction.reply('▶️ Resumed');
        break;

      case 'clear':
        if (!this.requireLevel('clear', interaction)) return this.deny(interaction);
        this.queue.clear();
        await interaction.reply('🗑️ Queue cleared');
        break;

      case 'remove': {
        const index = interaction.options.getInteger('index', true);
        if (!this.requireLevel('remove', interaction)) return this.deny(interaction);
        const removed = this.queue.remove(index - 1);
        await interaction.reply(removed ? `Removed **${removed.name}**` : 'Index out of range.');
        break;
      }

      case 'volume': {
        if (!this.requireLevel('volume', interaction)) return this.deny(interaction);
        const vol = interaction.options.getInteger('level', true);
        this.playback.volume(vol);
        await interaction.reply(`🔊 Volume set to ${vol}%`);
        break;
      }

      case 'nowplaying': {
        const st = this.queue.getState();
        if (!st.track) {
          await interaction.reply('Nothing is playing.');
          return;
        }
        const pos = st.positionMs;
        const dur = st.durationMs || st.track.durationMs;
        const pct = dur ? Math.round((pos / dur) * 10) : 0;
        const bar = '▰'.repeat(pct) + '▱'.repeat(10 - pct);
        await interaction.reply({
          embeds: [
            new EmbedBuilder()
              .setTitle(st.track.name)
              .setDescription(`by ${st.track.artists.join(', ')} · ${st.playing ? '▶' : '⏸'} ${bar} ${fmtMs(pos)} / ${fmtMs(dur)}`)
              .setThumbnail(st.track.image ?? '')
              .setColor(0x8a7dff),
          ],
        });
        break;
      }

      case 'shuffle': {
        if (!this.requireLevel('shuffle', interaction)) return this.deny(interaction);
        const on = interaction.options.getBoolean('enabled', true);
        this.playback.shuffle(on);
        await interaction.reply(on ? '🔀 Shuffle on' : '🔂 Shuffle off');
        break;
      }

      case 'perms':
        await this.handlePerms(interaction);
        break;

      default:
        await interaction.reply('Unknown command.');
    }
  }

  private async deny(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.reply({ content: '⛔ You don\'t have permission to do that.', ephemeral: true });
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
      await interaction.reply({ embeds: [new EmbedBuilder().setTitle('Permissions').setDescription(lines.join('\n')).setColor(0x8a7dff)] });
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
}
