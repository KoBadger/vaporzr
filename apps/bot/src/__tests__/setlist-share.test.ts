import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SetlistShareStore } from '@vaporzr/core/setlistShare';
import { renderSetlistPage, setlistViewFromShare } from '../setlistPage.js';

const track = (name: string, artists = 'Aphex Twin') => ({
  uri: `spotify:track:${name}`,
  name,
  artists,
  album: 'Selected Ambient Works',
  durationMs: 180_000,
  addedBy: 'host',
});

describe('SetlistShareStore', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vz-setlist-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('freezes the queue behind an unguessable id', () => {
    const store = new SetlistShareStore(tmp);
    const share = store.create({
      guildId: 'g1',
      tracks: [track('Xtal'), track('Tha')],
      nowPlaying: 1,
      now: 1_000,
      ttlMs: 60_000,
    });

    expect(share.id).toMatch(/^[A-Za-z0-9_-]{10,}$/);
    expect(share.tracks).toHaveLength(2);
    expect(share.nowPlaying).toBe(1);
    expect(share.expiresAt).toBe(61_000);
    expect(store.get(share.id, 1_500)?.tracks[0].name).toBe('Xtal');
    expect(store.get(share.id, 61_001)).toBeNull();
  });

  it('persists shares across instances', () => {
    const first = new SetlistShareStore(tmp);
    const share = first.create({ guildId: 'g1', tracks: [track('Xtal')], now: 5 });
    const second = new SetlistShareStore(tmp);
    expect(second.get(share.id, 6)?.guildId).toBe('g1');
  });

  it('drops malformed and empty tracks instead of trusting them', () => {
    const store = new SetlistShareStore(tmp);
    const share = store.create({
      guildId: 'g1',
      tracks: [track('Xtal'), { ...track(''), uri: '' }, track('Tha')],
      now: 5,
    });
    expect(share.tracks.map((t) => t.name)).toEqual(['Xtal', 'Tha']);
  });
});

describe('renderSetlistPage', () => {
  it('renders a shared queue with the playing row marked', () => {
    const share = {
      id: 'abc123',
      guildId: 'g1',
      guildName: 'The Room',
      name: 'Friday set',
      createdAt: 1_700_000_000_000,
      expiresAt: 1_700_600_000_000,
      nowPlaying: 1,
      tracks: [track('Xtal'), track('Tha')],
    };
    const html = renderSetlistPage({
      origin: 'https://www.vaporzr.app',
      view: setlistViewFromShare(share),
      canonicalUrl: 'https://www.vaporzr.app/setlist/abc123',
    });

    expect(html).toContain('Friday set');
    expect(html).toContain('The Room');
    expect(html).toContain('2 songs');
    expect(html).toContain('https://www.vaporzr.app/setlist/abc123');
    expect(html).toContain('class="track playing"');
    expect(html).toContain('▶');
    expect(html).toContain('link expires');
  });

  it('escapes hostile track metadata', () => {
    const share = {
      id: 'x',
      guildId: 'g1',
      guildName: '<script>alert(1)</script>',
      name: 'set',
      createdAt: 1,
      expiresAt: 2,
      nowPlaying: 0,
      tracks: [track('<img src=x onerror=alert(1)>', '"><b>')],
    };
    const html = renderSetlistPage({ origin: 'https://x.test', view: setlistViewFromShare(share) });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});
