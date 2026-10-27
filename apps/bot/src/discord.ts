import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  describeAddress,
  describeLabel,
  describeScope,
  describeUserAgent,
  listAccess,
  mintInvite,
  revokeAll,
  revokeSession,
  type AccessSession,
  type AccessScope,
} from './access.js';
import fs from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ActionRowBuilder,
  ActivityType,
  AttachmentBuilder,
  AutocompleteInteraction,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  MessageFlags,
  ModalBuilder,
  Partials,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ModalSubmitInteraction,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildBasedChannel,
  type GuildTextBasedChannel,
  type Interaction,
  type Message,
  type MessageActionRowComponentBuilder,
  type MessageComponentInteraction,
  type MessageReaction,
  type TextBasedChannel,
  type User,
} from 'discord.js';
import { generateDependencyReport } from '@discordjs/voice';
import { config } from '@vaporzr/core/config';
import { getCrossfadeMs, setCrossfadeMs } from './crossfadeStore.js';
import {
  getRecommendations,
  resolveTracks,
  searchCandidates,
  searchTracks,
  SpotifyError,
  getAudioFeatures,
  extractSpotifyId,
  type AudioFeatures,
  type RecommendationParams,
  type ResolvedTrack,
} from '@vaporzr/core/spotify';
import { getMeasuredFeatures } from '@vaporzr/core/featureStore';
import { orderByVibe, orderBySonic, SHUFFLE_MODE_LABEL, type ShuffleMode } from '@vaporzr/core/smartShuffle';
import { cosineEnabled, cosineSimilarScores, cosineSimilarCandidates, cosineRoomFit } from '@vaporzr/core/cosine';
import { THEMES, themeById } from './themes.js';
import {
  isGenericMediaUrl,
  isYoutubePlaylistUrl,
  isYoutubeUrl,
  probeYoutube,
  resolveGenericMediaUrl,
  resolveYoutubePlaylist,
  resolveYoutubeVideo,
  rotateYoutubeFallbackProxy,
  searchAndResolveYoutube,
  searchYoutube,
  setYoutubeHealthListener,
  youtubeHealth,
  YoutubeBusyError,
  YoutubeError,
  type YoutubeHealth,
  type YoutubeHealthContext,
} from '@vaporzr/core/youtube';
import { isSunoUrl, resolveSuno } from '@vaporzr/core/suno';
import { isAppleMusicUrl, resolveAppleMusicUrl } from '@vaporzr/core/apple';
import {
  isSoundcloudSetUrl,
  isSoundcloudUrl,
  resolveSoundcloudSet,
  resolveSoundcloudVideo,
  SoundcloudError,
} from '@vaporzr/core/soundcloud';
import { Session, SessionManager, type RestoredPlayingInfo } from './session.js';
import { fetchLyrics, type LyricsResult, type SyncedLine } from '@vaporzr/core/lyrics';
import { PermissionsManager } from './permissions.js';
import { analyzer } from '@vaporzr/core/analyzer';
import { vizTunnel } from './tunnel.js';
import { renderPanelIconPng, PANEL_ICON_FALLBACKS } from './panelIcons.js';
import { jamJoinLinks, type Bridge } from './bridge.js';
import { DeckController } from './decks.js';
import type { DeckEq, DeckId, InboundMessage, PermissionLevel, TrackInfo, PlaybackState } from '@vaporzr/shared';
import * as EW from '@vaporzr/core/endlesswave';
import { playlistStore } from '@vaporzr/core/playlists';
import { statsStore } from '@vaporzr/core/stats';
import { trackKey } from '@vaporzr/core/stats';
import { gamesStore, fitPercent, describeFit, pickRouletteWeighted, keyToQuery, explainFit } from '@vaporzr/core/games';
import { packCategoryFields, chunkFieldsIntoEmbeds, aliasIndexFields } from './help.js';
import { V_ALIASES, V_DISPATCH_ALIASES } from './aliases.js';
import { buildSwapItems, swapLabel, trackQuery } from './swapItems.js';
import { ttsEngine } from '@vaporzr/core/tts';
import { pushBroadcast, pushSubscriptionCount } from './push.js';
import { fallbackOpusModule, opusPlan, opusTelemetry } from './opusStream.js';
import { downloadToTempFile } from '@vaporzr/core/mediaDownload';
import { safeFetch, BlockedFetchError } from '@vaporzr/core/net';
import { separateStemsReplicate, replicateStemsEnabled } from '@vaporzr/core/stemSeparation';
import { estimateTempo, beatAlignLagMs } from '@vaporzr/core/tempo';
import { renderRadarGif, type RadarMetric } from '@vaporzr/core/images';
import { parseVibe, vibeIsSteerable, type ParsedVibe } from '@vaporzr/core/vibe';
import { buildJamInviteCard, type JamInviteInfo } from './jamInvite.js';
import {
  askAmokRich,
  curateEndlessWaveTracks,
  getWeaselMemorySummary,
  noteWeaselUserArtists,
  pcmMono48kToWav,
  rememberWeaselFact,
  synthWeaselVoice,
  transcribeVoiceUtterance,
  type WeaselWavePick,
} from './amok.js';

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
    // Already public-ready (the anti-bot wall's soft line): no wrapping, no internals.
    if (err instanceof YoutubeBusyError) return msg;
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
    .setDescription('Queue a track (search/link) or play an attached audio/video file')
    .addStringOption((o) => o.setName('query').setDescription('Track name or Spotify/YouTube URL'))
    .addAttachmentOption((o) => o.setName('file').setDescription('Audio/video file to play instead')),
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
  new SlashCommandBuilder().setName('clear').setDescription('Clear upcoming tracks (the current song keeps playing)'),
  new SlashCommandBuilder()
    .setName('remove')
    .setDescription('Remove a track from the queue')
    .addIntegerOption((o) =>
      o.setName('index').setDescription('1-based index into the queue').setRequired(true).setAutocomplete(true),
    ),
  new SlashCommandBuilder()
    .setName('volume')
    .setDescription('Check the current volume, or set it with a level')
    .addIntegerOption((o) => o.setName('level').setDescription('0-100 (omit to just check the current volume)')),
  new SlashCommandBuilder().setName('nowplaying').setDescription('Show the currently playing track'),
  new SlashCommandBuilder().setName('join').setDescription('Join your voice channel and stream audio to it'),
  new SlashCommandBuilder().setName('leave').setDescription('Leave the voice channel'),
  new SlashCommandBuilder()
    .setName('shuffle')
    .setDescription('Toggle shuffle, or reorder the queue by vibe')
    .addStringOption((o) =>
      o
        .setName('mode')
        .setDescription('Reorder instead of toggling: smart, arc, key, or sonic')
        .addChoices(
          { name: 'smart — flows from the current track', value: 'smart' },
          { name: 'arc — warm-up, peak, wind-down', value: 'arc' },
          { name: 'key — harmonic key mixing', value: 'key' },
          { name: 'sonic — audio similarity to now (cosine.club)', value: 'sonic' },
        ),
    )
    .addBooleanOption((o) => o.setName('enabled').setDescription('On or off (used when no mode is given)')),
  new SlashCommandBuilder().setName('panel').setDescription('Post (or refresh) the live control panel with buttons'),
  new SlashCommandBuilder()
    .setName('key')
    .setDescription('Web access: mint invite links, list devices, rotate the master key')
    .addSubcommand((sc) =>
      sc
        .setName('give')
        .setDescription('Owner: mint a single-use link (control = full panel, view = watch/listen)')
        .addStringOption((o) =>
          o
            .setName('scope')
            .setDescription('control (panel + audio + visuals) or view (watch/listen only)')
            .addChoices(
              { name: 'control', value: 'control' },
              { name: 'view', value: 'view' },
              { name: 'request', value: 'request' },
            ),
        )
        .addIntegerOption((o) =>
          o
            .setName('hours')
            .setDescription('How long the invite stays usable (1-168, default 12 control / 24 view)')
            .setMinValue(1)
            .setMaxValue(168),
        ),
    )
    .addSubcommand((sc) => sc.setName('show').setDescription('Owner: reveal the master key itself'))
    .addSubcommand((sc) => sc.setName('list').setDescription('Owner: list active devices and unused invites'))
    .addSubcommand((sc) =>
      sc
        .setName('revoke')
        .setDescription('Owner: revoke one device/invite, or everything')
        .addStringOption((o) =>
          o.setName('id').setDescription('id from /key list, or "all"').setRequired(true).setMaxLength(40),
        ),
    )
    .addSubcommand((sc) => sc.setName('rotate').setDescription('Owner: new master key; kills every device and invite')),
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
        .addStringOption((o) =>
          o
            .setName('name')
            .setDescription('e.g. Neon-rzr, Bass Drop-orzr, Vapor-porzr')
            .setRequired(true)
            .setMaxLength(100),
        ),
    )
    .addSubcommand((sc) => sc.setName('clear').setDescription('Reset my server nickname')),
  new SlashCommandBuilder()
    .setName('screensaver')
    .setDescription('Fullscreen the visualizer like a milkdrop screensaver on this machine'),
  new SlashCommandBuilder().setName('viz').setDescription('Open the web visualizer in your browser'),
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
    .setName('lyrics')
    .setDescription('Show lyrics for the current or searched song')
    .addStringOption((o) =>
      o.setName('query').setDescription('Song to look up (optional — defaults to current track)').setRequired(false),
    )
    .addBooleanOption((o) =>
      o.setName('karaoke').setDescription('Jump straight into live karaoke highlight').setRequired(false),
    ),
  new SlashCommandBuilder()
    .setName('perms')
    .setDescription('Manage permissions (admin only)')
    .addSubcommand((s) => s.setName('view').setDescription('View current permissions'))
    .addSubcommand((s) =>
      s
        .setName('set')
        .setDescription('Set the minimum level for a command')
        .addStringOption((o) =>
          o.setName('command').setDescription('Command name').setRequired(true).setAutocomplete(true),
        )
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
    .addStringOption((o) =>
      o.setName('sound').setDescription('The effect to play (omit to list)').setAutocomplete(true),
    ),
  new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show how to use Vaporzr')
    .addStringOption((o) =>
      o
        .setName('topic')
        .setDescription('Show everything at once, the V@ shortcut index, or one category')
        .setRequired(false)
        .addChoices(
          { name: '📖 Everything (all commands)', value: 'all' },
          { name: '⌨️ V@ shortcut index', value: 'aliases' },
          { name: '🎵 Playback', value: 'playback' },
          { name: '📜 Queue', value: 'queue' },
          { name: '🌊 Autoplay', value: 'autoplay' },
          { name: '🎛️ FX & DJ', value: 'fx' },
          { name: '🎮 Games', value: 'games' },
          { name: '🎤 Lyrics', value: 'lyrics' },
          { name: '🎨 Visuals', value: 'visuals' },
          { name: '💾 Library', value: 'library' },
          { name: '🔊 Voice', value: 'voice' },
          { name: '🛠️ System', value: 'system' },
        ),
    ),
  new SlashCommandBuilder().setName('invite').setDescription('Get a link to add Vaporzr to your server'),
  new SlashCommandBuilder()
    .setName('jam')
    .setDescription('Post the jam invite card — QR + link so guests can request songs from their phones'),
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
          { name: '1.10x (slightly more reactive)', value: 1.1 },
          { name: '1.15x (moderately reactive)', value: 1.15 },
          { name: '1.25x (noticeably snappy)', value: 1.25 },
          { name: '1.50x (very reactive)', value: 1.5 },
        ),
    ),
  new SlashCommandBuilder()
    .setName('speed')
    .setDescription('Change the playback speed (Nightcore / slowed / normal)')
    .addStringOption((o) =>
      o
        .setName('mode')
        .setDescription('Speed preset (omit to check current)')
        .setRequired(false)
        .addChoices(
          { name: '⚡ Nightcore (1.25x, pitch up)', value: 'nightcore' },
          { name: '🐢 Slowed (0.85x)', value: 'slowed' },
          { name: '▶️ Normal (1x)', value: 'normal' },
        ),
    ),
  new SlashCommandBuilder()
    .setName('bassboost')
    .setDescription('Add a low-frequency boost for the current session')
    .addIntegerOption((o) =>
      o
        .setName('db')
        .setDescription('Boost amount in dB: 5, 8, 10 (omit to check/off)')
        .setRequired(false)
        .addChoices(
          { name: '5 dB (subtle)', value: 5 },
          { name: '8 dB (punchy)', value: 8 },
          { name: '10 dB (heavy)', value: 10 },
        ),
    ),
  new SlashCommandBuilder()
    .setName('eq')
    .setDescription('Session EQ preset (bass, vocal, night, warm, lo-fi)')
    .addStringOption((o) =>
      o
        .setName('preset')
        .setDescription('EQ preset (omit to check the current one)')
        .setRequired(false)
        .addChoices(
          { name: '⬜ Flat (off)', value: 'flat' },
          { name: '🔊 Bass', value: 'bass' },
          { name: '🗣️ Vocal', value: 'vocal' },
          { name: '🌙 Night', value: 'night' },
          { name: '🔥 Warm', value: 'warm' },
          { name: '📼 Lofi', value: 'lofi' },
        ),
    ),
  new SlashCommandBuilder()
    .setName('norm')
    .setDescription('Loudness match — level every source to Spotify-standard volume')
    .addBooleanOption((o) => o.setName('on').setDescription('On or off (omit to check)')),
  new SlashCommandBuilder()
    .setName('wrapped')
    .setDescription("This server's listening Wrapped — hours, top tracks, artists, DJs")
    .addStringOption((o) =>
      o
        .setName('month')
        .setDescription('Which month (omit for the current one)')
        .setRequired(false)
        .addChoices({ name: 'This month', value: 'this' }, { name: 'Last month', value: 'last' }),
    ),
  new SlashCommandBuilder()
    .setName('follow')
    .setDescription('Pin the live now-playing strip here — it updates with every new song')
    .addBooleanOption((o) => o.setName('off').setDescription('Stop following (remove the strip)')),
  new SlashCommandBuilder()
    .setName('stump')
    .setDescription('Stump the Bot — bet a track will fit the room: survive to the end and you win')
    .addStringOption((o) =>
      o.setName('track').setDescription('Track to bet on (omit to bet your last pick)').setRequired(false),
    ),
  new SlashCommandBuilder()
    .setName('games')
    .setDescription('How the games work — Stump the Bot, DJ Duel and Track Roulette'),
  new SlashCommandBuilder()
    .setName('duel')
    .setDescription('DJ Duel — the bot scores both picks, then the room decides whose wins')
    .addUserOption((o) => o.setName('opponent').setDescription('Who you are challenging').setRequired(false))
    .addBooleanOption((o) =>
      o.setName('now').setDescription('Instant verdict from the bot instead of letting the room decide'),
    ),
  new SlashCommandBuilder()
    .setName('roulette')
    .setDescription("Track Roulette — a random track from this server's history, star it or ban it"),
  new SlashCommandBuilder()
    .setName('sleep')
    .setDescription('Stop playback and leave the voice channel after a timer')
    .addStringOption((o) =>
      o.setName('time').setDescription('When to stop, e.g. 30m, 1h, 45s (omit to cancel)').setRequired(false),
    ),
  new SlashCommandBuilder()
    .setName('cookie-refresh')
    .setDescription('Refresh YouTube cookies from your browser (write to youtubeCookiesPath)')
    .addBooleanOption((o) =>
      o.setName('confirm').setDescription('Confirm you want to export cookies from your browser').setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName('cookie-upload')
    .setDescription('Upload a Netscape cookies.txt to refresh YouTube cookies (owner only)')
    .addAttachmentOption((o) =>
      o.setName('file').setDescription('A cookies.txt exported from your browser (Netscape format)').setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName('similar')
    .setDescription('Find tracks that sound like the current one (cosine.club)')
    .addStringOption((o) =>
      o.setName('query').setDescription("Seed with this instead of what's playing").setRequired(false),
    ),
  new SlashCommandBuilder()
    .setName('config')
    .setDescription('Set several playback settings at once')
    .addStringOption((o) =>
      o.setName('settings').setDescription('e.g. "bass +3; crossfade 2; norm on; ew smart"').setRequired(false),
    ),
  new SlashCommandBuilder()
    .setName('device')
    .setDescription('Manage the Spotify Connect device (librespot)')
    .addSubcommand((sc) => sc.setName('list').setDescription('Show the current Spotify device status'))
    .addSubcommand((sc) =>
      sc
        .setName('select')
        .setDescription('Rename the Spotify Connect device (restarts librespot)')
        .addStringOption((o) => o.setName('name').setDescription('New device name (max 32 chars)').setRequired(true)),
    ),
  new SlashCommandBuilder()
    .setName('diag')
    .setDescription('Show bot diagnostics (gateway, voice/DAVE, librespot, sessions)'),
  new SlashCommandBuilder()
    .setName('autoplay')
    .setDescription('Keep the music going after the queue ends (off / basic / smart)')
    .addStringOption((o) =>
      o
        .setName('mode')
        .setDescription('Autoplay mode (omit to see the current mode)')
        .setRequired(false)
        .addChoices(
          { name: 'Off — stop when the queue ends', value: 'off' },
          { name: 'Basic — keep music going (light & fast)', value: 'basic' },
          { name: 'Smart — Endless Wave (evolves with the vibe)', value: 'smart' },
        ),
    )
    .addBooleanOption((o) => o.setName('now').setDescription('Queue one more track right now').setRequired(false))
    .addIntegerOption((o) =>
      o
        .setName('count')
        .setDescription('How many tracks to keep buffered ahead (1–10)')
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(10),
    ),
  new SlashCommandBuilder()
    .setName('playlist')
    .setDescription('Save the current queue as a playlist, or load a saved one')
    .addSubcommand((sc) =>
      sc
        .setName('save')
        .setDescription('Save the current queue as a playlist')
        .addStringOption((o) =>
          o.setName('name').setDescription('Playlist name').setRequired(true).setAutocomplete(true),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName('load')
        .setDescription('Load a saved playlist into the queue')
        .addStringOption((o) =>
          o.setName('name').setDescription('Playlist name').setRequired(true).setAutocomplete(true),
        ),
    )
    .addSubcommand((sc) => sc.setName('list').setDescription('List saved playlists'))
    .addSubcommand((sc) =>
      sc
        .setName('delete')
        .setDescription('Delete a saved playlist')
        .addStringOption((o) =>
          o.setName('name').setDescription('Playlist name').setRequired(true).setAutocomplete(true),
        ),
    ),
  new SlashCommandBuilder()
    .setName('djrole')
    .setDescription('Set (or clear) the DJ role that can control playback without a vote')
    .addRoleOption((o) =>
      o.setName('role').setDescription('Role to grant DJ powers (omit to view current)').setRequired(false),
    )
    .addBooleanOption((o) => o.setName('off').setDescription('Clear the DJ role').setRequired(false)),
  new SlashCommandBuilder()
    .setName('voteskip')
    .setDescription('Require a majority vote to skip (off = anyone can skip). Default: on')
    .addBooleanOption((o) => o.setName('enabled').setDescription('Turn vote-to-skip on or off').setRequired(false)),
  new SlashCommandBuilder()
    .setName('duck')
    .setDescription('Lower the music for a moment so people can talk (manual, not automatic)')
    .addIntegerOption((o) =>
      o
        .setName('seconds')
        .setDescription('How long to duck (5-300, default 30)')
        .setRequired(false)
        .setMinValue(5)
        .setMaxValue(300),
    )
    .addBooleanOption((o) => o.setName('cancel').setDescription('Cancel an in-progress duck').setRequired(false)),
  new SlashCommandBuilder()
    .setName('duckmode')
    .setDescription('Auto-lower the music while people talk: off | auto | hosts (DJ/owner only)')
    .addStringOption((o) =>
      o
        .setName('mode')
        .setDescription('off | auto | hosts')
        .setRequired(true)
        .addChoices({ name: 'off', value: 'off' }, { name: 'auto', value: 'auto' }, { name: 'hosts', value: 'hosts' }),
    ),
  new SlashCommandBuilder()
    .setName('npchannel')
    .setDescription('Post the live now-playing strip in this channel (mod); "off" disables it')
    .addBooleanOption((o) => o.setName('off').setDescription('Disable the now-playing strip').setRequired(false)),
  new SlashCommandBuilder()
    .setName('jump')
    .setDescription('Jump to a lyric line in the current song (e.g. "jump to the chorus")')
    .addStringOption((o) =>
      o.setName('query').setDescription('Words from the lyric line to jump to').setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName('ambient')
    .setDescription('Play a quiet lo-fi/ambient track when the queue ends (intermission)')
    .addBooleanOption((o) =>
      o.setName('enabled').setDescription('Turn ambient intermission on or off').setRequired(false),
    ),
  new SlashCommandBuilder()
    .setName('mood')
    .setDescription("Tint now-playing colors + visuals from the current track's mood")
    .addBooleanOption((o) =>
      o.setName('enabled').setDescription('Turn mood-reactive visuals on or off').setRequired(false),
    ),
  new SlashCommandBuilder()
    .setName('tts')
    .setDescription('Toggle spoken DJ announcements between tracks (opt-in, off by default)')
    .addBooleanOption((o) =>
      o.setName('enabled').setDescription('Turn TTS announcements on or off').setRequired(false),
    ),
  new SlashCommandBuilder()
    .setName('vibe')
    .setDescription('Let the DJ pick a set for your mood, time of day or weather')
    .addStringOption((o) =>
      o
        .setName('mood')
        .setDescription('Optional mood/style, e.g. "rainy lo-fi", "peak time techno"')
        .setRequired(false),
    ),
  new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Server listening stats — top DJs and most-played artists'),
  new SlashCommandBuilder().setName('dna').setDescription("Show the current track's Song DNA radar card"),
  new SlashCommandBuilder().setName('cover').setDescription('Render a mosaic of the queue album art'),
  new SlashCommandBuilder()
    .setName('hype')
    .setDescription('Fire short hype SFX on strong beats (auto-hype)')
    .addBooleanOption((o) => o.setName('enabled').setDescription('Turn auto-hype on or off').setRequired(false)),
  new SlashCommandBuilder().setName('dedupe').setDescription('Remove duplicate tracks from the upcoming queue'),
  new SlashCommandBuilder()
    .setName('bulk')
    .setDescription('Queue a list of songs at once (one per line, max 25)')
    .addStringOption((o) =>
      o
        .setName('tracks')
        .setDescription('Songs or links separated by ; (capped at 10)')
        .setRequired(true)
        .setMaxLength(1500),
    ),
  new SlashCommandBuilder().setName('skipto').setDescription('Jump to a future queued track (drops the ones skipped)'),
  new SlashCommandBuilder()
    .setName('skiptoggle')
    .setDescription('Allow /skipto in this server (mod)')
    .addBooleanOption((o) => o.setName('enabled').setDescription('Enable or disable /skipto').setRequired(true)),
  new SlashCommandBuilder()
    .setName('mashup')
    .setDescription('Blend two songs into a beat/key-matched mix (attached) + 5 similar tracks')
    .addStringOption((o) => o.setName('a').setDescription('First song (link or name)').setRequired(true))
    .addStringOption((o) => o.setName('b').setDescription('Second song (link or name)').setRequired(true))
    .addIntegerOption((o) =>
      o
        .setName('length')
        .setDescription('Excerpt length in seconds (30–180, default 90)')
        .setRequired(false)
        .setMinValue(30)
        .setMaxValue(180),
    ),
  new SlashCommandBuilder()
    .setName('mashupgame')
    .setDescription('Mashup game: auto-pick two queued songs, render stems, vote for the best'),
  new SlashCommandBuilder().setName('mashups').setDescription('Show past mashup games and their winners'),
  new SlashCommandBuilder()
    .setName('mix')
    .setDescription('Crossfade two tracks into one DJ-style mix')
    .addStringOption((o) => o.setName('a').setDescription('First track (link or name)').setRequired(true))
    .addStringOption((o) => o.setName('b').setDescription('Second track (link or name)').setRequired(true))
    .addIntegerOption((o) =>
      o
        .setName('crossfade')
        .setDescription('Crossfade seconds (2–20, default 6)')
        .setRequired(false)
        .setMinValue(2)
        .setMaxValue(20),
    ),
  new SlashCommandBuilder().setName('quiz').setDescription('Start a guess-the-song lyric quiz'),
  new SlashCommandBuilder()
    .setName('guess')
    .setDescription('Guess the current quiz song')
    .addStringOption((o) => o.setName('text').setDescription('Your guess').setRequired(true)),
  new SlashCommandBuilder()
    .setName('weasel')
    .setDescription('Chat with Amok ("The Weasel" — 90s Pauly Shore AI agent)')
    .addStringOption((o) =>
      o.setName('message').setDescription('What to ask or say to The Weasel (or "reset")').setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName('amok')
    .setDescription('Chat with Amok ("The Weasel" — 90s Pauly Shore AI agent)')
    .addStringOption((o) =>
      o.setName('message').setDescription('What to ask or say to Amok (or "reset")').setRequired(true),
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

/** Parse a sleep-timer spec ("30m", "1h", "45s", "1h30m") into milliseconds. */
export function parseSleepSpec(spec: string): number | null {
  const m = /^(\d+(?:\.\d+)?)([smh])$/.exec(spec.trim().toLowerCase());
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!(n > 0)) return null;
  const per = m[2] === 'h' ? 3_600_000 : m[2] === 'm' ? 60_000 : 1_000;
  return n * per;
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

/** A queue add the user may still correct ("swap this pick"). */
interface SwapRef {
  guildId: string;
  userId: string;
  addedBy: string;
  mode: 'queue' | 'insert';
  items: { uri: string; label: string; query?: string }[];
  /** Alternatives to re-roll from (a `/similar` surprise pick has no query). */
  pool?: ResolvedTrack[];
  createdAt: number;
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
  /** guildId -> how many autoplay tracks to keep buffered (1–10). Unset = default per mode. */
  private ewAheadOverride = new Map<string, number>();
  /** Per-guild saved playlists (favorites). */
  private playlists = playlistStore;
  /** Per-guild listening statistics (leaderboards). */
  private stats = statsStore;
  /** token -> pending interactive search results (for the `V@p <text>` picker). */
  private pendingSearch = new Map<
    string,
    { guildId: string; userId: string; candidates: ResolvedTrack[]; query?: string; createdAt: number }
  >();
  /** token -> pending /skipto picker. */
  private pendingSkipTo = new Map<string, { guildId: string; createdAt: number }>();
  /**
   * token -> a queue add the user may still correct ("swap this pick").
   * Any command that resolves search text into queue adds can register one, so a
   * wrong guess is fixable without hunting the track down in `V@q`. Each item
   * keeps the original query so a swap can re-offer the very same candidate
   * dropdown the picker showed in the first place.
   */
  private swapRefs = new Map<string, SwapRef>();
  /** guildId -> in-flight vote-to-skip. */
  private skipVotes = new Map<string, { voters: Set<string>; eligible: Set<string>; timer: NodeJS.Timeout }>();
  /** guildId -> last voice-status text posted (rate-limit aware). */
  private voiceStatusText = new Map<string, string>();
  private voiceStatusAt = new Map<string, number>();
  /** Guilds where Discord refused the voice-status write (missing permission).
   *  Retried at most hourly — otherwise a permanent permission error logs on
   *  every attempt, every three minutes, forever. */
  private voiceStatusDenied = new Map<string, number>();
  /** guildId -> fire a short SFX on strong beats (auto-hype). */
  private hypeGuilds = new Set<string>();
  private lastHypeAt = new Map<string, number>();
  /** guildId -> Weasel Auto-VJ spoken track intros enabled (`v@w vj on`). */
  private weaselVjGuilds = new Set<string>();
  /** guildId -> Weasel live voice-channel ear enabled (`v@w listen on`). */
  private weaselListenGuilds = new Set<string>();
  private weaselListenBusy = new Set<string>();
  /** guildId -> live two-deck mixer (see decks.ts). Created on first use. */
  private deckControllers = new Map<string, DeckController>();
  /** guildId -> active AI steering / harmonic arc directive for Endless Wave (`v@w wave ...`). */
  private ewSteerPrompt = new Map<string, string>();
  /** guildId -> buffered AI crate-digger picks for Endless Wave. */
  private ewAiPickBuffer = new Map<string, WeaselWavePick[]>();
  /** track.uri -> 1-line AI crate-digger note explaining sample/producer/harmonic fit. */
  private ewTrackLore = new Map<string, string>();
  /** Message IDs sent by Amok ("The Weasel") so users can reply without `v@w`. */
  private amokMessageIds = new Set<string>();
  /** guildId -> active lyric guess-the-song quiz. */
  private quizzes = new Map<string, { name: string; artists: string[]; timer: NodeJS.Timeout }>();
  /** guildId -> (track uri|name) whose lyrics were last broadcast, so a
   *  pause/resume state re-emit doesn't refetch/rebroadcast the same lyrics. */
  private lastLyricsKey = new Map<string, string>();
  /** guildId -> pending Stump-the-Bot wager (resolved on the track's end/skip). */
  private stumps = new Map<string, { uri: string; user: string; fit: number; name: string; channelId: string }>();
  /** guildId -> a DJ Duel awaiting both tracks' fates in the room. */
  private duels = new Map<
    string,
    {
      channelId: string;
      at: number;
      predicted: string;
      a: { user: string; uri: string; name: string; fit: number; outcome?: 'played' | 'skipped' };
      b: { user: string; uri: string; name: string; fit: number; outcome?: 'played' | 'skipped' };
    }
  >();
  /** nonce -> a roulette offer waiting on a star/ban button press. */
  private rouletteOffers = new Map<
    string,
    {
      guildId: string;
      key: string;
      userId: string;
      track: {
        uri: string;
        name: string;
        artists: string[];
        album: string;
        durationMs: number;
        source: string;
        image?: string;
      };
    }
  >();
  /** nonce -> a /similar candidate list waiting on a queue button press. */
  private similarPending = new Map<string, { guildId: string; userId: string; tracks: ResolvedTrack[]; at: number }>();
  /** guildId -> recently applied V@config clauses (most recent first). */
  private recentConfig = new Map<string, string[]>();
  /** guildId -> mood visuals on; moodColor tints now-playing colors from features. */
  private moodOn = new Set<string>();
  private moodColor = new Map<string, number>();
  /** Guilds with the optional TTS DJ announcements enabled (opt-in, default off). */
  private ttsAnnounced = new Map<string, string>();
  /** guildId -> panel message location. */
  private panels = new Map<string, { channelId: string; messageId: string }>();
  private npMessages = new Map<string, { channelId: string; messageId: string }>();
  /** guildId -> last text channel a command ran in (mini now-playing posts there). */
  private lastTextChannel = new Map<string, string>();
  /** guildId -> auto-posted mini now-playing message (always-on, self-updating). */
  private miniNp = new Map<string, { channelId: string; messageId: string }>();
  /** guildId -> track uri the mini strip currently represents (for re-anchoring). */
  private miniTrackUri = new Map<string, string>();
  /** Guilds currently re-anchoring their mini now-playing strip — a lock that
   *  prevents overlapping state-change calls from posting duplicate strips. */
  private miniNpBusy = new Set<string>();
  /**
   * Anti-spam gate for the mini now-playing strip. POSTING a new message is
   * rate-limited hard; editing the existing one is always allowed. A burst
   * (e.g. the panel refresh clearing the registry on a failed edit while state
   * changes arrive every second) used to post a fresh panel every second and
   * flood the channel — that must never be possible again.
   */
  private miniNpGate = new Map<string, { last: number; count: number; since: number; mutedUntil: number }>();
  private static readonly MINI_NP_MIN_POST_GAP_MS = 20_000;
  private static readonly MINI_NP_BURST_MAX = 4;
  private static readonly MINI_NP_BURST_WINDOW_MS = 5 * 60_000;
  private static readonly MINI_NP_MUTE_MS = 10 * 60_000;
  /** Last rendered strip payload per guild — identical renders skip the edit. */
  private miniNpSig = new Map<string, string>();
  /** Last "queue ended" notice per guild, so a flapping queue can't spam it. */
  private queueEndedNotified = new Map<string, number>();
  /** guildId -> track uri whose auto mini-strip is suppressed because a command
   *  reply is already showing that track (prevents a duplicate now-playing). */
  private miniNpSuppress = new Map<string, string>();
  /** Message IDs already processed — guards against Discord retrying messageCreate. */
  private processedMessages = new Set<string>();
  /** The last tracks removed from the queue (per guild), so `V@undo` can put them
   *  back. A single slot: a second removal replaces it. */
  private lastRemoved = new Map<string, TrackInfo[]>();
  private panelRefreshQueued = false;
  /** messageId -> live karaoke session (synced lines + track), edited by a ticker. */
  private static readonly KARAOKE_MAX_SESSIONS = 200;
  private static readonly KARAOKE_TTL_MS = 30 * 60 * 1000; // 30 min
  private static readonly LYRIC_PAGES_MAX = 500;
  private static readonly LYRIC_PAGES_TTL_MS = 60 * 60 * 1000; // 1 hour
  private karaokeSessions = new Map<
    string,
    {
      guildId: string;
      channelId: string;
      messageId: string;
      title: string;
      artist: string;
      lines: SyncedLine[];
      lastIdx: number;
      createdAt: number;
    }
  >();
  private lyricPages = new Map<
    string,
    { title: string; artist: string; synced: boolean; pages: string[]; syncedLines?: SyncedLine[]; createdAt: number }
  >();
  private lyricPagesTicker: NodeJS.Timeout | null = null;
  private karaokeTicker: NodeJS.Timeout | null = null;
  /** guildId -> active sleep timer (stops playback + leaves voice when it fires). */
  private sleepTimers = new Map<
    string,
    { timeout: NodeJS.Timeout; at: number; fade?: NodeJS.Timeout; step?: NodeJS.Timeout; prevVolume?: number }
  >();

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
    } catch (err) {
      console.warn('[vaporzr] failed to load panel registrations:', err instanceof Error ? err.message : err);
    }
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
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Message, Partials.Channel, Partials.Reaction],
    });
    this.rest = new REST({ version: '10' });
    // The jam/request page accepts the same input as V@p: direct links,
    // playlists, Spotify, Suno, Apple Music, SoundCloud, plain searches.
    // resolvePlayInput lives in this module, so the bridge takes it as a hook
    // rather than importing it (discord.ts already imports the bridge).
    bridge.onResolveRequest = resolvePlayInput;
    // The panel's play/resume need a voice channel and cannot supply one (no
    // interaction to read a member from), so the bridge asks the bot to join
    // wherever the listeners are.
    bridge.onEnsureJoined = () => this.joinWhereListenersAre();
    // Live decks: the bridge carries the sockets, the bot owns the mixers.
    bridge.onDeckAction = (guildId, msg) => {
      void this.handleDeckMessage(guildId, msg).catch((err) => {
        console.warn(`[deck] ${err instanceof Error ? err.message : err}`);
        bridge.notice('error', 'Deck command failed — see the bot log.');
      });
    };
    bridge.deckStateProvider = (guildId) => {
      const gid = guildId ?? bridge.getPrimaryGuildId();
      return gid ? (this.deckControllers.get(gid)?.state() ?? null) : null;
    };
    // The web panel's Share button posts the jam card through the same path as
    // /jam. The panel has no channel of its own, so the bot resolves one (the
    // panel's channel, else the last text channel it heard from).
    bridge.onShareJam = (guildId) => this.shareJamCard(guildId ?? this.client.guilds.cache.first()?.id ?? '', null);
    // Panel toggles Endless Wave through the same machinery as `V@ew on/off`.
    bridge.setEndlessWaveToggle((guildId, mode) => {
      void this.panelSetEndlessWave(guildId, mode).catch((err) => {
        console.warn(`[autoplay] panel set failed: ${err instanceof Error ? err.message : err}`);
      });
    });
    // A queue that was mid-playback when the bot restarted gets one chance to
    // resume seamlessly: rejoin the channel it was streaming into and start the
    // restored current track (never earlier, already-played ones).
    sessions.onRestoredPlaying((s, info) => this.scheduleRestartResume(s, info));
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
        onQueueChanged: () => {
          // Void any bet whose track left the queue before it played.
          this.expireBets(s);
          this.scheduleWaveTopUp(s);
          // An emptied queue means playback is done for now — drop the
          // now-playing voice status so it doesn't linger as stale.
          if (s.queue.getSnapshot().tracks.length === 0) this.clearVoiceStatus(s);
        },
        onStateChanged: (st) => {
          if (st.playing && st.track) {
            this.markWaveStarted(s, st.track);
            void this.syncVoiceStatus(s);
            if (this.moodOn.has(s.guildId)) void this.updateMood(s, st.track);
            this.stats.notePlayed(s.guildId ?? '', st.track.addedBy ?? 'unknown', st.track.artists);
            this.maybeAnnounceTts(s, st.track);
          }
          this.scheduleWaveTopUp(s);
        },
      });
      s.playback.onTrackEnd = (ended) => {
        // Mini-games: a track that reached its natural end beats the bot's bet
        // and counts as "played through" for any duel it was part of.
        this.resolveStump(s, ended, false);
        this.noteDuelOutcome(s, ended, false);
        if (!EW.isAutoActive(s.endlessWave)) return;
        void this.waveTrackEnded(s, ended).catch((err) => {
          console.warn(`[endlesswave] on-end failed: ${err instanceof Error ? err.message : err}`);
        });
      };
      // Fired only for early abandonment (skip / voteskip / jump).
      s.playback.onTrackSkipped = (skipped) => {
        this.resolveStump(s, skipped, true);
        this.noteDuelOutcome(s, skipped, true);
      };
      // When the queue runs dry, post a friendly notice so listeners aren't left
      // wondering why the music stopped. An active wave ignores the backoff here
      // and refills right away so silence doesn't hang.
      s.playback.onQueueEnd = () => {
        void (async () => {
          if (EW.isAutoActive(s.endlessWave)) {
            this.ewRetryAfter.delete(s.guildId);
            const before = s.queue.getSnapshot().tracks.length;
            try {
              await this.topUpWave(s);
            } catch (err) {
              console.warn(`[endlesswave] queue-end refill failed: ${err instanceof Error ? err.message : err}`);
            }
            // Wave refilled the queue — resume on the first refilled track so
            // the wave actually plays (the refill alone left the bot idle with a
            // queue). If it couldn't (dead-end / backoff), fall through so the
            // ambient pad or queue-ended notice still fires.
            if (s.queue.getSnapshot().tracks.length > before) {
              if (!s.queue.getState().playing) s.playback.playAt(before);
              return;
            }
          }
          if (this.perms.getAmbient(s.guildId) && s.voice.isJoined()) {
            void s.playback.startAmbient();
            return;
          }
          // Nothing will play now — clear the voice status while still connected.
          this.clearVoiceStatus(s);
          void this.notifyQueueEnded(s.guildId);
        })();
      };
      // Playback stopped because several tracks in a row couldn't start.
      s.playback.onPlaybackStalled = () => {
        void this.notifyPlaybackStalled(s.guildId);
      };
      // Auto ducking: 'auto' ducks for any speaker, 'hosts' only for DJ/owner,
      // 'off' (default) disables it. Manual /duck still works either way.
      s.voice.setDuckAuto((userId) => {
        const mode = this.perms.getDuckMode(s.guildId);
        if (mode === 'auto') return true;
        if (mode === 'hosts') return this.isDuckHost(s.guildId, userId);
        return false;
      });
      // A wave restored as active from disk needs re-arming after a restart:
      // kick off an immediate top-up so it resumes generating on its own.
      if (EW.isAutoActive(s.endlessWave)) {
        this.ewRetryAfter.delete(s.guildId);
        void this.topUpWave(s).catch((err) => {
          console.warn(`[endlesswave] post-restart top-up failed: ${err instanceof Error ? err.message : err}`);
        });
      }
    });
  }

  /** Resolve the isolated playback session for a guild (DMs share one session). */
  private sessionFor(guildId: string | null | undefined): Session {
    return this.sessions.get(guildId ?? '__dm__');
  }

  /** Live decks for a guild — one mixer per guild, sharing its voice link. */
  private deckFor(guildId: string): DeckController {
    let decks = this.deckControllers.get(guildId);
    if (!decks) {
      const s = this.sessionFor(guildId);
      decks = new DeckController({
        guildId,
        voice: s.voice,
        resolve: (query) => resolvePlayInput(query),
        resolveStream: async (track) => (await EW.resolveCandidate(track))?.streamUrl,
        // Decks own the stream while they're up; the queue keeps its cursor so
        // `V@r` picks up exactly where the set interrupted it.
        pauseQueue: () => s.playback.pause(),
        onState: (state) => this.bridge.broadcastDeck(state, guildId),
      });
      this.deckControllers.set(guildId, decks);
    }
    return decks;
  }

  /**
   * Deck commands from the `/deck` page. Continuous controls (fader, trim, EQ,
   * seek) stay silent — only discrete actions and failures toast, otherwise
   * dragging the crossfader would fire a hundred notifications.
   */
  private async handleDeckMessage(
    guildId: string | undefined,
    msg: (InboundMessage & { type: 'deck:load' }) | (InboundMessage & { type: 'deck:control' }),
  ): Promise<void> {
    const gid = guildId ?? this.bridge.getPrimaryGuildId() ?? '';
    if (!gid) return;
    const decks = this.deckFor(gid);
    const report = (r: { ok: boolean; message: string }): void => {
      this.bridge.notice(r.ok ? 'success' : 'error', r.message);
    };
    const quiet = (r: { ok: boolean; message: string }): void => {
      if (!r.ok) this.bridge.notice('error', r.message);
    };

    if (msg.type === 'deck:load') {
      if (!this.sessionFor(gid).voice.isConnectionReady() && !(await this.joinWhereListenersAre())) {
        report({ ok: false, message: 'Join a voice channel first — I need somewhere to spin.' });
        return;
      }
      report(await decks.load(msg.deck, msg.query));
    } else {
      const deck: DeckId = msg.deck ?? 'a';
      switch (msg.action) {
        case 'play':
          report(decks.play(msg.deck));
          break;
        case 'pause':
          report(decks.pause(msg.deck));
          break;
        case 'cue':
          quiet(decks.pause(deck));
          quiet(decks.seek(deck, 0));
          break;
        case 'seek':
          quiet(decks.seek(deck, msg.positionMs ?? 0));
          break;
        case 'nudge':
          quiet(decks.nudge(deck, msg.positionMs ?? 0));
          break;
        case 'sync':
          report(decks.sync());
          break;
        case 'stop':
          report(decks.stop());
          break;
        case 'crossfader':
          quiet(decks.crossfader(msg.value ?? 0.5));
          break;
        case 'gain':
          quiet(decks.gain(deck, msg.value ?? 1));
          break;
        case 'eq':
          quiet(decks.eq(deck, (msg.band ?? 'mid') as keyof DeckEq, msg.db ?? 0));
          break;
        case 'kill':
          quiet(decks.kill(deck, (msg.band ?? 'mid') as keyof DeckEq));
          break;
        case 'tempo':
          quiet(decks.tempo(deck, msg.tempo ?? 1));
          break;
        default:
          break;
      }
    }
    this.bridge.broadcastDeck(decks.state(), gid);
  }

  async start(): Promise<void> {
    this.client.on('clientReady', async () => {
      console.log(`[vaporzr] logged in as ${this.client.user?.tag}`);
      await this.loadPanelRegistrations();
      // Remove now-playing strips in channels that never opted in (see /npchannel).
      await this.cleanupMiniNp();
      // Create every guild's session up front so queue restores (and the
      // seamless restart resume) run at boot instead of waiting for the first
      // event in that guild.
      for (const g of this.client.guilds.cache.values()) this.sessions.get(g.id);
      // Alert the owner if the YouTube canary flips to a broken state.
      setYoutubeHealthListener((status, context) => void this.alertYoutubeHealth(status, context));
      if (!config.ownerId) {
        // Auto-detect owner from the application record. This fetch can fail
        // on a flaky network at boot, so retry with backoff, then keep
        // re-checking periodically — owner rank must never silently vanish.
        let attempts = 0;
        const MAX_RETRIES = 10;
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
            console.warn(
              `[vaporzr] owner auto-detect attempt ${attempts} failed:`,
              err instanceof Error ? err.message : err,
            );
            if (attempts < 6) {
              const dt = setTimeout(() => void detect(), 5000 * attempts);
              dt.unref?.();
            } else if (attempts < MAX_RETRIES) {
              // Slow periodic re-check with max retry limit.
              const t = setInterval(
                () => {
                  if (this.perms.hasOwner) {
                    clearInterval(t);
                    return;
                  }
                  void detect();
                },
                15 * 60 * 1000,
              );
              t.unref?.();
            } else {
              console.warn(`[vaporzr] owner auto-detect giving up after ${MAX_RETRIES} attempts`);
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
      void this.registerCommands().catch((err) =>
        console.error('[vaporzr] registerCommands failed:', err instanceof Error ? err.message : err),
      );
      void this.ensurePanelEmojis();
      void this.syncBotAvatar();
      void this.loadKeyedGuilds();
      this.startAccessWatch();
    });
    // Never let a stray client error take the process down.
    this.client.on('error', (e) => console.warn('[vaporzr] client error:', e instanceof Error ? e.message : e));
    this.client.on('interactionCreate', (i) => {
      if (process.env.LOG_MESSAGES === '1') {
        const name = 'commandName' in i ? i.commandName : 'customId' in i ? i.customId : '';
        console.log(`[dbg] interaction type=${i.type} name=${name} guild=${i.guildId ?? ''}`);
      }
      void this.onInteraction(i);
    });
    this.client.on('messageCreate', (m) => {
      if (process.env.LOG_MESSAGES === '1') {
        console.log(
          `[dbg] message id=${m.id} guild=${m.guildId ?? ''} ch=${m.channelId} bot=${m.author?.bot} partial=${m.partial} content=${JSON.stringify(m.content ?? '').slice(0, 100)}`,
        );
      }
      void this.handleMessageCommand(m);
    });
    this.client.on(
      'guildCreate',
      () =>
        void this.registerCommands().catch((err) =>
          console.error('[vaporzr] registerCommands on guildCreate failed:', err instanceof Error ? err.message : err),
        ),
    );
    this.client.on('guildCreate', () => this.syncPrimaryGuild());
    this.client.on('guildCreate', (g) => void this.handleGuildCreate(g));
    this.client.on('guildDelete', (g) => {
      this.cancelSleepTimer(g.id);
      this.syncPrimaryGuild();
    });
    // Duplicate-instance detection. Two clients sharing one token fight over the
    // single gateway session, which surfaces as rapid disconnect/reconnect churn
    // (missed events, duplicate replies, voice flapping) — warn loudly so it's
    // obvious instead of looking like a mysterious bug.
    const recentDisconnects: number[] = [];
    this.client.on('shardDisconnect', (event, shardId) => {
      const now = Date.now();
      recentDisconnects.push(now);
      while (recentDisconnects.length && now - recentDisconnects[0] > 60_000) recentDisconnects.shift();
      const code = (event as { code?: number } | undefined)?.code;
      console.warn(`[vaporzr] gateway shard ${shardId} disconnected (code ${code ?? '?'})`);
      if (recentDisconnects.length >= 3) {
        console.error(
          '[vaporzr] WARNING: gateway dropped 3+ times in 60s. Another instance is probably ' +
            'using this bot token (run only ONE), or the network/host is unstable.',
        );
        recentDisconnects.length = 0;
      }
    });
    this.client.on('shardResume', (_shardId, replayedEvents) =>
      console.log(`[vaporzr] gateway shard resumed (${replayedEvents} events replayed)`),
    );
    // Reaction controls on the always-on now-playing strip.
    this.client.on('messageReactionAdd', (reaction, user) => {
      void this.handleReaction(reaction as MessageReaction, user as User);
    });
    // Auto-hype: beat onsets from the analyzer fire a short SFX.
    analyzer.setBeatHandler(() => this.onBeat());
    await this.loginWithRetry();
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
      console.warn(`[vaporzr] could not send welcome to ${guild.name}:`, err instanceof Error ? err.message : err);
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
        perms?.has(PermissionFlagsBits.SendMessages) === true && perms.has(PermissionFlagsBits.EmbedLinks) === true
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
          'The server owner is **admin** here automatically — use `/perms` to grant roles. Every server has its own isolated queue, which survives reconnects — `/leave` clears it and leaves the voice channel.',
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
      if (interaction.customId.startsWith('lyrics_karaoke:')) {
        await this.startLyricsKaraoke(interaction);
      } else if (interaction.customId.startsWith('jampin:')) {
        await this.handleJamPin(interaction);
      } else if (interaction.customId.startsWith('mashvote:')) {
        await this.handleMashVote(interaction);
      } else if (interaction.customId.startsWith('mashreveal:')) {
        await this.handleMashReveal(interaction);
      } else if (interaction.customId.startsWith('mashrepick:')) {
        await this.handleMashRepickButton(interaction);
      } else if (interaction.customId.startsWith('mashreclose:')) {
        await this.handleMashRepickClose(interaction);
      } else if (interaction.customId.startsWith('swap:')) {
        await this.handleSwapButton(interaction);
      } else if (interaction.customId.startsWith('vzhelp:')) {
        const id = interaction.customId.slice('vzhelp:'.length);
        if (id === 'all') {
          await interaction.reply({ embeds: this.helpAllEmbeds(), flags: MessageFlags.Ephemeral }).catch(() => {});
        } else if (id === 'aliases') {
          await interaction.reply({ embeds: [this.helpAliasesEmbed()], flags: MessageFlags.Ephemeral }).catch(() => {});
        } else {
          const embed = this.helpCategoryEmbed(id);
          if (embed) await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral }).catch(() => {});
        }
      } else if (interaction.customId.startsWith('qa:')) {
        await this.handleQueueAdjust(interaction);
      } else if (interaction.customId.startsWith('roulette:')) {
        await this.handleRouletteButton(interaction);
      } else if (interaction.customId.startsWith('similar:')) {
        await this.handleSimilarButton(interaction);
      } else {
        await this.handleButton(interaction);
      }
      return;
    }
    if (interaction.isStringSelectMenu()) {
      if (interaction.customId === 'qa:pick') {
        await this.handleQueueAdjust(interaction);
      } else if (interaction.customId === 'queue_page') {
        const s = this.sessionFor(interaction.guildId);
        const start = parseInt(interaction.values[0] ?? '0', 10);
        const { embeds, components } = this.queuePage(s, Number.isFinite(start) ? start : 0);
        await interaction.update({ embeds, components }).catch(() => {});
      } else if (interaction.customId.startsWith('lyrics_page:')) {
        const id = interaction.customId.slice('lyrics_page:'.length);
        const stash = this.lyricPages.get(id);
        if (stash) {
          const val = interaction.values[0] ?? '0';
          if (val === 'full') {
            const fullText = stash.pages.join('\n\n');
            const embeds = [this.lyricsPageEmbed(stash.title, stash.artist, stash.synced, fullText, 1, 1)];
            const components = this.lyricsComponents(id, stash.pages, Boolean(stash.syncedLines?.length), -1);
            await interaction.update({ embeds, components }).catch(() => {});
          } else {
            const idx = parseInt(val, 10);
            const page = Number.isFinite(idx) ? Math.min(stash.pages.length - 1, Math.max(0, idx)) : 0;
            const embeds = [
              this.lyricsPageEmbed(
                stash.title,
                stash.artist,
                stash.synced,
                stash.pages[page],
                page + 1,
                stash.pages.length,
              ),
            ];
            const components = this.lyricsComponents(id, stash.pages, Boolean(stash.syncedLines?.length), page);
            await interaction.update({ embeds, components }).catch(() => {});
          }
        }
      } else if (interaction.customId.startsWith('vzsearch:')) {
        await this.handleSearchPick(interaction);
      } else if (interaction.customId.startsWith('swapselect:')) {
        await this.handleSwapPick(interaction);
      } else if (interaction.customId.startsWith('swapitem:')) {
        await this.handleSwapItemPick(interaction);
      } else if (interaction.customId.startsWith('skipto:')) {
        await this.handleSkipToPick(interaction);
      }
      return;
    }
    if (interaction.isAutocomplete()) {
      await this.handleAutocomplete(interaction);
      return;
    }
    if (interaction.isModalSubmit()) {
      if (interaction.customId.startsWith('mashrepickmodal:')) {
        await this.handleMashRepickModal(interaction);
        return;
      }
      if (interaction.customId.startsWith('swapmodal:')) {
        await this.handleSwapModal(interaction);
        return;
      }
      return;
    }
    if (!interaction.isChatInputCommand()) return;
    try {
      await this.handleCommand(interaction);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[discord] command "/${interaction.commandName}" failed in guild ${interaction.guildId ?? 'DM'}: ${msg}`,
      );
      const friendly = friendlyPlayError(err);
      if (interaction.deferred)
        await interaction.followUp({ content: `⚠️ ${friendly}`, flags: MessageFlags.Ephemeral });
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

  /** Set or replace a guild's sleep timer. Fades the volume out over the last
   *  ~20s, then fires once and clears itself. */
  private setSleepTimer(s: Session, ms: number, onFire: () => void): void {
    this.cancelSleepTimer(s.guildId);
    const FADE_MS = 20_000;
    let fade: NodeJS.Timeout | undefined;
    let step: NodeJS.Timeout | undefined;
    let prevVolume: number | undefined;
    if (ms > FADE_MS + 5_000) {
      fade = setTimeout(() => {
        prevVolume = s.queue.getState().volume;
        const steps = 20;
        let i = 0;
        step = setInterval(() => {
          i++;
          s.playback.volume(Math.max(0, Math.round((prevVolume ?? 100) * (1 - i / steps))));
          if (i >= steps && step) clearInterval(step);
        }, FADE_MS / steps);
        step.unref?.();
        const e = this.sleepTimers.get(s.guildId);
        if (e) {
          e.step = step;
          e.prevVolume = prevVolume;
        }
      }, ms - FADE_MS);
      fade.unref?.();
    }
    const timeout = setTimeout(() => {
      this.sleepTimers.delete(s.guildId);
      onFire();
    }, ms);
    timeout.unref?.();
    this.sleepTimers.set(s.guildId, { timeout, at: Date.now() + ms, fade, prevVolume });
  }

  private cancelSleepTimer(guildId: string): void {
    const t = this.sleepTimers.get(guildId);
    if (t) {
      clearTimeout(t.timeout);
      if (t.fade) clearTimeout(t.fade);
      if (t.step) clearInterval(t.step);
      // Restore the pre-fade volume if the timer is cancelled mid-fade.
      if (t.prevVolume !== undefined) this.sessions.get(guildId).playback.volume(t.prevVolume);
      this.sleepTimers.delete(guildId);
    }
  }

  /** Fired when a sleep timer elapses: stop playback, clear queue, leave voice. */
  private async sleepFireNotify(s: Session): Promise<void> {
    s.playback.stopAll();
    s.queue.clear();
    s.voice.leave();
    const guildId = s.guildId;
    // Only the opted-in now-playing channel (see /npchannel) — never an
    // arbitrary channel the bot merely saw a command in.
    const channelId = this.perms.getNpChannel(guildId);
    if (channelId) {
      try {
        const channel = await this.client.channels.fetch(channelId);
        if (channel && 'send' in channel) {
          await channel.send('😴 Sleep timer up — playback stopped and I left the voice channel. Good night!');
        }
      } catch {
        /* channel gone — nothing to notify */
      }
    }
  }

  /** Hue/sat/light from a track's audio features (valence → hue, energy → sat/light). */
  private moodTone(f: EW.AudioFeatures): { hue: number; sat: number; light: number } {
    return {
      hue: Math.round((1 - clamp01(f.valence ?? 0.5)) * 280),
      sat: Math.round(45 + clamp01(f.energy ?? 0.5) * 45),
      light: Math.round(38 + clamp01(f.energy ?? 0.5) * 16),
    };
  }

  /** Stable per-track hue for sources with no Spotify features (YouTube-only
   *  tracks), so mood visuals still shift every song instead of going dead. */
  private moodFallbackTone(track: TrackInfo): { hue: number; sat: number; light: number } {
    const s = `${track.name ?? ''}|${(track.artists ?? [])[0] ?? ''}`;
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
    return { hue: h, sat: 62, light: 52 };
  }

  /** Broadcast the current track's mood palette to the visuals (and panels). */
  private async updateMood(s: Session, track: TrackInfo): Promise<void> {
    const f = await EW.fetchFeatures(track).catch(() => null);
    const tone = f ? this.moodTone(f) : this.moodFallbackTone(track);
    const color = hslToInt(tone.hue, tone.sat, tone.light);
    this.moodColor.set(s.guildId, color);
    this.bridge.broadcast({
      type: 'visuals:mood',
      on: true,
      hue: tone.hue,
      sat: tone.sat,
      light: tone.light,
      energy: f?.energy ?? 0.5,
      valence: f?.valence ?? 0.5,
      color,
    });
    this.schedulePanelRefresh();
  }

  /** Tell the visuals to fall back to the static theme. */
  private clearMood(guildId: string): void {
    this.moodOn.delete(guildId);
    this.moodColor.delete(guildId);
    this.bridge.broadcast({ type: 'visuals:mood', on: false });
    this.schedulePanelRefresh();
  }

  /** Auto-DJ: pick a set for the mood / time of day / weather, then let Endless Wave carry it. */
  private async vibeDj(s: Session, moodArg: string | undefined, ensureJoined: () => Promise<boolean>): Promise<string> {
    // Natural language first: "chill like Bonobo", "hype workout 5", "sad acoustic"…
    // Maps the words to Spotify audio-feature targets so they steer the sound,
    // not just the search text. Falls back to the classic mood seed on failure.
    if (moodArg?.trim()) {
      const parsed = parseVibe(moodArg);
      if (vibeIsSteerable(parsed)) {
        const nl = await this.vibeFromTargets(s, parsed, ensureJoined);
        if (nl) return nl;
      }
    }
    const weather = moodArg ? null : await this.fetchWeatherMood().catch(() => null);
    const seed = (moodArg?.trim() || weather || this.timeOfDayMood()).trim();
    let picks = await searchCandidates(seed, 5).catch(() => [] as ResolvedTrack[]);
    if (picks.length === 0) picks = await searchYoutube(seed, 5).catch(() => [] as ResolvedTrack[]);
    if (picks.length === 0) return `🔎 Couldn't find anything for “${seed}”.`;
    this.setAutoplayMode(s, 'smart');
    const failed = await this.playTracks(s, picks.slice(0, 5), 'vibe-dj', ensureJoined);
    const tag = weather ? ` (${weather})` : '';
    return `🎧 **Vibe DJ** — queued ${picks.length} track${picks.length === 1 ? '' : 's'} for “**${seed}**”${tag}. Endless Wave is on to keep the mood going.${failed ? `\n⚠️ ${failed}` : ''}`;
  }

  /** Queue tracks from parsed vibe targets (audio-feature steering via Spotify recs). */
  private async vibeFromTargets(
    s: Session,
    parsed: ParsedVibe,
    ensureJoined: () => Promise<boolean>,
  ): Promise<string | null> {
    try {
      // Spotify /recommendations needs at least one seed: "like X" → that artist's
      // top track; otherwise seed from whatever is currently playing.
      let seedTracks: string[] = [];
      let seedName = '';
      if (parsed.likeArtist) {
        const top = await searchTracks(parsed.likeArtist, 1).catch(() => null);
        const id = top?.[0] ? extractSpotifyId(top[0].uri) : null;
        if (id) {
          seedTracks = [id];
          seedName = top![0].name;
        }
      }
      if (seedTracks.length === 0 && parsed.genres.length === 0) {
        const cur = s.queue.getCurrentTrack();
        const curId = cur ? extractSpotifyId(cur.uri) : null;
        if (!cur || !curId) return null;
        seedTracks = [curId];
        seedName = cur.name;
      }
      // parseVibe speaks "energy/valence/…" but /recommendations wants
      // "target_energy/target_valence/…" — map them explicitly (a blind spread
      // would silently drop every target and steer nothing).
      const recParams: RecommendationParams = {
        ...(seedTracks.length ? { seedTracks } : {}),
        ...(parsed.genres.length ? { seedGenres: parsed.genres } : {}),
        limit: 30,
      };
      const t = parsed.targets;
      if (t.energy !== undefined) recParams.targetEnergy = t.energy;
      if (t.valence !== undefined) recParams.targetValence = t.valence;
      if (t.danceability !== undefined) recParams.targetDanceability = t.danceability;
      if (t.instrumentalness !== undefined) recParams.targetInstrumentalness = t.instrumentalness;
      if (t.acousticness !== undefined) recParams.targetAcousticness = t.acousticness;
      if (t.minTempo !== undefined) recParams.minTempo = t.minTempo;
      if (t.maxTempo !== undefined) recParams.maxTempo = t.maxTempo;
      const recs = await getRecommendations(recParams);
      if (recs.length === 0) return null;
      // Skip tracks already queued (same song, any upload) — like every add path.
      const snap = s.queue.getSnapshot();
      const queued = new Set(snap.tracks.map((t) => `${t.name.toLowerCase()}|${(t.artists[0] ?? '').toLowerCase()}`));
      const fresh = recs.filter((t) => !queued.has(`${t.name.toLowerCase()}|${(t.artists[0] ?? '').toLowerCase()}`));
      const picks = (fresh.length ? fresh : recs).slice(0, parsed.count);
      this.setAutoplayMode(s, 'smart');
      const failed = await this.playTracks(s, picks, 'vibe-dj', ensureJoined);
      const understood = [...parsed.matched, ...parsed.genres.map((g) => `+${g}`)].join(' · ');
      return (
        `🎧 **Vibe DJ** — heard: **${understood || 'the mood'}**${seedName ? `, seeded from **${seedName}**` : ''}.` +
        `\nQueued ${picks.length} track${picks.length === 1 ? '' : 's'} matched on audio features (energy/valence/etc.), Endless Wave keeps the mood going.` +
        `${failed ? `\n⚠️ ${failed}` : ''}`
      );
    } catch (err) {
      console.warn('[vibe] target-based vibe failed:', err instanceof Error ? err.message : err);
      return null;
    }
  }

  /** A mood seed based on the local hour. */
  private timeOfDayMood(): string {
    const h = new Date().getHours();
    if (h < 5) return 'deep night ambient';
    if (h < 11) return 'morning acoustic chill';
    if (h < 16) return 'daytime feel-good';
    if (h < 20) return 'evening indie rock';
    return 'late night electronic';
  }

  /** Map current weather (if VIBE_LAT/VIBE_LON are set) to a music mood. */
  private async fetchWeatherMood(): Promise<string | null> {
    if (!config.vibeLat || !config.vibeLon) return null;
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(config.vibeLat)}&longitude=${encodeURIComponent(config.vibeLon)}&current_weather=true`;
    const res = await fetch(url, { headers: { 'user-agent': 'vaporzr-bot' } });
    if (!res.ok) return null;
    const j = (await res.json()) as { current_weather?: { weathercode?: number } };
    const code = j.current_weather?.weathercode;
    if (code == null) return null;
    if (code === 0) return 'sunny feel-good';
    if (code <= 3) return 'cloudy chill';
    if (code === 45 || code === 48) return 'foggy ambient';
    if (code >= 51 && code <= 67) return 'rainy lo-fi';
    if (code >= 71 && code <= 77) return 'snowy ambient';
    if (code >= 80 && code <= 82) return 'rainy lo-fi';
    if (code >= 95) return 'stormy dark techno';
    return null;
  }

  /** Jump to the first synced-lyrics line whose text contains the phrase. */
  private async jumpToLyric(s: Session, phrase: string): Promise<string> {
    const cur = s.queue.getCurrentTrack();
    if (!cur) return 'Nothing is playing.';
    const lyr = await fetchLyrics(cur).catch(() => null);
    const lines = lyr?.syncedLines ?? [];
    if (lines.length === 0) return `No synced lyrics for **${cur.name}**, so I can't jump.`;
    const q = phrase.toLowerCase().trim();
    const hit = lines.find((l) => l.text.toLowerCase().includes(q));
    if (!hit) return `Couldn't find “${phrase}” in the lyrics.`;
    s.playback.seek(hit.timeMs);
    return `⏩ Jumped to **${fmtMs(hit.timeMs)}** — “${truncate(hit.text, 80)}”`;
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
        const query = interaction.options.getString('query');
        const file = interaction.options.getAttachment('file');
        await interaction.deferReply();
        if (file) {
          await this.playUploadedFiles(
            s,
            [{ name: file.name, url: file.url }],
            interaction.user.username,
            () => this.ensureJoinedForPlayback(interaction, s),
            async (embed) => interaction.editReply({ embeds: [embed] }),
          );
        } else if (!query) {
          await interaction.editReply('Give a track name/link, or attach an audio/video file.');
        } else if (isUrlPlayInput(query)) {
          const tracks = await resolvePlayInput(query);
          if (this.userQueueMode(s) === 'insert') await this.insertToQueue(interaction, tracks);
          else await this.addToQueue(interaction, tracks);
        } else {
          await this.presentSearch(interaction, query);
        }
        break;
      }

      case 'insert': {
        const query = interaction.options.getString('query', true);
        await interaction.deferReply();
        const tracks = await resolvePlayInput(query);
        await this.insertToQueue(interaction, tracks, isUrlPlayInput(query) ? undefined : query);
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
        await this.addToQueue(interaction, tracks, isUrlPlayInput(query) ? undefined : query);
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
        if (this.isDjMember(interaction.guild, interaction.member)) {
          this.clearSkipVote(interaction.guildId);
          s.playback.next();
          const r1 = await interaction.reply('⏭️ Skipped');
          this.autoExpire(r1);
          break;
        }
        const v = this.requestSkip(s, interaction.user.id);
        if (v.result === 'skipped') {
          s.playback.next();
          const r1 = await interaction.reply(
            this.perms.getVoteSkip(interaction.guildId ?? '') ? '⏭️ Skipped (majority vote reached)' : '⏭️ Skipped',
          );
          this.autoExpire(r1);
        } else if (v.result === 'started') {
          await interaction.reply(
            `🗳️ Vote to skip started — **${v.votes}/${v.needed}**. Others: use \`/skip\` again to vote.`,
          );
        } else {
          await interaction.reply(`🗳️ Vote recorded — **${v.votes}/${v.needed}**.`);
        }
        break;
      }

      case 'pause':
        if (!this.requireLevel('pause', interaction)) return this.deny(interaction);
        s.playback.pause();
        {
          const r2 = await interaction.reply('⏸️ Paused');
          this.autoExpire(r2);
        }
        break;

      case 'resume':
        if (!this.requireLevel('resume', interaction)) return this.deny(interaction);
        await s.playback.resume();
        {
          const r3 = await interaction.reply('▶️ Resumed');
          this.autoExpire(r3);
        }
        break;

      case 'clear':
        if (!this.requireLevel('clear', interaction)) return this.deny(interaction);
        // Clear the UPCOMING list only - the current track keeps playing.
        const removed = s.queue.clearUpcoming();
        const nowPlaying = s.queue.getState().track?.name;
        {
          const r4 = await interaction.reply(
            nowPlaying
              ? `Cleared ${removed} upcoming track${removed === 1 ? '' : 's'} - still playing **${nowPlaying}**`
              : 'Queue cleared',
          );
          this.autoExpire(r4);
        }
        break;

      case 'remove': {
        const index = interaction.options.getInteger('index', true);
        if (!this.requireLevel('remove', interaction)) return this.deny(interaction);
        const removed = s.removeFromQueue(index - 1);
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
          await s.voice.join(guild.id, channel.id, guild.voiceAdapterCreator, channel);
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
        {
          const r = await interaction.reply({
            content: '🔴 Live now-playing message posted right here — it updates itself.',
            flags: MessageFlags.Ephemeral,
          });
          this.autoExpireNotice(r);
        }
        break;
      }

      case 'lyrics': {
        if (!this.requireLevel('lyrics', interaction)) return this.deny(interaction);
        await interaction.deferReply();
        const query = interaction.options.getString('query') ?? undefined;
        const karaoke = interaction.options.getBoolean('karaoke') ?? false;
        if (karaoke) {
          const payload = await this.lyricsKaraokePayload(s, query);
          if ('error' in payload) {
            await interaction.followUp({ content: payload.error, flags: MessageFlags.Ephemeral });
          } else {
            const msg = await interaction.followUp({ embeds: [payload.embed] });
            this.registerKaraoke(
              s,
              msg.id,
              interaction.guildId!,
              interaction.channelId,
              payload.title,
              payload.artist,
              payload.syncedLines,
            );
          }
          break;
        }
        const payload = await this.lyricsPayload(s, query);
        if ('error' in payload) await interaction.followUp({ content: payload.error, flags: MessageFlags.Ephemeral });
        else await interaction.followUp({ embeds: payload.embeds, components: payload.components });
        break;
      }

      case 'shuffle': {
        if (!this.requireLevel('shuffle', interaction)) return this.deny(interaction);
        const modeArg = interaction.options.getString('mode');
        if (modeArg) {
          const mode = (
            modeArg === 'arc' ? 'arc' : modeArg === 'key' ? 'key' : modeArg === 'sonic' ? 'sonic' : 'flow'
          ) as ShuffleMode;
          // A smart reorder replaces the upcoming order with a deliberate one,
          // so random shuffle must go off or it re-randomises at the next track.
          const wasShuffle = s.queue.getState().shuffle;
          if (wasShuffle) s.playback.shuffle(false);
          await interaction.deferReply();
          const { embed, skipReason } = await this.smartShuffleCore(s, mode, wasShuffle);
          await interaction.editReply(skipReason ? skipReason : { embeds: [embed!] });
          break;
        }
        const on = interaction.options.getBoolean('enabled') ?? !s.queue.getState().shuffle;
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
        {
          const r = await interaction.editReply({ content: '🎛️ Control panel posted right here.' });
          this.autoExpireNotice(r);
        }
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
        if (!this.perms.isOwner(interaction.user.id)) return this.deny(interaction);
        const pl = vizTunnel.panelLink();
        const vl = vizTunnel.vizLink();
        const linkFor = (base: { url: string; secure: boolean }, token: string): string =>
          base.secure ? `${base.url}?invite=${encodeURIComponent(token)}` : '';

        if (sub === 'rotate') {
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
          const killed = revokeAll();
          await interaction.reply({
            content:
              `New master key issued. Every device and invite is dead ` +
              `(${killed.sessions} session${killed.sessions === 1 ? '' : 's'}, ${killed.invites} invite${killed.invites === 1 ? '' : 's'}).\n` +
              `The new key is in your .env (SHARE_KEY). Use \`/key give\` for links from now on.`,
            flags: MessageFlags.Ephemeral,
          });
          break;
        }

        if (sub === 'show') {
          if (!config.shareKey) {
            await interaction.reply({
              content: 'No share key is configured - the web tier is open.',
              flags: MessageFlags.Ephemeral,
            });
            break;
          }
          await interaction.reply({
            embeds: [
              new EmbedBuilder()
                .setTitle('Master key')
                .setDescription(
                  `**Key:** \`${config.shareKey}\`\n\n` +
                    'Keep this private: it can mint access. For people and devices use `/key give` - those links expire, work once and can be revoked.',
                )
                .setColor(this.themeColor())
                .setFooter({ text: '/key rotate invalidates every device · /key list shows them' }),
            ],
            flags: MessageFlags.Ephemeral,
          });
          break;
        }

        if (sub === 'list') {
          const access = listAccess();
          const when = (t: number) => `<t:${Math.floor(t / 1000)}:R>`;
          const sessions = access.sessions
            .map(
              (x) =>
                `\`${x.id}\` · ${x.scope}${x.owner ? ' · owner' : ''} · ${x.label} · last ${when(x.lastSeenAt)} · ` +
                `${describeUserAgent(x.lastUserAgent)}${x.lastIp ? ` · ${x.lastIp}` : ''}`,
            )
            .join('\n');
          const invites = access.invites
            .map(
              (x) =>
                `\`${x.id}\` · ${x.scope} · ${x.label} · ${when(x.expiresAt)} · ` +
                `${x.maxUses === 0 ? 'reusable' : `used ${x.uses}/${x.maxUses}`}`,
            )
            .join('\n');
          await interaction.reply({
            embeds: [
              new EmbedBuilder()
                .setTitle('Web access')
                .setColor(this.themeColor())
                .addFields(
                  { name: `Devices (${access.sessions.length})`, value: sessions || '`none`' },
                  { name: `Unused invites (${access.invites.length})`, value: invites || '`none`' },
                )
                .setFooter({ text: '/key revoke <id> cuts one off · /key rotate cuts everything' }),
            ],
            flags: MessageFlags.Ephemeral,
          });
          break;
        }

        if (sub === 'revoke') {
          const id = interaction.options.getString('id', true).trim();
          if (id === 'all') {
            const killed = revokeAll();
            await interaction.reply({
              content: `Revoked ${killed.sessions} session(s) and ${killed.invites} invite(s).`,
              flags: MessageFlags.Ephemeral,
            });
          } else {
            const ok = revokeSession(id);
            await interaction.reply({
              content: ok ? `Revoked \`${id}\`.` : `No device or invite with id \`${id}\`.`,
              flags: MessageFlags.Ephemeral,
            });
          }
          break;
        }

        // give - owner only: mint a single-use invite instead of handing out the key.
        if (!config.shareKey) {
          await interaction.reply({
            content: 'No share key is configured - the web tier is open.',
            flags: MessageFlags.Ephemeral,
          });
          break;
        }
        const scopeArg = interaction.options.getString('scope') ?? 'control';
        const scope: AccessScope = scopeArg === 'view' ? 'view' : scopeArg === 'request' ? 'request' : 'control';
        const hours = Math.max(
          1,
          Math.min(168, interaction.options.getInteger('hours') ?? (scope === 'control' ? 12 : 24)),
        );
        const minted = mintInvite(scope, `discord:${interaction.user.username}`, hours * 60 * 60 * 1000);
        const link = linkFor(scope === 'control' ? pl : vl, minted.token);
        if (interaction.guildId) await this.markKeyedGuild(interaction.guildId);
        await interaction.reply({
          embeds: [
            new EmbedBuilder()
              .setTitle(
                scope === 'control' ? 'Control invite' : scope === 'view' ? 'View invite' : 'Song-request invite',
              )
              .setDescription(
                (link ? `<${link}>\n\n` : '(links appear once PUBLIC_BASE_URL or a tunnel is up)\n\n') +
                  `Single use, expires in ${hours}h. ` +
                  (scope === 'control'
                    ? 'Unlocks the control panel, and the same link also opens /viz and /listen.'
                    : scope === 'view'
                      ? 'Watch the visualizer or listen in hi-fi; cannot change playback.'
                      : 'Opens the song-request page only - no listening, no controls.') +
                  "\n\nIf a key screen appears, paste this link's code there.",
              )
              .setColor(this.themeColor())
              .setFooter({ text: `id ${minted.invite.id} · /key revoke ${minted.invite.id} to cut it off early` }),
          ],
          flags: MessageFlags.Ephemeral,
        });
        break;
      }
      case 'endwav': {
        if (!this.requireLevel('endwav', interaction)) return this.deny(interaction);
        if (!interaction.guildId)
          return void (await interaction.reply({
            content: 'Must be used in a server.',
            flags: MessageFlags.Ephemeral,
          }));
        const s = this.sessionFor(interaction.guildId);
        const sub = interaction.options.getSubcommand();
        if (sub === 'on') {
          this.setAutoplayMode(s, 'smart');
          await interaction.reply({
            content: this.autoplayStatus(
              s,
              "🌊 **Endless Wave enabled** — I'll keep the vibes flowing with AI-curated tracks that evolve with your session.",
            ),
            flags: MessageFlags.Ephemeral,
          });
        } else if (sub === 'off') {
          const wasOff = EW.modeOf(s.endlessWave) === 'off';
          this.setAutoplayMode(s, 'off');
          await interaction.reply({
            content: wasOff
              ? 'Autoplay is already off.'
              : `🌊 **Autoplay off** — ${s.endlessWave.generated} tracks were auto-curated this session.`,
            flags: MessageFlags.Ephemeral,
          });
        } else {
          await interaction.reply({ content: this.autoplayStatus(s), flags: MessageFlags.Ephemeral });
        }
        break;
      }

      case 'autoplay': {
        if (!this.requireLevel('autoplay', interaction)) return this.deny(interaction);
        if (!interaction.guildId)
          return void (await interaction.reply({
            content: 'Must be used in a server.',
            flags: MessageFlags.Ephemeral,
          }));
        const s = this.sessionFor(interaction.guildId);
        const mode = interaction.options.getString('mode') as EW.AutoplayMode | null;
        const forceNow = interaction.options.getBoolean('now') ?? false;
        const count = interaction.options.getInteger('count');
        if (mode) this.setAutoplayMode(s, mode);
        if (count) this.ewAheadOverride.set(interaction.guildId, count);
        if (forceNow) {
          this.ewRetryAfter.delete(s.guildId);
          await this.topUpWave(s);
        }
        await interaction.reply({
          content: this.autoplayStatus(
            s,
            count
              ? `Autoplay buffer set to **${count}** track(s).`
              : mode
                ? `Autoplay set to **${mode.toUpperCase()}**.`
                : undefined,
          ),
          flags: MessageFlags.Ephemeral,
        });
        break;
      }

      case 'playlist': {
        if (!this.requireLevel('playlist', interaction)) return this.deny(interaction);
        if (!interaction.guildId)
          return void (await interaction.reply({
            content: 'Must be used in a server.',
            flags: MessageFlags.Ephemeral,
          }));
        const sub = interaction.options.getSubcommand();
        const ps = this.sessionFor(interaction.guildId);
        if (sub === 'save') {
          const name = interaction.options.getString('name', true);
          const snap = ps.queue.getSnapshot();
          const saved = this.playlists.save(
            interaction.guildId,
            name,
            snap.tracks.map((t) => ({
              uri: t.uri,
              name: t.name,
              artists: t.artists,
              album: t.album,
              durationMs: t.durationMs,
              source: t.source ?? 'spotify',
              image: t.image,
            })),
          );
          await interaction.reply({
            content: saved.ok
              ? `💾 Saved **${name}** (${saved.tracks} track${saved.tracks === 1 ? '' : 's'}).`
              : `⚠️ ${saved.error}`,
            flags: MessageFlags.Ephemeral,
          });
        } else if (sub === 'load') {
          const name = interaction.options.getString('name', true);
          const pl = this.playlists.get(interaction.guildId, name);
          if (!pl) {
            await interaction.reply({ content: `No playlist called **${name}**.`, flags: MessageFlags.Ephemeral });
            break;
          }
          const tracks = pl.tracks.map((t) => ({ ...t, source: t.source as ResolvedTrack['source'] }));
          const failed = await this.playTracks(ps, tracks, interaction.user.username, () =>
            this.ensureJoinedForPlayback(interaction, ps),
          );
          await interaction.reply({
            content: `▶️ Loading **${pl.name}** — ${tracks.length} track${tracks.length === 1 ? '' : 's'}${
              failed ? `\n⚠️ ${failed}` : ''
            }`,
            flags: MessageFlags.Ephemeral,
          });
        } else if (sub === 'delete') {
          const name = interaction.options.getString('name', true);
          const ok = this.playlists.delete(interaction.guildId, name);
          await interaction.reply({
            content: ok ? `🗑️ Deleted **${name}**.` : `No playlist called **${name}**.`,
            flags: MessageFlags.Ephemeral,
          });
        } else {
          const list = this.playlists.list(interaction.guildId);
          await interaction.reply({
            content: list.length
              ? `💾 Saved playlists:\n${list.map((p) => `• **${p.name}** — ${p.tracks.length} track${p.tracks.length === 1 ? '' : 's'}`).join('\n')}`
              : 'No saved playlists yet — use `/playlist save <name>`.',
            flags: MessageFlags.Ephemeral,
          });
        }
        break;
      }

      case 'djrole': {
        if (!this.requireLevel('djrole', interaction)) return this.deny(interaction);
        if (!interaction.guildId || !interaction.guild)
          return void (await interaction.reply({
            content: 'Must be used in a server.',
            flags: MessageFlags.Ephemeral,
          }));
        const off = interaction.options.getBoolean('off') ?? false;
        const role = interaction.options.getRole('role');
        if (off) {
          this.perms.setDjRole(interaction.guildId, null);
          await interaction.reply({
            content: '🎧 DJ role cleared — skip now uses vote-to-skip.',
            flags: MessageFlags.Ephemeral,
          });
        } else if (role) {
          this.perms.setDjRole(interaction.guildId, role.id);
          await interaction.reply({
            content: `🎧 DJ role set to <@&${role.id}>. Holders can skip/control without a vote.`,
            flags: MessageFlags.Ephemeral,
          });
        } else {
          const cur = this.perms.getDjRole(interaction.guildId);
          await interaction.reply({
            content: cur ? `🎧 DJ role: <@&${cur}>` : '🎧 No DJ role set — use `/djrole role:@YourRole`.',
            flags: MessageFlags.Ephemeral,
          });
        }
        break;
      }

      case 'ambient': {
        if (!this.requireLevel('ambient', interaction)) return this.deny(interaction);
        const gid = interaction.guildId;
        if (!gid)
          return void (await interaction.reply({
            content: 'Must be used in a server.',
            flags: MessageFlags.Ephemeral,
          }));
        const enabled = interaction.options.getBoolean('enabled');
        if (enabled === true) this.perms.setAmbient(gid, true);
        else if (enabled === false) this.perms.setAmbient(gid, false);
        const on = this.perms.getAmbient(gid);
        await interaction.reply({
          content: on
            ? "🌙 Lo-fi intermission **on** — when the queue ends I'll play a quiet lo-fi track instead of going quiet."
            : 'Ambient intermission **off** — the queue ends quietly.',
          flags: MessageFlags.Ephemeral,
        });
        break;
      }

      case 'jump': {
        if (!this.requireLevel('jump', interaction)) return this.deny(interaction);
        await interaction.deferReply();
        await interaction.editReply(await this.jumpToLyric(s, interaction.options.getString('query', true)));
        break;
      }

      case 'mood': {
        if (!this.requireLevel('mood', interaction)) return this.deny(interaction);
        const gid = interaction.guildId;
        if (!gid)
          return void (await interaction.reply({
            content: 'Must be used in a server.',
            flags: MessageFlags.Ephemeral,
          }));
        const enabled = interaction.options.getBoolean('enabled');
        if (enabled === true) this.moodOn.add(gid);
        else if (enabled === false) this.clearMood(gid);
        const on = this.moodOn.has(gid);
        if (on) {
          const cur = s.queue.getCurrentTrack();
          if (cur) void this.updateMood(s, cur);
        }
        await interaction.reply({
          content: on ? '🌈 Mood-reactive visuals **on** — colors follow the music.' : 'Mood-reactive visuals **off**.',
          flags: MessageFlags.Ephemeral,
        });
        break;
      }

      case 'tts': {
        if (!this.requireLevel('tts', interaction)) return this.deny(interaction);
        const gid = interaction.guildId;
        if (!gid)
          return void (await interaction.reply({
            content: 'Must be used in a server.',
            flags: MessageFlags.Ephemeral,
          }));
        const enabled = interaction.options.getBoolean('enabled');
        if (enabled !== null) this.perms.setTts(gid, enabled);
        const on = this.perms.getTts(gid);
        await interaction.reply({
          content: on
            ? ttsEngine.enabled
              ? "🗣 Spoken DJ announcements **on** — I'll announce each track."
              : '🗣 Announcements are **on**, but no TTS engine is configured on the bot (set `TTS_PROVIDER`).'
            : '🗣 Spoken DJ announcements **off**.',
          flags: MessageFlags.Ephemeral,
        });
        break;
      }

      case 'voteskip': {
        if (!this.requireLevel('voteskip', interaction)) return this.deny(interaction);
        const gid = interaction.guildId;
        if (!gid)
          return void (await interaction.reply({
            content: 'Must be used in a server.',
            flags: MessageFlags.Ephemeral,
          }));
        const enabled = interaction.options.getBoolean('enabled');
        if (enabled !== null) this.perms.setVoteSkip(gid, enabled);
        const on = this.perms.getVoteSkip(gid);
        await interaction.reply({
          content: on
            ? '🗳️ Vote-to-skip is **on** — non-DJs need a majority of the voice channel.'
            : '⏭️ Vote-to-skip is **off** — anyone can skip instantly.',
          flags: MessageFlags.Ephemeral,
        });
        break;
      }

      case 'duck': {
        if (!this.requireLevel('duck', interaction)) return this.deny(interaction);
        if (!s.voice.isJoined())
          return void (await interaction.reply({ content: 'Not in a voice channel.', flags: MessageFlags.Ephemeral }));
        if (interaction.options.getBoolean('cancel')) {
          s.voice.cancelDuck();
          await interaction.reply({ content: '🔊 Duck cancelled.', flags: MessageFlags.Ephemeral });
          break;
        }
        const seconds = interaction.options.getInteger('seconds') ?? 30;
        s.voice.duckFor(seconds * 1000);
        await interaction.reply({
          content: `🔉 Ducking the music for **${seconds}s** — talk away.`,
          flags: MessageFlags.Ephemeral,
        });
        break;
      }

      case 'duckmode': {
        if (!this.requireLevel('duckmode', interaction)) return this.deny(interaction);
        const gid = interaction.guildId;
        if (!gid)
          return void (await interaction.reply({
            content: 'Must be used in a server.',
            flags: MessageFlags.Ephemeral,
          }));
        const mode = interaction.options.getString('mode', true) as 'off' | 'auto' | 'hosts';
        this.perms.setDuckMode(gid, mode);
        await interaction.reply({
          content:
            mode === 'off'
              ? '🔇 Auto-ducking **off** (manual `/duck` still works).'
              : mode === 'auto'
                ? '🔉 Auto-ducking **on** — the music dips whenever anyone talks.'
                : '🎧 Auto-ducking **hosts only** — only DJs/owner dip the music.',
          flags: MessageFlags.Ephemeral,
        });
        break;
      }

      case 'npchannel': {
        if (!this.requireLevel('npchannel', interaction)) return this.deny(interaction);
        const gid = interaction.guildId;
        if (!gid)
          return void (await interaction.reply({
            content: 'Must be used in a server.',
            flags: MessageFlags.Ephemeral,
          }));
        if (interaction.options.getBoolean('off')) {
          this.perms.setNpAuto(gid, false);
          this.perms.setNpChannel(gid, null);
          await this.clearMiniNp(gid);
          await interaction.reply({ content: '🌙 Now-playing strip **disabled**.', flags: MessageFlags.Ephemeral });
        } else {
          this.perms.setNpAuto(gid, true);
          this.perms.setNpChannel(gid, interaction.channelId);
          this.miniTrackUri.delete(gid);
          await interaction.reply({
            content: `📻 The live now-playing strip will post in <#${interaction.channelId}>.`,
            flags: MessageFlags.Ephemeral,
          });
        }
        break;
      }

      case 'vibe': {
        if (!this.requireLevel('vibe', interaction)) return this.deny(interaction);
        await interaction.deferReply();
        await interaction.editReply(
          await this.vibeDj(s, interaction.options.getString('mood') ?? undefined, () =>
            this.ensureJoinedForPlayback(interaction, s),
          ),
        );
        break;
      }

      case 'leaderboard': {
        if (!this.requireLevel('leaderboard', interaction)) return this.deny(interaction);
        const gid = interaction.guildId;
        if (!gid)
          return void (await interaction.reply({
            content: 'Must be used in a server.',
            flags: MessageFlags.Ephemeral,
          }));
        await interaction.reply({ embeds: [this.leaderboardEmbed(gid, interaction.user.username)] });
        break;
      }

      case 'dna': {
        if (!this.requireLevel('dna', interaction)) return this.deny(interaction);
        await interaction.deferReply();
        const res = await this.dnaCard(s);
        if (typeof res === 'string') await interaction.editReply(res);
        else await interaction.editReply({ embeds: [res.embed], files: [res.file] });
        break;
      }

      case 'cover': {
        if (!this.requireLevel('cover', interaction)) return this.deny(interaction);
        await interaction.deferReply();
        const res = await this.coverCard(s);
        if (typeof res === 'string') await interaction.editReply(res);
        else await interaction.editReply({ embeds: [res.embed], files: [res.file] });
        break;
      }

      case 'hype': {
        if (!this.requireLevel('hype', interaction)) return this.deny(interaction);
        const gid = interaction.guildId;
        if (!gid)
          return void (await interaction.reply({
            content: 'Must be used in a server.',
            flags: MessageFlags.Ephemeral,
          }));
        const enabled = interaction.options.getBoolean('enabled');
        if (enabled === true) this.hypeGuilds.add(gid);
        else if (enabled === false) this.hypeGuilds.delete(gid);
        const on = this.hypeGuilds.has(gid);
        await interaction.reply({
          content: on ? "⚡ Auto-hype **on** — I'll drop a hit on strong beats." : 'Auto-hype **off**.',
          flags: MessageFlags.Ephemeral,
        });
        break;
      }

      case 'mix': {
        if (!this.requireLevel('mix', interaction)) return this.deny(interaction);
        await interaction.deferReply();
        const a = interaction.options.getString('a', true);
        const b = interaction.options.getString('b', true);
        const sec = interaction.options.getInteger('crossfade') ?? 6;
        await interaction.editReply(await this.mixTracks(s, a, b, sec));
        break;
      }

      case 'mashup': {
        if (!this.requireLevel('mashup', interaction)) return this.deny(interaction);
        await interaction.deferReply();
        const a = interaction.options.getString('a', true);
        const b = interaction.options.getString('b', true);
        const ch = interaction.channel;
        await interaction.editReply(
          '🎛️ Rendering stem mashup — separating both songs (this can take several minutes)…',
        );
        if (ch && 'send' in ch) {
          void this.startMashupRender((p) => ch.send(p), interaction.guildId ?? '', a, b, interaction.user.id);
        }
        break;
      }

      case 'mashupgame': {
        if (!this.requireLevel('mashupgame', interaction)) return this.deny(interaction);
        await interaction.deferReply();
        const ch = interaction.channel;
        const pair = this.suggestMashupPair(s);
        if (!pair) {
          await interaction.editReply('Need at least 2 tracks queued — or use `/mashup a:… b:…`.');
          break;
        }
        await interaction.editReply(
          `🎲 **Mashup game!** Suggesting **${pair.a}** × **${pair.b}** — rendering both stem blends (a few minutes)…`,
        );
        if (ch && 'send' in ch) {
          void this.runMashupGame((p) => ch.send(p), interaction.guildId ?? '', pair.a, pair.b);
        }
        break;
      }

      case 'mashups': {
        if (!this.requireLevel('mashups', interaction)) return this.deny(interaction);
        const hist = await loadMashupHistory();
        if (!hist.length) {
          await interaction.reply('No mashups yet — start one with `/mashupgame`.');
          break;
        }
        const lines = hist
          .slice(0, 10)
          .map(
            (h, i) =>
              `${i + 1}. **${truncate(h.a, 40)}** × **${truncate(h.b, 40)}**${h.winner ? ` — 🏆 ${h.winner}` : ''}`,
          );
        await interaction.reply({
          embeds: [
            new EmbedBuilder()
              .setTitle('🎲 Mashup history')
              .setDescription(lines.join('\n'))
              .setColor(this.themeColor()),
          ],
        });
        break;
      }

      case 'dedupe': {
        if (!this.requireLevel('dedupe', interaction)) return this.deny(interaction);
        const n = s.queue.dedupe();
        await interaction.reply(
          n > 0 ? `🧹 Removed ${n} duplicate track${n > 1 ? 's' : ''} from the queue.` : 'No duplicates in the queue.',
        );
        break;
      }

      case 'bulk': {
        if (!this.requireLevel('bulk', interaction)) return this.deny(interaction);
        await interaction.deferReply();
        const items = parseBulkItems(interaction.options.getString('tracks', true));
        const resolved: ResolvedTrack[] = [];
        const itemQuery = new Map<string, string>();
        for (const q of items) {
          try {
            const t = await resolvePlayInput(q);
            if (t[0]) {
              resolved.push(t[0]);
              itemQuery.set(t[0].uri, q);
            }
          } catch {
            /* skip an unresolvable item */
          }
        }
        if (resolved.length === 0) {
          await interaction.editReply('None of those could be resolved.');
          break;
        }
        const who = interaction.user.username;
        if (this.userQueueMode(s) === 'insert') s.queue.insertAfterCurrent(resolved, who);
        else s.queue.enqueueMany(resolved, who);
        this.stats.noteQueued(
          s.guildId ?? '',
          who,
          resolved.flatMap((t) => t.artists),
        );
        try {
          await this.ensureJoinedForPlayback(interaction, s);
          if (!s.queue.getState().playing) await s.playback.play();
        } catch {
          /* queued anyway */
        }
        const row = this.registerSwap({
          guildId: interaction.guildId ?? '',
          userId: interaction.user.id,
          addedBy: who,
          mode: this.userQueueMode(s),
          items: resolved.map((t) => ({
            uri: t.uri,
            label: `${t.name} — ${t.artists.join(', ')}`,
            query: itemQuery.get(t.uri),
          })),
        });
        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setTitle(`Added ${resolved.length} track${resolved.length > 1 ? 's' : ''}`)
              .setDescription(
                resolved.map((t, i) => `${i + 1}. ${srcEmoji(t.source)} **${truncate(t.name, 60)}**`).join('\n'),
              )
              .setColor(this.themeColor()),
          ],
          components: row,
        });
        break;
      }

      case 'skipto': {
        if (!this.requireLevel('skipto', interaction)) return this.deny(interaction);
        if (!this.perms.getSkipForward(interaction.guildId ?? '')) {
          await interaction.reply({
            content: '⏭ Skip-to is **off** here — a mod can enable it with `/skiptoggle`.',
            flags: MessageFlags.Ephemeral,
          });
          break;
        }
        await interaction.deferReply();
        await this.presentSkipTo(interaction);
        break;
      }

      case 'skiptoggle': {
        if (!this.requireLevel('skiptoggle', interaction)) return this.deny(interaction);
        const gid = interaction.guildId;
        if (!gid) {
          await interaction.reply({ content: 'Must be used in a server.', flags: MessageFlags.Ephemeral });
          break;
        }
        const on = interaction.options.getBoolean('enabled', true);
        this.perms.setSkipForward(gid, on);
        await interaction.reply({
          content: on
            ? '⏭ Skip-to **on** — use `/skipto` to jump ahead (drops the tracks you skip).'
            : '⏭ Skip-to **off** — `/skipto` is disabled here.',
          flags: MessageFlags.Ephemeral,
        });
        break;
      }

      case 'quiz': {
        if (!this.requireLevel('quiz', interaction)) return this.deny(interaction);
        await interaction.deferReply();
        await interaction.editReply(await this.startQuiz(s));
        break;
      }

      case 'guess': {
        if (!this.requireLevel('guess', interaction)) return this.deny(interaction);
        const q = this.quizzes.get(interaction.guildId ?? '');
        if (!q) {
          await interaction.reply({
            content: 'No quiz running — start one with `/quiz`.',
            flags: MessageFlags.Ephemeral,
          });
          break;
        }
        const norm = (x: string): string =>
          x
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, ' ')
            .trim();
        const g = norm(interaction.options.getString('text', true));
        const t = norm(q.name);
        if (g.length >= 3 && (t.includes(g) || g.includes(t))) {
          this.endQuiz(interaction.guildId ?? '');
          await interaction.reply(
            `✅ **${interaction.user.username}** got it — **${q.name}** — ${(q.artists ?? []).join(', ')}!`,
          );
        } else {
          await interaction.reply({ content: '❌ Not it — keep guessing!', flags: MessageFlags.Ephemeral });
        }
        break;
      }

      case 'weasel':
      case 'amok': {
        if (!this.requireLevel(name, interaction)) return this.deny(interaction);
        const prompt = interaction.options.getString('message', true);
        await interaction.deferReply();
        const reply = await this.handleWeaselRequest(s, prompt, {
          scopeId: interaction.guildId ?? interaction.channelId ?? 'dm',
          guildId: interaction.guildId,
          channelId: interaction.channelId,
          userId: interaction.user.id,
          username: interaction.user.username,
          ensureJoin: () => this.ensureJoinedForPlayback(interaction, s),
        });
        const sent = await interaction.editReply(reply);
        if (sent?.id) this.rememberAmokMessage(sent.id);
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

      case 'speed': {
        if (!this.requireLevel('speed', interaction)) return this.deny(interaction);
        const mode = interaction.options.getString('mode');
        if (!mode) {
          const speed = s.playback.getSpeed();
          const label =
            speed === 1
              ? 'Normal (1x)'
              : speed > 1
                ? `Nightcore (${speed.toFixed(2)}x)`
                : `Slowed (${speed.toFixed(2)}x)`;
          await interaction.reply(`🎚️ Current speed: **${label}** — use \`/speed mode\` to change it.`);
          break;
        }
        const factor = mode === 'nightcore' ? 1.25 : mode === 'slowed' ? 0.85 : 1;
        s.playback.setSpeed(factor);
        await interaction.reply(
          factor === 1
            ? '▶️ Speed back to normal.'
            : factor > 1
              ? `⚡ Nightcore mode — everything runs at **${factor.toFixed(2)}x**!`
              : `🐢 Slowed down to **${factor.toFixed(2)}x** — chill vibes.`,
        );
        break;
      }

      case 'bassboost': {
        if (!this.requireLevel('bassboost', interaction)) return this.deny(interaction);
        const db = interaction.options.getInteger('db');
        if (!db || db <= 0) {
          const current = s.playback.getBassBoost();
          if (current > 0) {
            s.playback.setBassBoost(0);
            await interaction.reply('🎛️ Bass boost off.');
          } else {
            await interaction.reply('🔇 Bass boost is off. Add a `db` value (5/8/10) to dial it in.');
          }
          break;
        }
        const clamped = Math.min(12, Math.max(2, db));
        s.playback.setBassBoost(clamped);
        await interaction.reply(
          clamped <= 5
            ? `🎚️ Bass +${clamped} dB — subtle low shelf.`
            : clamped <= 8
              ? `🎚️ Bass +${clamped} dB — punchy.`
              : `💥 Bass +${clamped} dB — the neighbors will feel it.`,
        );
        break;
      }

      case 'eq': {
        if (!this.requireLevel('eq', interaction)) return this.deny(interaction);
        const preset = (interaction.options.getString('preset') ?? '').toLowerCase();
        if (!preset) {
          const cur = s.playback.getEq();
          await interaction.reply(
            `🎛️ Current EQ: **${cur}** — presets: flat, bass, vocal, night, warm, lofi.\nTakes effect from the next track (never restarts the current one).`,
          );
          break;
        }
        if (!s.playback.setEq(preset)) {
          await interaction.reply({
            content: `Unknown preset \`${preset}\`. Try flat, bass, vocal, night, warm, lofi.`,
            flags: MessageFlags.Ephemeral,
          });
          break;
        }
        await interaction.reply(`🎛️ EQ preset → **${preset}** — applies from the next track.`);
        break;
      }

      case 'norm': {
        if (!this.requireLevel('norm', interaction)) return this.deny(interaction);
        const on = interaction.options.getBoolean('on');
        if (on === null || on === undefined) {
          await interaction.reply(
            s.playback.getLoudnorm()
              ? '🔊 Loudness match **on** — every source plays at Spotify-standard level (-14 LUFS).'
              : 'Loudness match is **off** — sources play at their own level. Use `/norm on`.',
          );
          break;
        }
        s.playback.setLoudnorm(on);
        await interaction.reply(
          on
            ? '🔊 Loudness match **on** — all sources are normalized to Spotify-standard loudness (-14 LUFS), so YouTube tracks stop jumping out louder or hiding quieter. Applies from the next track.'
            : 'Loudness match **off** — sources play at their native level.',
        );
        break;
      }

      case 'wrapped': {
        if (!this.requireLevel('wrapped', interaction)) return this.deny(interaction);
        const gid = interaction.guildId;
        if (!gid)
          return void (await interaction.reply({
            content: 'Must be used in a server.',
            flags: MessageFlags.Ephemeral,
          }));
        const which = interaction.options.getString('month') ?? 'this';
        const now = new Date();
        const month =
          which === 'last'
            ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1)).toISOString().slice(0, 7)
            : now.toISOString().slice(0, 7);
        await interaction.reply({ embeds: [this.wrappedEmbed(gid, month)] });
        break;
      }

      case 'follow': {
        if (!this.requireLevel('follow', interaction)) return this.deny(interaction);
        const gid = interaction.guildId;
        if (!gid)
          return void (await interaction.reply({
            content: 'Must be used in a server.',
            flags: MessageFlags.Ephemeral,
          }));
        await interaction.reply(
          await this.followNowPlaying(gid, interaction.channelId, interaction.options.getBoolean('off') ?? false),
        );
        break;
      }

      case 'stump': {
        if (!this.requireLevel('stump', interaction)) return this.deny(interaction);
        const res = await this.gameStump(
          s,
          interaction.user.username,
          interaction.options.getString('track') ?? undefined,
          interaction.user.id,
        );
        await interaction.reply(typeof res === 'string' ? res : { content: res.content, components: res.components });
        break;
      }

      case 'games': {
        await interaction.reply({ embeds: [this.gamesEmbed()] });
        break;
      }

      case 'duel': {
        if (!this.requireLevel('duel', interaction)) return this.deny(interaction);
        const opp = interaction.options.getUser('opponent');
        const duel = await this.gameDuel(s, interaction.user.username, opp?.username, {
          now: interaction.options.getBoolean('now') ?? false,
        });
        if (typeof duel === 'string') await interaction.reply(duel);
        else await interaction.reply({ embeds: [duel] });
        break;
      }

      case 'roulette': {
        if (!this.requireLevel('roulette', interaction)) return this.deny(interaction);
        const spin = await this.gameRoulette(s, interaction.user.username);
        if (typeof spin === 'string') await interaction.reply(spin);
        else await interaction.reply({ content: spin.content, components: spin.components });
        break;
      }

      case 'sleep': {
        if (!this.requireLevel('sleep', interaction)) return this.deny(interaction);
        if (!interaction.inGuild()) {
          await interaction.reply({
            content: 'Sleep timer only works inside a server.',
            flags: MessageFlags.Ephemeral,
          });
          break;
        }
        const raw = interaction.options.getString('time');
        if (!raw) {
          if (this.sleepTimers.has(interaction.guildId)) {
            this.cancelSleepTimer(interaction.guildId);
            await interaction.reply('⏰ Sleep timer cancelled.');
          } else {
            await interaction.reply('No sleep timer set. Use `/sleep 30m` (or `1h`, `45s`) to set one.');
          }
          break;
        }
        const ms = parseSleepSpec(raw);
        if (!ms || ms <= 0) {
          await interaction.reply({
            content: `Couldn't parse \`${raw}\`. Try \`30m\`, \`1h\`, or \`45s\`.`,
            flags: MessageFlags.Ephemeral,
          });
          break;
        }
        const when = new Date(Date.now() + ms);
        this.setSleepTimer(s, ms, () => {
          void this.sleepFireNotify(s);
        });
        await interaction.reply(
          `⏰ Sleep timer set — I'll stop playing and leave at **${when.toLocaleTimeString()}**.\nUse \`/sleep\` again to cancel.`,
        );
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
          await interaction.reply({
            content: '🎛️ DJ effects are off for this server. A mod can enable them with `/dj on`.',
            flags: MessageFlags.Ephemeral,
          });
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
            : `Unknown sound \`${sound}\`. Try ${s.playback
                .listSoundEffects()
                .map((snd) => `\`${snd.id}\``)
                .join(', ')}.`,
        );
        break;
      }

      case 'help': {
        const topic = (interaction.options.getString('topic') ?? '').toLowerCase();
        if (topic === 'all') {
          await interaction.reply({ embeds: this.helpAllEmbeds() });
          break;
        }
        if (topic === 'aliases') {
          await interaction.reply({ embeds: [this.helpAliasesEmbed()] });
          break;
        }
        const cat = topic ? this.helpCategoryEmbed(topic) : null;
        if (cat) await interaction.reply({ embeds: [cat], components: this.helpButtons() });
        else await interaction.reply({ embeds: [this.helpEmbed()], components: this.helpButtons() });
        break;
      }

      case 'invite': {
        const appId = this.client.user!.id;
        const perms =
          (1n << 6n) |
          (1n << 10n) |
          (1n << 11n) |
          (1n << 13n) |
          (1n << 14n) |
          (1n << 15n) |
          (1n << 16n) |
          (1n << 18n) |
          (1n << 20n) |
          (1n << 21n) |
          (1n << 31n) |
          (1n << 52n);
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

      case 'jam': {
        if (!interaction.inGuild()) {
          await interaction.reply({ content: 'Must be used inside a server.', flags: MessageFlags.Ephemeral });
          break;
        }
        const ch = interaction.channel;
        if (!ch || !ch.isTextBased()) {
          await interaction.reply({ content: 'I cannot post in this channel.', flags: MessageFlags.Ephemeral });
          break;
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const r = await this.shareJamCard(interaction.guildId!, ch as GuildTextBasedChannel);
        if (!r.ok) {
          await interaction.editReply({ content: r.error ?? 'Could not post the jam card.' });
          break;
        }
        await interaction.editReply({
          content: `📱 Jam card posted in ${r.where ?? 'this channel'}. Anyone in here can scan it — requests only, no playback control.`,
          components: r.pinRow ? [r.pinRow] : [],
        });
        break;
      }

      case 'stats': {
        await interaction.reply({ embeds: [this.statsEmbed()], flags: MessageFlags.Ephemeral });
        break;
      }

      case 'device': {
        const sub = interaction.options.getSubcommand(true);
        if (sub === 'list') {
          const info = this.bridge.librespot.getDeviceInfo();
          const status = info.enabled
            ? info.running
              ? `🟢 **Running** (uptime ${fmtMs(info.uptimeMs)})`
              : '🟡 **Down** (will restart automatically)'
            : '⚪ **Disabled** — no LIBRESPOT_PATH configured';
          const embed = new EmbedBuilder()
            .setTitle('🎛️ Spotify Device')
            .setColor(this.themeColor())
            .setDescription(
              `**Name:** \`${info.name}\`\n` +
                `**ID:** \`${info.deviceId}\`\n` +
                `**Status:** ${status}\n` +
                `**Bitrate:** ${info.bitrate} kbps\n` +
                `**Stderr log:** \`${info.stderrLog}\``,
            );
          await interaction.reply({ embeds: [embed] });
        } else {
          const name = interaction.options.getString('name', true);
          const clean = name.trim().replace(/\s+/g, ' ').slice(0, 32);
          if (!clean) {
            await interaction.reply('Name cannot be empty.');
            break;
          }
          if (clean === this.bridge.librespot.getDeviceInfo().name) {
            await interaction.reply(`That's already the current device name.`);
            break;
          }
          this.bridge.librespot.setDeviceName(clean);
          await interaction.reply(`🔄 Renaming Spotify device to \`${clean}\` — will take effect momentarily.`);
        }
        break;
      }

      case 'cookie-refresh': {
        const confirm = interaction.options.getBoolean('confirm', true);
        if (!confirm) {
          await interaction.reply(
            'Cookies were NOT refreshed. Run `/cookie-refresh confirm:true` to export cookies from your browser.',
          );
          break;
        }
        await interaction.deferReply();
        try {
          const { refreshYoutubeCookies } = await import('@vaporzr/core/youtube');
          const saved = await refreshYoutubeCookies();
          await interaction.followUp(
            saved.ok
              ? `✅ Cookies refreshed and written to \`${saved.path}\` (${saved.lines} cookies).`
              : `⚠️ ${saved.error}`,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await interaction.followUp(`⚠️ Cookie refresh failed: ${msg}`);
        }
        break;
      }

      case 'cookie-upload': {
        if (!this.perms.isOwner(interaction.user.id)) return this.deny(interaction);
        const file = interaction.options.getAttachment('file', true);
        await interaction.deferReply();
        try {
          if (file.size > 512 * 1024) {
            await interaction.followUp('⚠️ That file is too large for a cookies.txt (max 512 KB).');
            break;
          }
          const res = await fetch(file.url);
          if (!res.ok) {
            await interaction.followUp(`⚠️ Could not download the attachment (HTTP ${res.status}).`);
            break;
          }
          const { saveYoutubeCookies } = await import('@vaporzr/core/youtube');
          const saved = await saveYoutubeCookies(await res.text());
          await interaction.followUp(
            saved.ok
              ? `✅ Cookies saved (${saved.lines} lines) — YouTube requests use them immediately.`
              : `⚠️ ${saved.error}`,
          );
        } catch (err) {
          await interaction.followUp(`⚠️ Cookie upload failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        break;
      }

      case 'similar': {
        await interaction.deferReply();
        if (!cosineEnabled()) {
          await interaction.followUp("🔎 cosine.club isn't configured (no COSINE_API_KEY).");
          break;
        }
        const q = interaction.options.getString('query');
        const cur = s.queue.getCurrentTrack();
        const seed = q
          ? { name: q, artists: [] as string[], uri: '' }
          : cur
            ? { name: cur.name, artists: cur.artists, uri: cur.uri }
            : null;
        if (!seed) {
          await interaction.followUp('🔎 Nothing is playing — give me a track with `/similar query:…`.');
          break;
        }
        const cands = await cosineSimilarCandidates(seed, 10).catch(() => []);
        if (cands.length === 0) {
          await interaction.followUp(
            `🔎 No cosine.club matches for **${truncate(seed.name, 60)}** — its catalogue is electronic/underground, so it may not know this track.`,
          );
          break;
        }
        const list = cands.slice(0, 8);
        const embed = new EmbedBuilder()
          .setTitle(`🔎 Sounds like ${truncate(seed.name, 60)}`)
          .setDescription(
            list
              .map((c, i) => `${i + 1}. ${truncate(c.name, 58)} — ${Math.round((c.cosineScore ?? 0) * 100)}%`)
              .join('\n'),
          )
          .setFooter({ text: 'cosine.club audio similarity' })
          .setColor(this.themeColor());
        const nonce = Math.random().toString(36).slice(2, 10);
        this.similarPending.set(nonce, {
          guildId: interaction.guildId ?? '',
          userId: interaction.user.id,
          tracks: list,
          at: Date.now(),
        });
        if (this.similarPending.size > 50) {
          const oldest = this.similarPending.keys().next().value;
          if (oldest) this.similarPending.delete(oldest);
        }
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`similar:queue:${nonce}`)
            .setLabel(`Queue all (${list.length})`)
            .setEmoji('➕')
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`similar:one:${nonce}`)
            .setLabel('Surprise me')
            .setEmoji('🎲')
            .setStyle(ButtonStyle.Secondary),
        );
        await interaction.followUp({ embeds: [embed], components: [row] });
        break;
      }

      case 'config': {
        if (!this.requireLevel('config', interaction)) return this.deny(interaction);
        const gid = interaction.guildId;
        if (!gid) {
          await interaction.reply({ content: 'Must be used in a server.', flags: MessageFlags.Ephemeral });
          break;
        }
        await interaction.reply({
          content: await this.runConfig(s, gid, interaction.options.getString('settings') ?? ''),
          flags: MessageFlags.Ephemeral,
        });
        break;
      }

      case 'diag':
        await interaction.reply({ embeds: [this.diagEmbed(interaction.guildId)] });
        break;

      default:
        await interaction.reply('Unknown command.');
    }
    this.commandsRun++;
  }

  // ---- Prefix commands (V@…) ----

  private async handleMessageCommand(message: Message): Promise<void> {
    if (message.author.bot) return;
    if (this.processedMessages.has(message.id)) return;
    this.processedMessages.add(message.id);
    setTimeout(() => this.processedMessages.delete(message.id), 30_000);

    // Trigger forms: `v@…` / `V@…`, or a leading bot mention (`@Vaporzr diag`).
    // The mention form keeps prefix commands working even when Discord withholds
    // message content except for mentions/DMs (limited Message Content intent).
    const raw = message.content ?? '';
    const me = this.client.user?.id ?? '';
    let rest: string | null = null;
    if (raw.startsWith('v@') || raw.startsWith('V@')) {
      rest = raw.slice(2).trimStart();
    } else if (me && (raw.startsWith(`<@${me}>`) || raw.startsWith(`<@!${me}>`))) {
      rest = raw.replace(/^<@!?\d+>/, '').trimStart();
    } else if (message.reference?.messageId && this.amokMessageIds.has(message.reference.messageId) && raw.trim()) {
      rest = `weasel ${raw.trim()}`;
    }
    if (rest === null) return;

    if (message.guildId && message.channelId) {
      this.lastTextChannel.set(message.guildId, message.channelId);
      this.scheduleSavePanels();
    }

    if (!rest) {
      await message.reply(
        'Vaporzr commands — try `V@p <link or search>`, `V@s`, `V@i <link or search>`, `V@q`, or `V@help`.',
      );
      return;
    }
    const [rawCmd, ...rawArgs] = rest.split(/\s+/);
    let cmd = rawCmd.toLowerCase();
    const args = rawArgs.join(' ');
    const s = this.sessionFor(message.guildId);

    const canUse = (c: string): boolean => {
      if (!message.inGuild() || !message.member) return true;
      return this.perms.can(c, message.guild!, message.member);
    };
    const canWindow = (): boolean => this.requireWindowOwner(message.author.id, message.guild, message.member);
    const deny = async (): Promise<never> => {
      await message.reply("⛔ You don't have permission to do that.");
      throw new Error('denied');
    };

    // Rate limit prefix commands against the same bucket as their / command.
    const alias: Record<string, string> = V_ALIASES;
    const canonical = alias[cmd];
    if (canonical) {
      const wait = this.cooldownRemaining(message.author.id, canonical);
      if (wait > 0) {
        await message.reply(`⏳ Slow down — try again in ${Math.ceil(wait / 1000)}s.`);
        return;
      }
    }
    // Plain spelling aliases are dispatched on their canonical name, otherwise
    // they only shared a cooldown bucket and fell through to "Unknown command"
    // (that's why V@dd / V@dedup / V@mh / V@mg / V@msh / V@boost did nothing).
    // Subcommand shortcuts (save / load / del / pl) keep their own case and
    // read `args`, so they are deliberately not listed here.
    const dispatchAlias: Record<string, string> = V_DISPATCH_ALIASES;
    if (dispatchAlias[cmd]) cmd = dispatchAlias[cmd];

    try {
      switch (cmd) {
        case 'p':
        case 'play': {
          const attachments = [...message.attachments.values()];
          if (attachments.length > 0) {
            await this.withAck(message, '📂 Adding your file(s)…', async () => {
              await this.playUploadedFiles(
                s,
                attachments.map((a) => ({ name: a.name ?? 'file', url: a.url })),
                message.author.username,
                () => this.ensureJoinedForMessage(message, s),
                async (embed) => message.reply({ embeds: [embed] }),
              );
            });
            break;
          }
          if (!args) return void (await message.reply('Usage: `V@p <track name or link>` — or attach a file'));
          await this.withAck(message, '🔎 Working on it…', async () => {
            const run = async (): Promise<void> => {
              if (isUrlPlayInput(args)) {
                const tracks = await resolvePlayInput(args);
                if (this.userQueueMode(s) === 'insert') await this.insertToQueueMsg(message, tracks);
                else await this.addToQueueMsg(message, tracks);
              } else {
                await this.presentSearch(message, args);
              }
            };
            const before = s.queue.getSnapshot().tracks.length;
            try {
              await run();
            } catch (err) {
              // A transient network blip shouldn't lose the command — retry once,
              // unless the first attempt already changed the queue (no double-add).
              if (!isTransientNetError(err) || s.queue.getSnapshot().tracks.length !== before) throw err;
              await new Promise((r) => setTimeout(r, 800));
              await run();
            }
          });
          break;
        }

        case 'i':
        case 'insert': {
          if (!args) return void (await message.reply('Usage: `V@i <track name or link>`'));
          await this.withAck(message, '🔎 Working on it…', async () => {
            const tracks = await resolvePlayInput(args);
            await this.insertToQueueMsg(message, tracks, isUrlPlayInput(args) ? undefined : args);
          });
          break;
        }

        case 's':
        case 'skip': {
          if (!canUse('skip')) return void (await deny());
          if (this.isDjMember(message.guild, message.member)) {
            this.clearSkipVote(message.guildId);
            s.playback.next();
            this.scheduleWaveTopUp(s);
            {
              const m1 = await message.reply('⏭️ Skipped');
              this.autoExpire(m1);
            }
            break;
          }
          const v = this.requestSkip(s, message.author.id);
          if (v.result === 'skipped') {
            s.playback.next();
            this.scheduleWaveTopUp(s);
            const m1 = await message.reply(
              this.perms.getVoteSkip(message.guildId ?? '') ? '⏭️ Skipped (majority vote reached)' : '⏭️ Skipped',
            );
            this.autoExpire(m1);
          } else {
            await message.reply(
              v.result === 'started'
                ? `🗳️ Vote to skip started — **${v.votes}/${v.needed}**. Others: use \`V@s\` again to vote.`
                : `🗳️ Vote recorded — **${v.votes}/${v.needed}**.`,
            );
          }
          break;
        }

        case 'jump': {
          if (!canUse('jump')) return void (await deny());
          if (!args) return void (await message.reply('Usage: `V@jump <words from a lyric line>`.'));
          await message.reply(await this.jumpToLyric(s, args));
          break;
        }

        case 'pau':
        case 'pause': {
          if (!canUse('pause')) return void (await deny());
          s.playback.pause();
          {
            const m2 = await message.reply('⏸️ Paused');
            this.autoExpire(m2);
          }
          break;
        }

        case 'r':
        case 'resume': {
          if (!canUse('resume')) return void (await deny());
          await s.playback.resume();
          {
            const m3 = await message.reply('▶️ Resumed');
            this.autoExpire(m3);
          }
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
            {
              const m = await message.reply(`🔊 Current volume is **${s.queue.getState().volume}%**`);
              this.autoExpire(m);
            }
            break;
          }
          s.playback.volume(Math.max(0, Math.min(100, n)));
          {
            const m = await message.reply(`🔊 Volume set to ${n}%`);
            this.autoExpire(m);
          }
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

        case 'similar': {
          if (!cosineEnabled()) return void (await message.reply("🔎 cosine.club isn't configured."));
          const seedQ = args.trim();
          const cur = s.queue.getCurrentTrack();
          const seed = seedQ
            ? { name: seedQ, artists: [] as string[], uri: '' }
            : cur
              ? { name: cur.name, artists: cur.artists, uri: cur.uri }
              : null;
          if (!seed) return void (await message.reply('🔎 Nothing is playing — try `V@similar <track>`.'));
          const cands = await cosineSimilarCandidates(seed, 10).catch(() => []);
          if (cands.length === 0)
            return void (await message.reply(`🔎 No cosine.club matches for **${truncate(seed.name, 60)}**.`));
          const list = cands.slice(0, 8);
          const embed = new EmbedBuilder()
            .setTitle(`🔎 Sounds like ${truncate(seed.name, 60)}`)
            .setDescription(
              list
                .map((c, i) => `${i + 1}. ${truncate(c.name, 58)} — ${Math.round((c.cosineScore ?? 0) * 100)}%`)
                .join('\n'),
            )
            .setColor(this.themeColor());
          const nonce = Math.random().toString(36).slice(2, 10);
          this.similarPending.set(nonce, {
            guildId: message.guildId ?? '',
            userId: message.author.id,
            tracks: list,
            at: Date.now(),
          });
          const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId(`similar:queue:${nonce}`)
              .setLabel(`Queue all (${list.length})`)
              .setEmoji('➕')
              .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
              .setCustomId(`similar:one:${nonce}`)
              .setLabel('Surprise me')
              .setEmoji('🎲')
              .setStyle(ButtonStyle.Secondary),
          );
          await message.reply({ embeds: [embed], components: [row] });
          break;
        }

        case 'config': {
          if (!canUse('config')) return void (await deny());
          if (!message.guildId) return void (await message.reply('Must be used in a server.'));
          await message.reply(await this.runConfig(s, message.guildId, args));
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
          {
            const m = await message.reply('🔴 Live now-playing message posted right here — it updates itself.');
            this.autoExpireNotice(m);
          }
          break;
        }

        case 'c':
        case 'clear':
        case 'stop': {
          if (!canUse('clear')) return void (await deny());
          {
            // Keep the queue so V@undo can bring it back after a mis-click.
            const snapshot = s.queue.getSnapshot().tracks;
            if (snapshot.length)
              this.lastRemoved.set(
                message.guildId ?? '',
                snapshot.map((t) => ({ ...t })),
              );
          }
          // Keep the current track playing (V@leave is the hard stop).
          const removed = s.queue.clearUpcoming();
          const nowPlaying = s.queue.getState().track?.name;
          {
            const m4 = await message.reply(
              nowPlaying
                ? `Cleared ${removed} upcoming track${removed === 1 ? '' : 's'} - still playing **${nowPlaying}**`
                : 'Queue cleared',
            );
            this.autoExpire(m4);
          }
          break;
        }

        case 'rem':
        case 'remove': {
          if (!canUse('remove')) return void (await deny());
          const query = args.trim();
          if (!query)
            return void (await message.reply('Usage: `V@remove <n[, n…]>` or `V@remove <song>` — numbers match `V@q`'));
          // Numbers may be given as a list ("4, 8, 9, 10"). Resolve EVERY token
          // against the queue as it is right now, then delete from the highest
          // index down — otherwise each removal renumbers the ones behind it
          // (which is why "V@rem 4, 8, 9, 10" used to drop only index 4).
          const listInput = /^[\d\s,]+$/.test(query);
          const tokens = listInput ? query.split(/[,\s]+/).filter(Boolean) : [query];
          const tracks = s.queue.getSnapshot().tracks;
          const targets = new Set<number>();
          const misses: string[] = [];
          for (const tok of tokens) {
            if (/^\d+$/.test(tok)) {
              const idx = Number(tok) - 1; // V@q numbers are 1-based
              if (idx >= 0 && idx < tracks.length) targets.add(idx);
              else misses.push(tok);
              continue;
            }
            const q = tok.toLowerCase();
            const found = tracks.findIndex(
              (t) => t.name.toLowerCase().includes(q) || (t.artists ?? []).some((a) => a.toLowerCase().includes(q)),
            );
            if (found >= 0) targets.add(found);
            else misses.push(tok);
          }
          if (targets.size === 0) {
            await message.reply(misses.length ? `Nothing matched: **${misses.join(', ')}**.` : 'Nothing to remove.');
            break;
          }
          const names: string[] = [];
          const removed: TrackInfo[] = [];
          for (const idx of [...targets].sort((a, b) => b - a)) {
            const r = s.removeFromQueue(idx);
            if (r) {
              names.push(r.name);
              removed.push(r);
            }
          }
          // Collected in descending index order; store ascending so V@undo
          // restores the original running order.
          if (removed.length) this.lastRemoved.set(message.guildId ?? '', removed.reverse());
          const left = s.queue.getSnapshot().tracks.length;
          await message.reply(
            `🧹 Removed ${names.length} track${names.length > 1 ? 's' : ''} — ${left} left in the queue:\n` +
              names.map((n) => `• ${truncate(n, 60)}`).join('\n') +
              (misses.length ? `\n-# Out of range: ${misses.join(', ')}` : ''),
          );
          break;
        }

        case 'oops': {
          if (!canUse('play')) return void (await deny());
          const last = this.latestSwap(message.author.id, message.guildId ?? '', s);
          if (!last) {
            {
              const m = await message.reply(
                'Nothing to fix — none of your picks from the last 15 minutes are still waiting in the queue.',
              );
              this.autoExpire(m);
            }
            break;
          }
          const { token, ref } = last;
          const embed = new EmbedBuilder()
            .setTitle(ref.items.length > 1 ? `Your last pick — ${ref.items.length} tracks` : 'Your last pick')
            .setDescription(
              ref.items.map((it, n) => `**${n + 1}.** ${it.label}`).join('\n') +
                '\n\nFix it here — the replacement takes the same spot in the queue.',
            )
            .setColor(this.themeColor());
          await message.reply({ embeds: [embed], components: this.swapRow(token) });
          break;
        }

        case 'undo': {
          if (!canUse('remove')) return void (await deny());
          const key = message.guildId ?? '';
          const removed = this.lastRemoved.get(key);
          if (!removed || removed.length === 0) {
            {
              const m = await message.reply('Nothing to undo.');
              this.autoExpire(m);
            }
            break;
          }
          this.lastRemoved.delete(key);
          // Put them back as a user block (in their original running order) —
          // same placement as any other explicit add.
          s.queue.insertUserBatch(
            removed.map(({ addedBy: _addedBy, addedAt: _addedAt, ...rest }) => rest),
            message.author.username,
          );
          await message.reply(
            `↩️ Restored ${removed.length} track${removed.length > 1 ? 's' : ''}:\n` +
              removed.map((t) => `• ${truncate(t.name, 60)}`).join('\n'),
          );
          break;
        }

        case 'qa':
        case 'qadjust': {
          if (!canUse('remove')) return void (await deny());
          await message.reply(this.qaView(s));
          break;
        }

        case 'sh':
        case 'shuffle': {
          if (!canUse('shuffle')) return void (await deny());
          const arg = args.trim().toLowerCase();
          // "smart" is the headline mode, so it maps to the flow ordering rather
          // than a separate algorithm. `vibe`/`vibes` are accepted as synonyms.
          const smart: ShuffleMode | null =
            arg === 'smart' || arg === 'flow' || arg === 'vibe' || arg === 'vibes'
              ? 'flow'
              : arg === 'arc' || arg === 'set'
                ? 'arc'
                : arg === 'key' || arg === 'keys' || arg === 'harmonic'
                  ? 'key'
                  : arg === 'sonic' || arg === 'audio' || arg === 'sound'
                    ? 'sonic'
                    : null;
          if (smart) {
            // A smart shuffle REPLACES the upcoming order with a deliberate one,
            // so it must not fight the random shuffle toggle: leaving that on
            // would re-randomise the queue at the next track end and throw the
            // careful ordering away. Turn it off and say so.
            const wasShuffle = s.queue.getState().shuffle;
            if (wasShuffle) s.playback.shuffle(false);
            await this.smartShuffleMsg(message, s, smart, wasShuffle);
            break;
          }
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
            await s.voice.join(message.guild!.id, channel.id, message.guild!.voiceAdapterCreator, channel);
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
              : `Unknown sound \`${id}\`. Try ${s.playback
                  .listSoundEffects()
                  .map((snd) => `\`${snd.id}\``)
                  .join(', ')}.`,
          );
          break;
        }

        case 'ambient': {
          if (!canUse('ambient')) return void (await deny());
          if (!message.guildId) return void (await message.reply('Must be used in a server.'));
          const a = args.trim().toLowerCase();
          if (/^(on|start|1|true)$/.test(a)) this.perms.setAmbient(message.guildId, true);
          else if (/^(off|stop|0|false)$/.test(a)) this.perms.setAmbient(message.guildId, false);
          const on = this.perms.getAmbient(message.guildId);
          await message.reply(
            on
              ? "🌙 Lo-fi intermission **on** — when the queue ends I'll play a quiet lo-fi track."
              : '🌌 Ambient intermission **off**. Use `V@ambient on` to enable.',
          );
          break;
        }

        case 'mood': {
          if (!canUse('mood')) return void (await deny());
          if (!message.guildId) return void (await message.reply('Must be used in a server.'));
          const a = args.trim().toLowerCase();
          if (/^(on|1|true)$/.test(a)) this.moodOn.add(message.guildId);
          else if (/^(off|0|false)$/.test(a)) this.clearMood(message.guildId);
          const on = this.moodOn.has(message.guildId);
          if (on) {
            const cur = s.queue.getCurrentTrack();
            if (cur) void this.updateMood(s, cur);
          }
          await message.reply(
            on ? '🌈 Mood-reactive visuals **on** — colors follow the music.' : 'Mood-reactive visuals **off**.',
          );
          break;
        }

        case 'crossfade':
        case 'xfade': {
          if (!canUse('crossfade')) return void (await deny());
          if (!message.guildId) return void (await message.reply('Must be used in a server.'));
          const arg = args.trim().toLowerCase();
          const cur = getCrossfadeMs(message.guildId);
          let ms: number;
          if (!arg) {
            await message.reply(
              cur > 0
                ? `🎚️ Crossfade is **on** — ${(cur / 1000).toFixed(1)}s (overlap + tail fade).\n` +
                    '-# `V@crossfade off` to disable · `V@crossfade <seconds>` to change'
                : '🎚️ Crossfade is **off** — tracks play right to the end.\n' +
                    '-# `V@crossfade on` · `V@crossfade <seconds 2–15>` to enable',
            );
            break;
          }
          if (/^(on|true|yes)$/.test(arg)) ms = cur > 0 ? cur : config.crossfadeMs > 0 ? config.crossfadeMs : 6000;
          else if (/^(off|false|no|none|0s?)$/.test(arg)) ms = 0;
          else {
            const sec = Number.parseFloat(arg.replace(/s$/, ''));
            if (!Number.isFinite(sec) || sec < 0 || sec > 15) {
              await message.reply('Usage: `V@crossfade on|off` or `V@crossfade <seconds 0–15>`');
              break;
            }
            ms = Math.round(sec * 1000);
          }
          const applied = setCrossfadeMs(message.guildId, ms);
          s.playback.setCrossfade(applied);
          s.voice.setFadeOut(applied / 1000);
          await message.reply(
            applied > 0
              ? `🎚️ Crossfade **on** — ${(applied / 1000).toFixed(1)}s (takes effect from the next track).`
              : '🎚️ Crossfade **off** — tracks play right to the end.',
          );
          break;
        }

        case 'tts': {
          if (!canUse('tts')) return void (await deny());
          if (!message.guildId) return void (await message.reply('Must be used in a server.'));
          const a = args.trim().toLowerCase();
          if (/^(on|1|true)$/.test(a)) this.perms.setTts(message.guildId, true);
          else if (/^(off|0|false)$/.test(a)) this.perms.setTts(message.guildId, false);
          const on = this.perms.getTts(message.guildId);
          await message.reply(
            on
              ? ttsEngine.enabled
                ? "🗣 Spoken DJ announcements **on** — I'll announce each track."
                : '🗣 Announcements are **on**, but no TTS engine is configured on the bot (set `TTS_PROVIDER`).'
              : '🗣 Spoken DJ announcements **off**.',
          );
          break;
        }

        case 'voteskip':
        case 'vs': {
          if (!canUse('voteskip')) return void (await deny());
          if (!message.guildId) return void (await message.reply('Must be used in a server.'));
          const a = args.trim().toLowerCase();
          if (/^(on|1|true)$/.test(a)) this.perms.setVoteSkip(message.guildId, true);
          else if (/^(off|0|false)$/.test(a)) this.perms.setVoteSkip(message.guildId, false);
          await message.reply(
            this.perms.getVoteSkip(message.guildId)
              ? '🗳️ Vote-to-skip is **on** — non-DJs need a majority of the voice channel.'
              : '⏭️ Vote-to-skip is **off** — anyone can skip instantly.',
          );
          break;
        }

        case 'duck': {
          if (!canUse('duck')) return void (await deny());
          if (!s.voice.isJoined()) return void (await message.reply('Not in a voice channel.'));
          const a = args.trim().toLowerCase();
          if (/^(off|cancel|0|stop)$/.test(a)) {
            s.voice.cancelDuck();
            await message.reply('🔊 Duck cancelled.');
            break;
          }
          const secs = a ? parseInt(a, 10) : 30;
          const seconds = Number.isFinite(secs) ? Math.max(5, Math.min(300, secs)) : 30;
          s.voice.duckFor(seconds * 1000);
          await message.reply(`🔉 Ducking the music for **${seconds}s** — talk away.`);
          break;
        }

        case 'duckmode':
        case 'dmode': {
          if (!canUse('duckmode')) return void (await deny());
          if (!message.guildId) return void (await message.reply('Must be used in a server.'));
          const a = args.trim().toLowerCase();
          if (a === 'off' || a === 'auto' || a === 'hosts') this.perms.setDuckMode(message.guildId, a);
          const mode = this.perms.getDuckMode(message.guildId);
          await message.reply(
            mode === 'off'
              ? '🔇 Auto-ducking **off** (manual `V@duck` still works).'
              : mode === 'auto'
                ? '🔉 Auto-ducking **on** — dips whenever anyone talks.'
                : '🎧 Auto-ducking **hosts only** — only DJs/owner dip the music.',
          );
          break;
        }

        case 'npchannel':
        case 'npc': {
          if (!canUse('npchannel')) return void (await deny());
          if (!message.guildId) return void (await message.reply('Must be used in a server.'));
          if (/^(off|0|false|disable)$/i.test(args.trim())) {
            this.perms.setNpAuto(message.guildId, false);
            this.perms.setNpChannel(message.guildId, null);
            await this.clearMiniNp(message.guildId);
            await message.reply('🌙 Now-playing strip **disabled**.');
          } else {
            this.perms.setNpAuto(message.guildId, true);
            this.perms.setNpChannel(message.guildId, message.channelId);
            this.miniTrackUri.delete(message.guildId);
            // Name the target and call out a voice channel's text chat — that's
            // where an easy-to-miss strip quietly piles up.
            const ch = message.channel as unknown as { isVoiceBased?: () => boolean };
            const voice = typeof ch.isVoiceBased === 'function' && ch.isVoiceBased();
            await message.reply(
              `📻 The live now-playing strip will post in <#${message.channelId}>` +
                (voice ? " — that's a voice channel, so it lands in its text chat." : '.') +
                ' `V@npchannel off` to stop it.',
            );
          }
          break;
        }

        case 'vibe': {
          if (!canUse('vibe')) return void (await deny());
          await message.reply(await this.vibeDj(s, args || undefined, () => this.ensureJoinedForMessage(message, s)));
          break;
        }

        case 'lb':
        case 'leaderboard': {
          if (!canUse('leaderboard')) return void (await deny());
          if (!message.guildId) return void (await message.reply('Must be used in a server.'));
          await message.reply({ embeds: [this.leaderboardEmbed(message.guildId, message.author.username)] });
          break;
        }

        case 'dna': {
          if (!canUse('dna')) return void (await deny());
          const res = await this.dnaCard(s);
          if (typeof res === 'string') await message.reply(res);
          else await message.reply({ embeds: [res.embed], files: [res.file] });
          break;
        }

        case 'cover': {
          if (!canUse('cover')) return void (await deny());
          const res = await this.coverCard(s);
          if (typeof res === 'string') await message.reply(res);
          else await message.reply({ embeds: [res.embed], files: [res.file] });
          break;
        }

        case 'quiz': {
          if (!canUse('quiz')) return void (await deny());
          await message.reply(await this.startQuiz(s));
          break;
        }

        case 'guess': {
          if (!canUse('guess')) return void (await deny());
          const res = this.guessSong(message, args);
          if (res) await message.reply(res);
          break;
        }

        case 'weasel': {
          if (!canUse('weasel')) return void (await deny());
          const prompt = args.trim() || "Hey buddy, what's shakin'?";
          if ('sendTyping' in message.channel) {
            void message.channel.sendTyping().catch(() => {});
          }
          const reply = await this.handleWeaselRequest(s, prompt, {
            scopeId: message.guildId ?? message.channelId ?? 'dm',
            guildId: message.guildId,
            channelId: message.channelId,
            userId: message.author.id,
            username: message.author.username,
            ensureJoin: () => this.ensureJoinedForMessage(message, s),
          });
          const sent = await message.reply(reply);
          if (sent?.id) this.rememberAmokMessage(sent.id);
          break;
        }

        case 'deck': {
          if (!canUse('deck')) return void (await deny());
          await message.reply(await this.deckCommandText(message.guildId ?? '', args));
          break;
        }

        case 'mix': {
          if (!canUse('mix')) return void (await deny());
          const parts = args
            .split(/\s*\|\s*|\s*->\s*/)
            .map((x) => x.trim())
            .filter(Boolean);
          if (parts.length < 2) return void (await message.reply('Usage: `V@mix <a> | <b> [seconds]` (or `/mix`).'));
          const sec = parts[2] ? parseInt(parts[2], 10) : 6;
          await message.reply(await this.mixTracks(s, parts[0], parts[1], Number.isFinite(sec) ? sec : 6));
          break;
        }

        case 'mashup': {
          if (!canUse('mashup')) return void (await deny());
          const gid = message.guildId ?? '';
          const raw = args.trim();
          const sub = (raw.split(/\s+/)[0] ?? '').toLowerCase();
          const reply = (content: string) => message.reply(content);
          if (sub === 'list' || sub === 'queue' || sub === 'status') {
            return void (await this.replyMashupQueue(reply, gid));
          }
          if (sub === 'clear') {
            const had = (this.mashupQueue.get(gid) ?? []).length;
            this.mashupQueue.delete(gid);
            return void (await reply(
              had ? `🧹 Cleared ${had} queued mashup${had === 1 ? '' : 's'}.` : 'The mashup queue is already empty.',
            ));
          }
          if (sub === 'remove' || sub === 'cancel' || sub === 'delete') {
            return void (await this.removeMashupFromQueue(reply, gid, parseInt(raw.split(/\s+/)[1] ?? '', 10)));
          }
          if (sub === 'move') {
            const [, x, y] = raw.split(/\s+/);
            return void (await this.moveMashupInQueue(reply, gid, parseInt(x ?? '', 10), parseInt(y ?? '', 10)));
          }
          if (sub === 'edit' || sub === 'replace') {
            const rest = raw.replace(/^\S+\s*/, '');
            const m = /^(\d+)\s+([\s\S]+)$/.exec(rest);
            const ep = m
              ? m[2]
                  .split(/\s*\|\s*|\s*->\s*/)
                  .map((x) => x.trim())
                  .filter(Boolean)
              : [];
            if (!m || ep.length < 2) return void (await reply('Usage: `V@mashup edit <n> <song A> | <song B>`'));
            return void (await this.editMashupInQueue(reply, gid, parseInt(m[1]!, 10), ep[0]!, ep[1]!));
          }
          const parts = raw
            .split(/\s*\|\s*|\s*->\s*/)
            .map((x) => x.trim())
            .filter(Boolean);
          if (parts.length < 2)
            return void (await reply(
              'Usage: `V@mashup <song A> | <song B>` — separates both songs and cross-layers their stems into 2 downloadable blends + 5 similar songs.\n' +
                'Queue: `V@mashup list` · `V@mashup remove <n>` · `V@mashup edit <n> <a> | <b>` · `V@mashup move <n> <m>` · `V@mashup clear`',
            ));
          const ch = message.channel;
          if (!('send' in ch)) return void (await reply('Cannot post here.'));
          void this.startMashupRender((p) => ch.send(p), gid, parts[0]!, parts[1]!, message.author?.username ?? '');
          break;
        }

        case 'mashupgame': {
          if (!canUse('mashupgame')) return void (await deny());
          const ch = message.channel;
          if (!('send' in ch)) return void (await message.reply('Cannot post here.'));
          const pair = this.suggestMashupPair(s);
          if (!pair)
            return void (await message.reply(
              'Need at least 2 tracks queued to suggest a mashup pair — or use `V@mashup <a> | <b>`.',
            ));
          await message.reply(
            `🎲 **Mashup game!** Suggesting:\n• **${pair.a}**\n• **${pair.b}**\n\nRendering both stem blends — this takes several minutes…`,
          );
          void this.runMashupGame((p) => ch.send(p), message.guildId ?? '', pair.a, pair.b);
          break;
        }

        case 'mashups': {
          if (!canUse('mashups')) return void (await deny());
          const hist = await loadMashupHistory();
          if (!hist.length) return void (await message.reply('No mashups yet — start one with `V@mashupgame`.'));
          const lines = hist
            .slice(0, 10)
            .map(
              (h, i) =>
                `${i + 1}. **${truncate(h.a, 40)}** × **${truncate(h.b, 40)}**${h.winner ? ` — 🏆 ${h.winner}` : ''}`,
            );
          await message.reply({
            embeds: [
              new EmbedBuilder()
                .setTitle('🎲 Mashup history')
                .setDescription(lines.join('\n'))
                .setColor(this.themeColor()),
            ],
          });
          break;
        }

        case 'dedupe': {
          if (!canUse('dedupe')) return void (await deny());
          const n = s.queue.dedupe();
          await message.reply(
            n > 0
              ? `🧹 Removed ${n} duplicate track${n > 1 ? 's' : ''} from the queue.`
              : 'No duplicates in the queue.',
          );
          break;
        }

        case 'bulk': {
          if (!canUse('bulk')) return void (await deny());
          // Use the raw text after the command so NEWLINE-separated lists survive:
          // `args` above joins on spaces, which flattens them into one query.
          const rawList = rest.slice(rawCmd.length).trim();
          // Attached audio/video files count toward the 10-item cap too, so a
          // bulk can freely mix names, links and uploads in any combination.
          const files = [...message.attachments.values()]
            .map((a) => ({ name: a.name ?? 'file', url: a.url }))
            .slice(0, 10);
          const items = parseBulkItems(rawList, files.length);
          const droppedByCap = Math.max(0, countBulkItems(rawList) - items.length);
          if (items.length === 0 && files.length === 0)
            return void (await message.reply(
              `Usage: \`V@bulk\` — mix names, links and attached files, separated by \`;\` or new lines, max ${BULK_MAX} total.\n` +
                'e.g. `V@bulk Deltron 3030, Del; https://open.spotify.com/track/…; https://suno.com/song/…` (+ attach a file)',
            ));
          await this.withAck(message, `🔎 Adding ${items.length + files.length} item(s)…`, async () => {
            const resolved: Omit<TrackInfo, 'addedBy' | 'addedAt'>[] = [];
            const unresolved: string[] = [];
            // Remember what each item was searched for, so a wrong pick can be
            // re-offered the same candidate list later.
            const itemQuery = new Map<string, string>();
            for (const q of items) {
              try {
                const t = await resolvePlayInput(q);
                if (t[0]) {
                  resolved.push(t[0]);
                  itemQuery.set(t[0].uri, q);
                } else unresolved.push(q);
              } catch {
                // Name it in the reply — a silent skip reads as "it ignored my song".
                unresolved.push(q);
              }
            }
            for (const f of files) {
              try {
                resolved.push(await this.downloadUploadedTrack(f));
              } catch (err) {
                console.warn(`[bulk] attachment failed: ${err instanceof Error ? err.message : err}`);
              }
            }
            if (resolved.length === 0) throw new Error('None of those could be resolved.');
            // Never stack the same song twice — including the same track from a
            // different upload (matched on title|artist, not just the URI).
            const fresh = s.queue.filterNew(resolved);
            const skipped = resolved.length - fresh.length;
            if (fresh.length === 0)
              throw new Error(
                skipped === 1 ? 'That track is already in the queue.' : 'All of those are already in the queue.',
              );
            const who = message.author.username;
            // Bulk adds always land ahead of Endless Wave filler so an explicit
            // list is never queued behind (or interleaved with) auto-play picks.
            s.queue.insertUserBatch(fresh, who);
            this.stats.noteQueued(
              s.guildId ?? '',
              who,
              fresh.flatMap((t) => t.artists),
            );
            try {
              await this.ensureJoinedForMessage(message, s);
              if (!s.queue.getState().playing) await s.playback.play();
            } catch {
              /* queued anyway */
            }
            const embed = new EmbedBuilder()
              .setTitle(`Added ${fresh.length} track${fresh.length > 1 ? 's' : ''}`)
              .setDescription(
                fresh.map((t, i) => `${i + 1}. ${srcEmoji(t.source)} **${truncate(t.name, 60)}**`).join('\n') +
                  (skipped > 0 ? `\n-# Skipped ${skipped} already in the queue` : '') +
                  (unresolved.length > 0
                    ? `\n-# Couldn't find: ${unresolved.map((u) => truncate(u, 40)).join(', ')}`
                    : '') +
                  (droppedByCap > 0
                    ? `\n-# Only the first ${BULK_MAX} items are read per bulk — ${droppedByCap} more were ignored`
                    : ''),
              )
              .setColor(this.themeColor());
            const row = this.registerSwap({
              guildId: s.guildId ?? '',
              userId: message.author.id,
              addedBy: who,
              mode: 'queue',
              items: fresh.map((t) => ({
                uri: t.uri,
                label: `${t.name} — ${t.artists.join(', ')}`,
                query: itemQuery.get(t.uri),
              })),
            });
            await message.reply({ embeds: [embed], components: row });
          });
          break;
        }

        case 'skipto': {
          if (!canUse('skipto')) return void (await deny());
          if (!this.perms.getSkipForward(message.guildId ?? ''))
            return void (await message.reply(
              '⏭ Skip-to is **off** here — a mod can enable it with `/skiptoggle enabled:true`.',
            ));
          await this.presentSkipTo(message);
          break;
        }

        case 'skiptoggle': {
          if (!canUse('skiptoggle')) return void (await deny());
          if (!message.guildId) return void (await message.reply('Must be used in a server.'));
          const a = args.trim().toLowerCase();
          if (/^(on|1|true)$/.test(a)) this.perms.setSkipForward(message.guildId, true);
          else if (/^(off|0|false)$/.test(a)) this.perms.setSkipForward(message.guildId, false);
          const on = this.perms.getSkipForward(message.guildId);
          await message.reply(
            on
              ? '⏭ Skip-to **on** — use `V@skipto` to jump ahead (drops the tracks you skip).'
              : '⏭ Skip-to **off** — `V@skipto` is disabled here.',
          );
          break;
        }

        case 'hype': {
          if (!canUse('hype')) return void (await deny());
          if (!message.guildId) return void (await message.reply('Must be used in a server.'));
          const a = args.trim().toLowerCase();
          if (/^(on|1|true)$/.test(a)) this.hypeGuilds.add(message.guildId);
          else if (/^(off|0|false)$/.test(a)) this.hypeGuilds.delete(message.guildId);
          const on = this.hypeGuilds.has(message.guildId);
          await message.reply(on ? "⚡ Auto-hype **on** — I'll drop a hit on strong beats." : 'Auto-hype **off**.');
          break;
        }

        case 'sens':
        case 'sensitivity': {
          if (!canUse('sensitivity')) return void (await deny());
          const val = args ? parseFloat(args) : NaN;
          const valid = [1.0, 1.1, 1.15, 1.25, 1.5];
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
            await message.reply(
              '⛔ Admins only — server admins can post the panel (or `/perms` grant admin to a role).',
            );
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

        case 'jam': {
          if (!canUse('jam')) return void (await deny());
          if (!message.inGuild()) return void (await message.reply('Must be used inside a server.'));
          const r = await this.shareJamCard(message.guildId!, message.channel as GuildTextBasedChannel);
          if (!r.ok) {
            await message.reply(r.error ?? 'Could not post the jam card.');
            break;
          }
          const notice = await message.reply({
            content: '📱 Jam card posted — anyone in here can scan it to request songs.',
            components: r.pinRow ? [r.pinRow] : [],
          });
          this.autoExpireNotice(notice);
          break;
        }

        case 'key': {
          if (!this.perms.isOwner(message.author.id)) return void (await deny());
          const parts = args.trim().split(/\s+/).filter(Boolean);
          const sub = (parts[0] ?? '').toLowerCase();
          const pl = vizTunnel.panelLink();
          const vl = vizTunnel.vizLink();
          const linkFor = (base: { url: string; secure: boolean }, token: string): string =>
            base.secure ? `${base.url}?invite=${encodeURIComponent(token)}` : '';

          if (sub === 'rotate') {
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
            const killed = revokeAll();
            await message.reply(
              `New master key issued. Every device and invite is dead ` +
                `(${killed.sessions} session${killed.sessions === 1 ? '' : 's'}, ${killed.invites} invite${killed.invites === 1 ? '' : 's'}).\n` +
                `The new key is in your .env (SHARE_KEY). Use \`V@key give\` for links from now on.`,
            );
            break;
          }

          if (sub === 'show') {
            if (!config.shareKey) {
              await message.reply('No share key is configured - the web tier is open.');
              break;
            }
            await message.reply(
              `**Master key**\n\`${config.shareKey}\`\n\n` +
                'Keep this private: it can mint access. For people and devices use `V@key give` - those links expire, work once and can be revoked.',
            );
            break;
          }

          if (sub === 'list') {
            const access = listAccess();
            const when = (t: number) => `<t:${Math.floor(t / 1000)}:R>`;
            const sessions = access.sessions
              .map(
                (x) =>
                  `\`${x.id}\` · ${x.scope}${x.owner ? ' · owner' : ''} · ${x.label} · last ${when(x.lastSeenAt)} · ` +
                  `${describeUserAgent(x.lastUserAgent)}${x.lastIp ? ` · ${x.lastIp}` : ''}`,
              )
              .join('\n');
            const invites = access.invites
              .map(
                (x) =>
                  `\`${x.id}\` · ${x.scope} · ${x.label} · ${when(x.expiresAt)} · ` +
                  `${x.maxUses === 0 ? 'reusable' : `used ${x.uses}/${x.maxUses}`}`,
              )
              .join('\n');
            await message.reply(
              `**Web access**\n**Devices (${access.sessions.length})**\n${sessions || '`none`'}\n\n` +
                `**Unused invites (${access.invites.length})**\n${invites || '`none`'}\n\n` +
                '`V@key revoke <id>` cuts one off · `V@key rotate` cuts everything',
            );
            break;
          }

          if (sub === 'revoke') {
            const id = (parts[1] ?? '').trim();
            if (!id) {
              await message.reply('Usage: `V@key revoke <id|all>` - ids come from `V@key list`.');
              break;
            }
            if (id === 'all') {
              const killed = revokeAll();
              await message.reply(`Revoked ${killed.sessions} session(s) and ${killed.invites} invite(s).`);
            } else {
              const ok = revokeSession(id);
              await message.reply(ok ? `Revoked \`${id}\`.` : `No device or invite with id \`${id}\`.`);
            }
            break;
          }

          // give - owner only: mint a single-use invite instead of handing out the key.
          if (!config.shareKey) {
            await message.reply('No share key is configured - the web tier is open.');
            break;
          }
          const scopeArg = (parts[1] ?? '').toLowerCase();
          const scope: AccessScope = scopeArg === 'view' ? 'view' : scopeArg === 'request' ? 'request' : 'control';
          const hours = Math.max(1, Math.min(168, Number(parts[2]) || (scope === 'control' ? 12 : 24)));
          const minted = mintInvite(scope, `discord:${message.author.username}`, hours * 60 * 60 * 1000);
          const link = linkFor(scope === 'control' ? pl : vl, minted.token);
          if (message.guildId) await this.markKeyedGuild(message.guildId);
          await message.reply(
            `**${scope === 'control' ? 'Control' : scope === 'view' ? 'View' : 'Song-request'} invite**\n` +
              (link ? `${link}\n\n` : '(links appear once PUBLIC_BASE_URL or a tunnel is up)\n\n') +
              `Single use, expires in ${hours}h. ` +
              (scope === 'control'
                ? 'Unlocks the control panel, and the same link also opens /viz and /listen.'
                : scope === 'view'
                  ? 'Watch the visualizer or listen in hi-fi; cannot change playback.'
                  : 'Opens the song-request page only - no listening, no controls.') +
              `\n\nid \`${minted.invite.id}\` · \`V@key revoke ${minted.invite.id}\` to cut it off early`,
          );
          break;
        }
        case 'sc':
        case 'screensaver': {
          const svl = vizTunnel.vizLink();
          await message.reply(
            `🎬 Fullscreen visuals live in the browser now:\n${svl.url}\n\nOpen it and tap ⛶ (or F) for fullscreen.`,
          );
          break;
        }

        case 'ew':
        case 'endwav':
        case 'autoplay':
        case 'ap':
        case 'auto': {
          const isAp = cmd === 'autoplay' || cmd === 'ap' || cmd === 'auto';
          if (!canUse(isAp ? 'autoplay' : 'endwav')) return void (await deny());
          if (!message.guildId) return void (await message.reply('Must be used in a server.'));
          const ewS = this.sessionFor(message.guildId);
          const arg = (args || '').toLowerCase().trim();
          if (isAp && (arg === 'now' || arg === 'next')) {
            this.ewRetryAfter.delete(message.guildId);
            await this.topUpWave(ewS);
            await message.reply({ content: this.autoplayStatus(ewS, '➕ Queued one more via autoplay.') });
          } else if (isAp && /^count\b/.test(arg)) {
            const n = parseInt(arg.replace(/^count\s*/, ''), 10);
            if (!Number.isFinite(n) || n < 1 || n > 10) {
              await message.reply('Usage: `V@autoplay count <1-10>`.');
            } else {
              this.ewAheadOverride.set(message.guildId, n);
              await message.reply({ content: this.autoplayStatus(ewS, `Autoplay buffer set to **${n}** track(s).`) });
            }
          } else if (arg === 'on' || arg === 'activate' || arg === 'smart' || arg === 'high') {
            this.setAutoplayMode(ewS, 'smart');
            await message.reply({
              content: this.autoplayStatus(
                ewS,
                "🌊 **Endless Wave (smart autoplay) enabled** — I'll keep the vibes flowing with AI-curated tracks.",
              ),
            });
          } else if (arg === 'basic' || arg === 'light' || arg === 'low') {
            this.setAutoplayMode(ewS, 'basic');
            await message.reply({
              content: this.autoplayStatus(
                ewS,
                "🎵 **Basic autoplay enabled** — I'll queue a related track whenever the queue ends.",
              ),
            });
          } else if (arg === 'off' || arg === 'deactivate' || arg === 'stop') {
            const wasOff = EW.modeOf(ewS.endlessWave) === 'off';
            this.setAutoplayMode(ewS, 'off');
            await message.reply({
              content: wasOff
                ? 'Autoplay is already off.'
                : `⏹️ **Autoplay off** — ${ewS.endlessWave.generated} tracks were auto-curated this session.`,
            });
          } else if (isAp && arg && arg !== 'status') {
            await message.reply('Usage: `V@autoplay off|basic|smart|now|count <1-10>` (or `V@autoplay` for status).');
          } else {
            await message.reply({ content: this.autoplayStatus(ewS) });
          }
          break;
        }

        case 'save': {
          if (!canUse('playlist')) return void (await deny());
          if (!message.guildId) return void (await message.reply('Must be used in a server.'));
          if (!args) return void (await message.reply('Usage: `V@save <name>`.'));
          const snap = s.queue.getSnapshot();
          const saved = this.playlists.save(
            message.guildId,
            args,
            snap.tracks.map((t) => ({
              uri: t.uri,
              name: t.name,
              artists: t.artists,
              album: t.album,
              durationMs: t.durationMs,
              source: t.source ?? 'spotify',
              image: t.image,
            })),
          );
          await message.reply(
            saved.ok
              ? `💾 Saved **${args}** (${saved.tracks} track${saved.tracks === 1 ? '' : 's'}).`
              : `⚠️ ${saved.error}`,
          );
          break;
        }

        case 'load': {
          if (!canUse('playlist')) return void (await deny());
          if (!message.guildId) return void (await message.reply('Must be used in a server.'));
          if (!args) return void (await message.reply('Usage: `V@load <name>`.'));
          const pl = this.playlists.get(message.guildId, args);
          if (!pl) return void (await message.reply(`No playlist called **${args}**.`));
          const tracks = pl.tracks.map((t) => ({ ...t, source: t.source as ResolvedTrack['source'] }));
          const failed = await this.playTracks(s, tracks, message.author.username, () =>
            this.ensureJoinedForMessage(message, s),
          );
          await message.reply(
            `▶️ Loading **${pl.name}** — ${tracks.length} track${tracks.length === 1 ? '' : 's'}${failed ? `\n⚠️ ${failed}` : ''}`,
          );
          break;
        }

        case 'playlists':
        case 'pl': {
          if (!canUse('playlist')) return void (await deny());
          if (!message.guildId) return void (await message.reply('Must be used in a server.'));
          const list = this.playlists.list(message.guildId);
          await message.reply(
            list.length
              ? `💾 Saved playlists:\n${list.map((p) => `• **${p.name}** — ${p.tracks.length}`).join('\n')}`
              : 'No saved playlists yet — use `V@save <name>`.',
          );
          break;
        }

        case 'del': {
          if (!canUse('playlist')) return void (await deny());
          if (!message.guildId) return void (await message.reply('Must be used in a server.'));
          if (!args) return void (await message.reply('Usage: `V@del <name>`.'));
          const ok = this.playlists.delete(message.guildId, args);
          await message.reply(ok ? `🗑️ Deleted **${args}**.` : `No playlist called **${args}**.`);
          break;
        }

        case 'djrole': {
          if (!canUse('djrole')) return void (await deny());
          if (!message.guildId) return void (await message.reply('Must be used in a server.'));
          const roleId = message.mentions.roles.first()?.id;
          if (/^(off|clear|none)$/i.test(args)) {
            this.perms.setDjRole(message.guildId, null);
            await message.reply('🎧 DJ role cleared — skip now uses vote-to-skip.');
          } else if (roleId) {
            this.perms.setDjRole(message.guildId, roleId);
            await message.reply(`🎧 DJ role set to <@&${roleId}>. Holders can skip/control without a vote.`);
          } else {
            const cur = this.perms.getDjRole(message.guildId);
            await message.reply(
              cur ? `🎧 DJ role: <@&${cur}>` : 'No DJ role set — use `V@djrole @Role` (or `V@djrole off`).',
            );
          }
          break;
        }

        case 'th':
        case 'theme': {
          if (!canUse('theme')) return void (await deny());
          if (!args) {
            const current = this.bridge.getTheme();
            const lines = THEMES.map((t) => `${t.id === current.id ? '▶' : '•'} **${t.name}** (\`${t.id}\`)`).join(
              '\n',
            );
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
            await message.reply('Nothing playing, or the audio is too quiet for a waveform right now.');
            break;
          }
          if ('send' in message.channel) {
            await message.channel.send({
              content: '📊 Waveform — last ~2.4s:',
              files: [new AttachmentBuilder(gif, { name: 'vaporzr-wave.gif' })],
            });
          }
          break;
        }

        case 'speed': {
          if (!canUse('speed')) return void (await deny());
          const mode = (args || '').toLowerCase();
          const label = (spd: number): string =>
            spd === 1 ? 'Normal (1x)' : spd > 1 ? `Nightcore (${spd.toFixed(2)}x)` : `Slowed (${spd.toFixed(2)}x)`;
          if (mode && !['nightcore', 'slowed', 'normal'].includes(mode)) {
            await message.reply(
              `🎚️ \`V@speed <mode>\` — modes: \`nightcore\`, \`slowed\`, \`normal\`.\nCurrent: **${label(s.playback.getSpeed())}**`,
            );
            break;
          }
          if (!mode) {
            await message.reply(
              `🎚️ Current speed: **${label(s.playback.getSpeed())}**\nUsage: \`V@speed nightcore\` / \`slowed\` / \`normal\``,
            );
            break;
          }
          const factor = mode === 'nightcore' ? 1.25 : mode === 'slowed' ? 0.85 : 1;
          s.playback.setSpeed(factor);
          await message.reply(
            factor === 1
              ? '▶️ Speed back to normal.'
              : factor > 1
                ? `⚡ Nightcore mode — everything runs at **${factor.toFixed(2)}x**!`
                : `🐢 Slowed down to **${factor.toFixed(2)}x** — chill vibes.`,
          );
          break;
        }

        case 'bass':
        case 'bassboost': {
          if (!canUse('bassboost')) return void (await deny());
          const raw = (args || '').toLowerCase();
          if (raw === 'off' || raw === '0') {
            s.playback.setBassBoost(0);
            await message.reply('🎛️ Bass boost off.');
            break;
          }
          const db = raw ? parseInt(raw, 10) : NaN;
          if (!raw || Number.isNaN(db) || db <= 0) {
            const current = s.playback.getBassBoost();
            if (current > 0) {
              s.playback.setBassBoost(0);
              await message.reply('🎛️ Bass boost off.');
            } else {
              await message.reply(
                `🔇 Bass boost is off.\nUsage: \`V@bass <5|8|10>\` — e.g. \`V@bass 10\` (or \`V@bass off\`).`,
              );
            }
            break;
          }
          const clamped = Math.min(12, Math.max(2, db));
          s.playback.setBassBoost(clamped);
          await message.reply(
            clamped <= 5
              ? `🎚️ Bass +${clamped} dB — subtle low shelf.`
              : clamped <= 8
                ? `🎚️ Bass +${clamped} dB — punchy.`
                : `💥 Bass +${clamped} dB — the neighbors will feel it.`,
          );
          break;
        }

        case 'eq': {
          if (!canUse('eq')) return void (await deny());
          const preset = (args || '').toLowerCase().trim();
          if (!preset) {
            await message.reply(
              `🎛️ Current EQ: **${s.playback.getEq()}**\nUsage: \`V@eq <flat|bass|vocal|night|warm|lofi>\` — takes effect from the next track.`,
            );
            break;
          }
          if (!s.playback.setEq(preset)) {
            await message.reply(
              `Unknown preset \`${preset}\`. Try \`flat\`, \`bass\`, \`vocal\`, \`night\`, \`warm\`, \`lofi\`.`,
            );
            break;
          }
          await message.reply(`🎛️ EQ preset → **${preset}** — applies from the next track.`);
          break;
        }

        case 'norm': {
          if (!canUse('norm')) return void (await deny());
          const raw = (args || '').toLowerCase().trim();
          if (!raw) {
            await message.reply(
              s.playback.getLoudnorm()
                ? '🔊 Loudness match **on** — all sources play at Spotify-standard level (-14 LUFS). Use `V@norm off` to disable.'
                : 'Loudness match is **off** — use `V@norm on` to level every source to Spotify-standard volume.',
            );
            break;
          }
          const on = ['on', 'true', 'yes', '1'].includes(raw);
          if (!on && !['off', 'false', 'no', '0'].includes(raw)) {
            await message.reply('Usage: `V@norm <on|off>` — level every source to Spotify-standard loudness.');
            break;
          }
          s.playback.setLoudnorm(on);
          await message.reply(
            on
              ? '🔊 Loudness match **on** — everything plays at Spotify-standard loudness (-14 LUFS). Applies from the next track.'
              : 'Loudness match **off** — sources play at their native level.',
          );
          break;
        }

        case 'wrapped': {
          if (!canUse('wrapped')) return void (await deny());
          const gid = message.guildId;
          if (!gid) return void (await message.reply('Wrapped only works inside a server.'));
          const now = new Date();
          const wantLast = (args || '').toLowerCase().includes('last');
          const month = wantLast
            ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1)).toISOString().slice(0, 7)
            : now.toISOString().slice(0, 7);
          await message.reply({ embeds: [this.wrappedEmbed(gid, month)] });
          break;
        }

        case 'follow': {
          if (!canUse('follow')) return void (await deny());
          const fid = message.guildId;
          if (!fid) return void (await message.reply('Follow only works inside a server.'));
          const off = /^(off|stop|clear|disable)$/i.test((args || '').trim());
          await message.reply(await this.followNowPlaying(fid, message.channelId, off));
          break;
        }

        case 'stump': {
          if (!canUse('stump')) return void (await deny());
          const res = await this.gameStump(s, message.author.username, args || undefined, message.author.id);
          await message.reply(typeof res === 'string' ? res : { content: res.content, components: res.components });
          break;
        }

        case 'games': {
          await message.reply({ embeds: [this.gamesEmbed()] });
          break;
        }

        case 'duel': {
          if (!canUse('duel')) return void (await deny());
          let raw = (args || '').trim();
          // Trailing "now" → instant model verdict instead of the room vote.
          let now = false;
          if (/\s+now$/i.test(raw)) {
            now = true;
            raw = raw.replace(/\s+now$/i, '').trim();
          }
          let opponent: string | undefined;
          const mention = /^<@!?(\d+)>$/.exec(raw);
          if (mention) {
            const member = await message.guild?.members.fetch(mention[1]).catch(() => null);
            opponent = member?.user.username ?? raw.replace(/[<@!>]/g, '');
          } else if (raw && !/^(board|top|leaderboard|rank)$/i.test(raw)) {
            const found = await message.guild?.members.fetch({ query: raw, limit: 1 }).catch(() => null);
            opponent = found?.first()?.user.username ?? raw;
          }
          const duel = await this.gameDuel(s, message.author.username, opponent, { now });
          if (typeof duel === 'string') await message.reply(duel);
          else await message.reply({ embeds: [duel] });
          break;
        }

        case 'roulette': {
          if (!canUse('roulette')) return void (await deny());
          const spin = await this.gameRoulette(s, message.author.username);
          if (typeof spin === 'string') await message.reply(spin);
          else await message.reply({ content: spin.content, components: spin.components });
          break;
        }

        case 'sleep':
        case 'timer': {
          if (!canUse('sleep')) return void (await deny());
          if (!message.guildId) return void (await message.reply('Sleep timer only works inside a server.'));
          const guildId = message.guildId;
          if (!args) {
            if (this.sleepTimers.has(guildId)) {
              this.cancelSleepTimer(guildId);
              await message.reply('⏰ Sleep timer cancelled.');
            } else {
              await message.reply('No sleep timer set. Use `V@sleep 30m` (or `1h`, `45s`) to set one.');
            }
            break;
          }
          const ms = parseSleepSpec(args);
          if (!ms || ms <= 0) {
            await message.reply(`Couldn't parse \`${args}\`. Try \`V@sleep 30m\`, \`1h\`, or \`45s\`.`);
            break;
          }
          const when = new Date(Date.now() + ms);
          this.setSleepTimer(s, ms, () => {
            void this.sleepFireNotify(s);
          });
          await message.reply(
            `⏰ Sleep timer set — I'll stop playing and leave at **${when.toLocaleTimeString()}**.\nUse \`V@sleep\` again to cancel.`,
          );
          break;
        }

        case 'lyrics':
        case 'lyr': {
          if (!canUse('lyrics')) return void (await deny());
          const payload = await this.lyricsPayload(s, args || undefined);
          if ('error' in payload) await message.reply({ content: payload.error });
          else await message.reply({ embeds: payload.embeds, components: payload.components });
          break;
        }

        case 'k':
        case 'karaoke': {
          if (!canUse('lyrics')) return void (await deny());
          const payload = await this.lyricsKaraokePayload(s, args || undefined);
          if ('error' in payload) await message.reply({ content: payload.error });
          else {
            const msg = await message.reply({ embeds: [payload.embed] });
            this.registerKaraoke(
              s,
              msg.id,
              message.guildId!,
              message.channelId,
              payload.title,
              payload.artist,
              payload.syncedLines,
            );
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
            await message.channel.send({
              content: '🎞 Visual burst:',
              files: [new AttachmentBuilder(gif, { name: 'vaporzr-burst.gif' })],
            });
          }
          break;
        }

        case 'player':
        case 'open': {
          const vl = vizTunnel.vizLink();
          // Same host, websocket scheme — the player can drive a bot that runs
          // on another machine (the VPS) through the public tunnel.
          const wsUrl = vl.url.replace(/^http/i, 'ws').replace(/\/+$/, '') + '/ws';
          await message.reply(
            [
              '🎥 **Visualizer on screen**',
              '',
              '**Easiest:** double-click **`Start Visualizer.cmd`** in the `vaporzr` folder',
              '_Hover the window to get the controls · Esc closes it_',
              '',
              '**Or by hand** (in the `vaporzr` folder):',
              '```',
              'npm --prefix apps/player run broadcast -- --ws=' + wsUrl,
              '```',
              '',
              '**Then, in OBS:**',
              '`1.` **+ → Window Capture** → pick **Vaporzr Visualizer** → right-click → **Fit to screen**',
              '`2.` **Start Virtual Camera**',
              '`3.` In Discord: turn your camera on in the VC → **OBS Virtual Camera**',
              '',
              `**Browser version** (any device): ${vl.url}`,
              vl.secure ? '🔒' : '',
            ]
              .filter(Boolean)
              .join('\n'),
          );
          break;
        }

        case 'viz': {
          const admin = this.isAdminMember(message.author.id, message.guild, message.member);
          await message.reply({ embeds: [this.vizEmbed(admin)] });
          break;
        }

        case 'help': {
          const topic = (args || '').toLowerCase().trim();
          if (topic === 'all' || topic === 'everything') {
            await message.reply({ embeds: this.helpAllEmbeds() });
            break;
          }
          if (topic === 'aliases' || topic === 'shortcuts') {
            await message.reply({ embeds: [this.helpAliasesEmbed()] });
            break;
          }
          const cat = args ? this.helpCategoryEmbed(args) : null;
          if (args && !cat) {
            await message.reply(
              `Unknown category \`${args}\`. Try: ${HELP_CATEGORIES.map((c) => `\`${c.id}\``).join(', ')}, \`all\`, or \`aliases\`.`,
            );
          } else if (cat) {
            await message.reply({ embeds: [cat], components: this.helpButtons() });
          } else {
            await message.reply({ embeds: [this.helpEmbed()], components: this.helpButtons() });
          }
          break;
        }

        case 'invite': {
          const appId = this.client.user!.id;
          const perms =
            (1n << 6n) |
            (1n << 10n) |
            (1n << 11n) |
            (1n << 13n) |
            (1n << 14n) |
            (1n << 15n) |
            (1n << 16n) |
            (1n << 18n) |
            (1n << 20n) |
            (1n << 21n) |
            (1n << 31n) |
            (1n << 52n);
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

        case 'diag': {
          await message.reply({ embeds: [this.diagEmbed(message.guildId)] });
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

  /** "Already in the queue" notice for a re-add of the same song. */
  private duplicateEmbed(tracks: { name: string }[]): EmbedBuilder {
    return new EmbedBuilder()
      .setDescription(
        tracks.length === 1
          ? `🎵 **${truncate(tracks[0]?.name ?? 'That track', 60)}** is already in the queue.`
          : '🎵 Those tracks are already in the queue.',
      )
      .setColor(this.themeColor());
  }

  private async addToQueueMsg(message: Message, tracks: ResolvedTrack[], query?: string): Promise<void> {
    const s = this.sessionFor(message.guildId);
    // Never stack a song that's already waiting — same upload or not.
    const fresh = s.queue.filterNew(tracks);
    if (fresh.length === 0) {
      this.replyTemp(message, this.duplicateEmbed(tracks));
      return;
    }
    const first = fresh[0];
    const requestedBy = message.author.username;
    const wasPlaying = s.queue.getState().playing;
    const suppressStrip = !wasPlaying && !!first;
    if (suppressStrip) this.suppressAutoMiniNp(message.guildId ?? undefined, first.uri);
    s.queue.enqueueMany(fresh, requestedBy);
    this.stats.noteQueued(
      s.guildId ?? '',
      requestedBy,
      fresh.flatMap((t) => t.artists),
    );
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
    const st = s.queue.getState();
    const startedFresh = !wasPlaying && st.playing && !!first && st.track?.uri === first.uri;
    if (suppressStrip && !startedFresh) this.miniNpSuppress.delete(message.guildId ?? '');
    const embed = new EmbedBuilder()
      .setTitle('Added to queue')
      .setDescription(
        `${srcEmoji(first.source)} **${first.name}** — ${truncate(first.artists.join(', '), 80)}` +
          (playbackFailed ? `\n⚠️ Couldn't start playback yet: ${playbackFailed}` : ''),
      )
      .setThumbnail(first.image ?? '')
      .setFooter({
        text: `${fresh.length} track${fresh.length > 1 ? 's' : ''} · ${s.queue.getSnapshot().tracks.length} in queue`,
      })
      .setColor(this.themeColor());
    // A name search can land on the wrong recording — offer a one-click fix.
    // A playlist needs it too: nobody typed those titles, so each item keeps
    // its own title as the query that "Pick another" re-runs.
    const items = buildSwapItems(fresh, query);
    if (items) {
      const row = this.registerSwap({
        guildId: s.guildId ?? '',
        userId: message.author.id,
        addedBy: requestedBy,
        mode: 'queue',
        items,
      });
      this.replyTemp(message, embed, 90_000, row);
    } else {
      this.replyTemp(message, embed);
    }
  }

  /** Download one Discord attachment into the uploads dir as a local track. */
  private async downloadUploadedTrack(file: {
    name: string;
    url: string;
  }): Promise<Omit<TrackInfo, 'addedBy' | 'addedAt'>> {
    const dir = path.join(config.dataDir, 'uploads');
    await fs.mkdir(dir, { recursive: true });
    const safe = file.name.replace(/[^A-Za-z0-9._-]+/g, '_');
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const filePath = path.join(dir, `${stamp}-${safe}`);
    const res = await fetch(file.url);
    if (!res.ok) throw new Error(`Could not download "${file.name}" (HTTP ${res.status}).`);
    const buf = Buffer.from(await res.arrayBuffer());
    await fs.writeFile(filePath, buf);
    return {
      uri: `local:${stamp}:${safe}`,
      name: file.name.replace(/\.[^.]+$/, ''),
      artists: ['Local file'],
      album: 'Uploads',
      durationMs: 0,
      source: 'local',
      filePath,
    };
  }

  private async playUploadedFiles(
    s: Session,
    files: { name: string; url: string }[],
    requester: string,
    ensureJoined: () => Promise<boolean>,
    reply: (embed: EmbedBuilder) => Promise<unknown>,
  ): Promise<void> {
    if (files.length === 0) return;
    const added: string[] = [];
    for (const file of files) {
      const track = await this.downloadUploadedTrack(file);
      s.queue.enqueue(track, requester);
      added.push(track.name);
    }
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
    const list = added.map((n) => `📂 **${n}**`).join('\n');
    const embed = new EmbedBuilder()
      .setTitle('Added to queue')
      .setDescription(
        (added.length === 1 ? `${list} — local file` : `${list}\n— ${added.length} local files`) +
          (playbackFailed ? `\n⚠️ Couldn't start playback yet: ${playbackFailed}` : ''),
      )
      .setFooter({ text: `${s.queue.getSnapshot().tracks.length} in queue` })
      .setColor(this.themeColor());
    await reply(embed);
  }

  private async insertToQueueMsg(message: Message, tracks: ResolvedTrack[], query?: string): Promise<void> {
    const s = this.sessionFor(message.guildId);
    // Never stack a song that's already waiting — same upload or not.
    const fresh = s.queue.filterNew(tracks);
    if (fresh.length === 0) {
      this.replyTemp(message, this.duplicateEmbed(tracks));
      return;
    }
    const first = fresh[0];
    const requestedBy = message.author.username;
    const wasPlaying = s.queue.getState().playing;
    const suppressStrip = !wasPlaying && !!first;
    if (suppressStrip) this.suppressAutoMiniNp(message.guildId ?? undefined, first.uri);
    s.queue.insertAfterCurrent(fresh, requestedBy);
    this.stats.noteQueued(
      s.guildId ?? '',
      requestedBy,
      fresh.flatMap((t) => t.artists),
    );
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
    const st = s.queue.getState();
    const startedFresh = !wasPlaying && st.playing && !!first && st.track?.uri === first.uri;
    if (suppressStrip && !startedFresh) this.miniNpSuppress.delete(message.guildId ?? '');
    const embed = new EmbedBuilder()
      .setTitle('Inserted to play next')
      .setDescription(
        `${srcEmoji(first.source)} **${first.name}** — ${first.artists.join(', ')}` +
          (playbackFailed ? `\n⚠️ Couldn't start playback yet: ${playbackFailed}` : ''),
      )
      .setThumbnail(first.image ?? '')
      .setFooter({
        text: `${fresh.length} track${fresh.length > 1 ? 's' : ''} · ${s.queue.getSnapshot().tracks.length} in queue`,
      })
      .setColor(this.themeColor());
    const items = buildSwapItems(fresh, query);
    if (items) {
      const row = this.registerSwap({
        guildId: s.guildId ?? '',
        userId: message.author.id,
        addedBy: requestedBy,
        mode: 'insert',
        items,
      });
      this.replyTemp(message, embed, 90_000, row);
    } else {
      this.replyTemp(message, embed);
    }
  }

  /** Reply with a confirmation embed and auto-delete it shortly after, so busy
   *  channels don't accumulate bot replies. */
  private replyTemp(
    message: Message,
    embed: EmbedBuilder,
    ms = 12_000,
    components?: ActionRowBuilder<ButtonBuilder>[],
  ): void {
    void message
      .reply({ embeds: [embed], components: components ?? [] })
      .then((msg) => {
        const t = setTimeout(() => void msg.delete().catch(() => {}), ms);
        t.unref?.();
      })
      .catch(() => {});
  }

  /** Error note for an auto-join that can't run (no voice channel visible). */
  private joinFailedError(): Error {
    return new Error("I couldn't join a voice channel — make sure you're in one, then try again.");
  }

  /** Auto-join the author's voice channel before playback (message-command variant). */
  private async ensureJoinedForMessage(message: Message, s: Session): Promise<boolean> {
    // Only a Ready link can carry audio. The old `isJoined()` check also
    // accepted Disconnected/Connecting links, so a dead one silently skipped
    // the rejoin — V@p replied "Added to queue" and the bot never joined.
    if (s.voice.isConnectionReady()) {
      const requester = message.member?.voice?.channel;
      const current = s.voice.getChannelId();
      if (requester && current && requester.id !== current)
        console.log(
          `[discord] auto-join skipped: already in ${current}, requester in ${requester.id} (use V@join to move)`,
        );
      return true;
    }
    if (s.voice.isJoined())
      console.warn(`[discord] auto-join: voice link is \`${s.voice.connectionStatus()}\` — rejoining`);
    if (!message.inGuild()) throw this.joinFailedError();
    const channel = message.member?.voice?.channel;
    if (!channel) {
      console.warn('[discord] auto-join: requester is not in a voice channel');
      throw this.joinFailedError();
    }
    try {
      await s.voice.join(message.guild!.id, channel.id, message.guild!.voiceAdapterCreator, channel);
    } catch (err) {
      // Joins can time out transiently (voice gateway hiccup); the internal
      // retry usually lands seconds later — auto-resume queued playback then.
      this.scheduleAutoResume(s);
      throw err;
    }
    const state = s.queue.getState();
    // A leave+rejoin tore down the audio stream, so re-arm the feed (Spotify)
    // or re-issue the stream (ffmpeg sources) instead of just starting an empty
    // stream — otherwise the track plays on silently and trips the stall watchdog.
    if (state.playing) void s.playback.reattachAfterRejoin();
    console.log('[discord] auto-joined voice channel');
    // A fresh join re-enables the now-playing follow. A previous `V@follow off`
    // must not silently outlive the session — the strip is how everyone sees what
    // is playing, so joining always turns it back on and posts it right away.
    this.perms.setNpAuto(s.guildId, true);
    void this.maybeAutoMiniNp(s.guildId, s.queue.getState());
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

  /** Guards the boot-time restart resume so a session only tries it once. */
  private restartResumed = new Set<string>();

  /**
   * After a restart, a queue that was mid-playback gets one chance to resume
   * seamlessly: rejoin the voice channel it was streaming into and start the
   * restored current track. Anything unexpected (channel gone, nobody left, a
   * stale interruption) skips the resume and leaves the queue queued — this
   * never walks back through tracks that already played.
   */
  private scheduleRestartResume(s: Session, info: RestoredPlayingInfo): void {
    const key = s.guildId || '__dm__';
    if (this.restartResumed.has(key)) return;
    // Only resume a recent interruption — a deploy or crash, not a bot that was
    // down for hours (its old queue would just replay stale music).
    const maxAgeMs = 15 * 60 * 1000;
    const ageMs = info.fileMtimeMs > 0 ? Date.now() - info.fileMtimeMs : Number.POSITIVE_INFINITY;
    if (ageMs > maxAgeMs) {
      console.log(
        `[discord] restart resume skipped for guild ${s.guildId} — last session ended ${Math.round(ageMs / 60000)}m ago`,
      );
      return;
    }
    if (!info.voiceChannelId) {
      console.log(`[discord] restart resume skipped for guild ${s.guildId} — no voice channel on record`);
      return;
    }
    this.restartResumed.add(key);
    // Let the gateway finish populating channel caches before reading members.
    const channelId = info.voiceChannelId;
    const t = setTimeout(() => void this.tryRestartResume(s, channelId), 3000);
    t.unref?.();
  }

  private async tryRestartResume(s: Session, channelId: string): Promise<void> {
    let joined = false;
    try {
      const guild = this.client.guilds.cache.get(s.guildId);
      const channel = guild?.channels.cache.get(channelId);
      if (!guild || !channel || !channel.isVoiceBased()) {
        console.log(`[discord] restart resume skipped for guild ${s.guildId} — channel ${channelId} is gone`);
        return;
      }
      if (!channel.members.some((m) => !m.user.bot)) {
        console.log(`[discord] restart resume skipped for guild ${s.guildId} — nobody is in ${channel.name}`);
        return;
      }
      const track = s.queue.getCurrentTrack();
      if (!track) return; // finished queue — nothing to pick back up
      await s.voice.join(guild.id, channel.id, guild.voiceAdapterCreator, channel);
      // join() resolves only once the link is Ready, so audio can flow.
      joined = true;
      this.perms.setNpAuto(s.guildId, true);
      await s.playback.play();
      console.log(`[discord] restart resume: rejoined ${channel.name} and resumed "${track.name}"`);
      void this.maybeAutoMiniNp(s.guildId, s.queue.getState());
    } catch (err) {
      console.warn(
        `[discord] restart resume failed for guild ${s.guildId}: ${err instanceof Error ? err.message : err}`,
      );
      // Don't squat in the channel with nothing playing — the queue stays
      // queued, and a later V@p picks it back up.
      if (joined) {
        try {
          this.clearVoiceStatus(s);
          s.voice.leave();
        } catch {
          /* ignore */
        }
      }
    }
  }

  private async insertToQueue(
    interaction: ChatInputCommandInteraction,
    tracks: ResolvedTrack[],
    query?: string,
  ): Promise<void> {
    const s = this.sessionFor(interaction.guildId);
    const first = tracks[0];
    const requestedBy = interaction.member?.user.username ?? 'unknown';
    const wasPlaying = s.queue.getState().playing;
    const suppressStrip = !wasPlaying && !!first;
    if (suppressStrip) this.suppressAutoMiniNp(interaction.guildId ?? undefined, first.uri);
    s.queue.insertAfterCurrent(tracks, requestedBy);
    this.stats.noteQueued(
      s.guildId ?? '',
      requestedBy,
      tracks.flatMap((t) => t.artists),
    );
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
    const st = s.queue.getState();
    const startedFresh = !wasPlaying && st.playing && !!first && st.track?.uri === first.uri;
    if (suppressStrip && !startedFresh) this.miniNpSuppress.delete(interaction.guildId ?? '');
    const embed = new EmbedBuilder()
      .setTitle('Inserted to play next')
      .setDescription(
        `${srcEmoji(first.source)} **${first.name}** — ${truncate(first.artists.join(', '), 80)}` +
          (playbackFailed ? `\n⚠️ Couldn't start playback yet: ${playbackFailed}` : ''),
      )
      .setThumbnail(first.image ?? '')
      .setFooter({
        text: `${tracks.length} track${tracks.length > 1 ? 's' : ''} · ${s.queue.getSnapshot().tracks.length} in queue`,
      })
      .setColor(this.themeColor());
    const items = buildSwapItems(tracks, query);
    const row = items
      ? this.registerSwap({
          guildId: interaction.guildId ?? '',
          userId: interaction.user.id,
          addedBy: requestedBy,
          mode: 'insert',
          items,
        })
      : undefined;
    await interaction.editReply({ embeds: [embed], components: row ?? [] });
  }

  private async addToQueue(
    interaction: ChatInputCommandInteraction,
    tracks: ResolvedTrack[],
    query?: string,
  ): Promise<void> {
    const s = this.sessionFor(interaction.guildId);
    const first = tracks[0];
    const requestedBy = interaction.member?.user.username ?? 'unknown';
    const wasPlaying = s.queue.getState().playing;
    const suppressStrip = !wasPlaying && !!first;
    if (suppressStrip) this.suppressAutoMiniNp(interaction.guildId ?? undefined, first.uri);
    s.queue.enqueueMany(tracks, requestedBy);
    this.stats.noteQueued(
      s.guildId ?? '',
      requestedBy,
      tracks.flatMap((t) => t.artists),
    );
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
    const st = s.queue.getState();
    const startedFresh = !wasPlaying && st.playing && !!first && st.track?.uri === first.uri;
    if (suppressStrip && !startedFresh) this.miniNpSuppress.delete(interaction.guildId ?? '');
    const embed = new EmbedBuilder()
      .setTitle('Added to queue')
      .setDescription(
        `${srcEmoji(first.source)} **${first.name}** — ${truncate(first.artists.join(', '), 80)}` +
          (playbackFailed ? `\n⚠️ Couldn't start playback yet: ${playbackFailed}` : ''),
      )
      .setThumbnail(first.image ?? '')
      .setFooter({
        text: `${tracks.length} track${tracks.length > 1 ? 's' : ''} · ${s.queue.getSnapshot().tracks.length} in queue`,
      })
      .setColor(this.themeColor());
    const items = buildSwapItems(tracks, query);
    const row = items
      ? this.registerSwap({
          guildId: interaction.guildId ?? '',
          userId: interaction.user.id,
          addedBy: requestedBy,
          mode: 'queue',
          items,
        })
      : undefined;
    await interaction.editReply({ embeds: [embed], components: row ?? [] });
  }

  private async deny(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.reply({ content: "⛔ You don't have permission to do that.", flags: MessageFlags.Ephemeral });
  }

  /** Auto-join the author's voice channel before playback, Luna/Jockie-style. */
  private async ensureJoinedForPlayback(
    interaction: ChatInputCommandInteraction | StringSelectMenuInteraction,
    s: Session,
  ): Promise<boolean> {
    // Same Ready-only rule as the message variant — a non-Ready link must not
    // satisfy "already joined" or the join gets silently skipped.
    if (s.voice.isConnectionReady()) return true;
    if (s.voice.isJoined())
      console.warn(`[discord] auto-join: voice link is \`${s.voice.connectionStatus()}\` — rejoining`);
    if (!interaction.inGuild()) throw this.joinFailedError();
    const member = interaction.member;
    if (!member || !('voice' in member)) throw this.joinFailedError();
    const channel = member.voice.channel;
    if (!channel) {
      console.warn('[discord] auto-join: requester is not in a voice channel');
      throw this.joinFailedError();
    }
    await s.voice.join(interaction.guild!.id, channel.id, interaction.guild!.voiceAdapterCreator, channel);
    const state = s.queue.getState();
    if (state.playing) void s.playback.reattachAfterRejoin();
    console.log('[discord] auto-joined voice channel');
    // Same as the message path: joining turns the now-playing follow back on.
    this.perms.setNpAuto(s.guildId, true);
    void this.maybeAutoMiniNp(s.guildId, s.queue.getState());
    return true;
  }

  /** Join wherever the listeners actually are, across every guild, and make that
   *  guild primary. The bridge's primary guild drifts to whichever guild last
   *  played, and after a restart it can point at a guild nobody is sitting in —
   *  which is exactly why every panel command came back "I'm not in a voice
   *  channel". Listeners are counted from voice STATES: channel.members needs the
   *  privileged GuildMembers intent, which this bot does not request. */
  private async joinWhereListenersAre(preferGuildId?: string): Promise<boolean> {
    const botId = this.client.user?.id;
    /** Listeners per channel in one guild. Counted from voice STATES, not
     *  channel.members: the member cache needs the privileged GuildMembers
     *  intent this bot does not request, so channel.members is always empty and
     *  every channel looked deserted. */
    const listeners = (guildId: string): Map<string, number> => {
      const per = new Map<string, number>();
      const guild = this.client.guilds.cache.get(guildId);
      if (!guild) return per;
      for (const vs of guild.voiceStates.cache.values()) {
        if (!vs.channelId || vs.id === botId) continue;
        per.set(vs.channelId, (per.get(vs.channelId) ?? 0) + 1);
      }
      return per;
    };
    let best: { guildId: string; channelId: string; size: number } | null = null;
    // The guild the requesting panel is looking at wins outright, so a busier
    // guild elsewhere cannot steal the bot out from under the operator.
    if (preferGuildId) {
      for (const [channelId, size] of listeners(preferGuildId)) {
        if (!best || size > best.size) best = { guildId: preferGuildId, channelId, size };
      }
    }
    if (!best) {
      for (const guild of this.client.guilds.cache.values()) {
        for (const [channelId, size] of listeners(guild.id)) {
          if (!best || size > best.size) best = { guildId: guild.id, channelId, size };
        }
      }
    }
    if (!best) return false;
    const s = this.sessions.get(best.guildId);
    if (!s) return false;
    if (this.bridge.getPrimaryGuildId() !== best.guildId) {
      console.log(`[discord] auto-join: primary guild -> ${best.guildId} (listeners there)`);
      this.bridge.setPrimaryGuildId(best.guildId);
    }
    if (s.voice.isConnectionReady()) return true; // Only a Ready link can carry audio — see ensureJoinedForMessage.
    const guild = this.client.guilds.cache.get(best.guildId);
    if (!guild) return false;
    const bitrateTarget = guild.channels.cache.get(best.channelId);
    await s.voice.join(
      guild.id,
      best.channelId,
      guild.voiceAdapterCreator,
      bitrateTarget && 'bitrate' in bitrateTarget ? bitrateTarget : undefined,
    );
    const state = s.queue.getState();
    if (state.playing) void s.playback.reattachAfterRejoin();
    this.perms.setNpAuto(s.guildId, true);
    void this.maybeAutoMiniNp(s.guildId, s.queue.getState());
    console.log(`[discord] panel play: joined ${best.channelId} (${best.size} listening)`);
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
          Object.keys(snap.commandLevels).length
            ? Object.entries(snap.commandLevels)
                .map(([c, l]) => `\`${c}\` → ${l}`)
                .join(', ')
            : 'none'
        }`,
      ];
      await interaction.reply({
        embeds: [
          new EmbedBuilder().setTitle('Permissions').setDescription(lines.join('\n')).setColor(this.themeColor()),
        ],
      });
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
   * A play/insert command posts its own reply embed for the track it just
   * started. Suppress the always-on mini strip for that track and remove any
   * existing strip so the reply is the only now-playing message (no duplicate).
   * The suppression self-clears when the track changes.
   */
  private suppressAutoMiniNp(guildId: string | undefined, uri: string): void {
    if (!guildId || !uri) return;
    this.miniNpSuppress.set(guildId, uri);
    const existing = this.miniNp.get(guildId);
    if (!existing) return;
    this.miniNp.delete(guildId);
    this.miniTrackUri.delete(guildId);
    this.scheduleSavePanels();
    void (async () => {
      try {
        const ch = await this.client.channels.fetch(existing.channelId);
        if (!ch?.isTextBased()) return;
        const msg = await ch.messages.fetch(existing.messageId);
        await msg.delete();
      } catch {
        /* already gone / no permission */
      }
    })();
  }

  /**
   * Posts the always-on mini now-playing message the first time a guild starts
   * playing — in whatever channel was last used for commands. After that it
   * updates in place on every queue/state change via refreshAllPanels, and
   * re-anchors to the bottom of the channel whenever the track changes so it
   * never gets buried by chat.
   */
  /** Delete the guild's now-playing strip (if any) and forget the registration. */
  private async clearMiniNp(guildId: string): Promise<void> {
    const mini = this.miniNp.get(guildId);
    this.miniNp.delete(guildId);
    this.miniTrackUri.delete(guildId);
    this.scheduleSavePanels();
    if (!mini) return;
    try {
      const ch = await this.client.channels.fetch(mini.channelId);
      if (ch && 'messages' in ch) {
        const msg = await ch.messages.fetch(mini.messageId).catch(() => null);
        if (msg) await msg.delete().catch(() => {});
      }
    } catch {
      /* already gone */
    }
  }

  /** On boot, remove stray strips for guilds that never opted in (see /npchannel). */
  private async cleanupMiniNp(): Promise<void> {
    for (const guildId of [...this.miniNp.keys()]) {
      if (!this.perms.getNpAuto(guildId)) await this.clearMiniNp(guildId);
    }
  }

  private async maybeAutoMiniNp(guildId: string | undefined, st: PlaybackState): Promise<void> {
    if (!guildId || !st.track) return;
    // Always-on now-playing: the strip follows the room. It targets an explicitly
    // set channel if one exists, otherwise the channel the room last interacted
    // in — so it updates with every song without anyone running /follow.
    // `/npchannel off` (or `/follow off`) sets npAuto=false to stop it.
    if (!this.perms.getNpAuto(guildId)) return;
    // Target: where the room last SPOKE first — that is the channel people are
    // actually looking at, and it moves the moment someone plays from another
    // channel, which is what "follow" means. Then the room's own voice channel
    // (usable only when it has a text chat), then an explicit /npchannel pin.
    //
    // Preferring the voice channel outright was a mistake: a voice channel is not
    // reliably postable, and the guard below returned silently, so the strip was
    // simply never created and follow looked broken in a new way.
    const room = this.sessionFor(guildId)?.voice.getChannelId() ?? null;
    const channelId = this.lastTextChannel.get(guildId) ?? room ?? this.perms.getNpChannel(guildId);
    if (!channelId) return;
    // A command reply for this exact track is already the visible now-playing —
    // don't also auto-post a strip (that was the "two identical embeds"
    // duplicate). Clears itself once the track moves on.
    const suppressedUri = this.miniNpSuppress.get(guildId);
    if (suppressedUri) {
      if (suppressedUri === st.track.uri) return;
      this.miniNpSuppress.delete(guildId);
    }
    // Hold the per-guild lock for the whole post/delete dance so a burst of
    // state-change events for the same track can't create duplicate strips.
    if (this.miniNpBusy.has(guildId)) return;
    this.miniNpBusy.add(guildId);
    try {
      const uri = st.track.uri;
      // Suppress re-posts for the same track even if the strip message is gone
      // — a 404 on the old strip used to clear miniTrackUri and let the same
      // track re-post in a burst. The strip reappears on the next track change.
      if (this.miniTrackUri.get(guildId) === uri) return;
      const channel = await this.client.channels.fetch(channelId).catch(() => null);
      if (!channel || !('send' in channel)) {
        // Never bail silently: an unpostable target is why the strip once just
        // failed to appear with nothing in the log to explain it.
        console.warn(`[np] no postable channel for the now-playing strip (target ${channelId})`);
        return;
      }
      const existing = this.miniNp.get(guildId);
      if (existing && existing.channelId !== channelId) {
        // Following the room into a different channel: clear the old strip first
        // so it does not linger as an orphan where the music used to be.
        await this.clearMiniNp(guildId);
      }
      const current = this.miniNp.get(guildId);
      if (current) {
        const old = await channel.messages.fetch(current.messageId).catch(() => null);
        if (old) {
          // ALWAYS edit the strip we already have — never delete in order to
          // re-post. The delete+repost dance was what let a failed refresh plus
          // rapid state changes flood the channel with fresh panels.
          const rendered = this.miniNpRendered(this.sessionFor(guildId));
          if (rendered) await old.edit(rendered).catch(() => {});
          this.miniTrackUri.set(guildId, uri);
          this.scheduleSavePanels();
          return;
        }
        // The message is genuinely gone (404) — forget the message ref but
        // keep miniTrackUri so the same track can't re-post in a burst.
        this.miniNp.delete(guildId);
      }
      // Hard rate limit on POSTING (a new message). Edits above are unlimited.
      const now = Date.now();
      const gate = this.miniNpGate.get(guildId) ?? { last: 0, count: 0, since: now, mutedUntil: 0 };
      if (gate.mutedUntil > now) return;
      if (now - gate.last < DiscordBot.MINI_NP_MIN_POST_GAP_MS) return;
      if (now - gate.since > DiscordBot.MINI_NP_BURST_WINDOW_MS) {
        gate.since = now;
        gate.count = 0;
      }
      gate.count++;
      if (gate.count > DiscordBot.MINI_NP_BURST_MAX) {
        gate.mutedUntil = now + DiscordBot.MINI_NP_MUTE_MS;
        this.miniNpGate.set(guildId, gate);
        console.warn(
          `[discord] mini now-playing posted ${gate.count} times in ${Math.round((now - gate.since) / 1000)}s for guild ${guildId} — muting it for 10 minutes`,
        );
        return;
      }
      const msg = await channel.send(this.miniNpMessage(this.sessionFor(guildId)));
      gate.last = now;
      this.miniNpGate.set(guildId, gate);
      this.miniNp.set(guildId, { channelId, messageId: msg.id });
      this.miniTrackUri.set(guildId, uri);
      this.scheduleSavePanels();
      void this.seedNpReactions(msg);
      // Sweep the channel for older Vaporzr strips so a track change never
      // leaves stale now-playing mini embeds piling up next to the fresh one.
      void this.sweepStaleMiniNp(channel, msg.id);
    } catch {
      /* no access to that channel — will retry on next state change */
    } finally {
      this.miniNpBusy.delete(guildId);
    }
  }

  /**
   * Deletes any pre-existing Vaporzr mini now-playing strips in the channel
   * (identified by their ▰▱ progress bar — the panel and /nowplaying embeds
   * use a different bar and are left alone) except the freshly posted one.
   */
  private async sweepStaleMiniNp(channel: TextBasedChannel, keepMessageId: string): Promise<void> {
    if (!this.client.user) return;
    let beforeId: string | undefined;
    for (let page = 0; page < 3; page++) {
      const found = await channel.messages
        .fetch({ limit: 25, ...(beforeId ? { before: beforeId } : {}) })
        .catch(() => null);
      if (!found || found.size === 0) break;
      for (const msg of found.values()) {
        if (msg.id === keepMessageId) continue;
        if (msg.author.id !== this.client.user.id) continue;
        // Never sweep something that was just posted: deleting a live strip
        // while the poster re-creates it is how the flood loop sustained itself.
        if (Date.now() - msg.createdTimestamp < 90_000) continue;
        const isMini = msg.embeds.some(
          (e) =>
            !!e.description &&
            ((e.description.includes('▰') && e.description.includes('▱')) || e.description.startsWith('⏸️ **Idle**')),
        );
        if (isMini) void msg.delete().catch(() => {});
      }
      beforeId = found.last()?.id;
      if (found.size < 25) break;
    }
  }

  private async editMiniNp(channelId: string, messageId: string, guildId: string): Promise<boolean> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel?.isTextBased()) return false;
      const msg = await channel.messages.fetch(messageId);
      const rendered = this.miniNpRendered(this.sessionFor(guildId));
      if (rendered) await msg.edit(rendered);
      return true;
    } catch (err) {
      return !isMessageGone(err);
    }
  }

  /** Post a friendly "queue's done" notice to the last-used text channel. */
  private async notifyQueueEnded(guildId: string): Promise<void> {
    // Only the opted-in now-playing channel (see /npchannel) — never an
    // arbitrary channel the bot merely saw a command in.
    const channelId = this.perms.getNpChannel(guildId);
    if (!channelId) return;
    // Rate-limit: a flapping queue (track fails → ends → retried) must not post
    // this repeatedly.
    const now = Date.now();
    if (now - (this.queueEndedNotified.get(guildId) ?? 0) < 5 * 60_000) return;
    this.queueEndedNotified.set(guildId, now);
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !('send' in channel)) return;
      await channel.send({
        embeds: [
          new EmbedBuilder()
            .setColor(this.themeColor())
            .setDescription(
              '⏹️ **Queue ended** — nothing left to play. Queue something with `V@p` or `/play` to keep it going!',
            ),
        ],
      });
    } catch {
      /* no access — skip; not worth retrying */
    }
  }

  /** DM the owner when the YouTube canary flips to a broken state. */
  private async alertYoutubeHealth(status: YoutubeHealth, context: YoutubeHealthContext = {}): Promise<void> {
    // The hop that refused connections is concrete and actionable — say which
    // one it is. ('bridge' has per-hop wording of its own below, so no note.)
    const hopNote =
      context.unreachableHop === 'alt'
        ? '\n\n⚠️ The local WARP hop (`YOUTUBE_PROXY_ALT`) is not accepting connections — check `warp-cli status` / `systemctl status warp-svc` on the VPS.'
        : context.unreachableHop === 'primary'
          ? `\n\n⚠️ The first proxy hop is not accepting connections — ${config.youtubeProxyLabel} is off, asleep, or its tunnel dropped.`
          : context.unreachableHop === 'fallback'
            ? '\n\n⚠️ The residential fallback (`YOUTUBE_PROXY_FALLBACK`) is not accepting connections — check its credentials at the provider.'
            : '';
    let text =
      status === 'auth'
        ? '⚠️ **Vaporzr: YouTube is refusing the bot** — the anti-bot wall persisted across every route (the direct connection plus all configured proxy hops), so no single exit IP is the cause: the cookies are stale or the PO token is missing. Check `/health` (`youtube`) and refresh the cookies with `/cookie-upload` if they are old.'
        : status === 'blocked'
          ? "⚠️ **Vaporzr: YouTube is blocking the bot's IP** — no proxy hops are configured (`YOUTUBE_PROXY_ALT` / `YOUTUBE_PROXY_FALLBACK` in `/opt/vaporzr/.env`), which is the usual cause for a datacenter address. Refreshing cookies alone will not fix this."
          : status === 'proxy'
            ? context.carryingHop === 'fallback'
              ? '⚠️ **Vaporzr: YouTube is running on the metered residential proxy** — every free route is failing, so playback is being carried by `YOUTUBE_PROXY_FALLBACK` and spending its balance. Investigate why the free routes are blocked, and check the balance before it runs dry.'
              : '⚠️ **Vaporzr: a YouTube proxy hop is failing** — a hop is reachable but rejecting requests (dead, out of balance, or 407), and the other routes failed too, so resolves are failing. Repair or renew the hop.'
            : status === 'exhausted'
              ? '⚠️ **Vaporzr: the residential fallback is OUT OF TRAFFIC** — `YOUTUBE_PROXY_FALLBACK` is reachable but has no balance left (DataImpulse answers `407 TRAFFIC_EXHAUSTED`). Top the plan up (DataImpulse → Add GBs) or point `YOUTUBE_PROXY_FALLBACK` at another provider.'
              : status === 'bridge'
                ? context.unreachableHop === 'alt'
                  ? '⚠️ **Vaporzr: the local WARP hop is DOWN** — the proxy at `YOUTUBE_PROXY_ALT` is not accepting connections, and the other routes failed too. Restart it on the VPS (`warp-cli connect` / `systemctl restart warp-svc`) — playback will fail until a route is healthy.'
                  : context.unreachableHop === 'primary'
                    ? `⚠️ **Vaporzr: the first YouTube proxy hop is DOWN** — ${config.youtubeProxyLabel} is off, asleep, offline, or its tunnel dropped, and the other routes failed too. Playback will fail until a route is healthy.`
                    : context.unreachableHop === 'fallback'
                      ? '⚠️ **Vaporzr: the residential fallback is DOWN** — `YOUTUBE_PROXY_FALLBACK` is not accepting connections and the other routes failed too. Playback will fail until a route is healthy.'
                      : '⚠️ **Vaporzr: a YouTube proxy hop is DOWN** — a configured hop is not accepting connections, and no other route could resolve. Playback will fail until a route is healthy.'
                : status === 'down'
                  ? '⚠️ **Vaporzr: YouTube resolution is failing** — check `/health` (`youtube`) and the network.'
                  : '';
    if (!text) return;
    if (hopNote && status !== 'bridge') text += hopNote;
    // The residential proxy is STICKY (DataImpulse holds one exit for `sessttl`
    // minutes), so a flagged exit otherwise sticks for up to an hour. On the wall,
    // rotate the session to a fresh exit and re-probe shortly after.
    if (status === 'auth') {
      const rotated = rotateYoutubeFallbackProxy();
      if (rotated) {
        text += "\n\n🔄 Rotated the residential fallback's exit — re-checking in ~30s.";
        const t = setTimeout(() => void probeYoutube(), 30_000);
        t.unref?.();
      }
    }
    void pushBroadcast({ title: 'Vaporzr', body: text.replace(/\*\*/g, ''), url: '/panel' }).catch(() => {});
    const owner = config.ownerId;
    if (owner) {
      try {
        const user = await this.client.users.fetch(owner);
        await user.send(text);
        return;
      } catch {
        /* fall back to a channel */
      }
    }
    const gid = this.bridge.getPrimaryGuildId();
    const chId = gid ? this.perms.getNpChannel(gid) : undefined;
    if (!chId) return;
    try {
      const ch = await this.client.channels.fetch(chId);
      if (ch && 'send' in ch) await ch.send(text);
    } catch {
      /* ignore */
    }
  }

  /** Playback halted because consecutive tracks couldn't start (backend issue). */
  private async notifyPlaybackStalled(guildId: string): Promise<void> {
    // Only the opted-in now-playing channel (see /npchannel) — never an
    // arbitrary channel the bot merely saw a command in.
    const channelId = this.perms.getNpChannel(guildId);
    if (!channelId) return;
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !('send' in channel)) return;
      await channel.send({
        embeds: [
          new EmbedBuilder()
            .setColor(this.themeColor())
            .setDescription(
              "⚠️ **Playback stopped** — several tracks in a row couldn't start (Spotify device unavailable / no YouTube match). The queue is intact; try `V@p` again or re-link Spotify.",
            ),
        ],
      });
    } catch {
      /* no access — skip */
    }
  }

  /** Chunk lyrics text into pages that fit Discord's 4096-char description cap. */
  private lyricsChunks(text: string): string[] {
    const MAX = 2000;
    const clean = text.trim();
    const chunks: string[] = [];
    let rest = clean;
    while (rest.length > MAX) {
      const cut = rest.lastIndexOf('\n', MAX);
      const idx = cut > 0 ? cut : MAX;
      chunks.push(rest.slice(0, idx));
      rest = rest.slice(idx).trim();
    }
    chunks.push(rest);
    return chunks.filter((c) => c.length > 0);
  }

  /** Render one lyrics page embed. */
  private lyricsPageEmbed(
    title: string,
    artist: string,
    synced: boolean,
    page: string,
    pageNum: number,
    total: number,
  ): EmbedBuilder {
    return new EmbedBuilder()
      .setColor(this.themeColor())
      .setDescription(
        `${pageNum === 1 ? `📝 **${title}** — ${artist}${synced ? ' (synced)' : ''}\n\n` : ''}${page}` +
          (total > 1 ? `\n\n*(part ${pageNum}/${total})*` : ''),
      );
  }

  /** Compact intro: title/artist + a short teaser, pointing at the dropdown. */
  private lyricsTeaserEmbed(
    title: string,
    artist: string,
    synced: boolean,
    lines: string[],
    lineCount: number,
    pageCount: number,
  ): EmbedBuilder {
    const teaser = lines.slice(0, 6).join('\n');
    return new EmbedBuilder()
      .setColor(this.themeColor())
      .setDescription(
        `📝 **${title}** — ${artist}${synced ? ' (synced)' : ''}\n\n${teaser}\n\n` +
          `*${lineCount} lines · ${pageCount} part${pageCount > 1 ? 's' : ''} — use the dropdown below to read*`,
      );
  }

  /** Build the dropdown + karaoke components for a lyrics result. */
  private lyricsComponents(
    id: string,
    pages: string[],
    hasSynced: boolean,
    current: number,
  ): ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] {
    const rows: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] = [];
    if (pages.length > 1) {
      const menu = new StringSelectMenuBuilder()
        .setCustomId(`lyrics_page:${id}`)
        .setPlaceholder('Read the full lyrics…');
      const opts: StringSelectMenuOptionBuilder[] = [];
      opts.push(
        new StringSelectMenuOptionBuilder()
          .setLabel('📜 Full Lyrics')
          .setValue('full')
          .setDefault(current === -1),
      );
      for (let i = 0; i < pages.length && opts.length < 25; i++) {
        opts.push(
          new StringSelectMenuOptionBuilder()
            .setLabel(`Part ${i + 1} of ${pages.length}`)
            .setValue(String(i))
            .setDefault(i === current),
        );
      }
      menu.addOptions(opts);
      rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu));
    }
    if (hasSynced) {
      rows.push(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`lyrics_karaoke:${id}`)
            .setLabel('Karaoke')
            .setEmoji('🎤')
            .setStyle(ButtonStyle.Secondary),
        ),
      );
    }
    return rows;
  }

  /** Resolve what track to use for lyrics: a query (resolve it) or the current track. */
  private async lyricsPayload(
    s: Session,
    query?: string,
  ): Promise<
    | { embeds: EmbedBuilder[]; components: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] }
    | { error: string }
  > {
    const track = query ? await this.resolveLyricsQuery(query) : s.queue.getCurrentTrack();
    if (!track) return { error: '📝 Nothing playing — run a query or queue a track first.' };
    const result = await fetchLyrics(track);
    if (!result)
      return { error: `📝 No lyrics found for **${truncate(track.name, 60)}** — works best with title + artist.` };
    const pages = this.lyricsChunks(result.lyrics);
    const id = randomBytes(4).toString('hex');
    if (this.lyricPages.size >= DiscordBot.LYRIC_PAGES_MAX) {
      const oldestKey = this.lyricPages.keys().next().value;
      if (oldestKey !== undefined) this.lyricPages.delete(oldestKey);
    }
    this.lyricPages.set(id, {
      title: result.trackName,
      artist: result.artistName,
      synced: result.synced,
      pages,
      syncedLines: result.syncedLines,
      createdAt: Date.now(),
    });
    this.ensureLyricPagesTicker();
    // Short lyrics fit on one page — show them straight. Otherwise show a
    // compact teaser and let the dropdown reveal the full text.
    const allLines = result.lyrics.split('\n').filter((l) => l.trim().length > 0);
    let embeds: EmbedBuilder[];
    let components: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[];
    if (pages.length <= 1) {
      embeds = [this.lyricsPageEmbed(result.trackName, result.artistName, result.synced, result.lyrics, 1, 1)];
      components = this.lyricsComponents(id, pages, Boolean(result.syncedLines?.length), 0);
    } else {
      embeds = [
        this.lyricsTeaserEmbed(
          result.trackName,
          result.artistName,
          result.synced,
          allLines,
          allLines.length,
          pages.length,
        ),
      ];
      components = this.lyricsComponents(id, pages, Boolean(result.syncedLines?.length), 0);
    }
    return { embeds, components };
  }

  /** Start a live "karaoke" view: highlight the current synced line as it plays. */
  private async startLyricsKaraoke(interaction: MessageComponentInteraction): Promise<void> {
    const id = interaction.customId.slice('lyrics_karaoke:'.length);
    const stash = this.lyricPages.get(id);
    const lines = stash?.syncedLines;
    if (!stash || !lines || lines.length === 0) {
      await interaction
        .reply({ content: 'No synced lyrics for this song.', flags: MessageFlags.Ephemeral })
        .catch(() => {});
      return;
    }
    const s = this.sessionFor(interaction.guildId);
    if (!s) return;
    const msgId = interaction.message.id;
    this.registerKaraoke(s, msgId, interaction.guildId!, interaction.channelId, stash.title, stash.artist, lines);
    const st = s.queue.getState();
    const pos = st.positionMs + (st.playing ? Math.max(0, Date.now() - (st.updatedAt || Date.now())) : 0);
    const idx = this.syncedLineIndex(lines, pos);
    await interaction
      .update({ embeds: [this.karaokeEmbed(stash.title, stash.artist, lines, idx, pos)], components: [] })
      .catch(() => {});
  }

  /** Register a message as a live karaoke session (starts the ticker). */
  private registerKaraoke(
    s: Session,
    messageId: string,
    guildId: string,
    channelId: string,
    title: string,
    artist: string,
    lines: SyncedLine[],
  ): void {
    const st = s.queue.getState();
    const pos = st.positionMs + (st.playing ? Math.max(0, Date.now() - (st.updatedAt || Date.now())) : 0);
    if (this.karaokeSessions.size >= DiscordBot.KARAOKE_MAX_SESSIONS) {
      const oldestKey = this.karaokeSessions.keys().next().value;
      if (oldestKey !== undefined) this.karaokeSessions.delete(oldestKey);
    }
    this.karaokeSessions.set(messageId, {
      guildId,
      channelId,
      messageId,
      title,
      artist,
      lines,
      lastIdx: this.syncedLineIndex(lines, pos),
      createdAt: Date.now(),
    });
    this.ensureKaraokeTicker();
  }

  /** Resolve lyrics for a track, jumping straight into karaoke when synced lyrics exist. */
  private async lyricsKaraokePayload(
    s: Session,
    query?: string,
  ): Promise<{ embed: EmbedBuilder; title: string; artist: string; syncedLines: SyncedLine[] } | { error: string }> {
    const track = query ? await this.resolveLyricsQuery(query) : s.queue.getCurrentTrack();
    if (!track) return { error: '🎤 Nothing playing — run a query or queue a track first.' };
    const result = await fetchLyrics(track);
    const lines = result?.syncedLines;
    if (!result || !lines || lines.length === 0) {
      return { error: `🎤 No synced lyrics for **${truncate(track.name, 60)}** — try \`/lyrics\` for plain text.` };
    }
    const st = s.queue.getState();
    const pos = st.positionMs + (st.playing ? Math.max(0, Date.now() - (st.updatedAt || Date.now())) : 0);
    const idx = this.syncedLineIndex(lines, pos);
    return {
      embed: this.karaokeEmbed(result.trackName, result.artistName, lines, idx, pos),
      title: result.trackName,
      artist: result.artistName,
      syncedLines: lines,
    };
  }

  /** Index of the synced line active at `pos` (the last line with time <= pos). */
  private syncedLineIndex(lines: SyncedLine[], pos: number): number {
    let idx = 0;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].timeMs <= pos) idx = i;
      else break;
    }
    return idx;
  }

  /** Render the karaoke window: ~5 lines around the active one, active highlighted. */
  private karaokeEmbed(title: string, artist: string, lines: SyncedLine[], idx: number, pos: number): EmbedBuilder {
    const start = Math.max(0, idx - 2);
    const end = Math.min(lines.length, idx + 3);
    const out: string[] = [];
    for (let i = start; i < end; i++) {
      out.push(i === idx ? `**▶ ${lines[i].text}**` : lines[i].text);
    }
    return new EmbedBuilder()
      .setColor(this.themeColor())
      .setDescription(`🎤 **${title}** — ${artist}\n\n${out.join('\n')}`)
      .setFooter({ text: `Karaoke · ${fmtMs(pos)} — updates as it plays` });
  }

  private ensureKaraokeTicker(): void {
    if (this.karaokeTicker) return;
    this.karaokeTicker = setInterval(() => void this.tickKaraoke(), 1500);
    this.karaokeTicker.unref?.();
  }

  private ensureLyricPagesTicker(): void {
    if (this.lyricPagesTicker) return;
    this.lyricPagesTicker = setInterval(() => void this.pruneLyricPages(), 60000);
    this.lyricPagesTicker.unref?.();
  }

  private pruneLyricPages(): void {
    const now = Date.now();
    let pruned = 0;
    for (const [id, page] of this.lyricPages) {
      if (now - page.createdAt > DiscordBot.LYRIC_PAGES_TTL_MS) {
        this.lyricPages.delete(id);
        pruned++;
      }
    }
    if (pruned) console.log(`[vaporzr] pruned ${pruned} expired lyric page(s)`);
    if (this.lyricPages.size === 0 && this.lyricPagesTicker) {
      clearInterval(this.lyricPagesTicker);
      this.lyricPagesTicker = null;
    }
  }

  private async tickKaraoke(): Promise<void> {
    if (this.karaokeSessions.size === 0) {
      if (this.karaokeTicker) {
        clearInterval(this.karaokeTicker);
        this.karaokeTicker = null;
      }
      return;
    }
    const now = Date.now();
    for (const [messageId, sess] of this.karaokeSessions) {
      // Clean up expired sessions (TTL)
      if (now - sess.createdAt > DiscordBot.KARAOKE_TTL_MS) {
        this.karaokeSessions.delete(messageId);
        continue;
      }
      const s = this.sessionFor(sess.guildId);
      if (!s) {
        this.karaokeSessions.delete(messageId);
        continue;
      }
      const st = s.queue.getState();
      const track = st.track;
      if (!track || !st.playing) continue;
      const pos = st.positionMs + Math.max(0, Date.now() - (st.updatedAt || Date.now()));
      const idx = this.syncedLineIndex(sess.lines, pos);
      if (idx === sess.lastIdx) continue;
      sess.lastIdx = idx;
      try {
        const channel = await this.client.channels.fetch(sess.channelId);
        if (!channel?.isTextBased()) {
          this.karaokeSessions.delete(messageId);
          continue;
        }
        const msg = await channel.messages.fetch(sess.messageId);
        await msg.edit({ embeds: [this.karaokeEmbed(sess.title, sess.artist, sess.lines, idx, pos)] });
      } catch {
        // Message gone (deleted) — drop the session.
        this.karaokeSessions.delete(messageId);
      }
    }
  }

  /** Best-effort resolve of a free-form lyrics query into a track (Spotify search, then YouTube). */
  private async resolveLyricsQuery(query: string): Promise<ResolvedTrack | null> {
    const q = query.trim();
    if (!q) return null;
    try {
      const hits = await resolveTracks(q);
      const first = hits.find((t) => t);
      if (first) return first;
    } catch {
      /* fall through to YouTube search */
    }
    const video = await searchAndResolveYoutube(q).catch(() => null);
    if (!video) return null;
    return {
      uri: video.uri,
      name: video.name,
      artists: video.artists,
      album: video.album,
      durationMs: video.durationMs,
      source: 'youtube',
    };
  }

  /** Render the strip, or null when the payload is byte-identical to the last
   *  one we sent — a paused/idle track used to re-edit the same embed forever. */
  private miniNpRendered(s: Session): {
    embeds: EmbedBuilder[];
    components: ActionRowBuilder<ButtonBuilder>[];
  } | null {
    const payload = this.miniNpMessage(s);
    const sig = JSON.stringify(payload.embeds[0]?.toJSON() ?? {});
    if (this.miniNpSig.get(s.guildId) === sig) return null;
    this.miniNpSig.set(s.guildId, sig);
    return payload;
  }

  /** Compact transport row (⏮ ▶/⏸ ⏭) attached to the mini now-playing strip. */
  private miniControlRow(s: Session): ActionRowBuilder<ButtonBuilder> {
    const playing = s.queue.getState().playing;
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('vz:prev').setEmoji(this.vzE('vz_prev', '⏮')).setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('vz:toggle')
        .setEmoji(this.vzE(playing ? 'vz_pause' : 'vz_play', playing ? '⏸' : '▶'))
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('vz:next').setEmoji(this.vzE('vz_next', '⏭')).setStyle(ButtonStyle.Secondary),
    );
  }

  /** Mini strip payload: the now-playing embed plus its transport controls. */
  private miniNpMessage(s: Session): {
    embeds: EmbedBuilder[];
    components: ActionRowBuilder<ButtonBuilder>[];
  } {
    return { embeds: [this.miniNpPayload(s)], components: [this.miniControlRow(s)] };
  }

  /**
   * Subtle nudge shown on the now-playing strip when a long queue is loaded and
   * autoplay is OFF — the situation where `V@p` appends to the back of a
   * playlist and a newcomer doesn't realise `V@insert` exists. Autoplay already
   * inserts, so the hint is redundant there and stays hidden.
   */
  private static readonly QUEUE_HINT_MIN = 4;
  private queueInsertHint(s: Session): string | null {
    if (EW.modeOf(s.endlessWave) !== 'off') return null;
    const snap = s.queue.getSnapshot();
    const queued = Math.max(0, snap.tracks.length - (snap.currentIndex + 1));
    if (queued < DiscordBot.QUEUE_HINT_MIN) return null;
    return '💡 `V@insert` plays your pick next';
  }

  /** Compact always-on now-playing strip — the panel's small sibling. */
  private miniNpPayload(s: Session): EmbedBuilder {
    const st = s.queue.getState();
    const track = st.track;
    const mode = EW.modeOf(s.endlessWave);
    const modeLabel =
      mode === 'smart' ? '🌊 Autoplay: smart' : mode === 'basic' ? '🎵 Autoplay: basic' : 'Autoplay: off';
    const color = this.panelColor(s.guildId);
    if (!track) {
      return new EmbedBuilder()
        .setColor(color)
        .setDescription('⏸️ **Idle** — queue something with `/play` or `V@p`')
        .setFooter({ text: modeLabel });
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
    const queued = Math.max(0, snap.tracks.length - (snap.currentIndex + 1));
    const hint = this.queueInsertHint(s);
    const embed = new EmbedBuilder()
      .setColor(color)
      .setDescription(
        `${status} ${srcEmoji(track.source)} **${truncate(track.name, 60)}**\n` +
          `${truncate((track.artists ?? []).join(', ') || track.album, 80)}\n` +
          `\`${bar}\` \`${fmtMs(pos)}\`/\`${fmtMs(dur)}\`` +
          (upNext ? `\n⏭ ${truncate(upNext.name, 42)}` : '') +
          (hint ? `\n${hint}` : ''),
      )
      .setFooter({ text: `${modeLabel} · ${queued} queued · ⏮ ⏯ ⏭ or react 🔥❤️⏭` });
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
    const embed = new EmbedBuilder().setColor(this.themeColor()).setTimestamp();
    if (this.client.user) {
      embed.setAuthor({
        name: st.playing ? 'PLAYING NOW' : 'PAUSED',
        iconURL: this.client.user.displayAvatarURL({ extension: 'gif', size: 128 }),
      });
    }
    if (track) {
      const snap = s.queue.getSnapshot();
      const idx = snap.tracks.findIndex((x) => x.current) + 1;
      const upNext = snap.tracks.find((x, i) => i > snap.tracks.findIndex((y) => y.current));
      const hint = this.queueInsertHint(s);
      embed
        .setTitle(`${srcEmoji(track.source)} ${track.name}`)
        .setDescription(
          `${truncate((track.artists ?? []).join(', '), 80)}\n\n\`${bar}\`\n${statusIcon} \`${fmtMs(pos)} / ${fmtMs(dur)}\`` +
            (upNext ? `\n\n⏭️ **Up next:** ${upNext.name}` : '') +
            (hint ? `\n\n${hint}` : ''),
        );
      if (track.image) embed.setThumbnail(track.image);
      embed.addFields([
        { name: '📜 Queue', value: `${snap.tracks.length}${idx ? ` · #${idx} now` : ''}`, inline: true },
      ]);
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
  private static readonly PANEL_ICON_VERSION = 3;

  /**
   * Keep the bot's Discord avatar in sync with the generated brand logo.
   * Discord rate-limits avatar changes hard (2/hour), so only update when the
   * logo bytes actually changed (hash tracked in the data dir).
   */
  private async syncBotAvatar(): Promise<void> {
    try {
      const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
      // Prefer the animated GIF so the avatar animates in Discord embeds (the
      // VC-chat now-playing post uses displayAvatarURL({ extension: 'gif', size: 128 }) as the author icon).
      const logo = await fs.readFile(path.join(dir, 'avatar.gif')).catch(() => fs.readFile(path.join(dir, 'logo.png')));
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
      .setAuthor({ name: 'NOW PLAYING', iconURL: this.client.user?.displayAvatarURL({ extension: 'gif', size: 128 }) })
      .setTitle(`${srcEmoji(t.source)} ${t.name}`)
      .setDescription(`${truncate((t.artists ?? []).join(', '), 80)}\n\n\`${bar}\`\n▶️ \`0:00 / ${fmtMs(dur)}\``)
      .setFooter({ text: action });
    if (t.image) embed.setThumbnail(t.image);
    return embed;
  }

  /** Short-lived command confirmation — delete it after a few seconds so rapid
   *  commands don't leave a wall of one-line replies in the channel. */
  private autoExpire(msg: { delete(): Promise<unknown> }, ms = 6000): void {
    setTimeout(() => {
      msg.delete().catch(() => {});
    }, ms);
  }

  /** Transient notice (an expired-button reply, a "posted right here"
   *  confirmation): remove it after a minute. These are informational only —
   *  leaving them in chat collects one-line bot replies that no longer mean
   *  anything once the moment has passed. */
  private autoExpireNotice(msg: { delete(): Promise<unknown> }): void {
    this.autoExpire(msg, 60_000);
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

    const embed = new EmbedBuilder().setColor(this.panelColor(s.guildId)).setTimestamp();
    if (this.client.user) {
      embed.setAuthor({ name: 'VAPORZR', iconURL: this.client.user.displayAvatarURL({ extension: 'gif', size: 128 }) });
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
      {
        name: 'Controls',
        value:
          '⏮ prev · ▶ play · ⏭ next · 🔁 repeat · 🔀 shuffle · ⏪/⏩ seek · 🔉/🔊 vol · 🎛 dj · 📝 lyrics · ⏹ stop · 📤 leave',
        inline: false,
      },
    ]);
    embed.setFooter({ text: `${this.client.user?.username ?? 'Vaporzr'} · this panel updates itself` });

    const rows: ActionRowBuilder<ButtonBuilder>[] = [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('vz:prev').setEmoji(this.vzE('vz_prev', '⏮')).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('vz:toggle')
          .setEmoji(this.vzE(st.playing ? 'vz_pause' : 'vz_play', st.playing ? '⏸' : '▶'))
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('vz:next').setEmoji(this.vzE('vz_next', '⏭')).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('vz:repeat')
          .setEmoji(this.vzE('vz_repeat', '🔁'))
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('vz:shuffle')
          .setEmoji(this.vzE('vz_shuffle', '🔀'))
          .setStyle(ButtonStyle.Secondary),
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId('vz:back10')
          .setLabel('10s')
          .setEmoji(this.vzE('vz_back10', '⏪'))
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('vz:fwd10')
          .setLabel('10s')
          .setEmoji(this.vzE('vz_fwd10', '⏩'))
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('vz:vol-down')
          .setEmoji(this.vzE('vz_voldown', '🔉'))
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('vz:vol-up')
          .setEmoji(this.vzE('vz_volup', '🔊'))
          .setStyle(ButtonStyle.Secondary),
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId('vz:dj')
          .setLabel('DJ')
          .setEmoji(this.vzE('vz_dj', '🎛️'))
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('vz:lyrics')
          .setEmoji(this.vzE('vz_lyrics', '📝'))
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('vz:stop').setEmoji(this.vzE('vz_stop', '⏹')).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('vz:leave')
          .setEmoji(this.vzE('vz_eject', '📤'))
          .setStyle(ButtonStyle.Secondary),
      ),
    ];
    const djRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('vz:sfx:airhorn').setLabel('📣').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('vz:sfx:drop').setLabel('💥').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('vz:sfx:riser').setLabel('📈').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('vz:sfx:reverse').setLabel('↩️').setStyle(ButtonStyle.Secondary),
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

  /** Autocomplete for dynamic options (playlist names, sfx ids, perms commands, queue index). */
  private async handleAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
    const cmd = interaction.commandName;
    const focused = interaction.options.getFocused(true);
    const q = String(focused.value ?? '').toLowerCase();
    const guildId = interaction.guildId ?? '';
    let choices: Array<{ name: string; value: string | number }> = [];
    try {
      if (cmd === 'playlist' && focused.name === 'name') {
        choices = this.playlists.list(guildId).map((p) => ({ name: `${p.name} · ${p.tracks.length}`, value: p.name }));
      } else if (cmd === 'sfx' && focused.name === 'sound') {
        choices = this.sessionFor(guildId)
          .playback.listSoundEffects()
          .map((snd) => ({ name: `${snd.emoji ?? '🔊'} ${snd.id}`, value: snd.id }));
      } else if (cmd === 'perms' && focused.name === 'command') {
        choices = COMMANDS.map((c) => ({ name: c.name, value: c.name }));
      } else if (cmd === 'remove' && focused.name === 'index') {
        const snap = this.sessionFor(guildId).queue.getSnapshot();
        choices = snap.tracks.slice(0, 25).map((t, i) => ({ name: `${i + 1}. ${truncate(t.name, 60)}`, value: i + 1 }));
      }
    } catch {
      /* fall through to empty */
    }
    const filtered = choices
      .filter((c) => !q || String(c.value).toLowerCase().includes(q) || c.name.toLowerCase().includes(q))
      .slice(0, 25);
    await interaction.respond(filtered).catch(() => {});
  }

  /** React on the now-playing strip: 🔥 boost · ❤️ save · ⏭️ skip · 🎛️ soundboard. */
  private async handleReaction(reaction: MessageReaction, user: User): Promise<void> {
    if (user.bot) return;
    const guildId = reaction.message.guildId;
    if (!guildId) return;
    const mini = this.miniNp.get(guildId);
    if (!mini || reaction.message.id !== mini.messageId) return;
    const s = this.sessionFor(guildId);
    const name = reaction.emoji.name ?? '';
    try {
      if (name === '🔥') {
        s.playback.volume(100);
      } else if (name === '❤️') {
        const cur = s.queue.getCurrentTrack();
        if (cur) {
          this.playlists.appendTrack(guildId, '❤️ Favorites', {
            uri: cur.uri,
            name: cur.name,
            artists: cur.artists,
            album: cur.album,
            durationMs: cur.durationMs,
            source: cur.source ?? 'spotify',
            image: cur.image,
          });
        }
      } else if (name === '⏭️' || name === '⏭') {
        const guild = reaction.message.guild;
        const member = guild ? await guild.members.fetch(user.id).catch(() => null) : null;
        if (this.isDjMember(guild, member)) s.playback.next();
        else if (this.requestSkip(s, user.id).result === 'skipped') s.playback.next();
      } else if (name === '🎛️' || name === '🎛') {
        s.playback.setDjEnabled(guildId, !s.playback.isDjEnabled(guildId));
        void this.maybeAutoMiniNp(guildId, s.queue.getState());
      }
    } catch (err) {
      console.warn(`[discord] reaction ${name} failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Add the reaction-control row to a freshly-posted now-playing strip. */
  private async seedNpReactions(msg: Message): Promise<void> {
    for (const e of ['🔥', '❤️', '⏭️', '🎛️']) {
      try {
        await msg.react(e);
      } catch {
        /* missing Add Reactions perm / rate limited */
      }
    }
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
      lyrics: 'lyrics',
      stop: 'clear',
      leave: 'leave',
    };
    const req = permissionCommand[action];
    const requiresSfx = action.startsWith('sfx:');
    if ((req || requiresSfx) && !this.canUse(requiresSfx ? 'sfx' : req, interaction)) {
      await interaction.reply({ content: "⛔ You don't have permission to do that.", flags: MessageFlags.Ephemeral });
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
      case 'lyrics': {
        const payload = await this.lyricsPayload(s);
        if ('error' in payload)
          void interaction.followUp({ content: payload.error, flags: MessageFlags.Ephemeral }).catch(() => {});
        else
          void interaction
            .followUp({ embeds: payload.embeds, components: payload.components, flags: MessageFlags.Ephemeral })
            .catch(() => {});
        break;
      }
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
          .followUp({
            content: st.repeat ? '🔁 Repeat off' : '🔁 Repeat on — track replays at its end',
            flags: MessageFlags.Ephemeral,
          })
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
        this.clearVoiceStatus(s);
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
          void interaction
            .followUp({ content: `🔊 ${sfx ? `${sfx.emoji} ${sfx.name}` : id}`, flags: MessageFlags.Ephemeral })
            .catch(() => {});
        }
        break;
    }

    if (interaction.guildId) {
      const panel = this.panels.get(interaction.guildId);
      if (panel) await this.editPanel(panel.channelId, panel.messageId, interaction.guildId);
    }
  }

  // ---- Themes, windows, visuals ----

  /** Embed color for a guild: the mood tone when mood visuals are on, otherwise
   *  the static theme. One place so the panel, now-playing strip and any other
   *  "unicolor" surface stay in step as the mood changes each track. */
  private panelColor(guildId: string | undefined): number {
    const id = guildId ?? '';
    return this.moodOn.has(id) && this.moodColor.has(id) ? this.moodColor.get(id)! : this.themeColor();
  }

  private themeColor(): number {
    return this.bridge.getTheme().embedColor;
  }

  /**
   * Help pages use a darker cut of the active theme's accent: same identity,
   * quieter sidebar. The bot reads as a dark room with one teal signal, and a
   * full-saturation stripe under every category clashes with that.
   */
  private helpColor(): number {
    const c = this.themeColor();
    const cut = (v: number): number => Math.max(22, Math.round(v * 0.52));
    return (cut((c >> 16) & 0xff) << 16) | (cut((c >> 8) & 0xff) << 8) | cut(c & 0xff);
  }

  private static readonly QUEUE_PAGE = 15;

  /** Build the queue embed for one 15-song page plus a jump-to dropdown for
   *  the rest — a single message even for 200-track playlists, instead of a
   *  wall of follow-up chunks. */
  private queuePage(
    s: Session,
    start?: number,
  ): {
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
      // Always show the absolute 1-based number (matching V@rem / V@skipto) so
      // the row you point at is never ambiguous.
      const cur = i === snap.currentIndex ? '▶ ' : '';
      lines.push(`${cur}${i + 1}. ${srcEmoji(t.source)} **${t.name}** — ${truncate(t.artists.join(', '), 80)}`);
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
    // Optional skip-to picker (jump ahead, dropping the skipped tracks) when a
    // mod has enabled it for this guild.
    if (this.perms.getSkipForward(s.guildId)) {
      const upcoming = tracks
        .map((t, i) => ({ t, i }))
        .filter(({ i }) => i > snap.currentIndex)
        .slice(0, 25);
      if (upcoming.length > 0) {
        const token = randomBytes(6).toString('hex');
        this.pendingSkipTo.set(token, { guildId: s.guildId, createdAt: Date.now() });
        const menu = new StringSelectMenuBuilder()
          .setCustomId(`skipto:${token}`)
          .setPlaceholder('⏭ Skip to a future track…')
          .addOptions(
            upcoming.map(({ t, i }) => ({
              label: truncate(t.name || 'Untitled', 90),
              description: truncate((t.artists ?? []).join(', ') || `#${i}`, 90),
              value: String(i),
            })),
          );
        components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu));
      }
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

  /** Post the jam invite card (link + QR) so guests can join from their phones.
   *  Used by `/jam`, `V@jam`, and the web panel's Share button (bridge hook).
   *  A null `channel` means "find one" — the panel has no channel of its own. */
  private async shareJamCard(
    guildId: string,
    channel: GuildTextBasedChannel | null,
  ): Promise<{ ok: boolean; where?: string; error?: string; pinRow?: ActionRowBuilder<ButtonBuilder> }> {
    const { joinUrl } = jamJoinLinks();
    if (!joinUrl) {
      return {
        ok: false,
        error:
          "⚠️ Sharing needs `JAM_PUBLIC_BASE` set to this bot's public URL (e.g. https://vaporzr.duckdns.org) — then restart.",
      };
    }
    const target = channel ?? (await this.panelShareChannel(guildId));
    if (!target) {
      return {
        ok: false,
        error: '📭 No channel to post in yet — run `/panel` here first, or use `/jam` in a text channel.',
      };
    }
    let card: Awaited<ReturnType<typeof buildJamInviteCard>>;
    try {
      card = await buildJamInviteCard(this.jamInviteInfo(guildId, joinUrl));
    } catch (err) {
      return { ok: false, error: `Could not build the jam card: ${err instanceof Error ? err.message : String(err)}` };
    }
    try {
      const sent = await target.send({ embeds: card.embeds, files: card.files, components: card.components });
      return {
        ok: true,
        where: `#${target.name}`,
        pinRow: new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`jampin:${sent.channelId}:${sent.id}`)
            .setLabel('📌 Pin it')
            .setStyle(ButtonStyle.Secondary),
        ),
      };
    } catch (err) {
      return { ok: false, error: `Discord refused the post: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /** The live numbers on the jam card. Room count = humans in the bot's voice
   *  channel (bots excluded, so it reads as listeners). */
  private jamInviteInfo(guildId: string, joinUrl: string): JamInviteInfo {
    const s = this.sessionFor(guildId);
    const state = s.queue.getState();
    const snap = s.queue.getSnapshot();
    const vc = this.client.guilds.cache.get(guildId)?.members.me?.voice?.channel;
    const inRoom = vc ? vc.members.filter((m) => !m.user.bot).size : undefined;
    const current = state.track;
    return {
      joinUrl,
      inRoom,
      now: current ? { name: current.name, artists: current.artists ?? [] } : null,
      upNext: Math.max(0, snap.tracks.length - (snap.currentIndex + 1)),
      color: this.themeColor(),
    };
  }

  /** Where a channel-less share lands: the panel's channel first (the Share
   *  button lives there), else the last text channel the bot heard from, else
   *  the welcome channel (system channel or first writable). */
  private async panelShareChannel(guildId: string): Promise<GuildTextBasedChannel | null> {
    const fetchWritable = async (id: string | undefined): Promise<GuildTextBasedChannel | null> => {
      if (!id) return null;
      const ch = await this.client.channels.fetch(id).catch(() => null);
      return ch && ch.isTextBased() && !ch.isDMBased() ? (ch as GuildTextBasedChannel) : null;
    };
    const fromPanel = await fetchWritable(this.panels.get(guildId)?.channelId);
    if (fromPanel) return fromPanel;
    const fromLast = await fetchWritable(this.lastTextChannel.get(guildId));
    if (fromLast) return fromLast;
    const guild = this.client.guilds.cache.get(guildId);
    return guild ? this.welcomeChannel(guild) : null;
  }

  /** 📌 Toggle the pin on a posted jam card. customId holds
   *  `jampin:<channelId>:<messageId>` so it survives restarts. */
  private async handleJamPin(interaction: ButtonInteraction): Promise<void> {
    const [, channelId, messageId] = interaction.customId.split(':');
    const build = (pinned: boolean): ActionRowBuilder<ButtonBuilder> =>
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(interaction.customId)
          .setLabel(pinned ? '📍 Unpin' : '📌 Pin it')
          .setStyle(ButtonStyle.Secondary),
      );
    const ch = await this.client.channels.fetch(channelId).catch(() => null);
    if (!ch || !ch.isTextBased() || ch.isDMBased()) {
      return void (await interaction.reply({ content: 'That channel is gone.', flags: MessageFlags.Ephemeral }));
    }
    const msg = await (ch as GuildTextBasedChannel).messages.fetch(messageId).catch(() => null);
    if (!msg) {
      return void (await interaction.reply({
        content: 'That card was deleted — run `/jam` again to post a fresh one.',
        flags: MessageFlags.Ephemeral,
      }));
    }
    try {
      if (msg.pinned) {
        await msg.unpin();
        await interaction.update({
          content: '📍 Unpinned — the jam card can scroll away.',
          components: [build(false)],
        });
      } else {
        await msg.pin();
        await interaction.update({
          content: '📌 Pinned — the jam card stays at the top of the channel.',
          components: [build(true)],
        });
      }
    } catch {
      await interaction.update({
        content: '⚠️ I need **Manage Messages** in that channel to pin — a mod can also pin it manually.',
        components: [build(msg.pinned)],
      });
    }
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
        text: link.secure
          ? 'HTTPS keeps links trusted · works great on phones'
          : 'Secure link reconnects automatically',
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

  /** One-shot health/diagnostic snapshot for `/diag` and `V@diag`. */
  private diagEmbed(guildId: string | null): EmbedBuilder {
    let dave = 'unknown';
    try {
      const line = generateDependencyReport()
        .split('\n')
        .find((l) => l.includes('@snazzah/davey'));
      dave = line && !/not found/i.test(line) ? line.split(':').slice(1).join(':').trim() : 'missing';
    } catch {
      dave = 'unknown';
    }

    const sessions = this.sessions.all();
    const s = guildId ? this.sessions.get(guildId) : this.sessions.primary;
    // "Connected" means Ready — a Disconnected/Connecting link still passes
    // isJoined() but can't carry audio; hiding that made voice bugs read as
    // "connected" in /diag.
    const ready = !!s?.voice.isConnectionReady();
    const chanId = ready ? s?.voice.getChannelId() : null;
    const linkNote = s && !ready && s.voice.isJoined() ? ` (link \`${s.voice.connectionStatus()}\`)` : '';
    const voiceLine = ready ? `connected${chanId ? ` · <#${chanId}>` : ''}` : `not connected${linkNote}`;
    const dev = this.bridge.librespot.getDeviceInfo();
    const up = process.uptime();
    const uptime = `${Math.floor(up / 3600)}h ${Math.floor((up % 3600) / 60)}m`;
    const st = s?.queue.getState();
    let cookieAge: number | null = null;
    try {
      cookieAge = Math.round((Date.now() - statSync(config.youtubeCookiesPath).mtimeMs) / 86_400_000);
    } catch {
      cookieAge = null;
    }
    const yt = youtubeHealth().status;

    return new EmbedBuilder()
      .setTitle('🩺 Diagnostics')
      .setColor(this.themeColor())
      .addFields(
        { name: 'Gateway', value: `ping \`${Math.round(this.client.ws.ping)} ms\` · up \`${uptime}\``, inline: true },
        {
          name: 'Token',
          value: `${this.client.guilds.cache.size} guild(s) · ${sessions.length} session(s)`,
          inline: true,
        },
        { name: 'Voice', value: `DAVE \`${dave}\`\n${voiceLine}`, inline: true },
        {
          name: 'librespot',
          value: dev.enabled
            ? `${dev.running ? '`running`' : '`stopped`'}` +
              `${dev.registered === undefined ? '' : dev.registered ? ' · `device ok`' : ' · `device LOST`'}` +
              ` · ${dev.name} · ${dev.running ? `${Math.round(dev.uptimeMs / 60000)}m` : `${dev.bitrate}kbps`}` +
              `${dev.restarts ? ` · ${dev.restarts} restart${dev.restarts === 1 ? '' : 's'}` : ''}`
            : '`disabled`',
          inline: true,
        },
        {
          name: 'YouTube',
          value:
            `canary \`${yt}\` · cookies ${cookieAge === null ? '`missing`' : `\`${cookieAge}d\``}` +
            ` · route \`${['direct', config.youtubeProxy ? 'primary' : '', config.youtubeProxyAlt ? 'alt' : '', config.youtubeProxyFallback ? 'fallback' : ''].filter(Boolean).join('→')}\``,
          inline: true,
        },
        {
          name: 'Playback',
          value: `path \`${config.spotifyPreferYoutube ? 'youtube' : 'librespot'}\` · search \`${
            config.spotifyAnonSearch ? 'anon' : 'oauth'
          }\` · autoplay \`${s ? EW.modeOf(s.endlessWave) : 'n/a'}\``,
          inline: true,
        },
        { name: 'Web Push', value: `${pushSubscriptionCount()} subscriber(s)`, inline: true },
        {
          name: 'Opus',
          value: this.opusLine(s),
          inline: true,
        },
        {
          name: 'Audio',
          value: st?.track ? `${st.playing ? '▶️' : '⏸️'} ${st.track.name}`.slice(0, 100) : '`idle`',
          inline: false,
        },
      )
      .setFooter({
        text: 'Two instances sharing one token fight over the gateway session — run only one.',
      });
  }

  /**
   * One line describing the voice encoder for /diag: which Opus implementation
   * is in use, at what bitrate, and the channel cap it was negotiated against.
   * Worth surfacing because the difference between the native module and the
   * opusscript fallback is audible, and neither is visible in the logs otherwise.
   */
  private opusLine(s: Session | null | undefined): string {
    const plan = opusPlan();
    const status = s?.voice.opusStatus();
    const channel = status?.channel ? ` · ch \`${Math.round(status.channel / 1000)}k\`` : '';
    const meter = opusTelemetry();
    const live =
      meter.frames === 0 ? '' : meter.kbps === null ? ' · `live…`' : ` · \`${Math.round(meter.kbps)}k live\``;
    if (plan) {
      return `\`@discordjs/opus\` · \`${Math.round(plan.bitrate / 1000)}k\`${plan.fec ? ' · fec' : ''}${channel}${live}`;
    }
    if (config.voiceOpusEncoder === 'off') return '`off` (wanted: raw PCM path)';
    return `\`missing\` → \`${fallbackOpusModule()}\`${meter.frames > 0 ? ' · raw-PCM path' : ''}`;
  }

  /** Human-readable autoplay status block shared by `/autoplay`, `/endwav`, `V@autoplay`, `V@ew`. */
  private autoplayStatus(s: Session, head?: string): string {
    const snap = EW.snapshot(s.endlessWave);
    const label = snap.mode === 'smart' ? 'SMART 🌊 (Endless Wave)' : snap.mode === 'basic' ? 'BASIC 🎵' : 'OFF ⏹️';
    const lines: string[] = [];
    if (head) lines.push(head);
    lines.push(`🎛️ Autoplay: **${label}**`);
    if (snap.mode === 'off') {
      lines.push('The queue will stop when it ends.');
    } else {
      const ahead = this.ewAheadOverride.get(s.guildId ?? '') ?? (snap.mode === 'smart' ? 3 : 1);
      lines.push(`• generated this session: ${snap.generated}`);
      lines.push(`• lookahead: ${ahead} track${ahead === 1 ? '' : 's'}`);
      if (snap.mode === 'smart') {
        lines.push(`• unique artists: ${snap.artistCount} · run streak ${snap.runStreak} (best ${snap.longestRun})`);
        lines.push(`• steering: ${EW.describeCalibration(s.endlessWave)}`);
        if (snap.deadEnds) lines.push(`• dead-ends: ${snap.deadEnds}`);
      }
    }
    lines.push('Change with `V@autoplay off|basic|smart` · `V@autoplay count 5` · `/autoplay`.');
    return lines.join('\n');
  }

  /** Enqueue tracks and kick playback, applying the mini-NP dedupe. Shared by
   *  the search picker and playlist loader. Returns an error string if playback
   *  couldn't start (tracks are still queued). */
  private async playTracks(
    s: Session,
    tracks: ResolvedTrack[],
    requestedBy: string,
    ensureJoined: () => Promise<boolean>,
    mode: 'queue' | 'insert' = 'queue',
  ): Promise<string | null> {
    const first = tracks[0];
    const wasPlaying = s.queue.getState().playing;
    const suppressStrip = !wasPlaying && !!first;
    if (suppressStrip) this.suppressAutoMiniNp(s.guildId, first.uri);
    if (mode === 'insert') s.queue.insertAfterCurrent(tracks, requestedBy);
    else s.queue.enqueueMany(tracks, requestedBy);
    this.stats.noteQueued(
      s.guildId ?? '',
      requestedBy,
      tracks.flatMap((t) => t.artists),
    );
    if (first) s.playback.prefetchStream(first);
    let playbackFailed: string | null = null;
    try {
      await ensureJoined();
      if (!s.queue.getState().playing) await s.playback.play();
    } catch (err) {
      playbackFailed = err instanceof Error ? err.message : String(err);
      console.warn(`[discord] queued but couldn't start playback: ${playbackFailed}`);
    }
    const st = s.queue.getState();
    const startedFresh = !wasPlaying && st.playing && !!first && st.track?.uri === first.uri;
    if (suppressStrip && !startedFresh) this.miniNpSuppress.delete(s.guildId);
    return playbackFailed;
  }

  /** Interactive picker for a free-text search (top matches as a dropdown). */
  /**
   * Post a quick acknowledgement to a prefix command, run `work`, then remove
   * the ack (or turn it into an error). Keeps slow resolves — search, yt-dlp,
   * voice join — from looking like the bot ignored the command.
   */
  private async withAck(message: Message, label: string, work: () => Promise<void>): Promise<void> {
    const ack = await message.reply(label).catch(() => null);
    try {
      await work();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[discord] "${label}" failed: ${msg}`);
      // Node surfaces a failed multi-address connect as `AggregateError:
      // "Received one or more errors"` — a transient network blip, not a bad
      // link. Give the user something actionable instead of the raw text.
      const friendly = /Received one or more errors|fetch failed|ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN/i.test(msg)
        ? 'Network hiccup reaching Discord/YouTube — give it another try.'
        : msg;
      const text = `❌ ${friendly}`;
      if (ack) await ack.edit(text).catch(() => {});
      else await message.reply(text).catch(() => {});
      return;
    }
    if (ack) await ack.delete().catch(() => {});
  }

  /** When autoplay/Endless Wave is on, user picks should jump ahead of the
   *  autoplay fills (insert right after the current track) instead of landing
   *  behind them. With autoplay off, normal append behaviour is kept. */
  private userQueueMode(s: Session): 'queue' | 'insert' {
    return EW.isAutoActive(s.endlessWave) ? 'insert' : 'queue';
  }

  private async presentSearch(target: Message | ChatInputCommandInteraction, query: string): Promise<void> {
    let candidates: ResolvedTrack[] = [];
    const isMsg = 'author' in target;
    // Spotify search first (best metadata); on ANY failure (no account, quota,
    // etc.) fall through to YouTube so plain `V@p <text>` always works.
    try {
      candidates = await searchCandidates(query, 5);
    } catch {
      candidates = [];
    }
    if (candidates.length === 0) {
      try {
        candidates = await searchYoutube(query, 5);
      } catch {
        /* ignore — reported below */
      }
    }
    if (candidates.length === 0) {
      const msg = `🔍 No results for \`${truncate(query, 60)}\` on Spotify or YouTube. Try a link (YouTube, SoundCloud, Bandcamp, Apple, Suno…) or \`/yt\`.`;
      if (isMsg) await (target as Message).reply(msg);
      else await (target as ChatInputCommandInteraction).editReply(msg);
      return;
    }
    // Play the best match immediately so a plain `V@p <text>` just works; the
    // dropdown below is an "alternatives" picker in case the guess was wrong.
    const best = candidates[0];
    const s = this.sessionFor(target.guildId);
    const insert = this.userQueueMode(s) === 'insert';
    if (isMsg) {
      if (insert) await this.insertToQueueMsg(target as Message, [best]);
      else await this.addToQueueMsg(target as Message, [best]);
    } else {
      if (insert) await this.insertToQueue(target as ChatInputCommandInteraction, [best]);
      else await this.addToQueue(target as ChatInputCommandInteraction, [best]);
    }
    if (candidates.length === 1) return;

    const token = randomBytes(6).toString('hex');
    const userId = isMsg ? (target as Message).author.id : (target as ChatInputCommandInteraction).user.id;
    this.pendingSearch.set(token, { guildId: target.guildId ?? '', userId, candidates, query, createdAt: Date.now() });
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`vzsearch:${token}`)
      .setPlaceholder('Pick a track to play…')
      .addOptions(
        candidates.map((c, i) =>
          new StringSelectMenuOptionBuilder()
            .setLabel(truncate(c.name || 'Unknown', 100))
            .setDescription(truncate(`${(c.artists ?? []).join(', ') || c.album} · ${fmtMs(c.durationMs)}`, 100))
            .setValue(String(i)),
        ),
      );
    const embed = new EmbedBuilder()
      .setTitle('🔍 Search results')
      .setDescription(`Playing **${truncate(best.name, 60)}** — pick another below if that's wrong.`)
      .setColor(this.themeColor());
    const payload = {
      embeds: [embed],
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
    };
    let sent: Message | undefined;
    if (isMsg) {
      sent = await (target as Message).reply(payload);
    } else {
      await (target as ChatInputCommandInteraction).followUp(payload);
      sent = (await (target as ChatInputCommandInteraction).fetchReply()) as Message;
    }
    const t = setTimeout(() => void this.expireSearch(token, sent), 90_000);
    t.unref?.();
  }

  private async expireSearch(token: string, sent?: Message): Promise<void> {
    if (!this.pendingSearch.has(token)) return;
    this.pendingSearch.delete(token);
    try {
      if (sent) {
        await sent.edit({ content: '⌛ Search expired — run the command again.', embeds: [], components: [] });
        this.autoExpireNotice(sent);
      }
    } catch {
      /* gone */
    }
  }

  private async handleSkipToPick(interaction: StringSelectMenuInteraction): Promise<void> {
    const token = interaction.customId.slice('skipto:'.length);
    this.pendingSkipTo.delete(token);
    const s = this.sessionFor(interaction.guildId);
    const idx = parseInt(interaction.values[0] ?? '-1', 10);
    const removed = s.queue.removeUpTo(idx);
    await interaction
      .update({
        content: `⏭ Jumping ahead — skipped ${removed} track${removed === 1 ? '' : 's'}.`,
        embeds: [],
        components: [],
      })
      .catch(() => {});
    s.playback.next();
  }

  /** Show a picker of upcoming tracks; choosing one jumps to it, dropping the rest. */
  /**
   * Core of a smart reorder, shared by the text command and the slash command.
   * Returns the reply embed, or a `skipReason` when there is nothing to reorder.
   */
  private async smartShuffleCore(
    s: Session,
    mode: ShuffleMode,
    wasShuffle: boolean,
  ): Promise<{ embed?: EmbedBuilder; skipReason?: string }> {
    const snap = s.queue.getSnapshot();
    const upcoming = snap.tracks.slice(snap.currentIndex + 1);
    if (upcoming.length < 3) {
      // Tell the truth about WHY rather than a generic "not enough": a finished
      // queue (index parked on the last track) is the common cause, and saying
      // "3 ahead" to someone with a 42-track queue loaded reads like a bug.
      const total = snap.tracks.length;
      const at = snap.currentIndex;
      const why =
        total > 3
          ? `the queue is nearly finished — ${total - at - 1} of ${total} still ahead (the cursor is at the end)`
          : `only ${total} track${total === 1 ? '' : 's'} in the queue`;
      return { skipReason: `🔀 Nothing to reorder — ${why}. Queue a few more, or \`V@qa\` to check.` };
    }
    // Sonic flow: order the queue by cosine.club audio similarity to what's
    // playing. Cosine-only, so it says so plainly when the current track isn't
    // in its (electronic/underground) catalogue.
    if (mode === 'sonic') {
      const curSonic = s.queue.getCurrentTrack();
      let scores = new Map<string, number>();
      if (curSonic && cosineEnabled()) {
        try {
          scores = await cosineSimilarScores(
            { name: curSonic.name, artists: curSonic.artists, uri: curSonic.uri },
            100,
          );
        } catch {
          /* best-effort */
        }
      }
      if (scores.size === 0) {
        return {
          skipReason:
            '🔀 Sonic flow needs cosine.club and a current track it knows — it only covers electronic/underground music. Try `flow` instead.',
        };
      }
      const norm = (x: string): string =>
        x
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, ' ')
          .trim();
      const scoreOf = (t: TrackInfo): number | undefined => {
        const n = norm(t.name);
        if (n.length < 3) return undefined;
        let best: number | undefined;
        for (const [k, sc] of scores) {
          if (k.includes(n) || n.includes(k)) {
            if (best === undefined || sc > best) best = sc;
          }
        }
        return best;
      };
      const { ordered, withoutFeatures } = orderBySonic(upcoming, scoreOf);
      const moved = s.queue.reorderUpcoming(ordered.map((t) => t.uri));
      const embed = new EmbedBuilder()
        .setTitle(`🔀 Smart shuffle — ${SHUFFLE_MODE_LABEL[mode]}`)
        .setDescription(
          ordered
            .slice(0, 12)
            .map((t, i) => `${i + 1}. ${srcEmoji(t.source)} ${truncate(t.name, 52)}`)
            .join('\n') +
            (ordered.length > 12 ? `\n… +${ordered.length - 12} more` : '') +
            (withoutFeatures ? `\n-# ${withoutFeatures} with no cosine match kept at the end` : '') +
            (moved === 0 ? '\n-# already in the best order' : '') +
            (wasShuffle ? '\n-# random shuffle was on — turned off so this order holds' : ''),
        )
        .setColor(this.themeColor());
      return { embed };
    }
    // One batched features call for every Spotify id we can map.
    const ids: string[] = [];
    for (const t of upcoming) {
      const id = extractSpotifyId(t.uri);
      if (id) ids.push(id);
    }
    const cur = s.queue.getCurrentTrack();
    const anchorId = cur ? extractSpotifyId(cur.uri) : null;
    if (anchorId) ids.push(anchorId);
    let features = new Map<string, AudioFeatures>();
    try {
      features = await getAudioFeatures(ids);
    } catch {
      /* fall back to whatever estimates the queue already carries */
    }
    const featOf = (t: TrackInfo): Partial<AudioFeatures> | null => {
      const id = extractSpotifyId(t.uri);
      const fromApi = id ? features.get(id) : undefined;
      if (fromApi) return fromApi;
      // Measured from the track's own audio when the mirror does not know it
      // (see audioFeatures.ts). Partial: only the fields we actually measured.
      // The queue copy is live-only; the store keeps measurements across
      // restarts so key/arc shuffle does not forget them.
      return (t as { estimatedFeatures?: Partial<AudioFeatures> }).estimatedFeatures ?? getMeasuredFeatures(t.uri);
    };
    const anchor = anchorId ? (features.get(anchorId) ?? null) : null;
    // Pass the artist so a track the mirror does not know can be ranked by the
    // average vibe of that artist's other tracks in the queue, instead of being
    // left unranked — which is why smart shuffle only ever moved part of a queue.
    const { ordered, withoutFeatures } = orderByVibe(upcoming, anchor, mode, featOf, (t) => (t.artists ?? [])[0] ?? '');
    // Ranking needs at least two tracks with real features. When nothing has
    // any, the old code fell through to "already in the best order" over an
    // unchanged queue — a no-op that looked like success. Say what happened.
    const rankable = upcoming.length - withoutFeatures;
    console.log(
      `[shuffle] mode=${mode} upcoming=${upcoming.length} rankable=${rankable} withoutFeatures=${withoutFeatures}`,
    );
    if (rankable < 2) {
      return {
        skipReason:
          `🔀 Can't rank these — only ${rankable} of ${upcoming.length} tracks have audio features ` +
          '(they build up as tracks play, or come from the Spotify mirror). `V@shuffle` still shuffles randomly.',
      };
    }
    const moved = s.queue.reorderUpcoming(ordered.map((t) => t.uri));
    console.log(`[shuffle] ${SHUFFLE_MODE_LABEL[mode]}: reordered ${moved}/${ordered.length}`);
    const embed = new EmbedBuilder()
      .setTitle(`🔀 Smart shuffle — ${SHUFFLE_MODE_LABEL[mode]}`)
      .setDescription(
        ordered
          .slice(0, 12)
          .map((t, i) => `${i + 1}. ${srcEmoji(t.source)} ${truncate(t.name, 52)}`)
          .join('\n') +
          (ordered.length > 12 ? `\n… +${ordered.length - 12} more` : '') +
          (withoutFeatures ? `\n-# ${withoutFeatures} without audio features kept in place` : '') +
          (moved === 0 ? '\n-# already in the best order' : '') +
          (wasShuffle ? '\n-# random shuffle was on — turned off so this order holds' : ''),
      )
      .setColor(this.themeColor());
    return { embed };
  }

  /** Reorder the upcoming queue by musical flow / set curve / harmonic key. */
  private async smartShuffleMsg(message: Message, s: Session, mode: ShuffleMode, wasShuffle = false): Promise<void> {
    const snap = s.queue.getSnapshot();
    const upcoming = snap.tracks.slice(snap.currentIndex + 1);
    if (upcoming.length < 3) {
      const { skipReason } = await this.smartShuffleCore(s, mode, wasShuffle);
      await message.reply(skipReason!);
      return;
    }
    await this.withAck(message, `🔀 Ordering ${upcoming.length} tracks by ${SHUFFLE_MODE_LABEL[mode]}…`, async () => {
      const { embed, skipReason } = await this.smartShuffleCore(s, mode, wasShuffle);
      await message.reply(skipReason ? skipReason : { embeds: [embed!] });
    });
  }

  /** Interactive queue editor: pick a track, then move / remove / play it now —
   *  no need to work out which queue number is which. */
  private qaView(
    s: Session,
    opts: { selected?: number; note?: string } = {},
  ): { embeds: EmbedBuilder[]; components: ActionRowBuilder<MessageActionRowComponentBuilder>[] } {
    const snap = s.queue.getSnapshot();
    const components: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [];
    const title = '🎛️ Queue adjust';
    const total = Math.max(0, snap.tracks.length - snap.currentIndex - 1);
    const upcoming = snap.tracks
      .map((t, i) => ({ t, i }))
      .filter(({ i }) => i > snap.currentIndex)
      .slice(0, 25);
    if (upcoming.length === 0) {
      return {
        embeds: [
          new EmbedBuilder()
            .setTitle(title)
            .setDescription('Nothing queued ahead to adjust.')
            .setColor(this.themeColor()),
        ],
        components,
      };
    }
    const sel = opts.selected;
    const selTrack = sel !== undefined ? snap.tracks[sel] : undefined;
    if (sel !== undefined && selTrack) {
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`qa:up:${sel}`).setLabel('Up').setEmoji('⏫').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`qa:down:${sel}`)
          .setLabel('Down')
          .setEmoji('⏬')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`qa:play:${sel}`)
          .setLabel('Play now')
          .setEmoji('▶')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`qa:rm:${sel}`).setLabel('Remove').setEmoji('🗑').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('qa:back').setLabel('Back').setEmoji('↩').setStyle(ButtonStyle.Secondary),
      );
      components.push(row);
      return {
        embeds: [
          new EmbedBuilder()
            .setTitle(title)
            .setDescription(
              (opts.note ? `${opts.note}\n\n` : '') +
                `**${sel + 1}. ${truncate(selTrack.name || 'Untitled', 70)}**\n` +
                `${truncate((selTrack.artists ?? []).join(', ') || 'Unknown artist', 90)}\n` +
                `-# position ${sel + 1} · ${total} upcoming`,
            )
            .setColor(this.themeColor()),
        ],
        components,
      };
    }
    const menu = new StringSelectMenuBuilder()
      .setCustomId('qa:pick')
      .setPlaceholder('Pick a track to adjust…')
      .addOptions(
        upcoming.map(({ t, i }) => ({
          label: truncate(`${i + 1}. ${t.name || 'Untitled'}`, 90),
          description: truncate((t.artists ?? []).join(', ') || 'Unknown artist', 90),
          value: String(i),
        })),
      );
    components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu));
    return {
      embeds: [
        new EmbedBuilder()
          .setTitle(title)
          .setDescription(
            (opts.note ? `${opts.note}\n\n` : '') +
              'Pick a track below, then **move**, **remove** or **play it now** — no numbers to remember.\n' +
              `-# ${total} upcoming${total > 25 ? ' · showing the first 25' : ''}`,
          )
          .setColor(this.themeColor()),
      ],
      components,
    };
  }

  private async handleQueueAdjust(interaction: MessageComponentInteraction): Promise<void> {
    if (!this.canUse('remove', interaction)) {
      await interaction
        .reply({ content: "⛔ You don't have permission to do that.", flags: MessageFlags.Ephemeral })
        .catch(() => {});
      return;
    }
    const s = this.sessionFor(interaction.guildId);
    const parts = interaction.customId.split(':');
    const action = parts[1] ?? '';
    if (action === 'back' || action === 'pick') {
      const val = action === 'pick' ? Number((interaction as StringSelectMenuInteraction).values[0]) : NaN;
      await interaction.update(this.qaView(s, Number.isFinite(val) ? { selected: val } : {})).catch(() => {});
      return;
    }
    const idx = Number(parts[2]);
    const snap = s.queue.getSnapshot();
    let note: string | undefined;
    if (!Number.isFinite(idx) || !snap.tracks[idx]) {
      note = '⚠️ That track is gone.';
    } else if (action === 'rm') {
      const r = s.removeFromQueue(idx);
      note = r ? `🗑 Removed **${truncate(r.name, 50)}**` : '⚠️ That track is gone.';
    } else if (action === 'up') {
      note = idx - 1 > snap.currentIndex && s.queue.swap(idx, idx - 1) ? '⏫ Moved up' : 'Already at the top.';
    } else if (action === 'down') {
      note = s.queue.swap(idx, idx + 1) ? '⏬ Moved down' : 'Already at the bottom.';
    } else if (action === 'play') {
      const dropped = s.queue.removeUpTo(idx);
      s.playback.next();
      note = `▶ Playing next${dropped > 0 ? ` — dropped ${dropped} track${dropped > 1 ? 's' : ''}` : ''}`;
    } else {
      note = '⚠️ Unknown action.';
    }
    await interaction.update(this.qaView(s, { note })).catch(() => {});
  }

  private async presentSkipTo(target: Message | ChatInputCommandInteraction): Promise<void> {
    const gid = target.guildId ?? '';
    const s = this.sessionFor(gid);
    const snap = s.queue.getSnapshot();
    const upcoming = snap.tracks
      .map((t, i) => ({ t, i }))
      .filter(({ i }) => i > snap.currentIndex)
      .slice(0, 25);
    if (upcoming.length === 0) {
      const msg = 'Nothing queued ahead to jump to.';
      if ('editReply' in target) await target.editReply(msg).catch(() => {});
      else await target.reply(msg).catch(() => {});
      return;
    }
    const token = randomBytes(6).toString('hex');
    this.pendingSkipTo.set(token, { guildId: gid, createdAt: Date.now() });
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`skipto:${token}`)
      .setPlaceholder('Jump to a future track…')
      .addOptions(
        upcoming.map(({ t, i }) => ({
          label: truncate(t.name || 'Untitled', 90),
          description: truncate((t.artists ?? []).join(', ') || `#${i}`, 90),
          value: String(i),
        })),
      );
    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
    const embed = new EmbedBuilder()
      .setTitle('⏭ Skip to a track')
      .setDescription(upcoming.map(({ t, i }) => `\`${i}\` ${truncate(t.name, 60)}`).join('\n'))
      .setColor(this.themeColor());
    if ('editReply' in target) await target.editReply({ embeds: [embed], components: [row] });
    else await target.reply({ embeds: [embed], components: [row] });
  }

  // --- Swap a wrong pick ----------------------------------------------------
  // The mashup repick flow, generalised. Anything that turned search text into
  // a queue add can be corrected in place: "Pick another" re-runs the original
  // query and offers the same dropdown the picker showed, "Type it" takes free
  // text for the cases a search cannot fix (bulk items, uploads, no results).

  /** Register a correctable queue add; returns the row to attach to its reply. */
  private registerSwap(opts: Omit<SwapRef, 'createdAt'>): ActionRowBuilder<ButtonBuilder>[] {
    const token = randomBytes(6).toString('hex');
    this.swapRefs.set(token, { ...opts, createdAt: Date.now() });
    const t = setTimeout(() => this.swapRefs.delete(token), 15 * 60 * 1000);
    t.unref?.();
    if (this.swapRefs.size > 500) {
      const cutoff = Date.now() - 15 * 60 * 1000;
      for (const [k, v] of this.swapRefs) if (v.createdAt < cutoff) this.swapRefs.delete(k);
    }
    return this.swapRow(token);
  }

  /** Buttons for a correctable pick. "Pick another" needs a query to re-run. */
  private swapRow(token: string): ActionRowBuilder<ButtonBuilder>[] {
    const ref = this.swapRefs.get(token);
    const canPick = !!ref?.items.some((it) => it.query);
    const buttons: ButtonBuilder[] = [];
    if (canPick) {
      buttons.push(
        new ButtonBuilder()
          .setCustomId(`swap:pick:${token}`)
          .setLabel(ref!.items.length > 1 ? 'Fix one' : 'Pick another')
          .setStyle(ButtonStyle.Primary)
          .setEmoji('🔄'),
      );
    }
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`swap:type:${token}`)
        .setLabel('Type it')
        .setStyle(canPick ? ButtonStyle.Secondary : ButtonStyle.Primary)
        .setEmoji('⌨️'),
      new ButtonBuilder().setCustomId(`swap:x:${token}`).setLabel('Looks right').setStyle(ButtonStyle.Secondary),
    );
    // A surprise pick ("Roll again") has no query to re-run, only the pool it
    // came from — offer that when there is something left to roll.
    if (ref && ref.items.length === 1 && (ref.pool?.length ?? 0) > 0) {
      buttons.splice(
        canPick ? 1 : 0,
        0,
        new ButtonBuilder()
          .setCustomId(`swap:roll:${token}`)
          .setLabel('Roll again')
          .setStyle(ButtonStyle.Secondary)
          .setEmoji('🎲'),
        new ButtonBuilder()
          .setCustomId(`swap:list:${token}`)
          .setLabel('Show list')
          .setStyle(ButtonStyle.Secondary)
          .setEmoji('📜'),
      );
    }
    return [new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons)];
  }

  /** Newest swap this user registered in this guild whose pick is still queued. */
  private latestSwap(userId: string, guildId: string, s: Session): { token: string; ref: SwapRef } | null {
    const snap = s.queue.getSnapshot();
    let best: { token: string; ref: SwapRef } | null = null;
    for (const [token, ref] of this.swapRefs) {
      if (ref.userId !== userId || ref.guildId !== guildId) continue;
      // Already corrected, already played, or removed — nothing left to fix.
      if (!ref.items.some((it) => snap.tracks.some((t) => t.uri === it.uri))) continue;
      if (!best || ref.createdAt > best.ref.createdAt) best = { token, ref };
    }
    return best;
  }

  /** Put the replacement where the wrong pick was. Returns a one-line status. */
  private applySwap(
    s: Session,
    addedBy: string,
    item: { uri: string; label: string },
    replacement: Omit<TrackInfo, 'addedBy' | 'addedAt'>,
    requestedBy: string,
  ): string {
    const snap = s.queue.getSnapshot();
    const idx = snap.tracks.findIndex((t) => t.uri === item.uri && (t.addedBy ?? '') === addedBy);
    const name = `**${truncate(replacement.name, 60)}**`;
    if (idx !== -1 && idx > snap.currentIndex) {
      s.queue.replaceAt(idx, replacement, requestedBy);
      return `🔄 Swapped in ${name} — same spot in the queue.`;
    }
    if (idx !== -1 && idx === snap.currentIndex) {
      s.queue.insertAfterCurrent([replacement], requestedBy);
      s.playback.next();
      return `🔄 Swapping what's playing for ${name}.`;
    }
    s.queue.enqueue(replacement, requestedBy);
    return `🔄 **${truncate(item.label, 50)}** had already left the queue — queued ${name} instead.`;
  }

  /** Resolve search text into candidates (Spotify first, then YouTube). */
  private async swapCandidates(query: string): Promise<ResolvedTrack[]> {
    let out: ResolvedTrack[] = [];
    try {
      out = await searchCandidates(query, 5);
    } catch {
      out = [];
    }
    if (out.length === 0) {
      try {
        out = await searchYoutube(query, 5);
      } catch {
        /* the caller reports the empty result */
      }
    }
    return out;
  }

  /** Ephemeral dropdown asking which of a multi-item add to fix. */
  private swapItemMenu(token: string, action: 'pick' | 'type'): ActionRowBuilder<StringSelectMenuBuilder> {
    const ref = this.swapRefs.get(token)!;
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`swapitem:${action}:${token}`)
      .setPlaceholder('Which one was wrong?')
      .addOptions(
        ref.items.slice(0, 25).map((it, i) =>
          new StringSelectMenuOptionBuilder()
            .setLabel(truncate(it.label, 100))
            .setDescription(truncate(it.query ? `searched: ${it.query}` : 'added directly', 100))
            .setValue(String(i)),
        ),
      );
    return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
  }

  private async handleSwapButton(i: ButtonInteraction): Promise<void> {
    const [, action = '', token = ''] = i.customId.split(':');
    const ref = this.swapRefs.get(token);
    if (!ref) {
      await i
        .reply({
          content: '⌛ That swap expired — add the track again if you still want it changed.',
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => {});
      return;
    }
    if (ref.userId && i.user.id !== ref.userId) {
      await i
        .reply({ content: '❌ Only the person who queued that track can swap it.', flags: MessageFlags.Ephemeral })
        .catch(() => {});
      return;
    }
    if (action === 'x') {
      this.swapRefs.delete(token);
      await i.update({ components: [] }).catch(() => {});
      return;
    }
    // "Surprise me" alternatives: re-roll the same candidate pool, or list it.
    if (action === 'list') {
      const pool = ref.pool ?? [];
      const shown = pool.slice(0, 20);
      await i
        .reply({
          content:
            `📜 The ${pool.length} candidates this picked from:\n` +
            shown.map((t, n) => `**${n + 1}.** ${swapLabel(t)}`).join('\n') +
            (pool.length > shown.length ? `\n…and ${pool.length - shown.length} more.` : ''),
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => {});
      return;
    }
    if (action === 'roll') {
      const item = ref.items[0];
      const choices = (ref.pool ?? []).filter((t) => t.uri !== item?.uri);
      if (!item || choices.length === 0) {
        await i
          .reply({
            content: '🎲 Nothing left to roll — that list is used up. Run `/similar` again.',
            flags: MessageFlags.Ephemeral,
          })
          .catch(() => {});
        return;
      }
      await i.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
      const pick = choices[Math.floor(Math.random() * choices.length)];
      let info: TrackInfo | null = null;
      try {
        info = await EW.resolveCandidate(pick);
      } catch {
        info = null;
      }
      if (!info) {
        await i
          .editReply({ content: `🎲 Rolled *${pick.name}* but couldn't resolve it — roll again.` })
          .catch(() => {});
        return;
      }
      const status = this.applySwap(this.sessionFor(ref.guildId), ref.addedBy, item, info, i.user.username);
      // Keep the ref pointing at what is actually queued now, so the next roll
      // swaps *that* instead of queueing a second copy — and drop the candidate
      // we just used so "Roll again" cannot return the same one twice.
      ref.items = [{ uri: info.uri, label: swapLabel(info), query: item.query }];
      ref.pool = choices.filter((t) => t !== pick);
      await i.editReply({ content: status, components: this.swapRow(token) }).catch(() => {});
      return;
    }
    // Several items in one add (bulk) — ask which one first.
    if (ref.items.length > 1) {
      await i
        .reply({
          content: `Which of the ${ref.items.length} tracks was wrong?`,
          components: [this.swapItemMenu(token, action === 'type' ? 'type' : 'pick')],
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => {});
      return;
    }
    await this.openSwapTarget(i, token, 0, action === 'type' ? 'type' : 'pick');
  }

  /** Open either the candidate dropdown or the free-text modal for one item. */
  private async openSwapTarget(
    i: ButtonInteraction,
    token: string,
    idx: number,
    action: 'pick' | 'type',
  ): Promise<void> {
    const ref = this.swapRefs.get(token);
    const item = ref?.items[idx];
    if (!ref || !item) {
      await i.reply({ content: '⌛ That swap expired.', flags: MessageFlags.Ephemeral }).catch(() => {});
      return;
    }
    if (action === 'type') {
      const modal = new ModalBuilder()
        .setCustomId(`swapmodal:${token}:${idx}`)
        .setTitle('Swap the track')
        .addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId('swap-song')
              .setLabel('Correct song (name or link)')
              .setPlaceholder(truncate(item.label, 100))
              .setStyle(TextInputStyle.Short)
              .setRequired(true),
          ),
        );
      await i.showModal(modal).catch(async (err) => {
        await i
          .reply({
            content: `❌ Could not open the swap box: ${err instanceof Error ? err.message : err}`,
            flags: MessageFlags.Ephemeral,
          })
          .catch(() => {});
      });
      return;
    }
    const query = item.query ?? item.label;
    await i.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
    const candidates = await this.swapCandidates(query);
    if (candidates.length === 0) {
      await i
        .editReply({ content: `🔍 No other results for \`${truncate(query, 60)}\` — try **Type it** with a link.` })
        .catch(() => {});
      return;
    }
    this.pendingSearch.set(`swap-${token}`, {
      guildId: ref.guildId,
      userId: ref.userId,
      candidates,
      createdAt: Date.now(),
    });
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`swapselect:${token}:${idx}`)
      .setPlaceholder('Pick the right track…')
      .addOptions(
        candidates.map((c, n) =>
          new StringSelectMenuOptionBuilder()
            .setLabel(truncate(c.name || 'Unknown', 100))
            .setDescription(truncate(`${(c.artists ?? []).join(', ') || c.album} · ${fmtMs(c.durationMs)}`, 100))
            .setValue(String(n)),
        ),
      );
    await i
      .editReply({
        content: `Replacing **${truncate(item.label, 60)}** — or pick a different result:`,
        components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
      })
      .catch(() => {});
  }

  /** A multi-item add: user picked which track to fix, then hand off. */
  private async handleSwapItemPick(i: StringSelectMenuInteraction): Promise<void> {
    const [, action = 'pick', token = ''] = i.customId.split(':');
    const idx = parseInt(i.values[0] ?? '0', 10);
    const ref = this.swapRefs.get(token);
    if (!ref || !ref.items[idx]) {
      await i.update({ content: '⌛ That swap expired.', components: [] }).catch(() => {});
      return;
    }
    if (action === 'type') {
      const modal = new ModalBuilder()
        .setCustomId(`swapmodal:${token}:${idx}`)
        .setTitle('Swap the track')
        .addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId('swap-song')
              .setLabel('Correct song (name or link)')
              .setPlaceholder(truncate(ref.items[idx].label, 100))
              .setStyle(TextInputStyle.Short)
              .setRequired(true),
          ),
        );
      await i.showModal(modal).catch(() => {});
      return;
    }
    const item = ref.items[idx];
    await i.deferUpdate().catch(() => {});
    const candidates = await this.swapCandidates(item.query ?? item.label);
    if (candidates.length === 0) {
      await i
        .editReply({
          content: `🔍 No other results for \`${truncate(item.query ?? item.label, 60)}\` — use **Type it**.`,
          components: [],
        })
        .catch(() => {});
      return;
    }
    this.pendingSearch.set(`swap-${token}`, {
      guildId: ref.guildId,
      userId: ref.userId,
      candidates,
      createdAt: Date.now(),
    });
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`swapselect:${token}:${idx}`)
      .setPlaceholder('Pick the right track…')
      .addOptions(
        candidates.map((c, n) =>
          new StringSelectMenuOptionBuilder()
            .setLabel(truncate(c.name || 'Unknown', 100))
            .setDescription(truncate(`${(c.artists ?? []).join(', ') || c.album} · ${fmtMs(c.durationMs)}`, 100))
            .setValue(String(n)),
        ),
      );
    await i
      .editReply({
        content: `Replacing **${truncate(item.label, 60)}**:`,
        components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
      })
      .catch(() => {});
  }

  private async handleSwapPick(i: StringSelectMenuInteraction): Promise<void> {
    const [, token = '', idxRaw = '0'] = i.customId.split(':');
    const ref = this.swapRefs.get(token);
    const pending = this.pendingSearch.get(`swap-${token}`);
    const item = ref?.items[parseInt(idxRaw, 10)];
    if (!ref || !pending || !item) {
      await i.update({ content: '⌛ That swap expired.', components: [] }).catch(() => {});
      return;
    }
    const track = pending.candidates[parseInt(i.values[0] ?? '0', 10)];
    if (!track) {
      await i.update({ content: '⚠️ Invalid selection.', components: [] }).catch(() => {});
      return;
    }
    if (ref.items.length === 1) {
      this.swapRefs.delete(token);
      this.pendingSearch.delete(`swap-${token}`);
    }
    const s = this.sessionFor(i.guildId);
    const status = this.applySwap(s, ref.addedBy, item, track, i.user.username);
    await i.update({ content: status, components: [] }).catch(() => {});
  }

  private async handleSwapModal(i: ModalSubmitInteraction): Promise<void> {
    const [, token = '', idxRaw = '0'] = i.customId.split(':');
    const ref = this.swapRefs.get(token);
    const item = ref?.items[parseInt(idxRaw, 10)];
    if (!ref || !item) {
      await i
        .reply({ content: '⌛ That swap expired — add the track again.', flags: MessageFlags.Ephemeral })
        .catch(() => {});
      return;
    }
    const input = i.fields.getTextInputValue('swap-song').trim();
    await i.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
    let track: ResolvedTrack | undefined;
    try {
      track = (await resolvePlayInput(input))[0];
    } catch {
      track = undefined;
    }
    if (!track) {
      await i
        .editReply({ content: `🔍 Couldn't find \`${truncate(input, 60)}\` — try a direct link.` })
        .catch(() => {});
      return;
    }
    if (ref.items.length === 1) this.swapRefs.delete(token);
    const s = this.sessionFor(i.guildId);
    const status = this.applySwap(s, ref.addedBy, item, track, i.user.username);
    await i.editReply({ content: status }).catch(() => {});
  }

  private async handleSearchPick(interaction: StringSelectMenuInteraction): Promise<void> {
    const token = interaction.customId.slice('vzsearch:'.length);
    const pending = this.pendingSearch.get(token);
    if (!pending) {
      {
        const r = await interaction
          .update({ content: '⌛ This search expired — run the command again.', embeds: [], components: [] })
          .catch(() => null);
        if (r) this.autoExpireNotice(r);
      }
      return;
    }
    this.pendingSearch.delete(token);
    const idx = parseInt(interaction.values[0] ?? '0', 10);
    const track = pending.candidates[idx];
    if (!track) {
      await interaction.update({ content: '⚠️ Invalid selection.', embeds: [], components: [] }).catch(() => {});
      return;
    }
    // Acknowledge within Discord's 3s window — joining voice + resolving the
    // stream can take longer (this was the "didn't respond in time" cause).
    await interaction.deferUpdate().catch(() => {});
    const s = this.sessionFor(interaction.guildId);
    const playbackFailed = await this.playTracks(
      s,
      [track],
      interaction.user.username,
      () => this.ensureJoinedForPlayback(interaction, s),
      this.userQueueMode(s),
    );
    const embed = new EmbedBuilder()
      .setTitle('Added to queue')
      .setDescription(
        `${srcEmoji(track.source)} **${truncate(track.name, 80)}** — ${truncate((track.artists ?? []).join(', '), 80)}` +
          (playbackFailed ? `\n⚠️ Couldn't start playback yet: ${playbackFailed}` : ''),
      )
      .setThumbnail(track.image ?? '')
      .setFooter({ text: `${s.queue.getSnapshot().tracks.length} in queue` })
      .setColor(this.themeColor());
    // Keep the correction loop open — a wrong pick from the dropdown is the
    // most likely wrong pick of all.
    const row = this.registerSwap({
      guildId: interaction.guildId ?? '',
      userId: interaction.user.id,
      addedBy: interaction.user.username,
      mode: this.userQueueMode(s),
      items: [
        {
          uri: track.uri,
          label: `${track.name} — ${(track.artists ?? []).join(', ')}`,
          query: pending.query ?? track.name,
        },
      ],
    });
    await interaction.editReply({ embeds: [embed], components: row }).catch(() => {});
  }

  /** Whether a member may control playback as DJ (owner/mod/admin or DJ role holder). */
  private isDjMember(guild: Guild | null, member: unknown): boolean {
    if (!guild || !member || !('roles' in (member as object))) return false;
    return this.perms.isDj(guild, member as { id: string; roles: { cache: ReadonlyMap<string, unknown> } });
  }

  /** True when a speaker counts as a "host" for Duck mode 'hosts' (DJ/mod/owner). */
  private isDuckHost(guildId: string, userId: string): boolean {
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) return false;
    if (userId === guild.ownerId || this.perms.isOwner(userId)) return true;
    const member = guild.members.cache.get(userId);
    if (!member) return false;
    return this.isDjMember(guild, member);
  }

  /** Start/advance a vote-to-skip. Returns the resulting state for the caller to message. */
  private requestSkip(
    s: Session,
    requesterId: string,
  ): { result: 'skipped' | 'started' | 'voted'; votes: number; needed: number } {
    const guildId = s.guildId ?? '';
    // Vote-skip turned off — any member may skip directly.
    if (!this.perms.getVoteSkip(guildId)) return { result: 'skipped', votes: 1, needed: 1 };
    const channelId = s.voice.getChannelId();
    let eligible = new Set<string>();
    if (channelId) {
      const ch = this.client.channels.cache.get(channelId);
      if (ch && ch.isVoiceBased()) {
        for (const m of ch.members.values()) if (!m.user.bot) eligible.add(m.id);
      }
    }
    const existing = this.skipVotes.get(guildId);
    if (!existing) {
      if (eligible.size <= 1) return { result: 'skipped', votes: 1, needed: 1 };
      const voters = new Set<string>([requesterId]);
      const needed = Math.floor(eligible.size / 2) + 1;
      if (voters.size >= needed) return { result: 'skipped', votes: voters.size, needed };
      const timer = setTimeout(() => this.skipVotes.delete(guildId), 30_000);
      timer.unref?.();
      this.skipVotes.set(guildId, { voters, eligible, timer });
      return { result: 'started', votes: voters.size, needed };
    }
    existing.voters.add(requesterId);
    if (eligible.size > existing.eligible.size) existing.eligible = eligible;
    const needed = Math.floor(existing.eligible.size / 2) + 1;
    if (existing.voters.size >= needed) {
      clearTimeout(existing.timer);
      this.skipVotes.delete(guildId);
      return { result: 'skipped', votes: existing.voters.size, needed };
    }
    return { result: 'voted', votes: existing.voters.size, needed };
  }

  private clearSkipVote(guildId: string | null | undefined): void {
    if (!guildId) return;
    const v = this.skipVotes.get(guildId);
    if (v) {
      clearTimeout(v.timer);
      this.skipVotes.delete(guildId);
    }
  }

  /** Mirror the now-playing track into the voice channel's status line. Discord
   *  rate-limits this endpoint hard, so it's throttled and best-effort. */
  private async syncVoiceStatus(s: Session): Promise<void> {
    const guildId = s.guildId;
    if (!guildId || !s.voice.isJoined()) return;
    const channelId = s.voice.getChannelId();
    if (!channelId) return;
    const track = s.queue.getState().track;
    const text = track ? `${track.name} — ${(track.artists ?? []).join(', ')}`.slice(0, 480) : '';
    if (this.voiceStatusText.get(guildId) === text) return;
    // A missing permission won't fix itself, so after a refusal back off to one
    // attempt an hour instead of hammering Discord and logging every time.
    const deniedAt = this.voiceStatusDenied.get(guildId) ?? 0;
    if (deniedAt && Date.now() - deniedAt < 60 * 60_000) return;
    // ~2 requests / 10 min per channel: refresh at most every 3 min.
    if (Date.now() - (this.voiceStatusAt.get(guildId) ?? 0) < 3 * 60_000) return;
    this.voiceStatusAt.set(guildId, Date.now());
    this.voiceStatusText.set(guildId, text);
    try {
      await this.rest.put(`/channels/${channelId}/voice-status`, { body: { status: text } });
      this.voiceStatusDenied.delete(guildId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/missing permissions|403|50013/i.test(msg)) {
        const first = !this.voiceStatusDenied.has(guildId);
        this.voiceStatusDenied.set(guildId, Date.now());
        if (first) {
          console.warn(
            `[voice] the now-playing voice-channel status needs the "Set Voice Channel Status" permission in <#${channelId}> — pausing those updates for an hour (${msg})`,
          );
        }
        return;
      }
      this.voiceStatusDenied.delete(guildId);
      console.warn(`[voice] status update failed: ${msg}`);
    }
  }

  /**
   * Drop the channel's now-playing voice status. Called while the bot is still
   * connected (the PUT targets the channel we're in) whenever playback stops for
   * good: an emptied queue, the queue running dry, or a manual leave. A no-op
   * when nothing was set this process — except it also sweeps a status left over
   * from before a restart, since the dedupe map starts empty.
   */
  private clearVoiceStatus(s: Session): void {
    const guildId = s.guildId;
    if (!guildId || !s.voice.isJoined()) return;
    const channelId = s.voice.getChannelId();
    if (!channelId) return;
    if (this.voiceStatusText.get(guildId) === '') return;
    // A refusal already warned once via syncVoiceStatus; don't repeat it.
    const deniedAt = this.voiceStatusDenied.get(guildId) ?? 0;
    if (deniedAt && Date.now() - deniedAt < 60 * 60_000) return;
    this.voiceStatusText.set(guildId, '');
    void this.rest.put(`/channels/${channelId}/voice-status`, { body: { status: '' } }).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (/missing permissions|403|50013/i.test(msg)) {
        this.voiceStatusDenied.set(guildId, Date.now());
        return;
      }
      console.warn(`[voice] status clear failed: ${msg}`);
    });
  }

  /** Fetch lyrics for a track and broadcast them to panels/visualizers (best-effort,
   *  cached by lyrics.ts, deduped per guild so state re-emits don't refetch). */
  private maybeBroadcastLyrics(s: Session, track: TrackInfo): void {
    const gid = s.guildId ?? '';
    const key = `${track.uri}|${track.name}`;
    if (this.lastLyricsKey.get(gid) === key) return;
    this.lastLyricsKey.set(gid, key);
    void (async () => {
      const lyr = await fetchLyrics(track).catch(() => null);
      this.bridge.broadcast({
        type: 'lyrics',
        guildId: gid || undefined,
        title: track.name,
        artist: (track.artists ?? []).join(', '),
        lines: (lyr?.syncedLines ?? []).map((l) => ({ timeMs: l.timeMs, text: l.text })),
        plain: lyr ? lyr.lyrics : undefined,
      });
    })();
  }

  /** Start a lyric-guess quiz on a random queued track (title hidden). */
  private async startQuiz(s: Session): Promise<string> {
    const snap = s.queue.getSnapshot();
    const pool = snap.tracks.filter((t) => !t.current);
    const target = pool.length ? pool[Math.floor(Math.random() * pool.length)] : s.queue.getCurrentTrack();
    if (!target) return 'Queue a few songs first, then start a quiz.';
    const lyr = await fetchLyrics(target).catch(() => null);
    const lines = (lyr?.syncedLines ?? []).map((l) => l.text).filter((t) => t.length > 12);
    if (lines.length === 0) return 'No lyrics to quiz on yet — try again once more tracks are queued.';
    const line = lines[Math.floor(Math.random() * lines.length)];
    const gid = s.guildId ?? '';
    this.endQuiz(gid);
    const timer = setTimeout(() => void this.revealQuiz(gid), 60_000);
    timer.unref?.();
    this.quizzes.set(gid, { name: target.name, artists: target.artists, timer });
    return `🎵 **Guess the song!** (60s)\n> ${truncate(line, 300)}\n\nType \`V@guess <answer>\`.`;
  }

  private endQuiz(guildId: string): void {
    const q = this.quizzes.get(guildId);
    if (q) {
      clearTimeout(q.timer);
      this.quizzes.delete(guildId);
    }
  }

  private async revealQuiz(guildId: string): Promise<void> {
    const q = this.quizzes.get(guildId);
    if (!q) return;
    this.quizzes.delete(guildId);
    const chId = this.lastTextChannel.get(guildId);
    if (!chId) return;
    const ch = await this.client.channels.fetch(chId).catch(() => null);
    if (ch && 'send' in ch) {
      await ch.send(`⏰ Time's up! It was **${q.name}** — ${(q.artists ?? []).join(', ')}.`).catch(() => {});
    }
  }

  /** Compare a guess to the quiz answer (forgiving fuzzy match). */
  private guessSong(message: Message, guess: string): string | null {
    const gid = message.guildId ?? '';
    const q = this.quizzes.get(gid);
    if (!q) return null;
    const norm = (x: string): string =>
      x
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
    const g = norm(guess);
    const t = norm(q.name);
    if (g.length < 3) return 'Nope — too short.';
    if (t.includes(g) || g.includes(t)) {
      this.endQuiz(gid);
      return `✅ **${message.author.username}** got it — **${q.name}** — ${(q.artists ?? []).join(', ')}!`;
    }
    return '❌ Not it — keep guessing!';
  }

  /** Crossfade two tracks into one mix by resolving each to a stream URL. */
  private static readonly KEY_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  /** Run ffmpeg to completion, rejecting with its stderr on failure. */
  private runFfmpeg(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const p = spawn(config.ffmpegPath, args, { windowsHide: true });
      let err = '';
      p.stderr?.on('data', (d: Buffer) => {
        err += d.toString();
      });
      p.on('error', reject);
      p.on('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(err.slice(0, 300) || `ffmpeg exited ${code}`)),
      );
    });
  }

  /**
   * Phase-1 "mashup": render a tempo- and key-matched blend of two tracks into a
   * downloadable MP3, plus a set of similar tracks to carry the vibe. (Stem-level
   * (vocal/instrumental) mixing is a later phase — this is the DJ-transition
   * foundation.)
   */
  private async mashupTracks(
    a: string,
    b: string,
    sec: number,
  ): Promise<{ text: string; file?: string; cleanup: string[]; similar: ResolvedTrack[] }> {
    const cleanup: string[] = [];
    const ra = (await resolvePlayInput(a).catch(() => []))[0];
    const rb = (await resolvePlayInput(b).catch(() => []))[0];
    if (!ra || !rb) return { text: 'Need two resolvable tracks (links or names).', cleanup, similar: [] };
    const ta = await EW.resolveCandidate(ra).catch(() => null);
    const tb = await EW.resolveCandidate(rb).catch(() => null);
    const ua = ra.streamUrl ?? ta?.streamUrl;
    const ub = rb.streamUrl ?? tb?.streamUrl;
    if (!ua || !ub) return { text: 'Could not resolve a playable stream for one of those.', cleanup, similar: [] };
    // ffmpeg's own HTTPS client 403s on googlevideo — pull via Node first.
    const toInput = async (url: string): Promise<string | null> => {
      if (!/^https?:\/\//i.test(url)) return url;
      if (/\.m3u8(\?|$)/i.test(url)) return url;
      const file = await downloadToTempFile(url);
      if (file) cleanup.push(file);
      return file;
    };
    const ia = await toInput(ua);
    const ib = await toInput(ub);
    if (!ia || !ib) return { text: 'Could not download one of those tracks.', cleanup, similar: [] };

    // Tempo + key from Spotify audio features (only available for Spotify tracks).
    type FeatArg = Parameters<typeof EW.fetchFeatures>[0];
    const fa = await EW.fetchFeatures(ra as unknown as FeatArg).catch(() => null);
    const fb = await EW.fetchFeatures(rb as unknown as FeatArg).catch(() => null);
    let semis = 0;
    if (fa && fb && fa.key != null && fb.key != null) {
      semis = (((fa.key - fb.key) % 12) + 12) % 12;
      if (semis > 6) semis -= 12;
    }
    const pitchRatio = Math.pow(2, semis / 12);
    const tempoA = fa?.tempo ?? 0;
    const tempoB = fb?.tempo ?? 0;
    const tempoScale = tempoA > 0 && tempoB > 0 ? Math.max(0.7, Math.min(1.4, tempoA / tempoB)) : 1;

    const xf = Math.max(4, Math.min(20, sec || 12));
    const aDurSec = Math.max(20, Math.round((ta?.durationMs || ra.durationMs || 0) / 1000));
    const AW = 30; // tail of A
    const BW = 90; // head of B
    const aStart = Math.max(0, aDurSec - AW);

    const outDir = path.join(config.dataDir, 'uploads');
    await fs.mkdir(outDir, { recursive: true });
    const out = path.join(outDir, `mashup-${Date.now()}.mp3`);
    const bChain = `rubberband=tempo=${tempoScale.toFixed(4)}:pitch=${pitchRatio.toFixed(4)},aresample=48000`;
    const filter = `[0:a]aresample=48000[a0];[1:a]${bChain}[a1];[a0][a1]acrossfade=d=${xf}:c1=tri:c2=tri[out]`;
    try {
      await this.runFfmpeg([
        '-hide_banner',
        '-loglevel',
        'error',
        '-ss',
        String(aStart),
        '-i',
        ia,
        '-t',
        String(BW),
        '-i',
        ib,
        '-filter_complex',
        filter,
        '-map',
        '[out]',
        '-c:a',
        'libmp3lame',
        '-b:a',
        '192k',
        '-y',
        out,
      ]);
    } catch (err) {
      return { text: `Render failed: ${err instanceof Error ? err.message : err}`, cleanup, similar: [] };
    }
    cleanup.push(out);

    // 5 genuinely similar tracks to spread the vibe.
    const seeds = [ra.uri, rb.uri].filter((u) => u.startsWith('spotify:track:')).map((u) => u.split(':')[2]);
    const similar = seeds.length ? await getRecommendations({ seedTracks: seeds, limit: 5 }).catch(() => []) : [];

    const keyNote =
      fa && fb
        ? ` · key ${DiscordBot.KEY_NAMES[fa.key] ?? '?'}→${DiscordBot.KEY_NAMES[fb.key] ?? '?'}${
            semis ? ` (${semis > 0 ? '+' : ''}${semis}st)` : ''
          }`
        : '';
    const tempoNote = tempoA && tempoB ? ` · ${Math.round(tempoA)}/${Math.round(tempoB)} BPM` : '';
    return {
      text: `🎛️ **${this.trackIdent(ra)}** × **${this.trackIdent(rb)}** — ${xf}s beat/key-matched blend${tempoNote}${keyNote}.`,
      file: out,
      cleanup,
      similar,
    };
  }

  /** Separate a track into stems with Demucs (CPU; vocals/other only — the two
   *  we mix). Returns stem paths and a cleanup list. Cached by demucs itself. */
  private async separateStems(
    file: string,
    cacheKey: string,
    cleanup: string[],
  ): Promise<{ vocals: string; other: string } | null> {
    // Reuse cached stems when we've separated this track before — the slow part
    // (the game re-uses tracks a lot, and repeat pairs become near-instant).
    const cacheDir = path.join(config.dataDir, 'stems', cacheKey);
    const cVoc = path.join(cacheDir, 'vocals.mp3');
    const cOth = path.join(cacheDir, 'no_vocals.mp3');
    if (existsSync(cVoc) && existsSync(cOth)) {
      console.log(`[mashup] stems cache hit (${cacheKey})`);
      return { vocals: cVoc, other: cOth };
    }
    // Hosted GPU separation when a Replicate token is set: the same htdemucs
    // model in ~80s instead of ~29 min on CPU. It writes into the same cache
    // dir, so a repeat pair is instant either way. On any failure we fall
    // through to the local run rather than failing the mashup.
    if (replicateStemsEnabled()) {
      const hosted = await separateStemsReplicate(file, cacheDir);
      if (hosted) {
        console.log(`[mashup] stems via Replicate (${cacheKey})`);
        void this.pruneStems();
        return hosted;
      }
      // Never fall through to the ~29-min CPU Demucs run here: the caller
      // posts a fast beat/key-matched blend instead, which beats hanging a
      // Discord command for half an hour.
      console.warn('[mashup] Replicate stems unavailable - using the fast blend instead');
      return null;
    }
    const outDir = path.join(config.dataDir, 'uploads', `stems-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    cleanup.push(outDir);
    try {
      await new Promise<void>((resolve, reject) => {
        const p = spawn(
          'demucs',
          // `--two-stems=vocals` (vocals + no_vocals) is much faster than the
          // full 4-stem split on CPU; `--mp3` keeps the cached stems small.
          ['-n', 'htdemucs', '--two-stems=vocals', '--mp3', '--mp3-bitrate', '192', '-o', outDir, file],
          { windowsHide: true },
        );
        let err = '';
        p.stderr?.on('data', (d: Buffer) => {
          err += d.toString();
        });
        p.on('error', reject);
        p.on('exit', (code) =>
          code === 0 ? resolve() : reject(new Error(err.slice(-300) || `demucs exited ${code}`)),
        );
      });
    } catch (e) {
      console.warn(`[mashup] demucs failed: ${e instanceof Error ? e.message : e}`);
      return null;
    }
    const base = path.join(outDir, 'htdemucs', path.basename(file).replace(/\.[^.]+$/, ''));
    const vocals = path.join(base, 'vocals.mp3');
    const other = path.join(base, 'no_vocals.mp3');
    if (!existsSync(vocals) || !existsSync(other)) return null;
    try {
      await fs.mkdir(cacheDir, { recursive: true });
      await fs.rename(vocals, cVoc);
      await fs.rename(other, cOth);
      void this.pruneStems();
      return { vocals: cVoc, other: cOth };
    } catch {
      // Couldn't persist — fall back to the temp copies (removed with cleanup).
      return { vocals, other };
    }
  }

  /** Keep the stems cache bounded (newest 60 tracks). */
  private pruneStems(): void {
    void (async () => {
      try {
        const root = path.join(config.dataDir, 'stems');
        const entries = await fs.readdir(root).catch(() => [] as string[]);
        if (entries.length <= 60) return;
        const stats = await Promise.all(
          entries.map(async (e) => ({
            e,
            m: (await fs.stat(path.join(root, e)).catch(() => null))?.mtimeMs ?? 0,
          })),
        );
        stats.sort((a, b) => b.m - a.m);
        for (const { e } of stats.slice(60)) {
          await fs.rm(path.join(root, e), { force: true, recursive: true }).catch(() => {});
        }
      } catch {
        /* ignore */
      }
    })();
  }

  /** Resolve + download both mashup inputs into a work dir. */
  private async prepareMashupInputs(
    a: string,
    b: string,
    cleanup: string[],
  ): Promise<
    | { ok: false; text: string }
    | { ok: true; ra: ResolvedTrack; rb: ResolvedTrack; ia: string; ib: string; dir: string }
  > {
    // YouTube resolution is intermittent — anti-bot walls come and go, and a
    // single transient wall used to fail the whole mashup with a misleading
    // "unresolvable" message. Retry a few times with a short backoff before
    // giving up, and log the real reason when we do.
    const resolveInput = async (input: string): Promise<ResolvedTrack | undefined> => {
      let lastErr: unknown;
      for (let i = 0; i < 3; i++) {
        try {
          const hit = (await resolvePlayInput(input))[0];
          if (hit) return hit;
        } catch (err) {
          lastErr = err;
        }
        if (i < 2) await new Promise((res) => setTimeout(res, 700));
      }
      if (lastErr) {
        console.warn(`[mashup] could not resolve "${input}": ${lastErr instanceof Error ? lastErr.message : lastErr}`);
      }
      return undefined;
    };
    const ra = await resolveInput(a);
    const rb = await resolveInput(b);
    if (!ra || !rb) return { ok: false, text: 'Need two resolvable tracks (links or names).' };

    // Re-mint a fresh signed stream URL for the same track. googlevideo URLs are
    // bound to the proxy exit that minted them and expire; a stale URL is a 403.
    const refreshStream = async (track: ResolvedTrack): Promise<string | undefined> => {
      const vid = /^youtube:video:([\w-]+)$/.exec(track.uri)?.[1];
      if (vid) {
        const v = await resolveYoutubeVideo(vid).catch(() => null);
        return v?.streamUrl;
      }
      if (track.uri.startsWith('spotify:')) {
        // resolveCandidate re-searches YouTube for Spotify tracks (its first
        // branch), so this genuinely re-mints rather than returning the old URL.
        const t = await EW.resolveCandidate({ ...track, streamUrl: undefined }).catch(() => null);
        return t?.streamUrl;
      }
      const again = (await resolvePlayInput(track.uri).catch(() => []))[0];
      return again?.streamUrl;
    };

    const resolveStream = async (track: ResolvedTrack): Promise<string | undefined> => {
      for (let i = 0; i < 3; i++) {
        const t = await EW.resolveCandidate(track).catch(() => null);
        if (t?.streamUrl) return t.streamUrl;
        if (i < 2) await new Promise((res) => setTimeout(res, 700));
      }
      return undefined;
    };
    const ua = ra.streamUrl ?? (await resolveStream(ra));
    const ub = rb.streamUrl ?? (await resolveStream(rb));
    if (!ua || !ub) return { ok: false, text: 'Could not resolve a playable stream for one of those.' };
    const dir = path.join(config.dataDir, 'uploads', `mash-${Date.now()}`);
    await fs.mkdir(dir, { recursive: true });
    cleanup.push(dir);
    const grab = async (url: string, base: string, track: ResolvedTrack): Promise<string | null> => {
      if (!/^https?:\/\//i.test(url)) return url;
      // Pass a refresh callback so an expired/throttled URL is re-minted and the
      // download retried instead of failing outright.
      const tmp = await downloadToTempFile(url, undefined, () => refreshStream(track));
      if (!tmp) return null;
      cleanup.push(tmp);
      const dest = path.join(dir, `${base}${path.extname(tmp) || '.mp3'}`);
      await fs.copyFile(tmp, dest);
      return dest;
    };
    const iaFull = await grab(ua, 'a', ra);
    const ibFull = await grab(ub, 'b', rb);
    if (!iaFull || !ibFull) return { ok: false, text: 'Could not download one of those tracks.' };
    // Stem separation cost tracks the input length, but the render only ever
    // uses the first `dur` seconds (its clamp is 180s). A 7-minute track took
    // ~4.5 minutes on Replicate to produce stems of which the first 90s were
    // used, so trim both sides to a small margin above the longest mix first —
    // the upload, the GPU run and the cached stems all get smaller.
    const ia = await this.trimForStems(iaFull, dir, 'a', cleanup);
    const ib = await this.trimForStems(ibFull, dir, 'b', cleanup);
    return { ok: true, ra, rb, ia, ib, dir };
  }

  /** The longest mix `renderMashupStems` can ask for (it clamps `dur` to 180s). */
  private static readonly STEM_MAX_SEC = 120;

  /** Cap the audio handed to stem separation. Returns the source unchanged when
   *  the trim fails, so a missing ffmpeg degrades to the old behaviour rather
   *  than breaking the mashup. */
  private async trimForStems(src: string, dir: string, tag: string, cleanup: string[]): Promise<string> {
    const out = path.join(dir, `stem-${tag}.mp3`);
    cleanup.push(out);
    try {
      await this.runFfmpeg([
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        src,
        '-t',
        String(DiscordBot.STEM_MAX_SEC),
        '-c:a',
        'libmp3lame',
        '-b:a',
        '192k',
        '-y',
        out,
      ]);
      return out;
    } catch (err) {
      console.warn(
        `[mashup] stem trim failed (${err instanceof Error ? err.message : err}) — separating the full track`,
      );
      return src;
    }
  }

  private async mashupTuning(ra: ResolvedTrack, rb: ResolvedTrack) {
    type FeatArg = Parameters<typeof EW.fetchFeatures>[0];
    const fa = await EW.fetchFeatures(ra as unknown as FeatArg).catch(() => null);
    const fb = await EW.fetchFeatures(rb as unknown as FeatArg).catch(() => null);
    return { fa, fb };
  }

  /** rubberband chain that matches `src` to `target`'s tempo + key. */
  private stretchChain(
    targetTempo: number,
    targetKey: number | null | undefined,
    srcTempo: number,
    srcKey: number | null | undefined,
  ): string {
    let semis = 0;
    if (targetKey != null && srcKey != null) {
      semis = (((targetKey - srcKey) % 12) + 12) % 12;
      if (semis > 6) semis -= 12;
    }
    const pitch = Math.pow(2, semis / 12);
    let ratio = targetTempo > 0 && srcTempo > 0 ? targetTempo / srcTempo : 1;
    // Fold octave errors (a detector reporting 60 for a 120 BPM track) into the
    // stretchable band before clamping, so the stretch corrects the tempo
    // instead of hitting the limit.
    while (ratio > 1.4) ratio /= 2;
    while (ratio < 0.7) ratio *= 2;
    const tempo = Math.max(0.7, Math.min(1.4, ratio));
    return `rubberband=tempo=${tempo.toFixed(4)}:pitch=${pitch.toFixed(4)},aresample=48000`;
  }

  /** Phase-2 render: separate both tracks and cross-layer their stems into two
   *  variants (A vocals over B backing, and the reverse). Falls back to the
   *  Phase-1 blend if Demucs is unavailable. */
  private async renderMashupStems(
    a: string,
    b: string,
    durSec: number,
    cleanup: string[],
  ): Promise<{ ok: boolean; text: string; files: string[]; similar: ResolvedTrack[] }> {
    const prep = await this.prepareMashupInputs(a, b, cleanup);
    if (!prep.ok) return { ok: false, text: prep.text, files: [], similar: [] };
    const { ra, rb, ia, ib, dir } = prep;

    // Without a Replicate token, local CPU Demucs takes ~29 min per track and
    // dominates mashup wall time. Skip it and post the fast beat/key-matched
    // blend instead (still tempo/key aligned, still downloadable). Set
    // STEMS_LOCAL_DEMUCS=1 to opt back into the slow local stem run.
    if (!replicateStemsEnabled() && process.env.STEMS_LOCAL_DEMUCS !== '1') {
      const blend = await this.mashupTracks(a, b, durSec || 90);
      cleanup.push(...blend.cleanup);
      return {
        ok: !!blend.file,
        text: `${blend.text}\n_(fast beat/key-matched blend — set REPLICATE_API_TOKEN for ~80s GPU stem separation)_`,
        files: blend.file ? [blend.file] : [],
        similar: blend.similar,
      };
    }

    const keyA = createHash('sha1').update(ra.uri).digest('hex').slice(0, 16);
    const keyB = createHash('sha1').update(rb.uri).digest('hex').slice(0, 16);
    const [sa, sb] = await Promise.all([this.separateStems(ia, keyA, cleanup), this.separateStems(ib, keyB, cleanup)]);
    if (!sa || !sb) {
      const blend = await this.mashupTracks(a, b, 12);
      cleanup.push(...blend.cleanup);
      return {
        ok: !!blend.file,
        text: `${blend.text}\n_(stem separation unavailable here — posted a beat/key-matched blend instead)_`,
        files: blend.file ? [blend.file] : [],
        similar: blend.similar,
      };
    }
    const { fa, fb } = await this.mashupTuning(ra, rb);
    // Tempo is often missing (non-Spotify tracks, or Spotify tracks the
    // ReccoBeats backfill doesn't cover). Estimate it from the instrumentals so
    // the blend is still time-aligned instead of layering two different tempos
    // and drifting apart.
    const tempoA = fa?.tempo || (await estimateTempo(sa.other)) || 0;
    const tempoB = fb?.tempo || (await estimateTempo(sb.other)) || 0;
    const dur = Math.max(30, Math.min(180, durSec || 90));
    const v1 = path.join(dir, 'v1.mp3');
    const v2 = path.join(dir, 'v2.mp3');
    // Trim each side's theatrical intro and stretch the instrumental to the
    // vocal's tempo, into plain intermediates. The trimmed backing doubles as
    // that side's BEAT REFERENCE — see the alignment below.
    const trim = 'silenceremove=start_periods=1:start_silence=0.05:start_threshold=-45dB';
    const fade = `loudnorm=I=-14:TP=-1.5:LRA=11,alimiter=limit=0.95,afade=t=in:st=0:d=2,afade=t=out:st=${dur - 3}:d=3`;
    const prepSide = async (
      voc: string,
      inst: string,
      chain: string,
      tag: string,
    ): Promise<{ voc: string; ref: string; inst: string }> => {
      const vo = path.join(dir, `prep-${tag}-voc.wav`);
      const ref = path.join(dir, `prep-${tag}-ref.wav`);
      const io = path.join(dir, `prep-${tag}-inst.wav`);
      cleanup.push(vo, ref, io);
      await this.runFfmpeg([
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        voc,
        '-af',
        `${trim},aresample=48000`,
        '-c:a',
        'pcm_s16le',
        '-y',
        vo,
      ]);
      await this.runFfmpeg([
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        inst,
        '-af',
        `${trim},aresample=48000`,
        '-c:a',
        'pcm_s16le',
        '-y',
        ref,
      ]);
      await this.runFfmpeg([
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        ref,
        '-af',
        chain,
        '-c:a',
        'pcm_s16le',
        '-y',
        io,
      ]);
      return { voc: vo, ref, inst: io };
    };
    // `adelay` nudges the earlier side so the downbeats land together.
    const mix = (voc: string, inst: string, delayVoc: number, delayInst: number, out: string): string[] => {
      const vc = delayVoc > 0 ? `adelay=${Math.round(delayVoc)}:all=1,` : '';
      const ic = delayInst > 0 ? `adelay=${Math.round(delayInst)}:all=1,` : '';
      return [
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        voc,
        '-i',
        inst,
        '-filter_complex',
        `[0:a]${vc}aresample=48000[v];[1:a]${ic}aresample=48000[i];[v][i]amix=inputs=2:duration=longest:normalize=0,${fade}[out]`,
        '-map',
        '[out]',
        '-t',
        String(dur),
        '-c:a',
        'libmp3lame',
        '-b:a',
        '192k',
        '-y',
        out,
      ];
    };
    try {
      const p1 = await prepSide(sa.vocals, sb.other, this.stretchChain(tempoA, fa?.key, tempoB, fb?.key), '1');
      const p2 = await prepSide(sb.vocals, sa.other, this.stretchChain(tempoB, fb?.key, tempoA, fa?.key), '2');
      // Align the BACKINGS, not the vocal: percussion is what carries a beat
      // grid, and a vocal's word onsets don't line up with drums (measuring
      // vocal-vs-backing produced up to 1.4s of nonsense on same-recording
      // stems). The vocal is already on its own backing's grid, so shifting the
      // other side's backing onto that grid lines the vocal up too.
      const lag1 = await beatAlignLagMs(p1.ref, p2.inst);
      const lag2 = await beatAlignLagMs(p2.ref, p1.inst);
      console.log(`[mashup] beat align: v1 ${Math.round(lag1)}ms · v2 ${Math.round(lag2)}ms`);
      // Positive lag = the second file (the backing) is early, so delay it.
      await this.runFfmpeg(mix(p1.voc, p2.inst, 0, Math.max(0, lag1), v1));
      await this.runFfmpeg(mix(p2.voc, p1.inst, 0, Math.max(0, lag2), v2));
    } catch (err) {
      return { ok: false, text: `Render failed: ${err instanceof Error ? err.message : err}`, files: [], similar: [] };
    }
    cleanup.push(v1, v2);

    const seeds = [ra.uri, rb.uri].filter((u) => u.startsWith('spotify:track:')).map((u) => u.split(':')[2]);
    const similar = seeds.length ? await getRecommendations({ seedTracks: seeds, limit: 5 }).catch(() => []) : [];
    const keyNote =
      fa && fb ? ` · keys ${DiscordBot.KEY_NAMES[fa.key] ?? '?'}/${DiscordBot.KEY_NAMES[fb.key] ?? '?'}` : '';
    const tempoNote =
      tempoA && tempoB
        ? ` · ${Math.round(tempoA)}/${Math.round(tempoB)} BPM${(!fa?.tempo && tempoA > 0) || (!fb?.tempo && tempoB > 0) ? ' (detected)' : ''}`
        : '';
    return {
      ok: true,
      text:
        `🎛️ **${this.trackIdent(ra)}** × **${this.trackIdent(rb)}** — stem mashup (${dur}s)${tempoNote}${keyNote}\n` +
        `• **v1** — ${truncate(ra.name, 30)} vocals over ${truncate(rb.name, 30)} backing\n` +
        `• **v2** — ${truncate(rb.name, 30)} vocals over ${truncate(ra.name, 30)} backing`,
      files: [v1, v2],
      similar,
    };
  }

  /** One mashup render per guild at a time; posts the result as a NEW message
   *  (a render can outlast Discord's interaction window). Extra requests are
   *  QUEUED rather than bounced, so several can be lined up at once. */
  private mashupBusy = new Set<string>();
  private mashupQueue = new Map<string, MashupJob[]>();
  /** Pending mashup results keyed by a short token, so a repick modal can
   *  re-render with one side swapped out (token -> job). */
  private mashupPending = new Map<
    string,
    {
      guildId: string;
      channelId: string;
      messageId: string;
      a: string;
      b: string;
      userId: string;
    }
  >();
  private static readonly MASHUP_QUEUE_MAX = 5;

  /** Enqueue a mashup, or render it now when the guild is idle. */
  private async startMashupRender(send: MashupSend, guildId: string, a: string, b: string, by = ''): Promise<void> {
    if (this.mashupBusy.has(guildId)) {
      const q = this.mashupQueue.get(guildId) ?? [];
      if (q.length >= DiscordBot.MASHUP_QUEUE_MAX) {
        await send({
          embeds: [
            new EmbedBuilder()
              .setColor(this.themeColor())
              .setDescription(
                `📋 The mashup queue is full (${DiscordBot.MASHUP_QUEUE_MAX}). Free a slot with \`V@mashup remove <n>\` or \`V@mashup clear\`.`,
              ),
          ],
          files: [],
        }).catch(() => {});
        return;
      }
      q.push({ id: randomBytes(3).toString('hex'), a, b, by, send });
      this.mashupQueue.set(guildId, q);
      await send({
        embeds: [
          new EmbedBuilder()
            .setColor(this.themeColor())
            .setDescription(
              `📋 Queued as **#${q.length}** — ${truncate(a, 40)} × ${truncate(b, 40)}\nUse \`V@mashup list\` to see the queue.`,
            ),
        ],
        files: [],
      }).catch(() => {});
      return;
    }
    await this.renderMashupNow(send, guildId, a, b, by);
    void this.drainMashupQueue(guildId);
  }

  /** Render a single mashup; the busy flag is held for its whole duration. */
  private async renderMashupNow(send: MashupSend, guildId: string, a: string, b: string, by = ''): Promise<void> {
    this.mashupBusy.add(guildId);
    const cleanup: string[] = [];
    try {
      // Stem separation dominates the wall time (minutes, not seconds) and the
      // finished render arrives as a separate message, so say something now
      // rather than leaving the channel silent and looking hung.
      await send({
        embeds: [
          new EmbedBuilder()
            .setColor(this.themeColor())
            .setDescription('🎛️ Separating stems and mixing — a minute or two (repeat pairs are instant).'),
        ],
        files: [],
      }).catch(() => {});
      const r = await this.renderMashupStems(a, b, 90, cleanup);
      const files = r.files.map((f, i) => new AttachmentBuilder(f, { name: `vaporzr-mashup-${i + 1}.mp3` }));
      const token = randomBytes(4).toString('hex');
      const sent = await send({
        embeds: [this.mashupEmbed(this.sillyMashupName(a, b), r.text, r.similar)],
        files,
        components: this.mashupRepickRow(token),
      }).catch(() => null);
      // Remember this render so a repick modal can re-render with one side swapped.
      if (sent && typeof sent === 'object' && 'id' in sent) {
        const s = sent as { id: string; channelId?: string };
        this.mashupPending.set(token, {
          guildId,
          channelId: String(s.channelId ?? ''),
          messageId: s.id,
          a,
          b,
          userId: by,
        });
        setTimeout(() => this.mashupPending.delete(token), 24 * 60 * 60 * 1000).unref?.();
      }
    } catch (err) {
      await send({
        embeds: [
          new EmbedBuilder()
            .setColor(this.themeColor())
            .setDescription(`❌ Mashup failed: ${err instanceof Error ? err.message : err}`),
        ],
        files: [],
      }).catch(() => {});
    } finally {
      this.mashupBusy.delete(guildId);
      for (const f of cleanup) await fs.rm(f, { force: true, recursive: true }).catch(() => {});
    }
  }

  /** Start the next queued mashup for a guild, if there is one. */
  private async drainMashupQueue(guildId: string): Promise<void> {
    if (this.mashupBusy.has(guildId)) return;
    const q = this.mashupQueue.get(guildId);
    const job = q?.shift();
    if (!job) return;
    if (q && q.length === 0) this.mashupQueue.delete(guildId);
    await job
      .send({
        embeds: [
          new EmbedBuilder()
            .setColor(this.themeColor())
            .setDescription(`▶️ Starting your queued mashup — ${truncate(job.a, 40)} × ${truncate(job.b, 40)}`),
        ],
        files: [],
      })
      .catch(() => {});
    await this.renderMashupNow(job.send, guildId, job.a, job.b, job.by);
    void this.drainMashupQueue(guildId);
  }

  /** `V@mashup list` — what is rendering and what is waiting. */
  private async replyMashupQueue(reply: (content: string) => Promise<unknown>, guildId: string): Promise<void> {
    const q = this.mashupQueue.get(guildId) ?? [];
    const lines: string[] = [
      this.mashupBusy.has(guildId) ? '🎛️ Rendering now — a slot is busy.' : '😴 Nothing rendering right now.',
    ];
    if (q.length === 0) {
      lines.push('📋 Queue is empty. Add one with `V@mashup <song A> | <song B>`.');
    } else {
      lines.push(`📋 Queue (${q.length}/${DiscordBot.MASHUP_QUEUE_MAX}):`);
      q.forEach((j, i) =>
        lines.push(`**${i + 1}.** ${truncate(j.a, 40)} × ${truncate(j.b, 40)}${j.by ? ` — by ${j.by}` : ''}`),
      );
      lines.push(
        'Remove: `V@mashup remove <n>` · Replace: `V@mashup edit <n> <a> | <b>` · Reorder: `V@mashup move <n> <m>` · Empty: `V@mashup clear`',
      );
    }
    await reply(lines.join('\n')).catch(() => {});
  }

  /** Remove entry `n` (1-based) from a guild's mashup queue. */
  private async removeMashupFromQueue(
    reply: (content: string) => Promise<unknown>,
    guildId: string,
    n: number,
  ): Promise<void> {
    const q = this.mashupQueue.get(guildId) ?? [];
    if (!Number.isInteger(n) || n < 1 || n > q.length) {
      await reply(
        q.length ? `Pick a number from 1 to ${q.length} (see \`V@mashup list\`).` : 'The mashup queue is empty.',
      ).catch(() => {});
      return;
    }
    const [gone] = q.splice(n - 1, 1);
    if (q.length === 0) this.mashupQueue.delete(guildId);
    await reply(
      `🗑️ Removed **#${n}** — ${truncate(gone?.a ?? '', 40)} × ${truncate(gone?.b ?? '', 40)}.${q.length ? ` ${q.length} left.` : ' Queue is now empty.'}`,
    ).catch(() => {});
  }

  /** Replace entry `n` (1-based) with a new pair. */
  private async editMashupInQueue(
    reply: (content: string) => Promise<unknown>,
    guildId: string,
    n: number,
    a: string,
    b: string,
  ): Promise<void> {
    const q = this.mashupQueue.get(guildId) ?? [];
    if (!Number.isInteger(n) || n < 1 || n > q.length) {
      await reply(
        q.length ? `Pick a number from 1 to ${q.length} (see \`V@mashup list\`).` : 'The mashup queue is empty.',
      ).catch(() => {});
      return;
    }
    q[n - 1] = { ...q[n - 1]!, a, b };
    await reply(`✏️ Updated **#${n}** — ${truncate(a, 40)} × ${truncate(b, 40)}.`).catch(() => {});
  }

  /** Move entry `from` to position `to` (both 1-based). */
  private async moveMashupInQueue(
    reply: (content: string) => Promise<unknown>,
    guildId: string,
    from: number,
    to: number,
  ): Promise<void> {
    const q = this.mashupQueue.get(guildId) ?? [];
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || from > q.length || to < 1 || to > q.length) {
      await reply(
        q.length ? `Pick numbers from 1 to ${q.length} (see \`V@mashup list\`).` : 'The mashup queue is empty.',
      ).catch(() => {});
      return;
    }
    const [item] = q.splice(from - 1, 1);
    q.splice(to - 1, 0, item!);
    await reply(`↕️ Moved **#${from}** to **#${to}**.`).catch(() => {});
  }

  /** Vote tallies for active mashup games (in-memory; resets on restart). */
  private mashupVotes = new Map<
    string,
    { v1: Set<string>; v2: Set<string>; timer?: NodeJS.Timeout; message?: Message }
  >();

  /** Suggest a pair of queued tracks for the mashup game. */
  private suggestMashupPair(s: Session): { a: string; b: string } | null {
    const snap = s.queue.getSnapshot();
    const tracks = snap.tracks;
    if (tracks.length < 2) return null;
    const a = tracks[Math.max(0, snap.currentIndex)] ?? tracks[0];
    const others = tracks.filter((t) => t.uri !== a.uri);
    const b = others[Math.floor(Math.random() * others.length)];
    if (!a || !b) return null;
    const q = (t: { name: string; artists?: string[] }): string => `${t.name} ${(t.artists ?? [])[0] ?? ''}`.trim();
    return { a: q(a), b: q(b) };
  }

  /** Phase-3: render a stem mashup and post it with voting buttons. */
  private async runMashupGame(send: MashupSend, guildId: string, a: string, b: string): Promise<void> {
    if (this.mashupBusy.has(guildId)) {
      await send({
        embeds: [
          new EmbedBuilder()
            .setColor(this.themeColor())
            .setDescription('⏳ Already rendering a mashup here — give it a few minutes.'),
        ],
        files: [],
      }).catch(() => {});
      return;
    }
    this.mashupBusy.add(guildId);
    const cleanup: string[] = [];
    try {
      const r = await this.renderMashupStems(a, b, 60, cleanup);
      if (!r.ok || r.files.length === 0) {
        await send({
          embeds: [this.mashupEmbed(this.sillyMashupName(a, b), `❌ ${r.text}`, [])],
          files: [],
        }).catch(() => {});
        return;
      }
      const id = randomBytes(4).toString('hex');
      this.mashupVotes.set(id, { v1: new Set(), v2: new Set() });
      const hist = await loadMashupHistory();
      hist.unshift({ id, a, b, at: Date.now() });
      await saveMashupHistory(hist);
      const files = r.files.map((f, i) => new AttachmentBuilder(f, { name: `vaporzr-mashup-v${i + 1}.mp3` }));
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`mashvote:${id}:1`)
          .setLabel('Vote v1')
          .setEmoji('1️⃣')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`mashvote:${id}:2`)
          .setLabel('Vote v2')
          .setEmoji('2️⃣')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`mashreveal:${id}`).setLabel('Close & reveal').setStyle(ButtonStyle.Secondary),
      );
      const sent = await send({
        embeds: [
          this.mashupEmbed(
            this.sillyMashupName(a, b),
            `🎲 **Mashup game!** Listen to both blends and vote for the best.\n${r.text}`,
            r.similar,
          ),
        ],
        files,
        components: [row],
      }).catch(() => null);
      const state = this.mashupVotes.get(id);
      if (state) {
        if (sent && typeof sent === 'object' && 'edit' in sent) state.message = sent as Message;
        // Auto-reveal after 3 minutes so the game never hangs waiting.
        const t = setTimeout(() => void this.revealMashup(id), 3 * 60 * 1000);
        t.unref?.();
        state.timer = t;
      }
    } catch (err) {
      await send({
        embeds: [
          new EmbedBuilder()
            .setColor(this.themeColor())
            .setDescription(`❌ Mashup game failed: ${err instanceof Error ? err.message : err}`),
        ],
        files: [],
      }).catch(() => {});
    } finally {
      this.mashupBusy.delete(guildId);
      for (const f of cleanup) await fs.rm(f, { force: true, recursive: true }).catch(() => {});
    }
  }

  private async handleMashVote(i: ButtonInteraction): Promise<void> {
    const parts = i.customId.split(':');
    const id = parts[1] ?? '';
    const pick = parts[2];
    const v = this.mashupVotes.get(id);
    if (!v) {
      await i.reply({ content: '⌛ This vote has closed.', flags: MessageFlags.Ephemeral }).catch(() => {});
      return;
    }
    (pick === '1' ? v.v1 : v.v2).add(i.user.id);
    (pick === '1' ? v.v2 : v.v1).delete(i.user.id);
    await i
      .reply({
        content: `🗳️ Voted for **v${pick}** — v1: ${v.v1.size} · v2: ${v.v2.size}`,
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => {});
    void this.maybeAutoReveal(id);
  }

  /** Close voting when every human in the bot's voice channel has voted. */
  private async maybeAutoReveal(id: string): Promise<void> {
    const st = this.mashupVotes.get(id);
    const guild = st?.message?.guild ?? null;
    if (!st || !guild) return;
    const s = this.sessionFor(guild.id);
    const chanId = s.voice.getChannelId();
    if (!chanId) return;
    const ch = await guild.channels.fetch(chanId).catch(() => null);
    const members =
      ch && 'members' in ch
        ? [...(ch as unknown as { members: Map<string, { id: string; user: { bot: boolean } }> }).members.values()]
        : [];
    const humans = members.filter((m) => !m.user.bot).map((m) => m.id);
    const voted = new Set([...st.v1, ...st.v2]);
    if (humans.length > 0 && humans.every((h) => voted.has(h))) void this.revealMashup(id);
  }

  /** Announce the winner, record it, and drop the vote buttons. */
  private async revealMashup(id: string): Promise<void> {
    const st = this.mashupVotes.get(id);
    if (!st) return;
    if (st.timer) clearTimeout(st.timer);
    this.mashupVotes.delete(id);
    const winner: 'v1' | 'v2' | 'tie' = st.v1.size === st.v2.size ? 'tie' : st.v1.size > st.v2.size ? 'v1' : 'v2';
    const hist = await loadMashupHistory();
    const rec = hist.find((h) => h.id === id);
    if (rec) {
      rec.winner = winner;
      await saveMashupHistory(hist);
    }
    if (st.message) {
      await st.message
        .edit({ content: `🏆 **Winner: ${winner}** (v1: ${st.v1.size} · v2: ${st.v2.size})`, components: [] })
        .catch(() => {});
    }
  }

  private async handleMashReveal(i: ButtonInteraction): Promise<void> {
    const id = i.customId.slice('mashreveal:'.length);
    if (!this.mashupVotes.has(id)) {
      await i.reply({ content: '⌛ Already revealed.', flags: MessageFlags.Ephemeral }).catch(() => {});
      return;
    }
    await i.deferUpdate().catch(() => {});
    await this.revealMashup(id);
  }

  /** Show a modal to replace one side of a finished mashup result. */
  private async handleMashRepickButton(i: ButtonInteraction): Promise<void> {
    const parts = i.customId.split(':'); // mashrepick:A:<token>
    const side = parts[1] ?? '';
    const token = parts[2] ?? '';
    const job = this.mashupPending.get(token);
    if (!job) {
      await i
        .reply({ content: '⌛ This mashup result has expired — render a new one.', flags: MessageFlags.Ephemeral })
        .catch(() => {});
      return;
    }
    const other = side === 'A' ? job.b : job.a;
    const modal = new ModalBuilder()
      .setCustomId(`mashrepickmodal:${side}:${token}`)
      .setTitle(`Repick ${side === 'A' ? 'song A' : 'song B'}`)
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId('mashrepick-song')
            .setLabel(`New ${side === 'A' ? 'song A' : 'song B'} (name or link)`)
            .setPlaceholder(other)
            .setStyle(TextInputStyle.Short)
            .setRequired(true),
        ),
      );
    await i.showModal(modal).catch(async (err) => {
      await i
        .reply({
          content: `❌ Could not open repick modal: ${err instanceof Error ? err.message : err}`,
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => {});
    });
  }

  /** Drop the repick/close buttons from a finished mashup result. */
  private async handleMashRepickClose(i: ButtonInteraction): Promise<void> {
    await i.deferUpdate().catch(() => {});
    await i.message.edit({ components: [] }).catch(() => {});
  }

  /** Re-render with one side swapped, editing the original result message in place. */
  private async handleMashRepickModal(i: ModalSubmitInteraction): Promise<void> {
    const parts = i.customId.split(':'); // mashrepickmodal:A:<token>
    const side = parts[1] ?? '';
    const token = parts[2] ?? '';
    const job = this.mashupPending.get(token);
    if (!job) {
      await i.reply({ content: '⌛ This mashup result has expired.', flags: MessageFlags.Ephemeral }).catch(() => {});
      return;
    }
    if (job.userId && i.user.id !== job.userId) {
      await i
        .reply({ content: '❌ Only the person who rendered this mashup can repick it.', flags: MessageFlags.Ephemeral })
        .catch(() => {});
      return;
    }
    const replacement = i.fields.getTextInputValue('mashrepick-song');
    const newA = side === 'A' ? replacement : job.a;
    const newB = side === 'B' ? replacement : job.b;
    await i.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
    const cleanup: string[] = [];
    try {
      const r = await this.renderMashupStems(newA, newB, 90, cleanup);
      const title = this.sillyMashupName(newA, newB);
      const embed = r.ok ? this.mashupEmbed(title, r.text, r.similar) : this.mashupEmbed(title, `❌ ${r.text}`, []);
      const files = r.files.map((f, ix) => new AttachmentBuilder(f, { name: `vaporzr-mashup-${ix + 1}.mp3` }));
      const newToken = randomBytes(4).toString('hex');
      const components = this.mashupRepickRow(newToken);
      if (i.message && 'edit' in i.message) {
        await i.message.edit({ embeds: [embed], files, components }).catch(() => {});
      }
      this.mashupPending.delete(token);
      this.mashupPending.set(newToken, {
        guildId: job.guildId,
        channelId: job.channelId,
        messageId: (i.message as { id: string }).id,
        a: newA,
        b: newB,
        userId: job.userId,
      });
      setTimeout(() => this.mashupPending.delete(newToken), 24 * 60 * 60 * 1000).unref?.();
      await i.editReply({ content: `✅ Repicked ${side}.` }).catch(() => {});
    } catch (err) {
      await i.editReply({ content: `❌ Repick failed: ${err instanceof Error ? err.message : err}` }).catch(() => {});
    } finally {
      for (const f of cleanup) await fs.rm(f, { force: true, recursive: true }).catch(() => {});
    }
  }

  /** One-line ID for a track: name — artists • source • mm:ss. */
  private trackIdent(t: ResolvedTrack): string {
    const secs = Math.max(0, Math.round((t.durationMs || 0) / 1000));
    const mm = Math.floor(secs / 60);
    const ss = String(secs % 60).padStart(2, '0');
    const artists = (t.artists ?? []).join(', ');
    return `${truncate(t.name, 40)} — ${truncate(artists, 30)} • ${t.source} • ${mm}:${ss}`;
  }

  /** Clever silly mashup title combining both song names. */
  private sillyMashupName(a: string, b: string): string {
    const A = truncate(a, 22);
    const B = truncate(b, 22);
    const styles = [
      () => `${A} & ${B} — The Unholy Union`,
      () => `${A} feat. ${B} (but make it cursed)`,
      () => `${B} × ${A}: A Match Made in Algorithm`,
      () => `${A} ${B.replace(/^[A-Za-z]/, (c) => c.toUpperCase())} — Now With Extra ${B}`,
      () => `${A} vs ${B}: Battle of the Bridges`,
      () => `${A.slice(0, Math.max(1, A.length / 2))}${B.slice(Math.floor(B.length / 2))} (the ${A} ${B} mashup)`,
      () => `${A} — ${B} (Extended Illegal Remix)`,
      () => `${B} ${A.replace(/^[A-Za-z]/, (c) => c.toUpperCase())} — DJ ${A} Radio Edit`,
    ];
    return styles[Math.floor(Math.random() * styles.length)]();
  }

  /** Embed for a rendered mashup: title (silly name), description + similar-track list. */
  private mashupEmbed(title: string, text: string, similar: ResolvedTrack[]): EmbedBuilder {
    const lines = [text];
    if (similar.length) {
      lines.push('', '**Similar vibes:**');
      lines.push(
        ...similar.map(
          (t, i) =>
            `${i + 1}. ${srcEmoji(t.source)} **${truncate(t.name, 60)}** — ${truncate(
              (t.artists ?? []).join(', '),
              50,
            )}`,
        ),
      );
    }
    return new EmbedBuilder().setTitle(title).setDescription(lines.join('\n')).setColor(this.themeColor());
  }

  /** Repick buttons on a finished mashup result: swap side A or side B via modal. */
  private mashupRepickRow(token: string): ActionRowBuilder<ButtonBuilder>[] {
    return [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`mashrepick:A:${token}`)
          .setLabel('Repick A')
          .setStyle(ButtonStyle.Secondary)
          .setEmoji('🔄'),
        new ButtonBuilder()
          .setCustomId(`mashrepick:B:${token}`)
          .setLabel('Repick B')
          .setStyle(ButtonStyle.Secondary)
          .setEmoji('🔄'),
        new ButtonBuilder().setCustomId(`mashreclose:${token}`).setLabel('Close').setStyle(ButtonStyle.Secondary),
      ),
    ];
  }

  /**
   * `V@deck …` — text-side control for the live decks. The full mixer lives on
   * the `/deck` page (faders and EQ need a UI); this covers loading and the
   * transport so a set can be driven from chat or a phone.
   */
  private async deckCommandText(gid: string, raw: string): Promise<string> {
    const decks = this.deckFor(gid);
    const trimmed = raw.trim();
    const [sub = 'status', ...rest] = trimmed.split(/\s+/);
    const arg = rest.join(' ').trim();
    const st = decks.state();
    const deckArg = (arg.split(/\s+/)[0] ?? '').toLowerCase();
    const isDeck = deckArg === 'a' || deckArg === 'b';
    const deck: DeckId = isDeck ? (deckArg as DeckId) : 'a';
    const value = isDeck ? arg.replace(/^\S+\s*/, '').trim() : arg;

    const parseTime = (v: string): number => {
      const clock = /^(\d+):([0-5]?\d)$/.exec(v);
      if (clock) return (Number(clock[1]) * 60 + Number(clock[2])) * 1000;
      const n = Number(v);
      return Number.isFinite(n) ? n * 1000 : 0;
    };

    switch (sub.toLowerCase()) {
      case 'load':
      case 'cue':
      case 'a':
      case 'b': {
        // `V@deck a <song>` and `V@deck load a <song>` mean the same thing.
        let target: DeckId = 'a';
        let query = arg;
        if (sub === 'a' || sub === 'b') {
          target = sub;
        } else if (isDeck) {
          target = deck;
          query = value;
        }
        if (!query) return 'Usage: `V@deck a <song or link>` / `V@deck b <song or link>`.';
        if (!this.sessionFor(gid).voice.isConnectionReady() && !(await this.joinWhereListenersAre())) {
          return 'Join a voice channel first (`V@j`), then load a deck.';
        }
        return (await decks.load(target, query)).message;
      }
      case 'play':
      case 'go':
        return decks.play().message;
      case 'pause':
        return decks.pause().message;
      case 'stop':
      case 'off':
        return decks.stop().message;
      case 'sync':
        return decks.sync().message;
      case 'nudge': {
        const ms = Number(value);
        if (!Number.isFinite(ms) || !ms) return 'Usage: `V@deck nudge a 25` (milliseconds).';
        return decks.nudge(deck, ms).message;
      }
      case 'seek': {
        const ms = parseTime(value);
        if (!ms) return 'Usage: `V@deck seek a 1:30`.';
        return decks.seek(deck, ms).message;
      }
      case 'cross':
      case 'xfade': {
        const pct = Number(value.replace('%', ''));
        if (!Number.isFinite(pct)) return 'Usage: `V@deck cross 60` (0 = A, 100 = B).';
        return decks.crossfader(Math.max(0, Math.min(1, pct / 100))).message;
      }
      case 'gain':
      case 'trim': {
        const pct = Number(value.replace('%', ''));
        if (!Number.isFinite(pct)) return 'Usage: `V@deck gain a 85`.';
        return decks.gain(deck, Math.max(0, Math.min(1, pct / 100))).message;
      }
      case 'eq': {
        const [bandRaw = 'mid', dbRaw = '0'] = value.split(/\s+/);
        const band = bandRaw.toLowerCase() as keyof DeckEq;
        if (band !== 'low' && band !== 'mid' && band !== 'high') {
          return 'Usage: `V@deck eq a low -40` (bands: low / mid / high).';
        }
        if (/^kill$/i.test(dbRaw)) return decks.kill(deck, band).message;
        const db = Number(dbRaw);
        if (!Number.isFinite(db)) return 'Give me a dB value, e.g. `V@deck eq a low -12`.';
        return decks.eq(deck, band, db).message;
      }
      case 'tempo': {
        const pct = Number(value.replace('%', ''));
        if (!Number.isFinite(pct) || pct <= 0) return 'Usage: `V@deck tempo b 104` (percent) or `V@deck tempo b 105%`.';
        return decks.tempo(deck, pct / 100).message;
      }
      case 'status':
      case 'now':
      default: {
        const line = (label: string, slot: typeof st.a): string => {
          if (!slot.source) return `**${label}** — empty`;
          const pos = `${Math.floor(slot.positionMs / 60000)}:${String(Math.floor((slot.positionMs % 60000) / 1000)).padStart(2, '0')}`;
          const eq = `L${slot.eq.low <= -39.5 ? '✕' : Math.round(slot.eq.low)} M${slot.eq.mid <= -39.5 ? '✕' : Math.round(slot.eq.mid)} H${slot.eq.high <= -39.5 ? '✕' : Math.round(slot.eq.high)}`;
          return `**${label}** ${slot.playing ? '▶' : '⏸'} ${slot.source.title} — ${pos}/${Math.floor(slot.durationMs / 60000)}:${String(Math.floor((slot.durationMs % 60000) / 1000)).padStart(2, '0')} · ${slot.bpm ? `${slot.bpm} BPM` : 'bpm…'} · ${eq}`;
        };
        return [
          '🎛️ **Live decks**',
          line('A', st.a),
          line('B', st.b),
          `Crossfader ${Math.round(st.crossfader * 100)}% · open \`/deck\` for faders, EQ knobs and cue points.`,
          '`V@deck a <song>` · `play` · `pause` · `sync` · `cross 60` · `eq a low kill` · `stop`',
        ].join('\n');
      }
    }
  }

  private async mixTracks(s: Session, a: string, b: string, sec: number): Promise<string> {
    const d = Math.max(2, Math.min(20, sec || 6));
    const ra = (await resolvePlayInput(a).catch(() => []))[0];
    const rb = (await resolvePlayInput(b).catch(() => []))[0];
    if (!ra || !rb) return 'Need two resolvable tracks (links or names).';
    const ua = ra.streamUrl ?? (await EW.resolveCandidate(ra).catch(() => null))?.streamUrl;
    const ub = rb.streamUrl ?? (await EW.resolveCandidate(rb).catch(() => null))?.streamUrl;
    if (!ua || !ub) return 'Could not resolve a playable stream for one of those.';
    if (!s.voice.isJoined()) return 'Join a voice channel first (`V@j`), then mix.';
    // `/mix` hands ffmpeg two inputs directly, but ffmpeg's own HTTPS client 403s
    // on googlevideo (TLS fingerprint). Pull http(s) sources with Node first;
    // local files and HLS playlists pass straight through.
    const cleanup: string[] = [];
    const toInput = async (url: string): Promise<string | null> => {
      if (!/^https?:\/\//i.test(url)) return url;
      if (/\.m3u8(\?|$)/i.test(url)) return url; // ffmpeg demuxes HLS natively
      const file = await downloadToTempFile(url);
      if (file) cleanup.push(file);
      return file;
    };
    const ia = await toInput(ua);
    const ib = await toInput(ub);
    if (!ia || !ib) {
      for (const f of cleanup) await fs.rm(f, { force: true }).catch(() => {});
      return 'Could not download one of those tracks to mix.';
    }
    s.voice.playMix(ia, ib, { crossfadeSec: d, volume: s.queue.getState().volume, cleanup });
    return `🎚️ Mixing **${truncate(ra.name, 60)}** → **${truncate(rb.name, 60)}** with a ${d}s crossfade.`;
  }

  /** Auto-hype: on a strong beat, fire a short SFX for the primary guild (throttled). */
  private onBeat(): void {
    const guildId = this.bridge.getPrimaryGuildId();
    if (!guildId || !this.hypeGuilds.has(guildId)) return;
    const now = Date.now();
    if (now - (this.lastHypeAt.get(guildId) ?? 0) < 1800) return;
    const s = this.sessionFor(guildId);
    if (!s.voice.isJoined() || !s.queue.getState().playing) return;
    this.lastHypeAt.set(guildId, now);
    const hype = ['drop', 'zap', 'boom'];
    void s.playback.playSoundEffect(hype[Math.floor(Math.random() * hype.length)]);
  }

  /** 🧬 Song DNA card: a radar GIF of the current track's audio features. */
  private async dnaCard(s: Session): Promise<{ embed: EmbedBuilder; file: AttachmentBuilder } | string> {
    const cur = s.queue.getCurrentTrack();
    if (!cur) return 'Nothing is playing.';
    const f = await EW.fetchFeatures(cur).catch(() => null);
    if (!f) return `No audio-feature data for **${truncate(cur.name, 80)}** (Spotify tracks only).`;
    const metrics: RadarMetric[] = [
      { label: 'Energy', value: f.energy },
      { label: 'Dance', value: f.danceability },
      { label: 'Mood', value: f.valence },
      { label: 'Bright', value: 1 - (f.acousticness ?? 0) },
      { label: 'Instrumental', value: 1 - (f.instrumentalness ?? 0) },
    ];
    const accent = this.moodColor.get(s.guildId ?? '') ?? this.themeColor();
    const file = new AttachmentBuilder(renderRadarGif(metrics, accent), { name: 'dna.gif' });
    const embed = new EmbedBuilder()
      .setTitle('🧬 Song DNA')
      .setDescription(`**${truncate(cur.name, 80)}** — ${truncate((cur.artists ?? []).join(', '), 80)}`)
      .setColor(accent)
      .setImage('attachment://dna.gif')
      .addFields(
        metrics.map((m) => ({ name: m.label, value: `${Math.round(clamp01(m.value) * 100)}%`, inline: true })),
      );
    return { embed, file };
  }

  /** 🎨 Queue cover: a 2x2 mosaic of the queue's album art (ffmpeg xstack). */
  private async coverCard(s: Session): Promise<{ embed: EmbedBuilder; file: AttachmentBuilder } | string> {
    const tracks = s.queue
      .getSnapshot()
      .tracks.filter((t) => t.image)
      .slice(0, 4);
    if (tracks.length === 0) return 'No album art in the queue yet.';
    const dir = path.join(config.dataDir, 'tmp');
    await fs.mkdir(dir, { recursive: true });
    const stamp = Date.now();
    const paths: string[] = [];
    for (let i = 0; i < tracks.length; i++) {
      try {
        const res = await fetch(tracks[i].image!);
        if (!res.ok) continue;
        const p = path.join(dir, `cover-${stamp}-${i}.img`);
        await fs.writeFile(p, Buffer.from(await res.arrayBuffer()));
        paths.push(p);
      } catch {
        /* skip this image */
      }
    }
    if (paths.length === 0) return 'Could not download any album art.';
    const out = path.join(dir, `cover-${stamp}.png`);
    const ok = await renderCollage(paths, out);
    void Promise.all(paths.map((p) => fs.rm(p, { force: true }).catch(() => {})));
    if (!ok) return 'Could not build the collage.';
    const png = await fs.readFile(out).catch(() => null);
    void fs.rm(out, { force: true }).catch(() => {});
    if (!png) return 'Could not read the collage.';
    const file = new AttachmentBuilder(png, { name: 'cover.png' });
    const embed = new EmbedBuilder()
      .setTitle('🎨 Queue cover')
      .setColor(this.themeColor())
      .setImage('attachment://cover.png')
      .setFooter({ text: `${tracks.length} track${tracks.length === 1 ? '' : 's'}` });
    return { embed, file };
  }

  /** Server listening leaderboard (top DJs by queued, top artists by plays). */
  private leaderboardEmbed(guildId: string, me: string): EmbedBuilder {
    const users = this.stats.topUsers(guildId, 10);
    const artists = this.stats.topArtists(guildId, 10);
    const mine = this.stats.user(guildId, me);
    return new EmbedBuilder()
      .setTitle('🏆 Server listening stats')
      .setColor(this.moodColor.get(guildId) ?? this.themeColor())
      .addFields(
        {
          name: '🎧 Top DJs (queued)',
          value: users.length
            ? users.map(([u, s], i) => `${i + 1}. **${u}** — ${s.queued} queued · ${s.played} played`).join('\n')
            : 'No data yet.',
        },
        {
          name: '🎤 Top artists (played)',
          value: artists.length ? artists.map(([a, c], i) => `${i + 1}. **${a}** — ${c}`).join('\n') : 'No data yet.',
        },
      )
      .setFooter({ text: `You: ${mine.queued} queued · ${mine.played} played` });
  }

  /* ---------- mini-games (DJ Duel · Stump the Bot · Track Roulette) ---------- */

  /**
   * Spotify audio features for a track. A non-Spotify pick (YouTube, SoundCloud)
   * has no features of its own — look the same song up on Spotify first, because
   * a feature-less pick silently skips the two biggest scoring terms and would
   * otherwise score artificially high in every comparison.
   */
  private async featuresFor(track: TrackInfo): Promise<AudioFeatures | undefined> {
    const own = track.uri.startsWith('spotify:') ? extractSpotifyId(track.uri) : null;
    if (own) return (await getAudioFeatures([own]).catch(() => undefined))?.get(own);
    const query = [track.name, track.artists[0]].filter(Boolean).join(' ').trim();
    if (!query) return undefined;
    const hits = await searchTracks(query, 1).catch(() => [] as ResolvedTrack[]);
    const id = hits[0] ? extractSpotifyId(hits[0].uri) : null;
    if (!id) return undefined;
    return (await getAudioFeatures([id]).catch(() => undefined))?.get(id);
  }

  /**
   * Endless Wave's fit score for a track against this guild's current vibe.
   * Scored deterministically (no random tiebreaker) so a judged number is
   * reproducible, and with plain-English reasons attached.
   */
  private async trackFit(
    s: Session,
    track: TrackInfo,
  ): Promise<{ fit: number; insufficient: boolean; reasons: string[]; features: boolean }> {
    const st = s.endlessWave;
    const insufficient = st.recentFeatures.length === 0 && !st.anchor;
    const targets = EW.buildTargets(st);
    const env = EW.buildNeighbourhood(st);
    const features = await this.featuresFor(track);
    // Audio room-fit (cosine.club): how much this track sounds like the room's
    // recently played tracks. Best-effort and cached — undefined for seeds the
    // (electronic/underground) catalogue doesn't know.
    let cosineScore: number | undefined;
    if (cosineEnabled()) {
      const snap = s.queue.getSnapshot();
      const recent = snap.tracks
        .slice(Math.max(0, snap.currentIndex - 4), Math.max(0, snap.currentIndex) + 1)
        .map((t) => ({ name: t.name, artists: t.artists }));
      if (recent.length > 0) {
        cosineScore = await cosineRoomFit({ name: track.name, artists: track.artists, uri: track.uri }, recent).catch(
          () => undefined,
        );
      }
    }
    const candidate = {
      uri: track.uri,
      name: track.name,
      artists: track.artists,
      album: track.album ?? '',
      durationMs: track.durationMs,
      source: track.source ?? 'spotify',
      cosineScore,
    };
    const { total, terms } = EW.scoreBreakdown(candidate, targets, st.recentArtists ?? [], features, env, {
      jitter: false,
    });
    return { fit: fitPercent(total), insufficient, reasons: explainFit(terms), features: !!features };
  }

  /** A player's most recently queued track (their "pick" for duels/stump). */
  private lastPickBy(s: Session, username: string): TrackInfo | null {
    const mine = s.queue.getSnapshot().tracks.filter((t) => t.addedBy === username);
    if (mine.length === 0) return null;
    return mine.reduce((a, b) => (b.addedAt >= a.addedAt ? b : a));
  }

  /** Resolve a track by name/query for a game (Spotify first, then YouTube). */
  private async findTrackTrack(query: string): Promise<ResolvedTrack | null> {
    let cand = await searchCandidates(query, 1).catch(() => [] as ResolvedTrack[]);
    if (cand.length === 0) cand = await searchYoutube(query, 1).catch(() => [] as ResolvedTrack[]);
    return cand[0] ?? null;
  }

  /** Open a Stump-the-Bot wager on the player's pick (or a named track). */
  private async gameStump(
    s: Session,
    userName: string,
    query: string | undefined,
    userId: string,
  ): Promise<string | { content: string; components: ActionRowBuilder<ButtonBuilder>[] }> {
    const gid = s.guildId ?? '';
    let track: TrackInfo | null;
    // A named track is a genuine silent guess: the bot searched the text and
    // queued whatever won. Keep the very same swap row any other guess gets.
    let row: ActionRowBuilder<ButtonBuilder>[] | undefined;
    if (query) {
      const found = await this.findTrackTrack(query);
      if (!found) return `🔎 Couldn't find “${query}”.`;
      s.queue.enqueue(
        {
          uri: found.uri,
          name: found.name,
          artists: found.artists,
          album: found.album ?? '',
          durationMs: found.durationMs,
          source: found.source,
          image: found.image,
        },
        userName,
      );
      track = s.queue.getSnapshot().tracks.find((t) => t.uri === found.uri) ?? null;
      if (!track) return `Queued *${found.name}* but couldn't track it for the bet — try again.`;
      const items = buildSwapItems([found], query);
      if (items) row = this.registerSwap({ guildId: gid, userId, addedBy: userName, mode: 'queue', items });
    } else {
      track = this.lastPickBy(s, userName);
    }
    if (!track)
      return 'Queue something first (`V@p <track>`), then bet on it with `V@stump`.\n_New here? `V@games` explains how these work._';
    const { fit, insufficient, reasons, features } = await this.trackFit(s, track);
    if (insufficient) {
      const text =
        '🤖 Not enough listening history for me to judge a fit yet — play a few tracks, then try again. (No bet placed.)\n_New here? `V@games` explains how these work._';
      return row ? { content: text, components: row } : text;
    }
    const prev = this.stumps.get(gid);
    const snap = s.queue.getSnapshot();
    const idx = snap.tracks.findIndex((t) => t.uri === track.uri);
    const place = idx >= 0 ? `#${idx + 1} in the queue` : 'somewhere in the queue';
    this.stumps.set(gid, {
      uri: track.uri,
      user: userName,
      fit,
      name: track.name,
      channelId: this.lastTextChannel.get(gid) ?? this.perms.getNpChannel(gid) ?? '',
    });
    const playing = s.voice.isJoined();
    const text = [
      `🤖 **Stump the Bot** — I rate *${track.name}* a **${fit}/100** room fit (${describeFit(fit)}).`,
      reasons.length > 0 ? `Why: ${reasons.join(' · ')}` : '',
      features ? '' : '_No audio features for this one, so I judged it on artist/genre only._',
      prev ? `_(Replacing your earlier bet on *${prev.name}*.)_` : '',
      `It settles when it plays — currently **${place}**. Play it through → you win. Skipped → I win.`,
      playing ? '' : '_Run `/follow` or `/join` so it can actually play._',
      row ? '_Wrong song? Fix it right here before it plays._' : '',
    ]
      .filter(Boolean)
      .join('\n');
    return row ? { content: text, components: row } : text;
  }

  /** Resolve a pending Stump bet when its track ends naturally or is skipped. */
  private resolveStump(s: Session, track: TrackInfo, skipped: boolean): void {
    const gid = s.guildId ?? '';
    const bet = this.stumps.get(gid);
    if (!bet || bet.uri !== track.uri) return;
    this.stumps.delete(gid);
    const g = gamesStore.get(gid);
    const humans = Object.values(g.stumpWins).reduce((a, b) => a + b, 0);
    let msg: string;
    if (skipped) {
      const botWins = gamesStore.addBotWin(gid);
      msg =
        `🤖 **Skipped** — the bot called it. *${track.name}* was rated **${bet.fit}/100** and the room disagreed.\n` +
        `_Score — bot ${botWins} · humans ${humans}_`;
    } else {
      const wins = gamesStore.addStumpWin(gid, bet.user);
      msg =
        `🏆 **${bet.user} stumps the bot!** *${track.name}* played all the way through — I rated it ${bet.fit}/100.\n` +
        `_Score — bot ${g.botWins} · humans ${humans + 1} · ${bet.user} has ${wins} win${wins === 1 ? '' : 's'}_`;
    }
    const channelId = bet.channelId || this.perms.getNpChannel(gid);
    if (!channelId) return;
    void (async () => {
      const ch = await this.client.channels.fetch(channelId).catch(() => null);
      if (ch && 'send' in ch) await ch.send(msg).catch(() => {});
    })();
  }

  /**
   * Resolve a pending DJ Duel when one of its tracks reaches its fate. Both
   * sides must resolve before the verdict: a track that played through is worth
   * a point, a skipped one is worth nothing — and we also record whether the
   * bot's pre-play prediction matched what the room actually did.
   */
  private noteDuelOutcome(s: Session, track: TrackInfo, skipped: boolean): void {
    const gid = s.guildId ?? '';
    const duel = this.duels.get(gid);
    if (!duel) return;
    const side = duel.a.uri === track.uri ? duel.a : duel.b.uri === track.uri ? duel.b : null;
    if (!side) return;
    side.outcome = skipped ? 'skipped' : 'played';
    if (!duel.a.outcome || !duel.b.outcome) return;
    this.duels.delete(gid);
    const { a, b, predicted } = duel;
    const line = (x: typeof a) =>
      `**${x.user}** — *${x.name}* · ${x.outcome === 'played' ? 'played through ✅' : 'skipped ❌'} (fit ${x.fit})`;
    const winner = a.outcome === b.outcome ? null : a.outcome === 'played' ? a.user : b.user;
    const bits: string[] = ['🎚️ **DJ Duel — result**', line(a), line(b)];
    if (!winner) {
      bits.push(
        `🤝 The room couldn't split them — both ${a.outcome === 'played' ? 'played through' : 'got skipped'}. No point awarded.`,
      );
      if (!predicted) bits.push('🤖 The bot called it a dead heat — correct.');
    } else {
      const wins = gamesStore.addDuelWin(gid, winner);
      bits.push(
        `🏆 **${winner}** takes the point (${wins} win${wins === 1 ? '' : 's'}) — the room let their pick play.`,
      );
      if (predicted) {
        const right = predicted === winner;
        const acc = gamesStore.noteDuelOutcome(gid, right);
        bits.push(
          right
            ? `🤖 The bot predicted **${predicted}** — correct. _(model accuracy ${acc.correct}/${acc.total})_`
            : `🤖 The bot predicted **${predicted}** — wrong. _(model accuracy ${acc.correct}/${acc.total})_`,
        );
      }
    }
    const channelId = duel.channelId || this.perms.getNpChannel(gid);
    if (!channelId) return;
    void (async () => {
      const ch = await this.client.channels.fetch(channelId).catch(() => null);
      if (ch && 'send' in ch) await ch.send(bits.join('\n')).catch(() => {});
    })();
  }

  /**
   * Void bets whose track left the queue before it could play, and drop stale
   * duels. Runs on every queue change (cheap — it exits immediately when a guild
   * has no pending bet).
   */
  private expireBets(s: Session): void {
    const gid = s.guildId ?? '';
    const live = (uri: string): boolean => {
      const snap = s.queue.getSnapshot();
      return snap.tracks.some((t) => t.uri === uri) || s.queue.getCurrentTrack()?.uri === uri;
    };
    const bet = this.stumps.get(gid);
    if (bet && !live(bet.uri)) {
      this.stumps.delete(gid);
      if (bet.channelId) {
        void (async () => {
          const ch = await this.client.channels.fetch(bet.channelId).catch(() => null);
          if (ch && 'send' in ch) {
            await ch.send(`🤖 Your bet on *${bet.name}* is void — it left the queue before it played.`).catch(() => {});
          }
        })();
      }
    }
    const duel = this.duels.get(gid);
    if (duel && (Date.now() - duel.at > 60 * 60_000 || (!live(duel.a.uri) && !live(duel.b.uri)))) {
      this.duels.delete(gid);
    }
  }

  /** DJ Duel: score both players' picks, then let the room decide (or `now` for an instant verdict). */
  private async gameDuel(
    s: Session,
    me: string,
    opponent?: string,
    opts: { now?: boolean } = {},
  ): Promise<string | EmbedBuilder> {
    const gid = s.guildId ?? '';
    const g = gamesStore.get(gid);
    if (!opponent) {
      const rows = gamesStore.topOf(g.duelWins, 10);
      const acc = g.duelAccuracy;
      return new EmbedBuilder()
        .setTitle('🎚️ DJ Duel — leaderboard')
        .setColor(this.moodColor.get(gid) ?? this.themeColor())
        .setDescription(
          (rows.length
            ? rows.map(([u, n], i) => `${i + 1}. **${u}** — ${n} win${n === 1 ? '' : 's'}`).join('\n')
            : 'No duels yet. Each player queues a track, then `V@duel @them`.') +
            (acc.total > 0
              ? `\n\n🤖 The bot has predicted the room's verdict **${acc.correct}/${acc.total}** times.`
              : ''),
        )
        .setFooter({ text: 'Room fit is 0-100 (higher is better) · V@games for the rules' });
    }
    if (opponent.toLowerCase() === me.toLowerCase()) return "You can't duel yourself — pick someone else.";
    const a = this.lastPickBy(s, me);
    const b = this.lastPickBy(s, opponent);
    if (!a || !b) {
      const missing = [!a ? me : null, !b ? opponent : null].filter(Boolean).join(' and ');
      return `🎚️ I need a queued pick from **${missing}** first — each of you queue a track (\`V@p <track>\`), then re-run \`V@duel\`.`;
    }
    if (a.uri === b.uri) return 'Both picks are the same track — queue different songs for a proper duel.';
    const [fa, fb] = await Promise.all([this.trackFit(s, a), this.trackFit(s, b)]);
    if (fa.insufficient || fb.insufficient) {
      return '🤖 Not enough listening history for a fair duel yet — play a few tracks first.\n_New here? `V@games`._';
    }
    const line = (who: string, t: TrackInfo, f: number) => `**${who}** — *${t.name}* · **${f}/100**`;
    const predicted = fa.fit === fb.fit ? '' : fa.fit > fb.fit ? me : opponent;

    if (opts.now) {
      // Instant verdict — the model alone, no room vote.
      if (!predicted) {
        return `🎚️ **Dead heat!**\n${line(me, a, fa.fit)}\n${line(opponent, b, fb.fit)}\nBoth fit equally — no point awarded.`;
      }
      const wins = gamesStore.addDuelWin(gid, predicted);
      return (
        `🎚️ **DJ Duel** — the bot judges **${predicted}**'s pick the better fit.\n` +
        `${line(me, a, fa.fit)}\n${line(opponent, b, fb.fit)}\n\n` +
        `🏆 **${predicted}** takes the point (${wins} win${wins === 1 ? '' : 's'}).`
      );
    }

    this.duels.set(gid, {
      channelId: this.lastTextChannel.get(gid) ?? this.perms.getNpChannel(gid) ?? '',
      at: Date.now(),
      predicted,
      a: { user: me, uri: a.uri, name: a.name, fit: fa.fit },
      b: { user: opponent, uri: b.uri, name: b.name, fit: fb.fit },
    });
    return [
      `🎚️ **DJ Duel** — ${me} vs ${opponent}. Room fit, scored right now:`,
      `${line(me, a, fa.fit)}${fa.reasons.length ? `\n> ${fa.reasons.join(' · ')}` : ''}`,
      `${line(opponent, b, fb.fit)}${fb.reasons.length ? `\n> ${fb.reasons.join(' · ')}` : ''}`,
      predicted
        ? `🤖 The bot predicts **${predicted}** — but the room has the final say: a track that plays through earns a point, a skipped one earns nothing.`
        : '🤖 The bot calls it a dead heat — the room decides.',
      "_I'll post the verdict once both songs have played. `V@games` for the rules._",
    ].join('\n');
  }

  /** ⭐ / 🚫 / 🎲 buttons for one roulette offer. */
  private rouletteRow(nonce: string): ActionRowBuilder<ButtonBuilder>[] {
    return [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`roulette:star:${nonce}`)
          .setLabel('Save to Hall of Fame')
          .setEmoji('⭐')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`roulette:ban:${nonce}`)
          .setLabel('Ban for everyone')
          .setEmoji('🚫')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(`roulette:spin:${nonce}`)
          .setLabel('Spin again')
          .setEmoji('🎲')
          .setStyle(ButtonStyle.Secondary),
      ),
    ];
  }

  /** Track Roulette: pull a random track from this server's own history. */
  private async gameRoulette(
    s: Session,
    userName: string,
    excludeKey?: string,
  ): Promise<string | { content: string; components: ActionRowBuilder<ButtonBuilder>[] }> {
    const gid = s.guildId ?? '';
    const history = this.stats.historyTracks(gid, 300);
    if (history.length < 5) {
      return '🎲 Not enough history yet — play a handful of tracks and spin again.\n_New here? `V@games`._';
    }
    const counts = new Map(history);
    const queued = s.queue.getSnapshot().tracks.map((t) => trackKey(t.name, t.artists));
    // Weighted toward DEEP CUTS — uniform picking just resurfaced the songs the
    // server already plays constantly, which is the opposite of a surprise.
    const banned = gamesStore.get(gid).banned;
    const key = pickRouletteWeighted(history, excludeKey ? [...banned, excludeKey] : banned, queued);
    if (!key) return '🎲 Everything worth spinning is already queued or banned.';
    const found = await this.findTrackTrack(keyToQuery(key));
    if (!found) return `🎲 Pulled *${keyToQuery(key)}* from your history but couldn't find a playable match.`;
    s.queue.enqueue(
      {
        uri: found.uri,
        name: found.name,
        artists: found.artists,
        album: found.album ?? '',
        durationMs: found.durationMs,
        source: found.source,
        image: found.image,
      },
      userName,
    );
    // Play it NEXT, so the decision and the song actually meet instead of the
    // track landing an hour later when everyone forgot the offer.
    const after = s.queue.getSnapshot();
    const from = after.tracks.findIndex((t) => t.uri === found.uri);
    const to = after.currentIndex + 1;
    if (from >= 0 && to >= 0 && to < after.tracks.length && from !== to) s.queue.move(from, to);
    // Keep the offer map bounded — old offers just expire.
    if (this.rouletteOffers.size > 50) {
      const oldest = this.rouletteOffers.keys().next().value;
      if (oldest) this.rouletteOffers.delete(oldest);
    }
    const nonce = Math.random().toString(36).slice(2, 10);
    this.rouletteOffers.set(nonce, {
      guildId: gid,
      key,
      userId: userName,
      track: {
        uri: found.uri,
        name: found.name,
        artists: found.artists,
        album: found.album ?? '',
        durationMs: found.durationMs,
        source: found.source,
        image: found.image,
      },
    });
    const row = this.rouletteRow(nonce);
    const plays = counts.get(key) ?? 1;
    return {
      content:
        `🎲 **Track Roulette** — spun **${found.name}** — ${found.artists.join(', ') || 'unknown artist'} ` +
        `out of this server's own history (played just ${plays}×). It's queued **next**.\n` +
        `⭐ **Save to Hall of Fame** — keeps it in a \`Hall of Fame\` playlist (anyone can add).\n` +
        `🚫 **Ban for everyone** — never spins that song here again (and skips it if it's on now).\n` +
        `🎲 **Spin again** — drop this one and pull another deep cut.` +
        (s.voice.isJoined() ? '' : '\n_Run `/join` so it can play._'),
      components: row,
    };
  }

  /** Handle the roulette ⭐/🚫 buttons. */
  private async handleRouletteButton(interaction: ButtonInteraction): Promise<void> {
    const [, action, nonce] = interaction.customId.split(':');
    const offer = nonce ? this.rouletteOffers.get(nonce) : undefined;
    if (!offer) {
      {
        const r = await interaction
          .reply({
            content: 'That roulette offer has expired — spin again with `V@roulette`.',
            flags: MessageFlags.Ephemeral,
          })
          .catch(() => null);
        if (r) this.autoExpireNotice(r);
      }
      return;
    }
    const gid = offer.guildId;
    const s = this.sessionFor(gid);
    if (action === 'spin') {
      // Re-roll before touching the old pick: if there is nothing else left to
      // spin, keep the offer (and its buttons) exactly as they were.
      const res = await this.gameRoulette(s, offer.userId, offer.key);
      if (typeof res === 'string') {
        await interaction.update({ content: res, components: this.rouletteRow(nonce) }).catch(() => {});
        return;
      }
      // Drop the previous pick — unless it is what's playing right now.
      const cur = s.queue.getCurrentTrack();
      if (cur?.uri !== offer.track.uri) {
        const prevIdx = s.queue.getSnapshot().tracks.findIndex((t) => t.uri === offer.track.uri);
        if (prevIdx >= 0) s.queue.remove(prevIdx);
      }
      this.rouletteOffers.delete(nonce);
      await interaction.update({ content: res.content, components: res.components }).catch(() => {});
      return;
    }
    this.rouletteOffers.delete(nonce);
    if (action === 'star') {
      const n = gamesStore.star(gid, interaction.user.username);
      playlistStore.appendTrack(gid, 'Hall of Fame', offer.track);
      await interaction
        .reply({
          content: `⭐ **${offer.track.name}** is in the Hall of Fame — saved to the \`Hall of Fame\` playlist (your ${n} star${n === 1 ? '' : 's'}).`,
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => {});
      return;
    }
    gamesStore.ban(gid, offer.key);
    const cur = s.queue.getCurrentTrack();
    let note: string;
    if (cur?.uri === offer.track.uri) {
      if (!this.perms.getVoteSkip(gid)) {
        s.playback.next();
        note = ' — skipping it now.';
      } else {
        note = ' (vote-skip is on here, so use `/skip` to drop it).';
      }
    } else {
      const idx = s.queue.getSnapshot().tracks.findIndex((t) => t.uri === offer.track.uri);
      if (idx >= 0) {
        s.queue.remove(idx);
        note = ' — removed from the queue.';
      } else {
        note = '.';
      }
    }
    await interaction
      .reply({ content: `🚫 Banned **${offer.track.name}** from roulette${note}`, flags: MessageFlags.Ephemeral })
      .catch(() => {});
  }

  /** /similar — queue one or all of the cosine-similar candidates. */
  private async handleSimilarButton(interaction: ButtonInteraction): Promise<void> {
    const [, action, nonce] = interaction.customId.split(':');
    const stash = nonce ? this.similarPending.get(nonce) : undefined;
    if (!stash || stash.tracks.length === 0) {
      {
        const r = await interaction
          .reply({ content: 'That list expired — run `/similar` again.', flags: MessageFlags.Ephemeral })
          .catch(() => null);
        if (r) this.autoExpireNotice(r);
      }
      return;
    }
    if (!this.canUse('play', interaction)) {
      await interaction
        .reply({ content: "⛔ You don't have permission to queue tracks.", flags: MessageFlags.Ephemeral })
        .catch(() => {});
      return;
    }
    const s = this.sessionFor(interaction.guildId);
    const picks = action === 'one' ? [stash.tracks[Math.floor(Math.random() * stash.tracks.length)]] : stash.tracks;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    let queued = 0;
    let failed = 0;
    const added: { uri: string; label: string; query?: string }[] = [];
    for (let i = 0; i < picks.length; i++) {
      try {
        const info = await EW.resolveCandidate(picks[i]);
        if (info) {
          s.queue.enqueue(info, interaction.user.username);
          // Queue-all: each track came from the list, so its own title is the
          // natural "pick another" query. Surprise-me: leave it clean and let
          // the pool power "Roll again" instead.
          added.push({
            uri: info.uri,
            label: swapLabel(info),
            ...(action === 'one' ? {} : { query: trackQuery(picks[i]) }),
          });
          queued++;
        } else {
          failed++;
        }
      } catch {
        failed++;
      }
      if (picks.length > 2) {
        await interaction.editReply(`➕ Queuing… ${i + 1}/${picks.length}`).catch(() => {});
      }
    }
    const text =
      `✅ Queued **${queued}** track${queued === 1 ? '' : 's'} from the cosine.club list` +
      (failed ? ` — ${failed} couldn't be resolved.` : '.');
    const components =
      added.length > 0
        ? this.registerSwap({
            guildId: interaction.guildId ?? '',
            userId: interaction.user.id,
            addedBy: interaction.user.username,
            mode: 'queue',
            items: added,
            // The pick is no longer a roll candidate; the rest of the list is.
            pool: action === 'one' ? stash.tracks.filter((t) => t !== picks[0]) : undefined,
          })
        : [];
    await interaction.editReply({ content: text, components }).catch(() => {});
  }

  /** Split a `V@config` line into `key value` clauses (`;`/newline separated). */
  private parseConfigClauses(input: string): Array<{ key: string; value: string }> {
    const out: Array<{ key: string; value: string }> = [];
    for (const part of String(input ?? '').split(/[;\n]+/)) {
      const t = part.trim();
      if (!t) continue;
      const m = t.match(/^([a-zA-Z]+)\s*[:=]?\s*(.*)$/);
      if (!m) continue;
      out.push({ key: m[1].toLowerCase(), value: (m[2] ?? '').trim().toLowerCase() });
    }
    return out;
  }

  /** Apply one `key value` config clause. Returns a short human label. */
  private applyConfigClause(s: Session, gid: string, key: string, value: string): string {
    const off = /^(off|false|no|0|none|disable)$/.test(value);
    const on = /^(on|true|yes|1|enable)$/.test(value);
    switch (key) {
      case 'bass':
      case 'bassboost': {
        if (off || !value) {
          s.playback.setBassBoost(0);
          return 'bass off';
        }
        const db = Math.min(12, Math.max(2, Math.round(Number.parseFloat(value.replace(/[^0-9.]/g, '')) || 0)));
        s.playback.setBassBoost(db);
        return `bass +${db}dB`;
      }
      case 'crossfade':
      case 'xfade': {
        let ms: number;
        if (on) ms = getCrossfadeMs(gid) || config.crossfadeMs || 6000;
        else if (off || !value) ms = 0;
        else {
          const sec = Number.parseFloat(value.replace(/s$/, ''));
          if (!Number.isFinite(sec) || sec < 0 || sec > 15) return 'crossfade: use 0–15s';
          ms = Math.round(sec * 1000);
        }
        const applied = setCrossfadeMs(gid, ms);
        s.playback.setCrossfade(applied);
        return applied > 0 ? `crossfade ${(applied / 1000).toFixed(1)}s` : 'crossfade off';
      }
      case 'norm':
      case 'normalize': {
        s.playback.setLoudnorm(!off);
        return `norm ${!off ? 'on' : 'off'}`;
      }
      case 'eq': {
        const preset = value || 'flat';
        if (!s.playback.setEq(preset)) return `eq: unknown "${preset}"`;
        return `eq ${preset}`;
      }
      case 'speed': {
        const f =
          value === 'nightcore'
            ? 1.25
            : value === 'slowed'
              ? 0.85
              : !value || value === 'normal'
                ? 1
                : Number.parseFloat(value);
        if (!Number.isFinite(f) || f <= 0) return 'speed: bad value';
        s.playback.setSpeed(f);
        return `speed ${f.toFixed(2)}×`;
      }
      case 'ew':
      case 'autoplay':
      case 'endwav': {
        const mode = off ? 'off' : value === 'basic' ? 'basic' : 'smart';
        EW.setMode(s.endlessWave, mode);
        return `autoplay ${mode}`;
      }
      case 'mood': {
        if (off) this.moodOn.delete(gid);
        else this.moodOn.add(gid);
        return `mood ${off ? 'off' : 'on'}`;
      }
      case 'tts': {
        this.perms.setTts(gid, !off);
        return `tts ${!off ? 'on' : 'off'}`;
      }
      case 'ambient': {
        this.perms.setAmbient(gid, !off);
        return `ambient ${!off ? 'on' : 'off'}`;
      }
      case 'duck':
      case 'duckmode': {
        const mode = value === 'auto' || value === 'hosts' ? value : 'off';
        this.perms.setDuckMode(gid, mode);
        return `duck ${mode}`;
      }
      case 'voteskip':
      case 'vs': {
        this.perms.setVoteSkip(gid, !off);
        return `voteskip ${!off ? 'on' : 'off'}`;
      }
      case 'repeat': {
        s.playback.setRepeat(!off);
        return `repeat ${!off ? 'on' : 'off'}`;
      }
      case 'shuffle': {
        s.playback.shuffle(!off);
        return `shuffle ${!off ? 'on' : 'off'}`;
      }
      default:
        return `? ${key}`;
    }
  }

  /** The `V@config` reply: applied clauses + the recently used ones. */
  private async runConfig(s: Session, gid: string, input: string): Promise<string> {
    const clauses = this.parseConfigClauses(input);
    if (clauses.length === 0) {
      const recent = this.recentConfig.get(gid) ?? [];
      return [
        '🎛️ **Config** — set several things at once:',
        '`V@config bass +3; crossfade 2; norm on; ew smart`',
        '',
        'Keys: `bass <dB>` · `crossfade <0-15|on|off>` · `norm <on|off>` · `eq <preset>` · `speed <nightcore|slowed|normal>`',
        '`ew <off|basic|smart>` · `mood <on|off>` · `tts <on|off>` · `ambient <on|off>` · `duck <off|auto|hosts>` · `voteskip <on|off>` · `repeat <on|off>` · `shuffle <on|off>`',
        recent.length ? `\n**Recently used here:** \`${recent[0]}\`` : '',
      ].join('\n');
    }
    const applied: string[] = [];
    for (const { key, value } of clauses) applied.push(this.applyConfigClause(s, gid, key, value));
    const line = input.trim();
    const recent = this.recentConfig.get(gid) ?? [];
    this.recentConfig.set(gid, [line, ...recent.filter((x) => x !== line)].slice(0, 5));
    return `🎛️ Applied ${applied.length} setting${applied.length === 1 ? '' : 's'}: ${applied.join(' · ')}`;
  }

  /** /follow — turn the live now-playing strip on or off. It FOLLOWS the room
   *  (see maybeAutoMiniNp); `/npchannel` is the pin-it-to-one-channel variant. */
  private async followNowPlaying(gid: string, _channelId: string, off: boolean): Promise<string> {
    if (off) {
      this.perms.setNpAuto(gid, false);
      this.perms.setNpChannel(gid, null);
      await this.clearMiniNp(gid);
      return '🌙 Now-playing strip **off** — it will stop updating. Turn it back on with `V@follow`.';
    }
    this.perms.setNpAuto(gid, true);
    // Follow means follow the room, so do NOT pin a channel here. Pinning was
    // what made the strip stay behind in whatever channel /follow was first run
    // in — a later rejoin then kept posting to a channel nobody was watching,
    // which looked exactly like follow being off. Use /npchannel to pin one.
    this.perms.setNpChannel(gid, null);
    this.miniTrackUri.delete(gid);
    // Post it immediately instead of waiting for the next track change.
    void this.maybeAutoMiniNp(gid, this.sessionFor(gid).queue.getState());
    return (
      '📌 **Following** — the live now-playing strip follows the room and updates with every new song.\n' +
      'Pin it to one channel with `/npchannel`, or turn it off with `V@follow off`.'
    );
  }

  /** "How the games work" — the plain-English rules, for anyone new. */
  private gamesEmbed(): EmbedBuilder {
    return new EmbedBuilder()
      .setTitle('🎮 Vaporzr Games — how to play')
      .setColor(this.themeColor())
      .setDescription(
        'One shared idea: the bot is always watching what the room is playing, and it can rate how well any song ' +
          '**fits the vibe right now**. That rating is the **room fit — a score out of 100, higher is better.**',
      )
      .addFields(
        {
          name: '🤖 Stump the Bot — `V@stump [track]`',
          value:
            '1. Queue a song you believe in (`V@p …`), or name one: `V@stump daft punk one more time`.\n' +
            '2. The bot gives it a **room fit score out of 100**, out loud.\n' +
            '3. It plays: **plays through → you win.** **Somebody skips it → the bot wins.**\n' +
            '4. `V@stump board` — humans vs the bot.',
        },
        {
          name: '🎚️ DJ Duel — `V@duel @friend`',
          value:
            '1. You each queue one song (`V@p …`).\n' +
            '2. Type `V@duel @yourfriend` — the bot scores both picks and says which fits the room better, and **why**.\n' +
            '3. Then the room decides: whichever song **plays through** earns the point, and the bot reports whether its own prediction matched.\n' +
            '4. `V@duel` — leaderboard + how often the bot called it right. Add `now` for an instant verdict.',
        },
        {
          name: '🎲 Track Roulette — `V@roulette`',
          value:
            "1. The bot pulls a song out of **your own server's history**, leaning toward ones you rarely play, and queues it **next**.\n" +
            '2. ⭐ **Save to Hall of Fame** — keeps it forever (a `Hall of Fame` playlist you can `V@load`).\n' +
            '3. 🚫 **Ban for everyone** — never spins that song here again.\n' +
            '4. Spin as often as you like — bans are remembered.',
        },
      )
      .setFooter({ text: 'Room fit is 0-100, higher is better · V@help games for the one-liners' });
  }

  /** Spotify-Wrapped-style monthly recap for a guild ('YYYY-MM'). */
  private wrappedEmbed(guildId: string, month: string): EmbedBuilder {
    const w = this.stats.wrapped(guildId, month);
    const hours = (ms: number) => {
      const h = Math.floor(ms / 3_600_000);
      const m = Math.round((ms % 3_600_000) / 60_000);
      return h > 0 ? `${h}h ${m}m` : `${m}m`;
    };
    const [y, mo] = month.split('-');
    const monthName = new Date(Date.UTC(Number(y), Number(mo) - 1, 1)).toLocaleString('en-US', {
      month: 'long',
      year: 'numeric',
    });
    const ranked = (rows: Array<[string, number]>) =>
      rows.length ? rows.map(([t, n], i) => `${i + 1}. ${truncate(t, 44)} — **${n}x**`).join('\n') : '_nothing yet_';
    return new EmbedBuilder()
      .setTitle(`🎧 Server Wrapped — ${monthName}`)
      .setColor(this.moodColor.get(guildId) ?? this.themeColor())
      .setDescription(
        `**${hours(w.playedMs)}** of music · **${w.plays}** track${w.plays === 1 ? '' : 's'} played · **${w.queued}** queued` +
          (w.biggestDay ? `\nBiggest listening day: **${w.biggestDay[0]}** (${hours(w.biggestDay[1])})` : ''),
      )
      .addFields(
        { name: '🎵 Top tracks', value: ranked(w.topTracks), inline: true },
        { name: '🎤 Top artists', value: ranked(w.topArtists), inline: true },
        { name: '🎧 Top DJs', value: ranked(w.topDjs), inline: true },
      )
      .setFooter({
        text: `All-time: ${hours(w.allTimeMs)} of music · ${w.allTimeQueued} tracks queued · V@wrapped last → previous month`,
      });
  }

  private accessWatch: NodeJS.Timeout | null = null;

  /**
   * DM the owner when a new web device signs in. Access sessions live in a
   * file, so this polls; the first tick seeds the known ids and stays silent.
   */
  private startAccessWatch(): void {
    if (this.accessWatch) return;
    const seen = new Set(listAccess().sessions.map((x) => x.id));
    this.accessWatch = setInterval(() => {
      for (const s of listAccess().sessions) {
        if (seen.has(s.id)) continue;
        seen.add(s.id);
        void this.notifyNewDevice(s);
      }
    }, 60_000);
    this.accessWatch.unref?.();
  }

  private async notifyNewDevice(s: AccessSession): Promise<void> {
    if (!config.ownerId) return;
    try {
      const user = await this.client.users.fetch(config.ownerId);
      await user.send(
        `**A new device opened the Vaporzr web panel.**\n\n` +
          `**Where:** ${describeUserAgent(s.lastUserAgent)} - ${describeAddress(s.lastIp)}\n` +
          `**Access:** ${describeScope(s.scope)}\n` +
          `**Came from:** ${describeLabel(s.label)}\n` +
          `**Device id:** \`${s.id}\`\n\n` +
          `If that was you, nothing to do.\n` +
          `If not: \`/key revoke ${s.id}\` removes just that device, or \`/key rotate\` removes every device and issues a new key.`,
      );
    } catch {
      /* DMs closed or owner offline */
    }
  }

  /** Shared reference for both `/help` and `V@help`. */
  private helpEmbed(): EmbedBuilder {
    const panel = vizTunnel.panelLink();
    const viz = vizTunnel.vizLink();
    const listen = vizTunnel.listenLink();
    const catLines = HELP_CATEGORIES.map((c) => `${c.emoji}  **${c.name}** — ${c.blurb}`).join('\n');
    const avatar = this.client.user?.displayAvatarURL({ size: 128 });
    // Public embed: secure links only. A LAN address is an admin-only detail,
    // so when no secure base is configured we point at the commands instead.
    const web: string[] = [];
    if (panel.secure) web.push(`[panel](${panel.url})`);
    if (viz.secure) web.push(`[visualizer](${viz.url})`);
    if (listen.secure) web.push(`[hi-fi listener](${listen.url})`);
    const webLine = web.length
      ? `**Web** — ${web.join(' · ')}`
      : '**Web** — `/panel`, `/viz`, `/listen` open the secure links';

    const embed = new EmbedBuilder()
      .setTitle('Vaporzr')
      .setDescription(`*music · autoplay · weasel ai · visuals · games*\n\n${catLines}\n\n${webLine}`)
      .setColor(this.helpColor())
      .addFields({
        name: "✨ what's new",
        value:
          "`/listen` — the bot's full-quality audio in a browser, with a sound-check panel\n" +
          '`/diag` — now shows the **live** Opus bitrate, not just the target\n' +
          '`V@w roast` — The Weasel roasts anyone · `V@w say` — Pauly Shore voice drops',
      })
      .setFooter({
        text: 'V@help all — every command · V@help aliases — every shortcut · V@help <category> — jump',
      });
    if (avatar) embed.setThumbnail(avatar);
    return embed;
  }

  /** "See everything": every help line, packed into as few messages as Discord allows. */
  private helpAllEmbeds(): EmbedBuilder[] {
    const fields = packCategoryFields(HELP_CATEGORIES.map((c) => ({ name: `${c.emoji} ${c.name}`, lines: c.lines })));
    const pages = chunkFieldsIntoEmbeds(fields);
    return pages.map((page, i) =>
      new EmbedBuilder()
        .setTitle(`Every command · ${i + 1}/${pages.length}`)
        .setDescription('*the complete reference — nothing truncated*')
        .setColor(this.helpColor())
        .addFields(...page)
        .setFooter({
          text: 'V@help aliases — shortcut index · V@help <category> — just one section',
        }),
    );
  }

  /** The complete V@ shortcut index, generated from the dispatcher's own table. */
  private helpAliasesEmbed(): EmbedBuilder {
    return new EmbedBuilder()
      .setTitle('Shortcuts')
      .setDescription('Type `V@<shortcut>` in any channel the bot can read. `/` slash commands run the same defaults.')
      .setColor(this.helpColor())
      .addFields(...aliasIndexFields(V_ALIASES))
      .setFooter({ text: 'V@help for the menu · V@help all for full descriptions' });
  }

  /** Category buttons for the help overview (max 5 per row). */
  private helpButtons(): ActionRowBuilder<ButtonBuilder>[] {
    const rows: ActionRowBuilder<ButtonBuilder>[] = [];
    for (let i = 0; i < HELP_CATEGORIES.length; i += 5) {
      const row = new ActionRowBuilder<ButtonBuilder>();
      for (const c of HELP_CATEGORIES.slice(i, i + 5)) {
        row.addComponents(
          new ButtonBuilder()
            .setCustomId(`vzhelp:${c.id}`)
            .setLabel(c.name)
            .setEmoji(c.emoji)
            .setStyle(ButtonStyle.Secondary),
        );
      }
      rows.push(row);
    }
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId('vzhelp:all')
          .setLabel('All commands')
          .setEmoji('📖')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('vzhelp:aliases')
          .setLabel('Shortcuts')
          .setEmoji('⌨️')
          .setStyle(ButtonStyle.Secondary),
      ),
    );
    return rows;
  }

  /** Detailed embed for one help category (or null if unknown). */
  private helpCategoryEmbed(id: string): EmbedBuilder | null {
    const q = id.trim().toLowerCase();
    const aliasId = q === 'ai' || q === 'w' || q === 'amok' || q === 'pauly' ? 'weasel' : q;
    const idx = HELP_CATEGORIES.findIndex((x) => x.id === aliasId || x.name.toLowerCase() === aliasId);
    if (idx < 0) return null;
    const c = HELP_CATEGORIES[idx];
    return new EmbedBuilder()
      .setTitle(`${c.emoji}  ${c.name}`)
      .setDescription(`*${c.blurb}*\n\n${c.lines.join('\n')}`)
      .setColor(this.helpColor())
      .setFooter({
        text: `${idx + 1}/${HELP_CATEGORIES.length} · V@help for the menu · V@help all for everything`,
      });
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
      await interaction.editReply(
        'No visualizer viewer found. Open the web visualizer first (`/viz`), then run `/burst` again.',
      );
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
      timer.unref?.();
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
    if (!EW.isAutoActive(s.endlessWave)) return;
    // Vibe analysis only matters for smart mode — basic stays cheap.
    if (s.endlessWave.active) {
      const features = await EW.fetchFeatures(ended);
      if (features) EW.recordFeatures(s.endlessWave, features);
    }
    EW.markPlayed(s.endlessWave, ended.uri, ended.name, ended.artists);
    await this.topUpWave(s);
  }

  /** Mark a track as played as soon as it starts (not on end) so EW's dedup
   *  immediately excludes it from future picks — critical for the lookahead
   *  buffer to not re-pick the currently playing song's variants. */
  private markWaveStarted(s: Session, track: TrackInfo): void {
    if (!EW.isAutoActive(s.endlessWave)) return;
    if (this.ewStartedUri.get(s.guildId) === track.uri) return;
    this.ewStartedUri.set(s.guildId, track.uri);
    EW.markPlayed(s.endlessWave, track.uri, track.name, track.artists);
  }

  /** Track message IDs sent by Amok so users can reply directly without `v@w`. */
  private rememberAmokMessage(messageId: string): void {
    this.amokMessageIds.add(messageId);
    if (this.amokMessageIds.size > 500) {
      const oldest = this.amokMessageIds.values().next().value;
      if (oldest !== undefined) this.amokMessageIds.delete(oldest);
    }
  }

  /** Speak a short Weasel line over the active voice stream with music ducking. */
  private async speakWeaselInVoice(s: Session, text: string): Promise<boolean> {
    if (!s.voice.isConnectionReady()) return false;
    try {
      const clip = await synthWeaselVoice(text);
      if (!clip || !s.voice.isConnectionReady()) return false;
      s.voice.duckFor(clip.durationMs + 400);
      s.voice.queueSfxPcm(clip.pcm);
      return true;
    } catch {
      return false;
    }
  }

  /** Gather recent channel messages + current voice channel members ("Read the Room"). */
  private async collectRoomAwareness(
    guildId: string | null,
    channelId?: string | null,
  ): Promise<{ recentChat: string[]; voiceMembers: string[] }> {
    const recentChat: string[] = [];
    const voiceMembers: string[] = [];

    if (guildId) {
      const guild = this.client.guilds.cache.get(guildId);
      if (guild) {
        const s = this.sessions.get(guildId);
        const vcId = s?.voice.getChannelId();
        const vc = vcId ? guild.channels.cache.get(vcId) : null;
        if (vc && vc.isVoiceBased()) {
          for (const [, m] of vc.members) {
            if (!m.user.bot) voiceMembers.push(m.displayName || m.user.username);
          }
        }
      }
    }

    if (channelId) {
      try {
        const ch = this.client.channels.cache.get(channelId);
        if (ch && ch.isTextBased() && 'messages' in ch) {
          const msgs = await ch.messages.fetch({ limit: 10 });
          const ordered = Array.from(msgs.values()).reverse();
          for (const m of ordered) {
            const txt = (m.content ?? '').replace(/\s+/g, ' ').trim();
            if (!txt) continue;
            recentChat.push(`${m.author.username}: ${txt.slice(0, 140)}`);
          }
        }
      } catch {
        /* channel history unavailable */
      }
    }

    return { recentChat, voiceMembers };
  }

  /** Handle a spoken utterance captured from the Discord voice channel (`v@w listen on`). */
  private async onWeaselVoiceUtterance(s: Session, userId: string, pcmMono48k: Buffer): Promise<void> {
    const gid = s.guildId;
    if (!this.weaselListenGuilds.has(gid) || this.weaselListenBusy.has(gid)) return;
    this.weaselListenBusy.add(gid);
    try {
      const wav = pcmMono48kToWav(pcmMono48k);
      const transcript = await transcribeVoiceUtterance(wav);
      if (!transcript) return;
      // Respond when the speaker addresses The Weasel or gives a clear DJ voice request
      const addressed =
        /\b(weasel|pauly|amok|bu+ddy|broham|hey dj|yo dj)\b/i.test(transcript) ||
        /^(?:hey|yo|okay|ok)?\s*(?:play|queue|put on|throw on|skip|what song|who sings|roast)\b/i.test(
          transcript.trim(),
        );
      if (!addressed) return;

      const guild = this.client.guilds.cache.get(gid);
      const member = guild?.members.cache.get(userId);
      const username = member?.user.username ?? 'broham';
      const channelId = this.lastTextChannel.get(gid) ?? null;

      const reply = await this.handleWeaselRequest(s, transcript, {
        scopeId: gid,
        guildId: gid,
        channelId,
        userId,
        username,
        ensureJoin: async () => true,
      });

      const firstParagraph = reply.split(/\n\n/)[0] ?? reply;
      await this.speakWeaselInVoice(s, firstParagraph);

      if (channelId) {
        const ch = this.client.channels.cache.get(channelId);
        if (ch && ch.isTextBased() && 'send' in ch) {
          const sent = await ch.send(`🎤 **${username}** *(in voice)*: "${transcript}"\n${reply}`);
          if (sent?.id) this.rememberAmokMessage(sent.id);
        }
      }
    } catch {
      /* ignore transient voice transcription errors */
    } finally {
      this.weaselListenBusy.delete(gid);
    }
  }

  /**
   * Full smart dispatcher for `/weasel`, `/amok`, `V@weasel` (`V@w`),
   * direct replies to The Weasel, and spoken voice-channel commands:
   *  - `vj [on|off]`: toggle spoken MTV VJ track announcements in voice
   *  - `listen [on|off]`: toggle live voice-channel ears (talk to The Weasel out loud)
   *  - `memory` / `remember <fact>`: persistent long-term user & server memory
   *  - `wave <vibe/arc>` / `arc <journey>` / `steer <vibe>`: AI Deep-DNA Endless Wave & Harmonic Set Architect
   *  - `breakdown` / `lore` / `sample`: deep track deconstruction (samples, producer, lyrics, Song DNA)
   *  - `say <prompt>`: speak out loud in the voice channel + reply in text
   *  - `roast` / `rate`: roast or hype the current queue and server DJs
   *  - `play` / `dj` / `spin` / natural song requests: auto-resolve & queue tracks
   */
  private async handleWeaselRequest(
    s: Session,
    rawPrompt: string,
    opts: {
      scopeId: string;
      guildId: string | null;
      channelId?: string | null;
      userId: string;
      username: string;
      ensureJoin: () => Promise<unknown>;
    },
  ): Promise<string> {
    const trimmed = rawPrompt.trim();
    const gid = opts.guildId ?? '';

    // 1. `v@w vj [on|off]` — toggle automatic spoken Weasel VJ intros on track changes
    const vjMatch = /^vj(?:\s+(on|off|toggle|status))?$/i.exec(trimmed);
    if (vjMatch) {
      if (!gid) return 'Must be used inside a server.';
      const mode = (vjMatch[1] ?? 'toggle').toLowerCase();
      if (mode === 'on') this.weaselVjGuilds.add(gid);
      else if (mode === 'off') this.weaselVjGuilds.delete(gid);
      else if (mode === 'toggle') {
        if (this.weaselVjGuilds.has(gid)) this.weaselVjGuilds.delete(gid);
        else this.weaselVjGuilds.add(gid);
      }
      const active = this.weaselVjGuilds.has(gid);
      return active
        ? "🎙️ **Weasel Auto-VJ is ON, buuuddy!** I'll hop on the mic with SSML surfer cadence and drop 90s MTV Spring Break intros (+ sample/producer notes) when tracks kick off. (`V@w vj off` to chill)"
        : '🔇 **Weasel Auto-VJ is OFF** — keeping the mic quiet during track changes, broham.';
    }

    // 2. `v@w listen [on|off]` — toggle live Voice-Channel Ears
    const listenMatch = /^listen(?:\s+(on|off|toggle|status))?$/i.exec(trimmed);
    if (listenMatch) {
      if (!gid) return 'Must be used inside a server.';
      const mode = (listenMatch[1] ?? 'toggle').toLowerCase();
      if (mode === 'on') this.weaselListenGuilds.add(gid);
      else if (mode === 'off') this.weaselListenGuilds.delete(gid);
      else if (mode === 'toggle') {
        if (this.weaselListenGuilds.has(gid)) this.weaselListenGuilds.delete(gid);
        else this.weaselListenGuilds.add(gid);
      }
      const active = this.weaselListenGuilds.has(gid);
      s.voice.setVoiceListenHandler(active ? (uid, pcm) => void this.onWeaselVoiceUtterance(s, uid, pcm) : null);
      if (active && !s.voice.isJoined()) {
        try {
          await opts.ensureJoin();
        } catch {
          /* user can join VC after */
        }
      }
      return active
        ? '👂 **Weasel Voice Ears are ON, buuuddy!** Just talk out loud in the voice channel — say *"Hey Weasel, what song is this?"* or *"Yo Weasel, play some Sublime"* and I\'ll hear you and answer back on the mic! (`V@w listen off` to disable)'
        : '🔇 **Weasel Voice Ears are OFF** — no longer listening to voice chat.';
    }

    // 3. `v@w memory` / `v@w remember <fact>` — persistent long-term memory
    const remMatch = /^(?:remember|memo)\s+(.+)$/i.exec(trimmed);
    if (remMatch) {
      rememberWeaselFact(gid || null, opts.userId, opts.username, remMatch[1]);
      return `🧠 Locked into the old melon forever, **${opts.username}**! I'll remember: *"${remMatch[1].trim()}"* — wheeze the juice!`;
    }
    if (/^memory$/i.test(trimmed)) {
      const mem = getWeaselMemorySummary(gid || null, opts.userId, opts.username);
      return mem
        ? `🧠 **What The Weasel remembers about you & this room, buuuddy:**\n${mem}\n-# Tip: I learn your tastes automatically as we chat and queue music, or use \`V@w remember <fact>\`.`
        : "🧠 My melon's still fresh on you, buuuddy! Queue some jams or tell me what you're into (or use `V@w remember <fact>`) and I'll remember it across sessions.";
    }

    // Build rich room context (current track, upcoming queue with addedBy, top DJs, DNA, chat, VC presence)
    const st = s.queue.getState();
    const cur = st.track;
    const snap = s.queue.getSnapshot();
    const curLore = cur ? this.ewTrackLore.get(cur.uri) : undefined;
    const dnaCal = EW.describeCalibration(s.endlessWave);
    const nowPlaying = cur
      ? `"${cur.name}" by ${(cur.artists ?? []).join(', ')}${cur.addedBy ? ` (queued by ${cur.addedBy})` : ''}${dnaCal ? ` [Sonic DNA: ${dnaCal}]` : ''}${curLore ? ` [Crate-Digger connection: ${curLore}]` : ''}`
      : null;
    const upcomingQueue = snap.tracks
      .slice(0, 8)
      .map(
        (t, i) =>
          `${i + 1}. "${t.name}" by ${(t.artists ?? []).join(', ')}${t.addedBy ? ` [DJ: ${t.addedBy}]` : ''}${this.ewTrackLore.get(t.uri) ? ` (${this.ewTrackLore.get(t.uri)})` : ''}`,
      );
    let leaderboardSummary: string | null = null;
    if (gid) {
      const topUsers = this.stats.topUsers(gid, 5);
      const topArtists = this.stats.topArtists(gid, 5);
      const parts: string[] = [];
      if (topUsers.length > 0) {
        parts.push(`Top DJs: ${topUsers.map(([u, c]) => `${u} (${c.queued} queued)`).join(', ')}`);
      }
      if (topArtists.length > 0) {
        parts.push(`Top artists: ${topArtists.map(([a, c]) => `${a} (${c})`).join(', ')}`);
      }
      if (parts.length > 0) leaderboardSummary = parts.join(' · ');
    }

    const { recentChat, voiceMembers } = await this.collectRoomAwareness(gid || null, opts.channelId);

    // 4. `v@w wave <vibe/arc>` / `v@w arc <journey>` / `v@w steer <vibe>` — Fused AI Deep-DNA Endless Wave + Harmonic Set Architect
    const waveMatch = /^(?:wave|arc|steer|journey)(?:\s+(.*))?$/i.exec(trimmed);
    if (waveMatch && gid) {
      const directive = (waveMatch[1] ?? '').trim();
      if (/^(off|clear|stop)$/i.test(directive)) {
        this.ewSteerPrompt.delete(gid);
        this.ewAiPickBuffer.delete(gid);
        return '🌊 Cleared the custom AI wave arc — Endless Wave is cruising on pure track-to-track DNA now, buuuddy!';
      }
      if (directive) {
        this.ewSteerPrompt.set(gid, directive);
      }
      this.ewAiPickBuffer.delete(gid);
      if (EW.modeOf(s.endlessWave) !== 'smart') {
        this.setAutoplayMode(s, 'smart');
      }
      const recentSeeds = EW.pickContext(snap.tracks, snap.currentIndex, 3, 4).map((t) => ({
        name: t.name,
        artists: t.artists ?? [],
      }));
      const picks = await curateEndlessWaveTracks({
        seedTracks: recentSeeds,
        dnaSummary: dnaCal,
        avoidNames: Array.from(s.endlessWave.playedNames),
        steerDirective: this.ewSteerPrompt.get(gid) ?? null,
        count: 3,
      });
      const resolved: ResolvedTrack[] = [];
      const whyByName = new Map<string, string>();
      for (const p of picks) {
        try {
          const hits = await resolvePlayInput(p.query);
          if (hits.length > 0) {
            resolved.push(hits[0]);
            whyByName.set(hits[0].uri, p.why);
            this.ewTrackLore.set(hits[0].uri, p.why);
          }
        } catch {
          /* skip unresolvable */
        }
      }
      const fresh = s.queue.filterNew(resolved);
      const lines: string[] = [];
      if (fresh.length > 0) {
        s.queue.insertUserBatch(fresh, 'endless-wave');
        try {
          await opts.ensureJoin();
          if (!s.queue.getState().playing) await s.playback.play();
        } catch {
          /* queued even if not in voice yet */
        }
        for (const [idx, t] of fresh.entries()) {
          const why = whyByName.get(t.uri);
          lines.push(`${idx + 1}. **${t.name}** — ${(t.artists ?? []).join(', ')}${why ? `\n   -# 🧬 *${why}*` : ''}`);
        }
      }
      const intro = await askAmokRich(
        directive
          ? `Introduce this new Endless Wave harmonic/DNA journey you just engineered for the room: "${directive}"`
          : 'Hype up the Deep-DNA Endless Wave crate-digging session you just kicked off based on the room’s current tracks!',
        {
          scopeId: opts.scopeId,
          guildId: gid,
          userId: opts.userId,
          username: opts.username,
          nowPlaying,
          upcomingQueue,
          recentChat,
          voiceMembers,
          ewSteerDirective: this.ewSteerPrompt.get(gid) ?? null,
          forceRoomContext: true,
        },
      );
      return lines.length > 0
        ? `${intro.text}\n\n🌊 **Endless Wave (Deep-DNA & Harmonic Arc) queued:**\n${lines.join('\n')}`
        : `${intro.text}\n-# 🌊 Endless Wave (smart) is active${directive ? ` — steering toward: **${directive}**` : ''}.`;
    }

    // 5. `v@w breakdown` / `v@w lore` / `v@w sample` — Deep Track Intelligence
    const breakdownMatch = /^(?:breakdown|lore|sample|samples|dna|why)(?:\s+(.*))?$/i.exec(trimmed);
    if (breakdownMatch) {
      const target = (breakdownMatch[1] ?? '').trim();
      const targetDesc = target || nowPlaying;
      if (!targetDesc) {
        return "Whoa buuuddy, nothing's spinning right now! Play a track or type `V@w breakdown <artist - song>` and I'll dig up the samples, producer lore, and sonic DNA!";
      }
      const bdPrompt = `Give a deep-dive musicologist breakdown of ${targetDesc}! Cover: (1) who produced it and the recording/album backstory, (2) what samples it flipped or who sampled it (WhoSampled lore), (3) what the lyrics and sonic DNA (${dnaCal || 'groove/key/BPM'}) are doing, and (4) at the very end output WEASEL_QUEUE: with 1 or 2 sample-source or producer-cousin tracks if the user wants to hear the connection!`;
      const res = await askAmokRich(bdPrompt, {
        scopeId: opts.scopeId,
        guildId: gid,
        userId: opts.userId,
        username: opts.username,
        nowPlaying,
        upcomingQueue,
        leaderboardSummary,
        recentChat,
        voiceMembers,
        ewSteerDirective: this.ewSteerPrompt.get(gid) ?? null,
        forceRoomContext: true,
      });
      const cousinNotes =
        res.queueQueries.length > 0
          ? `\n\n🧬 **Sample / Producer Cousins:** ${res.queueQueries.map((q) => `\`${q}\``).join(' · ')} *(reply "queue those" or \`V@w wave ${res.queueQueries[0]}\` to ride that DNA in Endless Wave!)*`
          : '';
      return `${res.text}${cousinNotes}`;
    }

    // 6. `v@w say ...` — speak out loud in the voice channel
    const sayMatch = /^(?:say|speak|mic|announce)(?:\s+(.*))?$/i.exec(trimmed);
    if (sayMatch) {
      const topic = (sayMatch[1] ?? '').trim();
      const voicePrompt = topic
        ? `Give a short, punchy 1-2 sentence 90s MTV VJ radio drop to say out loud on the microphone about: ${topic}`
        : cur
          ? `Give a short, punchy 1-2 sentence 90s MTV VJ radio intro to say out loud on the microphone for the song currently playing: ${nowPlaying}`
          : 'Give a short, punchy 1-2 sentence 90s MTV VJ shoutout to the Discord voice channel!';
      const res = await askAmokRich(voicePrompt, {
        scopeId: opts.scopeId,
        guildId: gid,
        userId: opts.userId,
        username: opts.username,
        nowPlaying,
        upcomingQueue,
        leaderboardSummary,
        recentChat,
        voiceMembers,
        forceRoomContext: true,
      });
      if (!s.voice.isConnectionReady()) {
        try {
          await opts.ensureJoin();
        } catch {
          /* user might not be in voice */
        }
      }
      const spoke = await this.speakWeaselInVoice(s, res.text);
      return spoke
        ? `🎙️ *On the mic in voice:*\n${res.text}`
        : `${res.text}\n-# (Join a voice channel to hear me on the mic!)`;
    }

    // 7. `v@w roast [target]` / `v@w rate [target]` — savage 90s MTV Roast of any target
    //    Target can be: empty (roast the queue + DJs), @mention, or a typed name/thing.
    const isRoast = /^(?:roast|rate)(?:\s+(.*))?$/i.exec(trimmed);
    let effectivePrompt = trimmed;
    let roastTargetNotes: string[] = [];
    if (isRoast) {
      const arg = (isRoast[1] ?? '').trim();
      const targets: string[] = [];
      const mentionIds: string[] = [];
      if (arg) {
        // Pull every @mention in the raw prompt and resolve to display names
        const mentionRe = /<@!?(\d+)>/g;
        let m: RegExpExecArray | null;
        while ((m = mentionRe.exec(arg)) !== null) mentionIds.push(m[1]);
        const cleanedArg = arg.replace(mentionRe, '').replace(/\s+/g, ' ').trim();
        if (mentionIds.length > 0 && (opts as { guildId?: string | null }).guildId) {
          const guild = this.client.guilds.cache.get((opts as { guildId?: string | null }).guildId!);
          for (const id of mentionIds) {
            const member = guild?.members.cache.get(id);
            const name = member?.displayName ?? member?.user.username ?? id;
            targets.push(name);
            // Load this target's memory profile so burns are personal
            const mem = getWeaselMemorySummary(gid || null, id, name);
            if (mem) roastTargetNotes.push(`Roast target ${name}: ${mem}`);
          }
        }
        if (cleanedArg) targets.push(cleanedArg);
      }
      const targetPhrase =
        targets.length > 0
          ? `Roast/Rate these specific targets BY NAME and go HARD: ${targets.join(', ')}. Use their music taste, queued songs, username, and anything you remember about them.`
          : `Roast and rate the current music queue, DJs, and channel vibe by name.`;
      effectivePrompt = `${targetPhrase} ${arg && targets.length > 0 ? `Extra roast direction: ${arg}.` : ''} Lay down the burns like a 90s MTV Spring Break Roast — witty, sharp, specific, savage but never slurs/bigotry/threats/real-appearance. 1-3 punchy sentences max.`;
    }

    const result = await askAmokRich(effectivePrompt, {
      scopeId: opts.scopeId,
      guildId: gid,
      userId: opts.userId,
      username: opts.username,
      nowPlaying,
      upcomingQueue,
      leaderboardSummary,
      recentChat,
      voiceMembers,
      ewSteerDirective: this.ewSteerPrompt.get(gid) ?? null,
      forceRoomContext: Boolean(isRoast),
      extraContextNotes: roastTargetNotes.length > 0 ? roastTargetNotes : undefined,
    });

    // 8. VJ Weasel Auto-DJ — resolve & queue any `WEASEL_QUEUE:` tracks
    const queuedLabels: string[] = [];
    if (result.queueQueries.length > 0 && gid) {
      const resolved: ResolvedTrack[] = [];
      for (const q of result.queueQueries.slice(0, 5)) {
        try {
          const hits = await resolvePlayInput(q);
          if (hits.length > 0) resolved.push(hits[0]);
        } catch {
          /* skip unresolvable pick */
        }
      }
      const fresh = s.queue.filterNew(resolved);
      if (fresh.length > 0) {
        s.queue.insertUserBatch(fresh, 'The Weasel 🦦');
        const allArtists = fresh.flatMap((t) => t.artists);
        this.stats.noteQueued(gid, opts.username, allArtists);
        noteWeaselUserArtists(opts.userId, opts.username, allArtists);
        try {
          await opts.ensureJoin();
          if (!s.queue.getState().playing) await s.playback.play();
        } catch {
          /* queued even if not in a voice channel yet */
        }
        for (const [idx, t] of fresh.entries()) {
          queuedLabels.push(`${idx + 1}. **${t.name}** — ${(t.artists ?? []).join(', ')}`);
        }
        if (s.voice.isJoined()) {
          const first = fresh[0];
          void this.speakWeaselInVoice(
            s,
            `Hey buuuddy! The Weasel just lined up ${first.name} by ${(first.artists ?? []).slice(0, 2).join(' and ')}! Keep wheezin the ju-uice!`,
          );
        }
      }
    }

    if (queuedLabels.length > 0) {
      return `${result.text}\n\n🎧 **The Weasel queued:**\n${queuedLabels.join('\n')}`;
    }
    return result.text;
  }

  /**
   * AI Deep-DNA Crate-Digger step inside Endless Wave (`smart` mode):
   * Pulls producer/sample/era/harmonic picks from Gemini + Google Search grounding
   * before falling back to the mechanical Spotify/Deezer recommender.
   */
  private async pickAiEndlessWaveTrack(s: Session, recent: TrackInfo[]): Promise<TrackInfo | null> {
    if (recent.length === 0 && !this.ewSteerPrompt.has(s.guildId)) return null;
    try {
      let buf = this.ewAiPickBuffer.get(s.guildId) ?? [];
      if (buf.length === 0) {
        buf = await curateEndlessWaveTracks({
          seedTracks: recent.slice(-4).map((t) => ({ name: t.name, artists: t.artists ?? [] })),
          dnaSummary: EW.describeCalibration(s.endlessWave),
          avoidNames: Array.from(s.endlessWave.playedNames),
          steerDirective: this.ewSteerPrompt.get(s.guildId) ?? null,
          count: 3,
        });
        this.ewAiPickBuffer.set(s.guildId, buf);
      }
      while (buf.length > 0) {
        const pick = buf.shift()!;
        const hits = await resolvePlayInput(pick.query).catch(() => []);
        if (hits.length === 0) continue;
        const hit = hits[0];
        if (s.endlessWave.playedUris.has(hit.uri)) continue;
        if (s.queue.filterNew([hit]).length === 0) continue;
        this.ewTrackLore.set(hit.uri, pick.why);
        EW.markPlayed(s.endlessWave, hit.uri, hit.name, hit.artists);
        s.endlessWave.generated++;
        s.endlessWave.runStreak++;
        if (s.endlessWave.runStreak > s.endlessWave.longestRun) {
          s.endlessWave.longestRun = s.endlessWave.runStreak;
        }
        for (const a of hit.artists ?? []) s.endlessWave.artistSet.add(a.toLowerCase());
        console.log(`[endlesswave:ai-dna] picked "${hit.name}" (${pick.why})`);
        return { ...hit, addedBy: 'endless-wave', addedAt: Date.now() };
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Optional TTS DJ: speak a short "now playing" line when a new track starts.
   * Strictly opt-in per guild (`/tts on` or `V@w vj on`), deduped per track.
   * The music ducks under the clip, then releases.
   */
  private maybeAnnounceTts(s: Session, track: TrackInfo): void {
    if (this.weaselVjGuilds.has(s.guildId)) {
      if (this.ttsAnnounced.get(s.guildId) === track.uri) return;
      this.ttsAnnounced.set(s.guildId, track.uri);
      const artists = (track.artists ?? []).filter(Boolean).slice(0, 2).join(' and ');
      const lore = this.ewTrackLore.get(track.uri);
      const dj =
        track.addedBy && track.addedBy !== 'endless-wave' && track.addedBy !== 'Endless Wave'
          ? ` queued up by ${track.addedBy},`
          : '';
      const line = lore
        ? `Hey buuuddy! Up next on the wave, we got ${track.name}${artists ? ` by ${artists}` : ''}! ${lore}`
        : `Hey buuuddy! Coming up on the crustacean station,${dj} we got ${track.name}${artists ? ` by ${artists}` : ''}! Keep wheezin the ju-uice!`;
      setTimeout(() => {
        if (s.queue.getCurrentTrack()?.uri !== track.uri) return;
        void this.speakWeaselInVoice(s, line);
      }, 1500);
      return;
    }
    if (!ttsEngine.enabled || !this.perms.getTts(s.guildId)) return;
    if (this.ttsAnnounced.get(s.guildId) === track.uri) return;
    this.ttsAnnounced.set(s.guildId, track.uri);
    const artists = (track.artists ?? []).filter(Boolean).slice(0, 2);
    const text = artists.length
      ? `Now playing, ${track.name}, by ${artists.join(' and ')}.`
      : `Now playing, ${track.name}.`;
    void ttsEngine
      .synth(text)
      .then((clip) => {
        if (!clip || !s.voice.isJoined()) return;
        // The track may have changed while synthesizing — don't speak over the wrong song.
        if (s.queue.getCurrentTrack()?.uri !== track.uri) return;
        s.voice.duckFor(clip.durationMs + 400);
        s.voice.queueSfxPcm(clip.pcm);
      })
      .catch(() => {
        /* announcements are best-effort */
      });
  }

  /** Debounced trigger for topUpWave — fires 700ms after any queue/state change
   *  so rapid skips or manual adds collapse into a single refill pass. */
  private scheduleWaveTopUp(s: Session): void {
    if (!EW.isAutoActive(s.endlessWave)) return;
    const t = this.ewTopUpTimers.get(s.guildId);
    if (t) clearTimeout(t);
    const wt = setTimeout(() => {
      this.ewTopUpTimers.delete(s.guildId);
      void this.topUpWave(s).catch((err) =>
        console.warn(`[endlesswave] top-up failed: ${err instanceof Error ? err.message : err}`),
      );
    }, 700);
    wt.unref?.();
    this.ewTopUpTimers.set(s.guildId, wt);
  }

  /** Set the autoplay mode (off | basic | smart). Shared by commands + panel. */
  private setAutoplayMode(s: Session, mode: EW.AutoplayMode): void {
    const gid = s.guildId;
    EW.setMode(s.endlessWave, mode);
    this.ewRetryAfter.delete(gid);
    const t = this.ewTopUpTimers.get(gid);
    if (t) clearTimeout(t);
    this.ewTopUpTimers.delete(gid);
    this.ewStartedUri.delete(gid);
    this.bridge.broadcast({
      type: 'endlesswave',
      active: mode !== 'off',
      generated: mode === 'off' ? s.endlessWave.generated : 0,
      mode,
    });
    if (mode === 'off') return;
    const cur = s.queue.getCurrentTrack();
    if (cur) EW.markPlayed(s.endlessWave, cur.uri, cur.name, cur.artists);
    if (mode === 'smart' && cur) {
      void EW.fetchFeatures(cur)
        .then((af) => {
          if (af) EW.recordFeatures(s.endlessWave, af);
        })
        .catch(() => {});
    }
    void this.topUpWave(s).catch((err) => {
      console.warn(`[autoplay] initial top-up failed: ${err instanceof Error ? err.message : err}`);
    });
  }

  /** Panel/visualizer-initiated autoplay mode change (via the browser). */
  private async panelSetEndlessWave(guildId: string, mode: EW.AutoplayMode): Promise<void> {
    const s = this.sessionFor(guildId);
    if (!s) return;
    if (EW.modeOf(s.endlessWave) === mode) return;
    this.setAutoplayMode(s, mode);
  }

  /** Login with backoff so a transient gateway 5xx (Discord/Cloudflare blip or
   *  IP throttle) never crash-loops the container. */
  private async loginWithRetry(): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.client.login(config.discordToken);
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const delay = Math.min(120_000, 5_000 * attempt);
        console.warn(
          `[vaporzr] gateway login failed (attempt ${attempt}): ${msg} — retrying in ${Math.round(delay / 1000)}s`,
        );
        await new Promise((r) => {
          const t = setTimeout(r, delay);
          t.unref?.();
        });
      }
    }
  }

  /** Keep a lookahead buffer of 2 EW-picked tracks at the tail of the queue.
   *  They're ordinary queue entries, so skips/manual adds interleave naturally;
   *  any queue or state change re-tops the buffer. */
  private async topUpWave(s: Session): Promise<void> {
    if (!EW.isAutoActive(s.endlessWave)) return;
    // Auto-upgrade basic → smart the moment an account is linked. Basic was only
    // in effect because there was no OAuth token to drive Web-API curation, so
    // once one appears (finished /login) we shouldn't stay on the lesser mode.
    if (s.endlessWave.basic && !s.endlessWave.active) {
      try {
        const { tokenStore } = await import('@vaporzr/core/tokenStore');
        if (tokenStore.load()?.refresh_token) {
          console.log('[autoplay] OAuth token available — upgrading basic → smart');
          this.setAutoplayMode(s, 'smart');
        }
      } catch {
        /* ignore */
      }
    }
    if ((this.ewRetryAfter.get(s.guildId) ?? 0) > Date.now()) return;
    if (this.ewBusy.has(s.guildId)) return;
    this.ewBusy.add(s.guildId);
    const smart = s.endlessWave.active;
    // Smart keeps a 3-track lookahead; basic just needs the next track ready.
    // A per-guild override (V@autoplay count N) wins when set.
    const AHEAD = this.ewAheadOverride.get(s.guildId) ?? (smart ? 3 : 1);
    const MAX_PER_RUN = smart ? 3 : 1;
    // Hard bounds for this refill pass: a single run must never grow the queue
    // without limit. (A cursor pinned at the tail used to make `ahead` read 0
    // forever, re-picking the same song ~20k times in one pass.)
    let enqueuedThisRun = 0;
    let lastPickUri: string | null = null;
    try {
      for (;;) {
        if (!EW.isAutoActive(s.endlessWave)) return;
        if (enqueuedThisRun >= MAX_PER_RUN) return;
        const snap = s.queue.getSnapshot();
        const upcoming = snap.tracks.slice(snap.currentIndex + 1);
        let ahead = 0;
        for (const t of upcoming) if (t.addedBy === 'endless-wave') ahead++;
        if (ahead >= AHEAD) return;
        // Adaptive dead-end backoff: if the buffer is nearly drained the wave is
        // about to die, so retry quickly (~8s) rather than the long anti-storm
        // wait. A healthy buffer keeps the long backoff so refill storms can't
        // re-search and re-reject the same candidates every couple of seconds.
        const deadEndBackoff = ahead <= 1 ? 8_000 : 45_000;

        // Context window around the current position: up to 3 recently played
        // tracks (seeds) + the next 6 upcoming (so the lookahead buffer and
        // any user-queued tracks are included as seeds and dedup targets).
        const recent = EW.pickContext(snap.tracks, snap.currentIndex, 3, 6);
        const failed = new Set<string>();
        let resolved: TrackInfo | null = null;
        if (smart) {
          resolved = await this.pickAiEndlessWaveTrack(s, recent);
        }
        for (let attempt = 0; attempt < 3 && !resolved; attempt++) {
          if (!EW.isAutoActive(s.endlessWave)) return;
          const candidate = smart ? await EW.pickNextTrack(s.endlessWave, recent, failed, upcoming) : null;
          // Smart can dead-end (recommendations empty, or every candidate is a
          // dupe / on cooldown). Fall through to the search-based basic picker so
          // autoplay always queues something instead of stopping the music.
          const chosen = candidate ?? (await EW.pickBasicTrack(s.endlessWave, recent, failed, upcoming));
          if (!chosen) break;
          if (chosen.uri === lastPickUri) {
            // Same pick twice in one pass — dedup inputs are blind (e.g. a
            // stale cursor), so stop instead of queueing it again forever.
            console.warn('[endlesswave] same pick twice in one refill — backing off');
            EW.noteWaveDeadEnd(s.endlessWave);
            this.ewRetryAfter.set(s.guildId, Date.now() + deadEndBackoff);
            return;
          }
          lastPickUri = chosen.uri;
          failed.add(chosen.uri);
          const r = await EW.resolveCandidate(chosen);
          if (!r) {
            console.log(`[endlesswave] could not resolve "${chosen.name}" — trying another`);
            continue;
          }
          // Dedupe again AFTER resolution: different picks (e.g. "Blue Monday
          // '88" vs "Blue Monday (2016 Remaster)") can resolve to the same
          // upload, which the pre-resolution filters can't see.
          if (s.queue.filterNew([r]).length === 0) {
            console.log(`[endlesswave] "${r.name}" already queued (resolved) — trying another`);
            continue;
          }
          resolved = r;
        }
        if (!resolved) {
          // Dead-end: the current context can't produce a fresh candidate (the
          // pool is all already-played/cooldown/rejected). Back off much longer
          // than a transient failure so refill storms stop re-searching and
          // re-rejecting the same candidates every couple of seconds. The wave
          // wakes up again when a new track actually plays (queue change).
          console.warn('[endlesswave] no suitable candidate right now — backing off');
          EW.noteWaveDeadEnd(s.endlessWave);
          this.ewRetryAfter.set(s.guildId, Date.now() + deadEndBackoff);
          return;
        }
        // keepCursor: background refills must not move the playing cursor
        // (see QueueManager.enqueue). background: they must also never be
        // scattered among the tracks the listener chose — they append.
        s.queue.enqueue(resolved, 'endless-wave', { keepCursor: true, background: true });
        enqueuedThisRun++;
        s.endlessWave.generated++;
        EW.noteWaveQueued(s.endlessWave, resolved.artists);
        this.bridge.broadcast({
          type: 'endlesswave',
          active: true,
          generated: s.endlessWave.generated,
          mode: EW.modeOf(s.endlessWave),
        });
        console.log(
          `[autoplay] queued: "${resolved.name}" — ${truncate(resolved.artists.join(', '), 80)} (#${s.endlessWave.generated})`,
        );
        this.ewRetryAfter.delete(s.guildId);
      }
    } finally {
      this.ewBusy.delete(s.guildId);
      // With keepCursor the refill never moves the cursor itself: walk it past
      // already-played tracks to the first fresh one so a cold/finished queue
      // self-resurrects instead of replaying (or sitting on) a stale entry.
      // Untouched when the cursor already sits on something fresh/unplayed.
      if (enqueuedThisRun > 0) {
        let walk = s.queue.getCurrentTrack();
        while (walk && EW.isDuplicate(s.endlessWave, walk.uri) && s.queue.next()) {
          walk = s.queue.getCurrentTrack();
        }
      }
      // Kick playback only for a *new* EW track. After skip/end the cursor still
      // sits on the just-finished song — starting that again is the same-song loop.
      const st = s.queue.getState();
      const cur = s.queue.getCurrentTrack();
      if (
        EW.isAutoActive(s.endlessWave) &&
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
    timer.unref?.();
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
  if (source === 'direct') return '🔗';
  if (source === 'suno') return '✨';
  if (source === 'soundcloud') return '🎧';
  if (source === 'apple') return '🍎';
  return '🎵';
}

/** Recognized direct media file extensions a playable URL may point at. */
const DIRECT_MEDIA_EXT_RE = /\.(wav|mp3|flac|ogg|opus|oga|m4a|aac|mp4|m4v|mkv|webm|aiff|wma|m3u8|m3u)$/i;

/** True when the input is an http(s) URL to a bare audio/video file. */
export function isDirectMediaUrl(input: string): boolean {
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  return DIRECT_MEDIA_EXT_RE.test(u.pathname);
}

/** Resolve a direct audio/video file URL into a playable track (streamed via ffmpeg). */
export async function resolveDirectMediaUrl(url: string): Promise<ResolvedTrack> {
  let name = 'Direct file';
  try {
    const file = new URL(url).pathname.split('/').filter(Boolean).pop();
    if (file) name = file.replace(DIRECT_MEDIA_EXT_RE, '');
  } catch {
    /* keep fallback name */
  }
  let res: Response;
  try {
    res = await safeFetch(url, {
      method: 'HEAD',
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; Vaporzr/1.0)' },
    });
  } catch (err) {
    if (err instanceof BlockedFetchError) throw new YoutubeError(err.message);
    throw new YoutubeError('Could not reach the media URL — it may be down or private.');
  }
  if (!res.ok) {
    throw new YoutubeError(`The media URL returned HTTP ${res.status} — check the link.`);
  }
  return {
    uri: `direct:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    name: name || 'Direct file',
    artists: ['Direct link'],
    album: 'Web',
    durationMs: 0,
    source: 'direct',
    streamUrl: url,
  };
}

/** Categorized command reference powering the interactive `/help` / `V@help`. */
const HELP_CATEGORIES: Array<{ id: string; emoji: string; name: string; blurb: string; lines: string[] }> = [
  {
    id: 'playback',
    emoji: '🎵',
    name: 'Playback',
    blurb: 'start, pause, skip and control the music',
    lines: [
      '`/play <name|link>` · `V@p` — play a song (a text search opens a picker)',
      '`/insert <name|link>` · `V@i` — play next',
      '`/yt <link|search>` — play from YouTube',
      '`/play` · `V@p` — queue a track (name/link) or play an attached file',
      '`/pause` · `V@pau` — pause',
      '`/resume` · `V@r` — resume',
      '`/toggle` · `V@t` — pause/resume',
      '`/skip` · `V@s` — skip (non-DJs start a vote)',
      "`/nowplaying` · `V@np` — what's playing",
      '`/follow` · `V@follow` — the now-playing strip follows the active channel by default; this pins it here (`off` turns it off)',
      "`/similar [track]` · `V@similar` — find tracks that sound like what's playing (cosine.club)",
      '`/volume <0-100>` · `V@v` — set the volume',
      '`/clear` · `V@c` — stop and clear the queue',
      '`/jump <lyric>` · `V@jump` — jump to a lyric line (e.g. "to the chorus")',
    ],
  },
  {
    id: 'queue',
    emoji: '📜',
    name: 'Queue',
    blurb: "view and rearrange what's coming up",
    lines: [
      '`/queue` · `V@q` — view the queue (paged)',
      '`/shuffle` · `V@sh` — shuffle the queue',
      '`V@shuffle smart` · `arc` · `key` — smart shuffle: order the upcoming tracks by vibe (flow), a set curve, or harmonic key',
      '`/remove <#>` · `V@rem <#>` — remove a queued track',
      '`V@undo` — put back the tracks from the last removal or clear',
      '`V@oops` — fix your most recent pick: pick another recording, retype it, or confirm it',
      '`V@qa` · `V@qadjust` — interactive queue editor: pick a track, then move / remove / play it now',
      '`/dedupe` · `V@dd` — remove duplicate upcoming tracks',
      '`/bulk <tracks>` · `V@bulk` — queue a list at once: names, links and/or attached files, one per line or `;` (max 25)',
      '`/skipto` · `V@skipto` — jump to a future track (drops the ones skipped; off by default)',
      '`/skiptoggle on|off` · `V@skiptoggle` — allow /skipto here (mod)',
    ],
  },
  {
    id: 'autoplay',
    emoji: '🌊',
    name: 'Autoplay',
    blurb: 'keep the music going after the queue ends',
    lines: [
      '`/autoplay` · `V@autoplay` (`V@ap`) — show the current mode',
      '`/autoplay mode:off|basic|smart` — set the mode',
      '  · **basic** — queue a related track (light & fast)',
      '  · **smart** — Endless Wave: evolves with the vibe',
      '`/autoplay now:true` — queue one more track right now',
      '`/autoplay count:<1-10>` — how many tracks to buffer ahead',
      '`/endwav on|off|status` · `V@ew` — Endless Wave shortcut',
      '`/ambient on|off` · `V@ambient` — quiet lo-fi intermission when the queue empties',
      '`/vibe [mood]` · `V@vibe` — auto-DJ for your mood / time of day / weather — or describe it: `V@vibe chill like Bonobo`, `V@vibe hype workout 5`',
    ],
  },
  {
    id: 'weasel',
    emoji: '🦦',
    name: 'Weasel & AI',
    blurb: '90s MTV VJ, AI auto-DJ, roasts, track lore and voice mic drops',
    lines: [
      '`/weasel <message>` · `V@w <msg>` (`V@weasel`, `V@amok`, `V@pauly`) — chat with The Weasel (web-grounded, room-aware) or reply directly to any of his messages',
      '`V@w play <vibe|request>` — AI Auto-DJ: picks & queues tracks matching any vibe, era, or prompt',
      '`V@w wave <vibe|arc>` · `V@w arc` · `V@w steer` — AI Deep-DNA Endless Wave & Harmonic Set Architect (`off` clears)',
      '`V@w breakdown [song]` · `V@w lore` · `V@w sample` — Deep Track Intelligence: samples, producer lore, sonic DNA & cousin tracks',
      '`V@w roast [@user|target]` · `V@w rate` — savage 90s MTV Spring Break roast of the queue, a tagged user, or any named target',
      '`V@w say [topic]` · `V@w speak` · `V@w mic` — hop on the voice-channel mic with a Pauly Shore voice drop',
      '`V@w vj on|off` — Auto-VJ: spoken track intros & sample/producer notes on track changes',
      '`V@w listen on|off` — Voice Ears: talk out loud in VC (*"Hey Weasel, play…"* ) and he answers on the mic',
      '`V@w memory` · `V@w remember <fact>` — view or teach persistent listener & room taste memory',
      '`/vibe [mood]` · `V@vibe` — mood / time-of-day / weather auto-DJ (e.g. `V@vibe chill like Bonobo`, `V@vibe hype workout 5`)',
    ],
  },
  {
    id: 'voice',
    emoji: '🔊',
    name: 'Voice',
    blurb: 'join, leave and manage the audio device',
    lines: [
      '`/join` · `V@j` — pull me into your voice channel',
      '`/leave` · `V@l` — leave and clear the queue',
      '`/device list|select <name>` — manage the Spotify Connect device',
    ],
  },
  {
    id: 'library',
    emoji: '💾',
    name: 'Library',
    blurb: 'save and load your own playlists',
    lines: [
      '`/playlist save <name>` · `V@save <name>` — save the current queue',
      '`/playlist load <name>` · `V@load <name>` — load a saved playlist',
      '`/playlist list` · `V@playlists` — list saved playlists',
      '`/playlist delete <name>` · `V@del <name>` — delete a playlist',
    ],
  },
  {
    id: 'fx',
    emoji: '🎛️',
    name: 'FX & DJ',
    blurb: 'sound effects, speed, bass and DJ controls',
    lines: [
      '`/speed <mode>` · `V@speed` — nightcore / slowed / normal',
      '`/eq <preset>` · `V@eq` — EQ presets: bass / vocal / night / warm / lofi (flat = off)',
      '`/norm <on|off>` · `V@norm` — loudness match: level every source to Spotify-standard volume',
      '`/bassboost <5|8|10>` · `V@bass` — bass boost',
      '`/config <settings>` · `V@config` — set several at once, e.g. `bass +3; crossfade 2; norm on; ew smart`',
      '`/sfx <id>` · `V@sfx` — play a sound effect',
      '`/dj` · `V@dj` — toggle the soundboard (mod)',
      '`/djrole @role` · `V@djrole` — set the DJ role (mod) — DJs skip without a vote',
      '`/voteskip on|off` · `V@vs` — require a majority vote to skip (off = anyone can skip)',
      '`/duck [seconds]` · `V@duck` — manually lower the music so people can talk',
      '`/duckmode off|auto|hosts` · `V@dmode` — auto-lower music while people talk (mod)',
      '`/npchannel` · `V@npc` — pin the live now-playing strip to this channel (mod; `off` disables it)',
      '`/hype on|off` · `V@hype` — auto-hype: drop a hit on strong beats',
      '`/mix <a> <b>` · `V@mix <a> | <b>` — crossfade two tracks into one mix',
      '`V@deck` (`V@dk`) — live two-deck mixer: `V@deck a <song>`, `b <song>`, `play`, `sync`, `cross 60`, `eq a low kill`, `stop`. Full faders + EQ on the web `/deck` page (mod)',
      '`/mashup <a> <b>` · `V@mashup <a> | <b>` — render a tempo/key-matched blend (downloadable) + 5 similar tracks',
      '`V@mashup list` · `V@mashup remove <n>` · `V@mashup edit <n> <a> | <b>` · `V@mashup move <n> <m>` · `V@mashup clear` — manage the mashup queue (up to 5 lined up while one renders)',
      '`/mashupgame` · `V@mashupgame` (`V@mg`) — auto-pick two queued songs, render stem blends, vote for the best',
      '`/mashups` · `V@mashups` (`V@mh`) — past mashups + winners',
    ],
  },
  {
    id: 'games',
    emoji: '🎮',
    name: 'Games',
    blurb: 'bet against the bot, duel your friends, spin the roulette',
    lines: [
      '`/games` · `V@games` — **how the games work (start here)**',
      '`/stump [track]` · `V@stump` — bet a track fits the room: play through → you beat the bot; skipped → the bot wins',
      '`V@stump board` — human-vs-bot scoreboard',
      '`/duel [@user] [now]` · `V@duel` — DJ Duel: the bot scores both picks and predicts a winner, then the room decides (add `now` for an instant verdict)',
      '`V@duel board` — duel leaderboard + how often the bot called the room right',
      "`/roulette` · `V@roulette` — a rarely-played track from this server's own history, queued next: ⭐ Hall of Fame or 🚫 Ban",
      '`/quiz` · `V@quiz` — guess-the-song lyric game · `/guess <answer>` · `V@guess`',
    ],
  },
  {
    id: 'lyrics',
    emoji: '🎤',
    name: 'Lyrics',
    blurb: 'read along with the music',
    lines: [
      '`/lyrics [query]` · `V@lyr` — lyrics for the current or searched song',
      '`/karaoke` · `V@k` — live karaoke highlight mode (the panel also shows synced lyrics)',
      '`/jump <lyric>` · `V@jump` — jump to a lyric line (e.g. "to the chorus")',
    ],
  },
  {
    id: 'visuals',
    emoji: '🎨',
    name: 'Visuals',
    blurb: 'panels, themes and the MilkDrop visualizer',
    lines: [
      '`/panel` · `V@pan` — post the control panel',
      '`/jam` · `V@jam` · `V@share` — post the jam invite card (QR + link) so guests can request songs from their phones',
      '`/viz` · `V@viz` — open the web visualizer (MilkDrop)',
      'Discord Activity: the visualizer there also offers hi-fi audio - press Connect inside it, then approve the 6-character code in the panel key dialog',
      "`/listen` — hi-fi listener: the bot's raw 48 kHz audio in a browser (full quality, ahead of Discord) with volume, buffer, mono and test-tone controls",
      '`/theme` · `V@th` — pick a color mood',
      '`/wave` — waveform snapshot · `/burst` — animated clip',
      '`/screensaver` · `V@sc` — idle screensaver',
      '`/sensitivity <0.5-1.5>` · `V@sens` — beat reactivity',
      "`/mood on|off` · `V@mood` — now-playing colors tinted by the track's mood",
      '`V@crossfade on|off|<seconds>` · `V@xfade` — crossfade + tail fade (0 = off, plays to the very end)',
      '`/dna` · `V@dna` — Song DNA radar card · `/cover` · `V@cover` — queue album-art mosaic',
    ],
  },
  {
    id: 'system',
    emoji: '🛠️',
    name: 'System',
    blurb: 'stats, diagnostics and admin tools',
    lines: [
      '`/diag` · `V@diag` — diagnostics (gateway, voice, librespot, live Opus bitrate)',
      '`/leaderboard` · `V@lb` — server listening stats (top DJs & artists)',
      "`/wrapped [month]` · `V@wrapped` — this server's monthly Wrapped: hours, top tracks, artists, DJs",
      '`/stats` — bot statistics',
      '`/sleep <30m|1h>` · `V@sleep` — sleep timer',
      '`/help` · `V@help` — this menu',
      '`/invite` · `V@invite` — add Vaporzr to a server',
      '`/key give [view|control|request] [hours]` · `V@key give` — mint an access link: panel, watch/listen, or song requests only (owner)',
      '`/key list` · `V@key list` — active devices + unused invites (owner)',
      '`/key revoke <id|all>` · `V@key revoke` — cut off one device/invite, or everything (owner)',
      '`/key show` · `V@key show` — reveal the master key · `/key rotate` — new key, kills all devices (owner)',
      '`/perms` — command levels & roles (admin)',
      '`/cookie-refresh` — re-export YouTube cookies from a browser (admin; only works where a browser exists)',
      '`/cookie-upload` — upload a cookies.txt to refresh YouTube cookies (owner)',
      '`/player` · `V@player` — desktop player window (admin)',
    ],
  },
];

/** Tile up to 4 album-art images into a 2x2 PNG mosaic via ffmpeg. */
function renderCollage(inputs: string[], outPath: string): Promise<boolean> {
  const imgs = inputs.slice(0, 4);
  if (imgs.length === 0) return Promise.resolve(false);
  while (imgs.length < 4) imgs.push(imgs[0]);
  const args: string[] = ['-hide_banner', '-loglevel', 'error'];
  for (const p of imgs) args.push('-i', p);
  const parts = imgs.map((_, i) => `[${i}]scale=320:320:force_original_aspect_ratio=increase,crop=320:320[s${i}]`);
  parts.push('[s0][s1][s2][s3]xstack=inputs=4:layout=0_0|w0_0|0_h0|w0_h0[out]');
  args.push('-filter_complex', parts.join(';'), '-map', '[out]', '-frames:v', '1', '-y', outPath);
  return new Promise((resolve) => {
    const proc = spawn(config.ffmpegPath, args, { windowsHide: true });
    proc.on('error', () => resolve(false));
    proc.on('exit', (code) => resolve(code === 0));
  });
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/** HSL (h 0-360, s/l 0-100) → 24-bit RGB int for Discord embed colors. */
function hslToInt(h: number, s: number, l: number): number {
  const sN = s / 100;
  const lN = l / 100;
  const c = (1 - Math.abs(2 * lN - 1)) * sN;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = lN - c / 2;
  return (Math.round((r + m) * 255) << 16) | (Math.round((g + m) * 255) << 8) | Math.round((b + m) * 255);
}

/** Transient network/connect errors (Node AggregateError, undici fetch failures). */
function isTransientNetError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const cause = err instanceof Error && err.cause ? String(err.cause) : '';
  return /Received one or more errors|fetch failed|ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN|ECONNREFUSED|socket hang up|other side closed|terminated/i.test(
    `${msg} ${cause}`,
  );
}

/** True when the play input is a direct link (resolve it) rather than a text
 *  search (which should open the interactive picker instead). */
function isUrlPlayInput(query: string): boolean {
  return (
    isDirectMediaUrl(query) ||
    isYoutubePlaylistUrl(query) ||
    isYoutubeUrl(query) ||
    isSunoUrl(query) ||
    isAppleMusicUrl(query) ||
    isSoundcloudSetUrl(query) ||
    isSoundcloudUrl(query) ||
    isGenericMediaUrl(query) ||
    /^(spotify:|https?:\/\/(open|play|embed)\.spotify\.com\/)/i.test(query)
  );
}

/** Payload poster shared by the mashup render/game (a channel `.send`). */
type MashupSend = (payload: {
  embeds: EmbedBuilder[];
  files: AttachmentBuilder[];
  components?: ActionRowBuilder<ButtonBuilder>[];
}) => Promise<unknown>;

interface MashupRecord {
  id: string;
  a: string;
  b: string;
  winner?: 'v1' | 'v2' | 'tie';
  at: number;
}

/** A mashup waiting its turn in a guild's queue (in-memory; a render takes
 *  minutes, so several can be lined up rather than bounced with "already
 *  rendering"). */
interface MashupJob {
  id: string;
  a: string;
  b: string;
  by: string;
  send: MashupSend;
}

const MASHUP_HISTORY_FILE = (): string => path.join(config.dataDir, 'mashup-history.json');

async function loadMashupHistory(): Promise<MashupRecord[]> {
  try {
    return JSON.parse(await fs.readFile(MASHUP_HISTORY_FILE(), 'utf8')) as MashupRecord[];
  } catch {
    return [];
  }
}

async function saveMashupHistory(recs: MashupRecord[]): Promise<void> {
  try {
    await fs.writeFile(MASHUP_HISTORY_FILE(), JSON.stringify(recs.slice(0, 50), null, 2));
  } catch {
    /* ignore */
  }
}

/** Max items a single `/bulk` or `V@bulk` accepts. Each item is a full resolve
 *  (sequential, a few seconds each), so this trades breadth against how long the
 *  command can run. */
export const BULK_MAX = 25;

/**
 * Split a bulk list into items. Newlines, `;` and `|` all separate items. The
 * message parser flattens newlines into spaces before commands see `args`, so
 * `V@bulk` reads the raw message text instead; this keeps that behaviour in one
 * testable place. `reserved` counts attached files that share the same cap.
 */
export function parseBulkItems(raw: string, reserved = 0): string[] {
  return raw
    .split(/[\n;|]+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, Math.max(0, BULK_MAX - reserved));
}

/** How many items a bulk list holds BEFORE the cap is applied. Lets the reply
 *  say "only the first 10 were read" instead of silently dropping the rest. */
export function countBulkItems(raw: string): number {
  return raw
    .split(/[\n;|]+/)
    .map((x) => x.trim())
    .filter(Boolean).length;
}

async function resolvePlayInput(query: string): Promise<ResolvedTrack[]> {
  if (isDirectMediaUrl(query)) {
    return [await resolveDirectMediaUrl(query)];
  }
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
  if (isGenericMediaUrl(query)) {
    return [await resolveGenericMediaUrl(query)];
  }
  try {
    return await resolveTracks(query);
  } catch (err) {
    // Spotify can fail for many reasons (no account linked, quota locked, web
    // token missing). Keep ordinary free-text play working through YouTube
    // instead of surfacing a hard error.
    const isSpotifyLink = /^(spotify:|https?:\/\/(open|play|embed)\.spotify\.com\/)/i.test(query);
    if (err instanceof SpotifyError && !isSpotifyLink) {
      const hit = await searchAndResolveYoutube(query);
      if (hit) return [hit];
    }
    if (err instanceof SpotifyError) throw err;
    throw new YoutubeError(err instanceof Error ? err.message : String(err));
  }
}
