import { apiRaw } from './spotify.js';

/**
 * The slice of the Spotify Web API this module needs, as a plain function.
 * Production uses the shared `apiRaw` (token refresh, rate-limit cooldown), while
 * tests inject a fake so playlist creation runs without tokens or a network.
 */
export type SpotifyRequest = (method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown) => Promise<Response>;

export interface CreatePlaylistOptions {
  name: string;
  description?: string;
  isPublic?: boolean;
  uris: string[];
}

export type CreatePlaylistResult =
  { ok: true; id: string; url: string; added: number; skipped: number } | { ok: false; error: string };

/** Spotify accepts at most 100 uris per "add items" call; the API rejects the whole chunk otherwise. */
const ADD_CHUNK_SIZE = 100;

const TRACK_URI = /^spotify:track:([A-Za-z0-9]+)$/;
const TRACK_URL = /^(?:https?:\/\/)?open\.spotify\.com\/(?:intl-[a-z-]+\/)?track\/([A-Za-z0-9]+)(?:[?#]\S*)?$/;

const PLAYLIST_WEB_URL = 'https://open.spotify.com/playlist/';

interface CreatedPlaylistResponse {
  id?: unknown;
  external_urls?: { spotify?: unknown };
}

interface AccountLookup {
  id?: string;
  error?: string;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Canonicalise one uri to `spotify:track:<id>`, or null when it is not a Spotify track. */
function toTrackUri(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  const match = TRACK_URI.exec(value) ?? TRACK_URL.exec(value);
  return match ? `spotify:track:${match[1]}` : null;
}

/**
 * Turn a failed Spotify response into something a Discord user can act on. The
 * status code stays in the text: it is the only way to tell a bad request apart
 * from an expired login when the error is pasted into a bug report.
 */
function describeHttpFailure(status: number, action: string): string {
  if (status === 401) return `Spotify rejected the login (HTTP 401) — run /login again, then retry.`;
  if (status === 403)
    return `Spotify returned 403 while trying to ${action} — the bot's Spotify login needs the playlist-modify scope, so run /login again.`;
  if (status === 429)
    return `Spotify rate-limited the bot while trying to ${action} (HTTP 429) — try again in a minute.`;
  return `Spotify could not ${action} (HTTP ${status}).`;
}

async function lookupAccount(request: SpotifyRequest): Promise<AccountLookup> {
  let res: Response;
  try {
    res = await request('GET', '/me');
  } catch (err) {
    return { error: `Could not reach Spotify to read the account: ${errorMessage(err)}` };
  }
  if (!res.ok) return { error: describeHttpFailure(res.status, 'read the Spotify account') };
  let data: { id?: unknown };
  try {
    data = (await res.json()) as { id?: unknown };
  } catch {
    return { error: 'Spotify returned an unreadable account response.' };
  }
  if (typeof data.id !== 'string' || data.id.length === 0) {
    return { error: 'Spotify returned an account without an id.' };
  }
  return { id: data.id };
}

/** GET /me -> id. Returns null when the token lacks the scope (403) or the call fails. */
export async function getCurrentUserId(request: SpotifyRequest = apiRaw): Promise<string | null> {
  const account = await lookupAccount(request);
  return account.id ?? null;
}

/**
 * Split the raw uri list into the windows Spotify will accept. Anything that is
 * not a Spotify track (YouTube/SoundCloud links, local files, episodes) is
 * dropped: Spotify rejects an entire add call over one bad uri, so a single
 * stray entry would cost the rest of the playlist. `skipped` is reported per
 * input window of 100, so summing it over the result gives the dropped count.
 */
export function partitionUris(uris: string[]): { valid: string[]; skipped: number }[] {
  const chunks: { valid: string[]; skipped: number }[] = [];
  for (let i = 0; i < uris.length; i += ADD_CHUNK_SIZE) {
    const valid: string[] = [];
    let skipped = 0;
    for (const raw of uris.slice(i, i + ADD_CHUNK_SIZE)) {
      const uri = toTrackUri(raw);
      if (uri) valid.push(uri);
      else skipped++;
    }
    chunks.push({ valid, skipped });
  }
  return chunks;
}

/**
 * Create a playlist in the linked account and fill it with the Spotify tracks
 * among `uris`. Never throws: Spotify failures and network errors come back as
 * `{ ok: false, error }` so a /tape command can always answer the user.
 */
export async function createPlaylist(
  opts: CreatePlaylistOptions,
  request: SpotifyRequest = apiRaw,
): Promise<CreatePlaylistResult> {
  const chunks = partitionUris(opts.uris);
  const total = chunks.reduce((sum, chunk) => sum + chunk.valid.length, 0);
  const skipped = chunks.reduce((sum, chunk) => sum + chunk.skipped, 0);
  // An empty playlist is not a useful artifact: if the session held nothing
  // Spotify can address, say so instead of leaving clutter in the user's library.
  if (total === 0) {
    return {
      ok: false,
      error:
        skipped > 0
          ? `None of the ${skipped} tracks are on Spotify, so there is nothing to add.`
          : 'There are no tracks to add to the playlist.',
    };
  }

  const account = await lookupAccount(request);
  if (!account.id) return { ok: false, error: account.error ?? 'Could not read the Spotify account.' };

  let createRes: Response;
  try {
    createRes = await request('POST', `/users/${encodeURIComponent(account.id)}/playlists`, {
      name: opts.name,
      description: opts.description ?? '',
      public: opts.isPublic ?? false,
    });
  } catch (err) {
    return { ok: false, error: `Could not reach Spotify to create the playlist: ${errorMessage(err)}` };
  }
  if (!createRes.ok) return { ok: false, error: describeHttpFailure(createRes.status, 'create the playlist') };

  let created: CreatedPlaylistResponse;
  try {
    created = (await createRes.json()) as CreatedPlaylistResponse;
  } catch {
    return { ok: false, error: 'Spotify created the playlist but returned an unreadable response.' };
  }
  const id = typeof created.id === 'string' && created.id.length > 0 ? created.id : '';
  if (!id) return { ok: false, error: 'Spotify created the playlist but returned no id.' };
  const url =
    typeof created.external_urls?.spotify === 'string' ? created.external_urls.spotify : `${PLAYLIST_WEB_URL}${id}`;

  let added = 0;
  let failure = '';
  for (const chunk of chunks) {
    if (chunk.valid.length === 0) continue;
    let res: Response;
    try {
      res = await request('POST', `/playlists/${id}/tracks`, { uris: chunk.valid });
    } catch (err) {
      failure = `Could not reach Spotify to add tracks: ${errorMessage(err)}`;
      break;
    }
    if (!res.ok) {
      failure = describeHttpFailure(res.status, 'add tracks to the playlist');
      break;
    }
    added += chunk.valid.length;
  }

  // A playlist that exists with some of its tracks is still worth handing back —
  // the user asked for a playlist, and the url makes the partial one usable.
  // Only when not a single track landed does the whole call read as a failure.
  if (added === 0) {
    return {
      ok: false,
      error: `Spotify created the playlist, but adding tracks failed — ${failure || 'no tracks were accepted.'}`,
    };
  }
  return { ok: true, id, url, added, skipped };
}
