import { describe, expect, it } from 'vitest';
import { buildJamInviteCard, JAM_CARD_NAME } from '../jamInvite.js';
import { CARD_H, CARD_W } from '../jamCardArt.js';

const JOIN = 'https://vaporzr.example.com/jam?key=k1';

describe('jam invite card', () => {
  it('carries the join URL in all three places a scanner could need it', async () => {
    const card = await buildJamInviteCard({
      joinUrl: JOIN,
      color: 0x6a5cff,
      inRoom: 4,
      now: { name: 'Night Drive', artists: ['Kredo'] },
      upNext: 7,
    });
    const embed = card.embeds[0].data;
    // 1. Typed URL under the card for anyone who prefers copying it…
    expect(embed.description).toContain(JOIN);
    // 2. …the QR postcard itself (attached, not a CDN URL, so it never expires)…
    expect(embed.image?.url).toBe(`attachment://${JAM_CARD_NAME}`);
    expect(card.files[0].name).toBe(JAM_CARD_NAME);
    // 3. …and the tap target for desktop users.
    const row = card.components[0].toJSON() as { components: { style: number; url?: string }[] };
    expect(row.components[0].style).toBe(5); // Link
    expect(row.components[0].url).toBe(JOIN);
  });

  it('attaches the vaporwave postcard as a real PNG at card size', async () => {
    const card = await buildJamInviteCard({ joinUrl: JOIN, color: 0x6a5cff });
    const buf = card.files[0].attachment as Buffer;
    expect(buf.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(buf.readUInt32BE(16)).toBe(CARD_W);
    expect(buf.readUInt32BE(20)).toBe(CARD_H);
    expect(buf.length).toBeGreaterThan(1000);
  });

  it('shows the live room, now-playing and up-next numbers', async () => {
    const card = await buildJamInviteCard({
      joinUrl: JOIN,
      color: 0x6a5cff,
      inRoom: 4,
      now: { name: 'Night Drive', artists: ['Kredo'] },
      upNext: 7,
    });
    const fields = card.embeds[0].data.fields ?? [];
    const by = (name: string) => fields.find((f) => f.name.includes(name))?.value;
    expect(by('In the room')).toBe('4 listeners');
    expect(by('Now playing')).toBe('Night Drive — Kredo');
    expect(by('Up next')).toBe('7 tracks');
  });

  it('degrades gracefully: unknown numbers hide, an idle queue invites', async () => {
    const card = await buildJamInviteCard({ joinUrl: JOIN, color: 0x1db954, upNext: 0 });
    const fields = card.embeds[0].data.fields ?? [];
    const names = fields.map((f) => f.name);
    expect(fields.find((f) => f.name.includes('In the room'))).toBeUndefined();
    expect(fields.find((f) => f.name.includes('Now playing'))?.value).toBe('Nothing yet');
    expect(fields.find((f) => f.name.includes('Up next'))?.value).toBe('Queue is open');
    expect(names.length).toBe(2);
  });

  it('singular counts read like English', async () => {
    const card = await buildJamInviteCard({ joinUrl: JOIN, color: 0x6a5cff, inRoom: 1, upNext: 1 });
    const fields = card.embeds[0].data.fields ?? [];
    expect(fields.find((f) => f.name.includes('In the room'))?.value).toBe('1 listener');
    expect(fields.find((f) => f.name.includes('Up next'))?.value).toBe('1 track');
  });
});
