import { describe, expect, it, vi } from 'vitest';
import { QueueManager } from '@vaporzr/core/queue';
import { Bridge } from '../bridge.js';

// Keep the real module surface; only the YouTube search is stubbed so the
// no-resolver fallback path is deterministic (and never hits the network).
vi.mock('@vaporzr/core/youtube', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@vaporzr/core/youtube')>();
  return {
    ...actual,
    searchAndResolveYoutube: vi.fn(async (q: string) => ({
      uri: 'youtube:video:fallback',
      name: `YT ${q}`,
      artists: ['YT Artist'],
      album: 'YouTube',
      durationMs: 180_000,
      image: undefined,
    })),
  };
});

interface FakeTrack {
  uri: string;
  name: string;
  artists: string[];
  album: string;
  durationMs: number;
  source: 'spotify' | 'youtube';
  image?: string;
}

function track(i: number): FakeTrack {
  return {
    uri: `spotify:track:t${i}`,
    name: `Track ${i}`,
    artists: ['Kredo'],
    album: 'Album',
    durationMs: 200_000,
    source: 'spotify',
  };
}

interface Harness {
  b: Bridge;
  q: QueueManager;
  notices: Array<{ level: string; text: string }>;
  playCalls: { n: number };
}

/** playSearch only touches `sessions.primary.queue`, `onResolveRequest`, the
 *  voice check, playback and notices — all plain fields — so a prototype-level
 *  fake sidesteps the real Bridge constructor, which binds a WebSocket server
 *  and a librespot manager. */
function harness(resolved: FakeTrack[], opts: { wired?: boolean } = {}): Harness {
  const q = new QueueManager();
  const notices: Harness['notices'] = [];
  const playCalls = { n: 0 };
  const b = Object.create(Bridge.prototype) as Bridge;
  Object.assign(b, {
    sessions: {
      primary: {
        queue: q,
        playback: {
          play: async () => {
            playCalls.n += 1;
          },
        },
        voice: { isJoined: () => true },
      },
    },
    onResolveRequest: opts.wired === false ? null : async (): Promise<FakeTrack[]> => resolved,
    notice: (level: string, text: string) => {
      notices.push({ level, text });
    },
  });
  return { b, q, notices, playCalls };
}

const run = (b: Bridge, query: string, now = false): Promise<void> =>
  (b as unknown as { playSearch(q: string, now: boolean): Promise<void> }).playSearch(query, now);

const names = (q: QueueManager): string[] => q.getSnapshot().tracks.map((t) => t.name);

describe('Bridge.playSearch (panel search box)', () => {
  it('resolves links through the wired resolver — not just YouTube', async () => {
    // The panel used to hardcode YouTube search, so a Spotify/Suno/SoundCloud
    // link (which V@p and the jam page all accept) simply found nothing.
    const h = harness([track(1)]);
    await run(h.b, 'https://open.spotify.com/track/t1', false);
    expect(names(h.q)).toEqual(['Track 1']);
    const entry = h.q.getSnapshot().tracks[0];
    expect(entry.source).toBe('spotify');
    expect(entry.addedBy).toBe('panel');
    expect(h.notices.at(-1)).toEqual({ level: 'success', text: 'Added: Track 1' });
  });

  it('a playlist link queues the fresh tracks in order, capped at 25', async () => {
    const h = harness(Array.from({ length: 30 }, (_, i) => track(i)));
    await run(h.b, 'https://open.spotify.com/playlist/p', false);
    expect(h.q.getSnapshot().tracks).toHaveLength(25);
    expect(names(h.q).slice(0, 3)).toEqual(['Track 0', 'Track 1', 'Track 2']);
    expect(h.notices.at(-1)?.text).toContain('25 tracks (+5 more not queued)');
  });

  it('never stacks a song that is already waiting', async () => {
    const h = harness([track(1)]);
    await run(h.b, 'mikado', false);
    await run(h.b, 'mikado', false);
    expect(h.q.getSnapshot().tracks).toHaveLength(1);
    expect(h.q.totalEnqueued).toBe(1);
    expect(h.notices.at(-1)).toEqual({ level: 'info', text: '"Track 1" is already in the queue.' });
  });

  it('a duplicate "play now" plays the copy that is already there', async () => {
    const h = harness([track(1)]);
    await run(h.b, 'mikado', false);
    await run(h.b, 'mikado', true);
    expect(h.q.getSnapshot().tracks).toHaveLength(1);
    expect(h.q.getCurrentTrack()?.uri).toBe('spotify:track:t1');
    expect(h.playCalls.n).toBe(1);
  });

  it('"play now" starts the first fresh track of a batch, joining voice first', async () => {
    const h = harness([track(1), track(2)]);
    // Something is already waiting, so the fresh batch lands behind it and
    // play-now has to move the cursor onto the new track instead of the head.
    h.q.enqueue(track(9), 'user');
    await run(h.b, 'a set', true);
    expect(h.q.getCurrentTrack()?.uri).toBe('spotify:track:t1');
    expect(h.playCalls.n).toBe(1);
    expect(h.notices.at(-1)?.text).toBe('Now playing: 2 tracks');
  });

  it('falls back to YouTube search when the bot has not wired a resolver', async () => {
    const h = harness([], { wired: false });
    await run(h.b, 'mikado', false);
    expect(names(h.q)).toEqual(['YT mikado']);
  });

  it('toasts the socket that asked when it is not a panel (the player add box)', async () => {
    // The desktop player connects as a visualizer, so a panels-only broadcast
    // would leave its add box silent; the bridge copies the toast to it.
    const h = harness([track(1)]);
    const socket = {};
    const direct: Array<{ level: string; text: string }> = [];
    Object.assign(h.b, {
      panels: new Set(),
      sendToSocket: (_s: unknown, m: { level: string; text: string }) => direct.push(m),
    });
    const call = (q: string): Promise<void> =>
      (h.b as unknown as { playSearch(q: string, now: boolean, gid?: string, requester?: unknown): Promise<void> }).playSearch(
        q,
        false,
        undefined,
        socket,
      );
    await call('mikado');
    expect(direct.at(-1)?.text).toBe('Added: Track 1');
    // A panel requester is already toasted by the broadcast — no duplicate.
    const sent = direct.length;
    Object.assign(h.b, { panels: new Set([{ socket }]) });
    await call('mikado two');
    expect(direct.length).toBe(sent);
  });
});
