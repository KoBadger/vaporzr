import type { AudioFeatures } from '@vaporzr/core/spotify';
import { extractSpotifyId, getAudioFeatures } from '@vaporzr/core/spotify';
import { PlaylistStore, playlistStore, type SavedTrack } from '@vaporzr/core/playlists';
import {
  TapeStore,
  orderSetlist,
  summarizeTape,
  tapes as globalTapes,
  toSetlist,
  type Tape,
  type TapeEntry,
  type TapeOrderMode,
} from '@vaporzr/core/tape';
import type { CreatePlaylistResult } from '@vaporzr/core/spotifyPlaylist';
import { createPlaylist } from '@vaporzr/core/spotifyPlaylist';
import { safeFilename, toCsv, toMarkdown, toM3U, type ExportTrack } from './setlistExport.js';

/**
 * The `/tape` command's brain, kept out of the 13k-line Discord dispatcher so the
 * decision-making can be read and changed without hunting through reply plumbing.
 *
 * Every action returns a plain payload — text, an ephemeral flag, optional file
 * attachments — and touches Discord only through what the caller passes in. That
 * is what makes the interesting cases (nothing recorded, tape too long, Spotify
 * not authorised) testable without a gateway connection.
 */

export interface TapeCommandDeps {
  tapes: TapeStore;
  playlists: PlaylistStore;
  /** Audio features keyed by Spotify id; failures degrade to recorded order. */
  features: (entries: TapeEntry[]) => Promise<Map<string, Partial<AudioFeatures>>>;
  createSpotify: (opts: {
    name: string;
    description: string;
    isPublic: boolean;
    uris: string[];
  }) => Promise<CreatePlaylistResult>;
  now: () => number;
}

export interface TapeAttachment {
  name: string;
  data: Buffer;
  description?: string;
}

export interface TapeReply {
  content: string;
  ephemeral: boolean;
  files?: TapeAttachment[];
}

export interface TapeCommandInput {
  sub: string;
  guildId: string;
  username: string;
  /** Tape name for start/save, or the id for delete. */
  name?: string;
  /** Export format: m3u | csv | md | all. */
  format?: string;
  /** Set order for save/spotify: time | flow | arc | key | sonic. */
  mode?: string;
  isPublic?: boolean;
}

const ORDER_MODES: TapeOrderMode[] = ['time', 'flow', 'arc', 'key', 'sonic'];

/** Coerce a user-supplied order name, defaulting to the recorded order. */
export function parseOrderMode(raw: string | undefined): TapeOrderMode {
  const value = (raw ?? '').toLowerCase().trim();
  return (ORDER_MODES as string[]).includes(value) ? (value as TapeOrderMode) : 'time';
}

function formatElapsed(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'under a minute';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

function describeTape(tape: Tape): string {
  const s = summarizeTape(tape);
  const bits = [`${s.total} track${s.total === 1 ? '' : 's'}`];
  if (s.unique !== s.total) bits.push(`${s.unique} unique`);
  bits.push(`${s.artists.length} artist${s.artists.length === 1 ? '' : 's'}`);
  if (s.elapsedMs > 0) bits.push(formatElapsed(s.elapsedMs));
  if (s.ears > 0) bits.push(`${s.ears} heard in the room`);
  return bits.join(' · ');
}

function toExportTracks(entries: TapeEntry[]): ExportTrack[] {
  return entries.map((e) => ({
    name: e.name,
    artists: e.artists,
    album: e.album || undefined,
    durationMs: e.durationMs || undefined,
    uri: e.uri,
    source: e.source,
    addedBy: e.addedBy,
    playedAt: e.playedAt,
  }));
}

function toSavedTracks(entries: TapeEntry[]): SavedTrack[] {
  return entries.map((e) => ({
    uri: e.uri,
    name: e.name,
    artists: e.artists,
    album: e.album,
    durationMs: e.durationMs,
    source: e.source,
    image: e.image,
  }));
}

/** Spotify access token scoped for playlist writes; the command layer checks auth before this. */
async function defaultFeatures(entries: TapeEntry[]): Promise<Map<string, Partial<AudioFeatures>>> {
  const ids = [
    ...new Set(
      entries.map((e) => extractSpotifyId(e.uri)).filter((id): id is string => typeof id === 'string' && id.length > 0),
    ),
  ];
  if (ids.length === 0) return new Map();
  try {
    return await getAudioFeatures(ids);
  } catch {
    // Ordering is a nicety; the tape itself must still save when Spotify is down.
    return new Map();
  }
}

export function tapeDeps(over: Partial<TapeCommandDeps> = {}): TapeCommandDeps {
  return {
    tapes: globalTapes,
    playlists: playlistStore,
    features: defaultFeatures,
    createSpotify: (opts) => createPlaylist(opts),
    now: () => Date.now(),
    ...over,
  };
}

/** Resolve the setlist for a tape, collapsing repeats and (optionally) re-sequencing. */
async function buildSetlist(
  tape: Tape,
  mode: TapeOrderMode,
  deps: TapeCommandDeps,
): Promise<{ entries: TapeEntry[]; withoutFeatures: number }> {
  const collapsed = toSetlist(tape.entries).map((item) => item.entry);
  if (mode === 'time') return { entries: collapsed, withoutFeatures: 0 };
  const features = await deps.features(collapsed);
  const ordered = orderSetlist(collapsed, mode, (e) => {
    const id = extractSpotifyId(e.uri);
    return id ? features.get(id) : undefined;
  });
  const known = ordered.filter((e) => {
    const id = extractSpotifyId(e.uri);
    return id ? features.has(id) : false;
  }).length;
  return { entries: ordered, withoutFeatures: ordered.length - known };
}

function needsTape(reply: TapeReply | null): TapeReply {
  return (
    reply ?? {
      content: 'No tape recorded yet — use /tape start first, or check /tape list.',
      ephemeral: true,
    }
  );
}

/**
 * Run one `/tape` action. Returns null when the caller must handle the subcommand
 * itself (ears needs the live voice connection, which lives in the bot).
 */
export async function runTapeCommand(
  input: TapeCommandInput,
  over: Partial<TapeCommandDeps> = {},
): Promise<TapeReply | null> {
  const deps = tapeDeps(over);
  const guildId = input.guildId;
  const sub = input.sub.toLowerCase();

  if (sub === 'start') {
    const res = deps.tapes.start(guildId, { name: input.name, startedBy: input.username, now: deps.now() });
    if (!res.ok) return { content: `⚠️ ${res.error}`, ephemeral: true };
    return {
      content: `⏺️ Rolling — **${res.tape.name}**\nI'm keeping a tape of everything this room hears. Use /tape stop when the set is over.`,
      ephemeral: false,
    };
  }

  if (sub === 'stop') {
    const sealed = deps.tapes.stop(guildId, deps.now());
    if (!sealed) {
      return {
        content: deps.tapes.active(guildId)
          ? 'The tape was rolling but nothing played into it — nothing to keep.'
          : 'No tape is rolling. `/tape start` begins one.',
        ephemeral: true,
      };
    }
    return {
      content:
        `⏹️ Tape sealed — **${sealed.name}**\n` +
        `${describeTape(sealed)}\n` +
        'Use /tape save to keep it as a playlist, /tape export for a file, or /tape spotify to put it on Spotify.',
      ephemeral: false,
    };
  }

  if (sub === 'status') {
    const active = deps.tapes.active(guildId);
    if (active) {
      return {
        content:
          `⏺️ **${active.name}** is rolling — ${describeTape(active)}.\n` +
          `Started ${new Date(active.startedAt).toLocaleTimeString()} by **${active.startedBy}**.`,
        ephemeral: true,
      };
    }
    const last = deps.tapes.latest(guildId);
    if (!last) return needsTape(null);
    return {
      content: `Not rolling. Last tape: **${last.name}** — ${describeTape(last)}.`,
      ephemeral: true,
    };
  }

  if (sub === 'list') {
    const finished = deps.tapes.list(guildId);
    const active = deps.tapes.active(guildId);
    if (!active && finished.length === 0) return needsTape(null);
    const rows: string[] = [];
    if (active) rows.push(`⏺️ **${active.name}** — rolling, ${describeTape(active)}`);
    for (const tape of finished.slice(0, 8)) {
      const when = new Date(tape.startedAt).toLocaleDateString();
      rows.push(`• **${tape.name}** [${tape.id}] — ${when}, ${describeTape(tape)}`);
    }
    if (finished.length > 8) rows.push(`_…and ${finished.length - 8} older tape(s)._`);
    return { content: `🎞️ **Tapes**\n${rows.join('\n')}`, ephemeral: true };
  }

  if (sub === 'save') {
    const tape = deps.tapes.latest(guildId);
    if (!tape) return needsTape(null);
    const mode = parseOrderMode(input.mode);
    const { entries, withoutFeatures } = await buildSetlist(tape, mode, deps);
    if (entries.length === 0) return { content: 'That tape is empty.', ephemeral: true };
    const name = (input.name ?? tape.name).trim();
    const saved = deps.playlists.save(guildId, name, toSavedTracks(entries));
    if (!saved.ok) return { content: `⚠️ ${saved.error}`, ephemeral: true };
    const order =
      mode === 'time'
        ? 'in the order it played'
        : `${mode}-ordered${withoutFeatures ? ` (${withoutFeatures} without audio features kept in place)` : ''}`;
    return {
      content: `💾 Saved **${name}** — ${saved.tracks} track${saved.tracks === 1 ? '' : 's'} ${order}.\nUse /load ${name} to play it back.`,
      ephemeral: true,
    };
  }

  if (sub === 'export') {
    const tape = deps.tapes.latest(guildId);
    if (!tape) return needsTape(null);
    const mode = parseOrderMode(input.mode);
    const { entries } = await buildSetlist(tape, mode, deps);
    if (entries.length === 0) return { content: 'That tape is empty.', ephemeral: true };
    const tracks = toExportTracks(entries);
    const meta = { title: tape.name, startedAt: tape.startedAt, endedAt: tape.endedAt };
    const format = (input.format ?? 'all').toLowerCase();
    const files: TapeAttachment[] = [];
    if (format === 'm3u' || format === 'all') {
      files.push({
        name: safeFilename(tape.name, 'm3u8'),
        data: Buffer.from(toM3U(tracks, { title: tape.name }), 'utf8'),
        description: 'M3U8 playlist',
      });
    }
    if (format === 'csv' || format === 'all') {
      files.push({
        name: safeFilename(tape.name, 'csv'),
        data: Buffer.from(toCsv(tracks), 'utf8'),
        description: 'CSV (spreadsheet)',
      });
    }
    if (format === 'md' || format === 'all') {
      files.push({
        name: safeFilename(tape.name, 'md'),
        data: Buffer.from(toMarkdown(tracks, meta), 'utf8'),
        description: 'Markdown setlist',
      });
    }
    return {
      content: `📄 **${tape.name}** — ${tracks.length} song${tracks.length === 1 ? '' : 's'} ready to keep.`,
      ephemeral: true,
      files,
    };
  }

  if (sub === 'spotify') {
    const tape = deps.tapes.latest(guildId);
    if (!tape) return needsTape(null);
    const mode = parseOrderMode(input.mode);
    const { entries } = await buildSetlist(tape, mode, deps);
    if (entries.length === 0) return { content: 'That tape is empty.', ephemeral: true };
    const name = (input.name ?? tape.name).trim();
    const summary = summarizeTape(tape);
    const description = [
      `${summary.unique} songs from a Vaporzr session`,
      summary.elapsedMs > 0 ? formatElapsed(summary.elapsedMs) : '',
      mode === 'time' ? 'in play order' : `${mode}-ordered`,
    ]
      .filter(Boolean)
      .join(' · ')
      .slice(0, 300);
    const result = await deps.createSpotify({
      name,
      description,
      isPublic: input.isPublic ?? false,
      uris: entries.map((e) => e.uri),
    });
    if (!result.ok) return { content: `⚠️ ${result.error}`, ephemeral: true };
    const skipped = result.skipped > 0 ? `\n${result.skipped} non-Spotify track(s) left out.` : '';
    return {
      content: `🎧 Created **${name}** on Spotify — ${result.added} track${result.added === 1 ? '' : 's'}.\n${result.url}${skipped}`,
      ephemeral: true,
    };
  }

  if (sub === 'delete') {
    const id = (input.name ?? '').trim();
    if (!id) return { content: 'Give me a tape id — see /tape list.', ephemeral: true };
    const ok = deps.tapes.remove(guildId, id);
    return {
      content: ok ? `🗑️ Deleted tape [${id}].` : `No tape with id [${id}].`,
      ephemeral: true,
    };
  }

  if (sub === 'now') {
    // "What is this?" — the last thing the tape heard, for the person asking in
    // chat while the music is somebody else's.
    const tape = deps.tapes.active(guildId);
    const last = tape?.entries[tape.entries.length - 1];
    if (!last) return { content: 'Nothing on the tape yet.', ephemeral: true };
    const who = last.heard === 'ears' ? 'heard in the room' : `queued by ${last.addedBy}`;
    return {
      content: `🎵 **${last.artists.join(', ') || 'Unknown'} — ${last.name}** (${who})`,
      ephemeral: true,
    };
  }

  return null;
}
