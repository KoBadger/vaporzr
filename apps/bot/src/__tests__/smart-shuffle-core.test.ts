import { describe, expect, it, vi } from 'vitest';
import { QueueManager } from '@vaporzr/core/queue';
import { getAudioFeatures, type AudioFeatures } from '@vaporzr/core/spotify';
import { DiscordBot } from '../discord.js';
import type { Session } from '../session.js';

// Keep every real export (extractSpotifyId and friends); only the features
// lookup is stubbed, so both branches run offline and deterministically.
vi.mock('@vaporzr/core/spotify', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@vaporzr/core/spotify')>();
  return { ...actual, getAudioFeatures: vi.fn(async () => new Map<string, AudioFeatures>()) };
});

const ID = (c: string): string => c.repeat(22);
const uri = (c: string): string => `spotify:track:${ID(c)}`;

function features(over: Partial<AudioFeatures> = {}): AudioFeatures {
  return {
    energy: 0.5,
    valence: 0.5,
    tempo: 120,
    danceability: 0.5,
    acousticness: 0.1,
    instrumentalness: 0,
    liveness: 0.1,
    speechiness: 0.05,
    time_signature: 4,
    duration_ms: 200_000,
    key: 0,
    mode: 1,
    ...over,
  };
}

function track(c: string): { uri: string; name: string; artists: string[]; album: string; durationMs: number } {
  return { uri: uri(c), name: c.toUpperCase(), artists: ['Artist'], album: '', durationMs: 200_000 };
}

/** smartShuffleCore only touches the session's queue, this.themeColor() and the
 *  features lookup — a prototype-level fake sidesteps the real constructor,
 *  which builds a Discord client and a librespot manager. */
function harness(): { b: DiscordBot; q: QueueManager } {
  const q = new QueueManager();
  const b = Object.create(DiscordBot.prototype) as DiscordBot;
  Object.assign(b, { themeColor: () => 0x123456 });
  return { b, q };
}

const run = (b: DiscordBot, q: QueueManager, mode = 'flow') =>
  (
    b as unknown as {
      smartShuffleCore(s: Session, mode: string, wasShuffle: boolean): Promise<{ embed?: unknown; skipReason?: string }>;
    }
  ).smartShuffleCore({ queue: q } as unknown as Session, mode, false);

const order = (q: QueueManager): string[] => q.getSnapshot().tracks.map((t) => t.uri);

describe('DiscordBot.smartShuffleCore', () => {
  it('says why it cannot rank when no track has audio features (instead of a fake success)', async () => {
    const { b, q } = harness();
    for (const c of ['a', 'b', 'c', 'd']) q.enqueue(track(c), 'user');
    const before = order(q);
    const { embed, skipReason } = await run(b, q);
    expect(embed).toBeUndefined();
    expect(skipReason).toContain("Can't rank");
    expect(skipReason).toContain('V@shuffle');
    expect(order(q)).toEqual(before); // no silent "already in the best order"
  });

  it('ranks with features and moves the queue (the success path still works)', async () => {
    const { b, q } = harness();
    for (const c of ['a', 'b', 'c', 'd']) q.enqueue(track(c), 'user');
    // a is playing; c sounds exactly like it, b and d sit far away. The greedy
    // walk must therefore lift c to the front of the upcoming queue.
    vi.mocked(getAudioFeatures).mockResolvedValueOnce(
      new Map<string, AudioFeatures>([
        [ID('a'), features()],
        [ID('b'), features({ energy: 0.95, tempo: 190, danceability: 0.9, valence: 0.9 })],
        [ID('c'), features()],
        [ID('d'), features({ energy: 0.05, tempo: 60, acousticness: 0.9 })],
      ]),
    );
    const { embed, skipReason } = await run(b, q);
    expect(skipReason).toBeUndefined();
    expect(embed).toBeDefined();
    expect(order(q)[1]).toBe(uri('c'));
  });
});
