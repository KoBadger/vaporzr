/**
 * The shareable jam card: a scan-to-join QR, the guest link, and a couple of
 * live lines, packaged the way `/jam`, `V@jam` and the web panel's Share button
 * all post it.
 *
 * Deliberately free of config and Discord-client state — the caller passes
 * every number in, so the whole card is testable without a guild.
 */
import QRCode from 'qrcode';
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js';

export const JAM_QR_NAME = 'jam-qr.png';

export interface JamInviteInfo {
  /** The guest URL the QR points at (already carries the request key). */
  joinUrl: string;
  /** People in the voice channel, bots excluded; undefined hides the field. */
  inRoom?: number;
  /** What the bot is playing right now; null = nothing loaded yet. */
  now?: { name: string; artists: string[] } | null;
  /** How many tracks wait after the current one; undefined hides the field. */
  upNext?: number;
  /** Embed colour (the guild's theme). */
  color: number;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** Render the guest URL as a chat-scan-friendly PNG. Mid error correction
 *  survives a phone held at an angle; the 2-module margin keeps the code out
 *  of Discord's rounded corners. */
export function jamQrPng(url: string): Promise<Buffer> {
  return QRCode.toBuffer(url, {
    type: 'png',
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 620,
    color: { dark: '#0b1026ff', light: '#ffffffff' },
  });
}

/** Build the jam invite card: embed + QR attachment + a link button. */
export async function buildJamInviteCard(info: JamInviteInfo): Promise<{
  embeds: EmbedBuilder[];
  files: AttachmentBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
}> {
  const embed = new EmbedBuilder()
    .setTitle('📱 Scan to join the jam')
    .setDescription(
      'Point your **phone camera** at the code — pick a song, add your name, and it lands in ' +
        "everyone's queue. No app, no account.\n\n" +
        `Or open: \`${info.joinUrl}\``,
    )
    .setColor(info.color)
    .setImage(`attachment://${JAM_QR_NAME}`)
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

  return {
    embeds: [embed],
    files: [new AttachmentBuilder(await jamQrPng(info.joinUrl), { name: JAM_QR_NAME })],
    components: [row],
  };
}
