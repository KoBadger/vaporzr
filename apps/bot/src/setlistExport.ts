/**
 * Setlist export formatters — the last step of a tape, where a session becomes a
 * file somebody can keep.
 *
 * Everything here is a pure string builder: no filesystem, no Discord, no
 * network. That keeps the byte-level output testable and lets the command layer
 * decide where an export goes (attachment, saved playlist, clipboard) without
 * the format logic caring.
 */

/**
 * The track metadata an export needs. Declared here rather than imported from
 * the tape module so the formats stay independent of the tape's own shape — the
 * command layer maps a tape entry onto this and the formatters never change.
 */
export interface ExportTrack {
  name: string;
  artists: string[];
  album?: string;
  durationMs?: number;
  uri?: string;
  source?: string;
  addedBy?: string;
  playedAt?: number;
}

/** YouTube Music's search endpoint, used whenever a track has no playable URI. */
const YT_MUSIC_SEARCH = 'https://music.youtube.com/search?q=';

/**
 * Flatten a value onto one line. Track names and tape titles come from users and
 * external APIs; an embedded newline would otherwise forge a second record in an
 * M3U or a second heading in the Markdown export.
 */
function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

/**
 * "Artist - Title", the shape every player and search engine expects. A track
 * with no artist metadata is just its title rather than a dangling separator.
 */
function trackLabel(track: ExportTrack): string {
  const artists = track.artists
    .map((artist) => oneLine(artist))
    .filter(Boolean)
    .join(', ');
  const name = oneLine(track.name);
  return artists ? `${artists} - ${name}` : name;
}

function youtubeSearchUrl(track: ExportTrack): string {
  return `${YT_MUSIC_SEARCH}${encodeURIComponent(trackLabel(track))}`;
}

/**
 * A URI worth writing into a playlist: an absolute URL (http, https, file, ...)
 * or a Spotify track URI. Anything else — local cache keys, blank placeholders —
 * is not something another player can open, so callers fall back to a search.
 */
function playableUri(uri: string | undefined): string | null {
  const value = (uri ?? '').trim();
  if (!value) return null;
  if (/^spotify:track:/i.test(value)) return value;
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : null;
}

/**
 * M3U8 (UTF-8, LF) for local players and `/load`.
 *
 * The playlist is emitted even with zero tracks — an empty tape should produce a
 * valid file, not an error. `#PLAYLIST` is optional in the format, so it only
 * appears when a title was actually supplied.
 */
export function toM3U(tracks: ExportTrack[], opts: { title?: string } = {}): string {
  const lines = ['#EXTM3U'];
  const title = oneLine(opts.title ?? '');
  if (title) lines.push(`#PLAYLIST:${title}`);
  for (const track of tracks) {
    // Unknown durations become 0: some players treat the -1 "unknown" sentinel
    // as an error, and 0 is the only other value that renders as a plain number.
    const seconds = Math.round((track.durationMs ?? 0) / 1000);
    lines.push(`#EXTINF:${seconds},${trackLabel(track)}`);
    lines.push(playableUri(track.uri) ?? youtubeSearchUrl(track));
  }
  return `${lines.join('\n')}\n`;
}

/** Column order is part of the format: spreadsheets and scripts key off it. */
const CSV_COLUMNS = ['title', 'artists', 'album', 'duration_ms', 'source', 'added_by', 'played_at', 'uri'];

/**
 * RFC 4180 quoting: quote a field only when a parser would otherwise split it,
 * and double embedded quotes. Artists join with `; ` so the common case stays
 * unquoted.
 */
function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function csvRow(values: Array<string | number | undefined>): string {
  return values.map((value) => csvField(value === undefined ? '' : String(value))).join(',');
}

/**
 * CSV for spreadsheets and scripting. Timestamps stay in epoch milliseconds
 * rather than a rendered date: that is lossless, carries no timezone guess, and
 * every consumer can format it locally.
 */
export function toCsv(tracks: ExportTrack[]): string {
  const rows = [CSV_COLUMNS.join(',')];
  for (const track of tracks) {
    rows.push(
      csvRow([
        track.name,
        track.artists.join('; '),
        track.album,
        track.durationMs,
        track.source,
        track.addedBy,
        track.playedAt,
        track.uri,
      ]),
    );
  }
  return `${rows.join('\n')}\n`;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * Wall-clock length of a session in the units people say out loud, rounded to
 * the nearest minute because a tape's endpoints are only meaningful to a minute.
 */
function elapsedLabel(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/**
 * HH:MM in the host's timezone. A setlist is read by the people who were in the
 * room, so server-local time is the useful reading; a UTC stamp would need the
 * export to carry a timezone just to stay honest.
 */
function clockLabel(playedAt: number): string {
  const at = new Date(playedAt);
  if (Number.isNaN(at.getTime())) return '';
  return `${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
}

/**
 * Markdown for pasting into a Discord message or a wiki. The heading and summary
 * stand alone (how many songs, how long the night ran) and the numbered list
 * keeps the exact play order, which is the part a setlist exists for.
 */
export function toMarkdown(
  tracks: ExportTrack[],
  meta: { title: string; guildName?: string; startedAt?: number; endedAt?: number },
): string {
  const heading = oneLine(meta.title) || 'Setlist';
  const summary = [`**${tracks.length} ${tracks.length === 1 ? 'track' : 'tracks'}**`];
  const { startedAt, endedAt } = meta;
  if (startedAt !== undefined && endedAt !== undefined && endedAt >= startedAt) {
    summary.push(elapsedLabel(endedAt - startedAt));
  }
  const guildName = oneLine(meta.guildName ?? '');
  if (guildName) summary.push(guildName);

  const lines = [`# ${heading}`, '', summary.join(' · ')];
  if (tracks.length > 0) lines.push('');
  tracks.forEach((track, index) => {
    const details = [oneLine(track.album ?? ''), oneLine(track.source ?? '')].filter(Boolean).join(' · ');
    const time = track.playedAt === undefined ? '' : clockLabel(track.playedAt);
    let line = `${index + 1}. **${trackLabel(track)}**`;
    if (details) line += ` — ${details}`;
    if (time) line += ` · ${time}`;
    lines.push(line);
  });
  return `${lines.join('\n')}\n`;
}

/**
 * One search URL per track, in play order, for the export that always works: no
 * OAuth, no region locks, no stale provider IDs.
 */
export function toYouTubeSearchLinks(tracks: ExportTrack[]): string {
  if (tracks.length === 0) return '';
  return `${tracks.map(youtubeSearchUrl).join('\n')}\n`;
}

/** Windows rejects these in a filename whatever the filesystem is underneath. */
const WINDOWS_ILLEGAL = /[<>:"/\\|?*\u0000-\u001f]/g;

/** Leaves room for the extension inside every path length we care about. */
const MAX_FILENAME_STEM = 60;

/**
 * Turn a free-form tape name into a filename that survives every platform the
 * bot might save to. A trailing copy of the extension is dropped first so a tape
 * already called "night.m3u8" does not become "night.m3u8.m3u8". An all-illegal
 * name still produces a usable file rather than an empty one.
 */
export function safeFilename(name: string, ext: string): string {
  const cleanExt = ext
    .toLowerCase()
    .trim()
    .replace(/^\.+/, '')
    .replace(/[^a-z0-9.]/g, '')
    .replace(/^\.+/, '');
  let stem = (name ?? '').toLowerCase();
  if (cleanExt && stem.endsWith(`.${cleanExt}`)) stem = stem.slice(0, -(cleanExt.length + 1));
  stem = stem
    .replace(WINDOWS_ILLEGAL, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, MAX_FILENAME_STEM)
    // The cut can land on a separator; Windows silently drops trailing dots and
    // spaces, so trim those here instead of letting the name change on save.
    .replace(/[-.]+$/, '');
  if (!stem) stem = 'setlist';
  return cleanExt ? `${stem}.${cleanExt}` : stem;
}
