import { describe, expect, it } from 'vitest';
import { buildJamInviteCard } from '../jamInvite.js';

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
    // 2. …the QR postcard, served as a URL instead of a multipart attachment…
    expect(embed.image?.url).toContain('/jam-card.png?u=');
    expect(card.files).toHaveLength(0);
    // 3. …and the tap target for desktop users.
    const row = card.components[0].toJSON() as { components: { style: number; url?: string }[] };
    expect(row.components[0].style).toBe(5); // Link
    expect(row.components[0].url).toBe(JOIN);
  });

  it('adds a crowd-view button next to the request link', async () => {
    const card = await buildJamInviteCard({
      joinUrl: JOIN,
      crowdUrl: 'https://vaporzr.example.com/c/ABC234',
      color: 0x6a5cff,
    });
    const row = card.components[0].toJSON() as { components: { label: string; url?: string }[] };
    expect(row.components.map((c) => c.label)).toEqual(['🔗 Join the jam', 'Crowd view']);
    expect(row.components[1].url).toBe('https://vaporzr.example.com/c/ABC234');
  });

  it('points the embed at the card endpoint with the join URL encoded', async () => {
    const card = await buildJamInviteCard({ joinUrl: JOIN, color: 0x6a5cff });
    const image = new URL(card.embeds[0].data.image?.url ?? '');
    expect(image.pathname).toBe('/jam-card.png');
    expect(image.searchParams.get('u')).toBe(JOIN);
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
