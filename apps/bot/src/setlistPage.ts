import { toSetlist, type Tape } from '@vaporzr/core/tape';
import type { SetlistShare } from '@vaporzr/core/setlistShare';

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtDate(ms: number): string {
  try {
    return new Date(ms).toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  } catch {
    return new Date(ms).toISOString();
  }
}

function fmtElapsed(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'under a minute';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

export interface SetlistTrackView {
  name: string;
  artists: string[];
  album: string;
  durationMs: number;
  /** Occurrences of this song; 1 unless a tape heard it more than once. */
  plays: number;
  addedBy: string;
  heard?: 'player' | 'ears';
  nowPlaying?: boolean;
}

export interface SetlistView {
  /** `queue` is a frozen snapshot; `tape` is a running transcript. */
  kind: 'queue' | 'tape';
  title: string;
  guildName?: string;
  startedAt: number;
  endedAt?: number;
  expiresAt?: number;
  startedBy?: string;
  tracks: SetlistTrackView[];
}

export function setlistViewFromTape(tape: Tape, guildName?: string): SetlistView {
  return {
    kind: 'tape',
    title: tape.name || 'Vaporzr setlist',
    guildName,
    startedAt: tape.startedAt,
    endedAt: tape.endedAt,
    startedBy: tape.startedBy,
    tracks: toSetlist(tape.entries).map((item) => ({
      name: item.entry.name,
      artists: item.entry.artists,
      album: item.entry.album,
      durationMs: item.entry.durationMs,
      plays: item.plays,
      addedBy: item.entry.addedBy,
      heard: item.entry.heard,
    })),
  };
}

export function setlistViewFromShare(share: SetlistShare): SetlistView {
  return {
    kind: 'queue',
    title: share.name || 'Vaporzr setlist',
    guildName: share.guildName,
    startedAt: share.createdAt,
    expiresAt: share.expiresAt,
    tracks: share.tracks.map((track, index) => ({
      name: track.name,
      artists: track.artists
        .split(',')
        .map((a) => a.trim())
        .filter(Boolean),
      album: track.album,
      durationMs: track.durationMs,
      plays: 1,
      addedBy: track.addedBy,
      nowPlaying: index === share.nowPlaying,
    })),
  };
}

export interface SetlistPageInput {
  /** Public origin, e.g. https://www.vaporzr.app */
  origin: string;
  view: SetlistView;
  /** Absolute URL for OG/embed canonical links. Defaults to `${origin}/setlist`. */
  canonicalUrl?: string;
}

/**
 * Server-rendered, self-contained setlist page.
 *
 * Deliberately static HTML with no client JS: Discord's unfurler (and a
 * text-only reader) must get the whole set from one response, so nothing here
 * depends on a socket, a cookie or a key.
 */
export function renderSetlistPage({ origin, view, canonicalUrl }: SetlistPageInput): string {
  const isQueue = view.kind === 'queue';
  const title = view.title || 'Vaporzr setlist';
  const live = !view.endedAt;
  const room = view.guildName ? `${esc(view.guildName)} · ` : '';
  const uniqueArtists = new Set<string>();
  let totalMs = 0;
  for (const track of view.tracks) {
    for (const artist of track.artists) if (artist.trim()) uniqueArtists.add(artist.trim());
    totalMs += track.durationMs;
  }
  // A tape's span is wall-clock time between first and last entry; a queue
  // snapshot has no history, so its meaningful number is how long it will run.
  const span = !isQueue && view.endedAt && view.endedAt > view.startedAt ? view.endedAt - view.startedAt : 0;
  const songCount = view.tracks.length;
  const playCount = view.tracks.reduce((n, t) => n + t.plays, 0);
  const description = `${songCount} song${songCount === 1 ? '' : 's'} · ${
    span > 0 ? fmtElapsed(span) : fmtElapsed(totalMs)
  }`;
  const canonical = (canonicalUrl || `${origin}/setlist`).replace(/\/+$/, '');

  const rows = view.tracks
    .map((track, index) => {
      const artists = esc(track.artists.join(', ') || 'Unknown artist');
      const plays = track.plays > 1 ? `<span class="plays">×${track.plays}</span>` : '';
      const duration = fmtTime(track.durationMs);
      const heard =
        track.heard === 'ears' ? ' <span class="ears" title="Identified from the voice channel">ears</span>' : '';
      const playing = track.nowPlaying ? '<span class="now" title="Playing when this snapshot was taken">▶</span>' : '';
      return `<li class="track${track.nowPlaying ? ' playing' : ''}">
        <span class="idx">${playing || index + 1}</span>
        <span class="meta">
          <span class="name">${esc(track.name || 'Unknown track')}${heard}</span>
          <span class="artist">${artists}${track.album ? ` · ${esc(track.album)}` : ''}</span>
        </span>
        ${plays}
        ${duration ? `<span class="dur">${duration}</span>` : ''}
      </li>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Vaporzr setlist</title>
<meta name="description" content="${esc(description)}">
<meta property="og:type" content="music.playlist">
<meta property="og:site_name" content="Vaporzr">
<meta property="og:title" content="${esc(title)} · Vaporzr setlist">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical)}">
<meta name="twitter:card" content="summary">
<link rel="icon" type="image/png" href="/favicon.png">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; padding: 40px 18px 64px;
    font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    color: #e9edf6;
    background:
      radial-gradient(900px 420px at 12% -8%, rgba(106, 92, 255, 0.22), transparent 62%),
      radial-gradient(760px 420px at 92% 0%, rgba(255, 60, 172, 0.14), transparent 58%),
      #080a12;
  }
  main { max-width: 760px; margin: 0 auto; }
  header { margin-bottom: 22px; }
  .brand { display: flex; align-items: center; gap: 10px; font-size: 11px; letter-spacing: .26em; font-weight: 800; color: #8ea0c8; text-transform: uppercase; }
  .brand img { width: 22px; height: 22px; border-radius: 6px; }
  h1 { margin: 14px 0 4px; font-size: clamp(24px, 5vw, 38px); line-height: 1.1; letter-spacing: -.02em; }
  .sub { color: #98a4c4; font-size: 13px; }
  .stats { display: flex; flex-wrap: wrap; gap: 8px; margin: 16px 0 22px; }
  .chip { border: 1px solid rgba(255,255,255,.1); background: rgba(18,22,38,.8); border-radius: 999px; padding: 5px 11px; font-size: 12px; color: #c7d2ea; }
  .chip.live { border-color: rgba(126, 224, 194, .45); color: #7ee0c2; }
  ol { list-style: none; margin: 0; padding: 0; border: 1px solid rgba(255,255,255,.08); border-radius: 14px; overflow: hidden; background: rgba(12,15,26,.72); }
  .track { display: flex; align-items: center; gap: 12px; padding: 11px 14px; border-top: 1px solid rgba(255,255,255,.055); }
  .track:first-child { border-top: 0; }
  .track.playing { background: rgba(106, 92, 255, .11); }
  .idx { width: 26px; flex: 0 0 26px; text-align: right; color: #5f6b80; font-variant-numeric: tabular-nums; font-size: 12.5px; }
  .now { color: #9d8cff; }
  .meta { flex: 1; min-width: 0; }
  .name { display: block; font-weight: 620; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .artist { display: block; color: #98a4c4; font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dur { color: #5f6b80; font-size: 12px; font-variant-numeric: tabular-nums; }
  .plays { color: #c7b3ff; background: rgba(106,92,255,.16); border-radius: 999px; padding: 2px 7px; font-size: 11px; }
  .ears { color: #ffb86b; font-size: 10px; letter-spacing: .08em; text-transform: uppercase; border: 1px solid rgba(255,184,107,.35); border-radius: 5px; padding: 0 4px; vertical-align: 1px; }
  .empty { padding: 28px; text-align: center; color: #98a4c4; }
  footer { margin-top: 22px; color: #5f6b80; font-size: 12px; text-align: center; }
  footer a { color: #8ea0c8; }
  @media print {
    body { background: #fff; color: #111; }
    ol { background: #fff; border-color: #ddd; }
    .track { border-top-color: #eee; }
    .track.playing { background: #f3f1ff; }
    .sub, .artist, .dur, footer { color: #555; }
  }
</style>
</head>
<body>
<main>
  <header>
    <div class="brand"><img src="/favicon.png" alt=""> Vaporzr setlist</div>
    <h1>${esc(title)}</h1>
    <div class="sub">${room}${
      isQueue
        ? `snapshot taken ${esc(fmtDate(view.startedAt))}`
        : `${esc(fmtDate(view.startedAt))}${view.endedAt ? ` → ${esc(fmtDate(view.endedAt))}` : ''}`
    }</div>
  </header>
  <div class="stats">
    <span class="chip${!isQueue && live ? ' live' : ''}">${isQueue ? 'snapshot' : live ? '● rolling' : 'sealed'}</span>
    <span class="chip">${songCount} song${songCount === 1 ? '' : 's'}</span>
    ${playCount !== songCount ? `<span class="chip">${playCount} plays</span>` : ''}
    <span class="chip">${uniqueArtists.size} artist${uniqueArtists.size === 1 ? '' : 's'}</span>
    ${span > 0 ? `<span class="chip">${esc(fmtElapsed(span))}</span>` : ''}
    ${!span && totalMs > 0 ? `<span class="chip">${esc(fmtElapsed(totalMs))} runtime</span>` : ''}
    ${view.startedBy ? `<span class="chip">started by ${esc(view.startedBy)}</span>` : ''}
    ${view.expiresAt ? `<span class="chip">link expires ${esc(fmtDate(view.expiresAt))}</span>` : ''}
  </div>
  ${songCount ? `<ol>${rows}</ol>` : `<div class="empty">${isQueue ? 'Nothing queued in this room yet.' : 'Nothing has been recorded on this tape yet.'}</div>`}
  <footer>
    Kept by <a href="${esc(origin)}">Vaporzr</a> ·
    ${
      isQueue
        ? 'a shared setlist is a snapshot of the room queue, frozen when the host shared it.'
        : 'a session tape records what the room actually heard, not just what the queue planned.'
    }
  </footer>
</main>
</body>
</html>`;
}
