import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SetlistShareStore } from '@vaporzr/core/setlistShare';
import { TapeStore } from '@vaporzr/core/tape';
import { renderSetlistPage, setlistViewFromShare, setlistViewFromTape } from '../setlistPage.js';

const track = (name: string, artists = 'Aphex Twin') => ({
  uri: `spotify:track:${name}`,
  name,
  artists,
  album: 'Selected Ambient Works',
  durationMs: 180_000,
  addedBy: 'host',
  addedAt: 0,
});

/** A tape entry needs the real TrackInfo shape (artists is an array). */
const tapeTrack = (name: string) => ({
  uri: `spotify:track:${name}`,
  name,
  artists: ['Aphex Twin'],
  album: 'Selected Ambient Works',
  durationMs: 180_000,
  addedBy: 'host',
  addedAt: 0,
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

describe('setlistViewFromTape', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vz-tape-view-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('renders a rolling tape as a sealed/rolling setlist', () => {
    const store = new TapeStore(tmp);
    store.start('g1', { startedBy: 'dj', name: 'Friday' });
    store.noteTrack('g1', tapeTrack('Xtal'));
    store.noteTrack('g1', tapeTrack('Tha'));
    store.noteTrack('g1', tapeTrack('Xtal')); // a repeat, still one entry

    const tape = store.active('g1');
    expect(tape).not.toBeNull();

    const html = renderSetlistPage({
      origin: 'https://www.vaporzr.app',
      view: setlistViewFromTape(tape!),
      canonicalUrl: 'https://www.vaporzr.app/tape/g1',
    });

    expect(html).toContain('rolling');
    expect(html).toContain('2 songs');
    expect(html).toContain('started by dj');
    expect(html).not.toContain('link expires');
  });

  it('marks a sealed tape as sealed rather than rolling', () => {
    const store = new TapeStore(tmp);
    store.start('g1', { startedBy: 'dj', name: 'Late' });
    store.noteTrack('g1', tapeTrack('Xtal'));
    const sealed = store.stop('g1', Date.now() + 1_000);

    const html = renderSetlistPage({
      origin: 'https://www.vaporzr.app',
      view: setlistViewFromTape(sealed!),
    });

    expect(html).toContain('sealed');
    expect(html).not.toContain('rolling');
  });

  it('renders an empty tape without inventing rows', () => {
    const store = new TapeStore(tmp);
    store.start('g1', { startedBy: 'dj', name: 'Empty' });
    const tape = store.active('g1');

    const html = renderSetlistPage({ origin: 'https://x.test', view: setlistViewFromTape(tape!) });
    expect(html).toContain('0 songs');
    expect(html).toContain('Nothing has been recorded on this tape yet.');
  });
});
