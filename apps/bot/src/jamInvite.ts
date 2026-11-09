/**
 * The shareable jam card: a vaporwave invite to the jam (the QR postcard from
 * jamCardArt, the guest link, and a couple of live lines), packaged the way
 * `/jam`, `V@jam` and the web panel's Share button all post it.
 *
 * Deliberately free of config and Discord-client state — the caller passes
 * every number in, so the whole card is testable without a guild.
 */
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';

export const JAM_CARD_NAME = 'jam-card.png';

export interface JamInviteInfo {
  /** The guest URL the QR points at (already carries the request key). */
  joinUrl: string;
  /** Read-only crowd panel for the same room, when a public base exists. */
  crowdUrl?: string;
  /** People in the voice channel, bots excluded; undefined hides the field. */
  inRoom?: number;
  /** What the bot is playing right now; null/undefined = nothing loaded yet. */
  now?: { name: string; artists: string[] } | null;
  /** How many tracks wait after the current one; undefined hides the field. */
  upNext?: number;
  /** Embed colour (the guild's theme). */
  color: number;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** Build the jam invite card: embed + vaporwave QR postcard + a link button. */
export async function buildJamInviteCard(info: JamInviteInfo): Promise<{
  embeds: EmbedBuilder[];
  files: [];
  components: ActionRowBuilder<ButtonBuilder>[];
}> {
  const embed = new EmbedBuilder()
    .setTitle("📼 You're invited to the jam")
    .setDescription(
      'Scan the card with your **phone camera** — pick a song, add your name, and it lands in ' +
        "everyone's queue. No app, no account.\n\n" +
        `Or open: \`${info.joinUrl}\``,
    )
    .setColor(info.color)
    // Served by /jam-card.png instead of an attachment: Discord's REST layer
    // rejected the file upload with undici's cross-instance FormData error.
    // A URL image keeps the same card art without touching multipart bodies.
    .setImage(`${new URL('/jam-card.png?u=' + encodeURIComponent(info.joinUrl), info.joinUrl).toString()}`)
    .setFooter({ text: 'Guests can add songs — playback control stays with the panel.' });

  const fields: { name: string; value: string; inline: boolean }[] = [];
  if (info.inRoom != null) {
    fields.push({
      name: '🎧 In the room',
      value: `${info.inRoom} listener${info.inRoom === 1 ? '' : 's'}`,
      inline: true,
    });
  }
  fields.push({
    name: '🎵 Now playing',
    value: info.now
      ? truncate(`${info.now.name}${info.now.artists.length ? ` — ${info.now.artists.join(', ')}` : ''}`, 80)
      : 'Nothing yet',
    inline: true,
  });
  if (info.upNext != null) {
    fields.push({
      name: '⏭ Up next',
      value: info.upNext === 0 ? 'Queue is open' : `${info.upNext} track${info.upNext === 1 ? '' : 's'}`,
      inline: true,
    });
  }
  embed.addFields(fields);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setLabel('🔗 Join the jam').setStyle(ButtonStyle.Link).setURL(info.joinUrl),
  );
  if (info.crowdUrl) {
    row.addComponents(new ButtonBuilder().setLabel('Crowd view').setStyle(ButtonStyle.Link).setURL(info.crowdUrl));
  }

  return {
    embeds: [embed],
    files: [],
    components: [row],
  };
}
