import { describe, expect, it } from 'vitest';
import { createPlaylist, getCurrentUserId, partitionUris, type SpotifyRequest } from '../spotifyPlaylist.js';

interface RecordedCall {
  method: string;
  path: string;
  body: unknown;
}

/**
 * Build a SpotifyRequest fake that answers from `handler` and records every call.
 * Tests assert on the calls as well as the result, so what is sent (endpoint,
 * body, chunk sizes) is covered, not just what is returned.
 */
function fakeSpotify(handler: (call: RecordedCall) => Response | Promise<Response>): {
  request: SpotifyRequest;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const request: SpotifyRequest = async (method, path, body) => {
    const call: RecordedCall = { method, path, body };
    calls.push(call);
    return handler(call);
  };
  return { request, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function failed(status: number): Response {
  return new Response(JSON.stringify({ error: { status, message: 'request failed' } }), { status });
}

/** Zero-padded ids keep fixtures the same 22-character shape Spotify uses. */
function trackUri(n: number): string {
  return `spotify:track:${String(n).padStart(22, '0')}`;
}

/** A Spotify that accepts everything, with an optional hook to fail selected add calls. */
function workingSpotify(onAdd?: (index: number) => Response | undefined) {
  let addIndex = 0;
  return fakeSpotify((call) => {
    if (call.method === 'GET' && call.path === '/me') return json({ id: 'bot-user', display_name: 'Vaporzr' });
    if (call.method === 'POST' && call.path === '/users/bot-user/playlists') {
      return json({ id: 'pl-1', external_urls: { spotify: 'https://open.spotify.com/playlist/pl-1' } }, 201);
    }
    if (call.method === 'POST' && call.path === '/playlists/pl-1/tracks') {
      return onAdd?.(addIndex++) ?? json({ snapshot_id: 'snap' }, 201);
    }
    return failed(404);
  });
}

describe('getCurrentUserId', () => {
  it('reads the account id from GET /me', async () => {
    const { request, calls } = fakeSpotify(() => json({ id: 'bot-user', display_name: 'Vaporzr' }));
    await expect(getCurrentUserId(request)).resolves.toBe('bot-user');
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /me']);
    expect(calls[0].body).toBeUndefined();
  });

  it('returns null when the login lacks the scope (403)', async () => {
    const { request } = fakeSpotify(() => failed(403));
    await expect(getCurrentUserId(request)).resolves.toBeNull();
  });

  it('returns null when the request throws or the body is unusable', async () => {
    const thrown = fakeSpotify(() => {
      throw new Error('socket closed');
    });
    await expect(getCurrentUserId(thrown.request)).resolves.toBeNull();

    const unreadable = fakeSpotify(() => new Response('not json', { status: 200 }));
    await expect(getCurrentUserId(unreadable.request)).resolves.toBeNull();

    const noId = fakeSpotify(() => json({ display_name: 'Vaporzr' }));
    await expect(getCurrentUserId(noId.request)).resolves.toBeNull();
  });
});

describe('partitionUris', () => {
  it('keeps Spotify tracks and reports everything else as skipped', () => {
    const chunks = partitionUris([
      trackUri(1),
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'spotify:episode:abc',
      trackUri(2),
    ]);
    expect(chunks).toEqual([{ valid: [trackUri(1), trackUri(2)], skipped: 2 }]);
  });

  it('canonicalises Spotify web links and drops blank or local uris', () => {
    const link = 'https://open.spotify.com/track/0123456789abcdefghijkl?si=tracking';
    const chunks = partitionUris([link, '   ', 'spotify:local:artist:album:title:1']);
    expect(chunks).toEqual([{ valid: ['spotify:track:0123456789abcdefghijkl'], skipped: 2 }]);
  });

  it('chunks long lists into groups of 100', () => {
    const uris = Array.from({ length: 250 }, (_, i) => trackUri(i));
    const chunks = partitionUris(uris);
    expect(chunks.map((c) => c.valid.length)).toEqual([100, 100, 50]);
    expect(chunks.reduce((n, c) => n + c.skipped, 0)).toBe(0);
  });

  it('counts skipped uris in the window they fell in', () => {
    const uris = Array.from({ length: 150 }, (_, i) => trackUri(i));
    uris[120] = 'https://soundcloud.com/someone/something';
    const chunks = partitionUris(uris);
    expect(chunks.map((c) => c.valid.length)).toEqual([100, 49]);
    expect(chunks.map((c) => c.skipped)).toEqual([0, 1]);
  });

  it('returns no chunks for an empty list', () => {
    expect(partitionUris([])).toEqual([]);
  });
});

describe('createPlaylist', () => {
  it('creates a private playlist and fills it with the given tracks', async () => {
    const { request, calls } = workingSpotify();
    const result = await createPlaylist(
      { name: 'Tape — Friday', description: 'What the room played', uris: [trackUri(1), trackUri(2)] },
      request,
    );

    expect(result).toEqual({
      ok: true,
      id: 'pl-1',
      url: 'https://open.spotify.com/playlist/pl-1',
      added: 2,
      skipped: 0,
    });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /me',
      'POST /users/bot-user/playlists',
      'POST /playlists/pl-1/tracks',
    ]);
    expect(calls[1].body).toEqual({ name: 'Tape — Friday', description: 'What the room played', public: false });
    expect(calls[2].body).toEqual({ uris: [trackUri(1), trackUri(2)] });
  });

  it('honours the public flag', async () => {
    const { request, calls } = workingSpotify();
    await createPlaylist({ name: 'Public tape', isPublic: true, uris: [trackUri(1)] }, request);
    expect(calls[1].body).toEqual({ name: 'Public tape', description: '', public: true });
  });

  it('splits more than 100 tracks across add calls', async () => {
    const { request, calls } = workingSpotify();
    const uris = Array.from({ length: 250 }, (_, i) => trackUri(i));
    const result = await createPlaylist({ name: 'Big tape', uris }, request);

    const adds = calls.filter((c) => c.path === '/playlists/pl-1/tracks');
    expect(adds.map((c) => (c.body as { uris: string[] }).uris.length)).toEqual([100, 100, 50]);
    expect(result).toMatchObject({ ok: true, added: 250 });
  });

  it('drops tracks Spotify cannot play and reports them as skipped', async () => {
    const { request, calls } = workingSpotify();
    const result = await createPlaylist(
      { name: 'Mixed tape', uris: [trackUri(1), 'https://www.youtube.com/watch?v=x', 'spotify:episode:1'] },
      request,
    );

    expect(result).toEqual({
      ok: true,
      id: 'pl-1',
      url: 'https://open.spotify.com/playlist/pl-1',
      added: 1,
      skipped: 2,
    });
    expect(calls[2].body).toEqual({ uris: [trackUri(1)] });
  });

  it('does not create a playlist when no uri is a Spotify track', async () => {
    const { request, calls } = workingSpotify();
    const result = await createPlaylist(
      { name: 'Nothing', uris: ['https://youtu.be/abc', 'spotify:episode:1'] },
      request,
    );

    if (result.ok) throw new Error('expected createPlaylist to fail');
    expect(result.error).toContain('2');
    expect(result.error).toContain('Spotify');
    expect(calls).toEqual([]);
  });

  it('maps a 403 on /me to the missing-scope hint', async () => {
    const { request, calls } = fakeSpotify(() => failed(403));
    const result = await createPlaylist({ name: 'Tape', uris: [trackUri(1)] }, request);

    if (result.ok) throw new Error('expected createPlaylist to fail');
    expect(result.error).toContain('403');
    expect(result.error).toContain('playlist-modify');
    expect(result.error).toContain('/login');
    expect(calls.map((c) => c.path)).toEqual(['/me']);
  });

  it('maps a 403 on creation to the same re-login hint', async () => {
    const { request } = fakeSpotify((call) => (call.path === '/me' ? json({ id: 'bot-user' }) : failed(403)));
    const result = await createPlaylist({ name: 'Tape', uris: [trackUri(1)] }, request);

    if (result.ok) throw new Error('expected createPlaylist to fail');
    expect(result.error).toContain('403');
    expect(result.error).toContain('playlist-modify');
    expect(result.error).toContain('/login');
  });

  it('keeps the playlist and reports the accurate count when a later chunk fails', async () => {
    const { request, calls } = workingSpotify((index) => (index === 1 ? failed(400) : undefined));
    const uris = Array.from({ length: 150 }, (_, i) => trackUri(i));
    const result = await createPlaylist({ name: 'Partial tape', uris }, request);

    expect(result).toEqual({
      ok: true,
      id: 'pl-1',
      url: 'https://open.spotify.com/playlist/pl-1',
      added: 100,
      skipped: 0,
    });
    expect(calls.filter((c) => c.path === '/playlists/pl-1/tracks')).toHaveLength(2);
  });

  it('fails when Spotify accepts the playlist but rejects every add call', async () => {
    const { request } = workingSpotify(() => failed(500));
    const result = await createPlaylist({ name: 'Empty tape', uris: [trackUri(1), trackUri(2)] }, request);

    if (result.ok) throw new Error('expected createPlaylist to fail');
    expect(result.error).toContain('HTTP 500');
  });

  it('turns unreachable-Spotify errors into a failure result', async () => {
    const onMe = fakeSpotify(() => {
      throw new Error('ENOTFOUND api.spotify.com');
    });
    const lookupFailure = await createPlaylist({ name: 'Offline', uris: [trackUri(1)] }, onMe.request);
    if (lookupFailure.ok) throw new Error('expected createPlaylist to fail');
    expect(lookupFailure.error).toContain('ENOTFOUND');

    const onCreate = fakeSpotify((call) => {
      if (call.path === '/me') return json({ id: 'bot-user' });
      throw new Error('socket hang up');
    });
    const createFailure = await createPlaylist({ name: 'Offline', uris: [trackUri(1)] }, onCreate.request);
    if (createFailure.ok) throw new Error('expected createPlaylist to fail');
    expect(createFailure.error).toContain('socket hang up');
  });

  it('falls back to the canonical playlist url when Spotify sends none', async () => {
    const { request } = fakeSpotify((call) => {
      if (call.path === '/me') return json({ id: 'bot-user' });
      if (call.path === '/users/bot-user/playlists') return json({ id: 'pl-2' }, 201);
      return json({ snapshot_id: 'snap' }, 201);
    });
    const result = await createPlaylist({ name: 'Fallback', uris: [trackUri(1)] }, request);

    expect(result).toMatchObject({ ok: true, id: 'pl-2', url: 'https://open.spotify.com/playlist/pl-2' });
  });

  it('fails when the created playlist comes back without an id', async () => {
    const { request } = fakeSpotify((call) =>
      call.path === '/me' ? json({ id: 'bot-user' }) : json({ snapshot_id: 'snap' }, 201),
    );
    const result = await createPlaylist({ name: 'Broken', uris: [trackUri(1)] }, request);

    if (result.ok) throw new Error('expected createPlaylist to fail');
    expect(result.error).toContain('no id');
  });
});
