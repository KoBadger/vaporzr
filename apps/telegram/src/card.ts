/**
 * The now-playing card: text and inline keyboard, built from the bot's own
 * `/api/queue` snapshot (`Bridge.jamQueue()`). Pure functions only — the
 * renderer is what the unit tests pin, because a malformed card is the one
 * failure mode that is visible to every user at once.
 *
 * Telegram limits that shape this file:
 *   - 4096 characters per message (we stay well under, and clip anyway);
 *   - 64 bytes of `callback_data` per button (so tracks are addressed by a
 *     short hash, never by URI);
 *   - edits are rate-limited per chat, so the caller edits one message in place
 *     instead of posting a new card per track.
 */

import type { TgInlineKeyboard } from './telegram.js';

export interface QueueTrack {
  uri: string;
  name: string;
  artists: string;
  album: string;
  addedBy: string;
  durationMs: number;
  votes: number;
  image?: string;
  source?: string;
}

export interface JamQueue {
  playing: QueueTrack | null;
  playingNow: boolean;
  ended: boolean;
  positionMs: number;
  durationMs: number;
  updatedAt: number;
  queueTotal: number;
  tracks: QueueTrack[];
}

export type CardAction =
  | { kind: 'toggle' }
  | { kind: 'next' }
  | { kind: 'queue' }
  | { kind: 'refresh' }
  | { kind: 'remove'; hash: string }
  | { kind: 'unknown' };

/** Escape the five characters Telegram's HTML parse mode treats as markup. */
export function esc(value: string): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Trim to `max` characters on a word boundary where possible. */
export function clip(value: string, max: number): string {
  const text = String(value ?? '');
  if (text.length <= max) return text;
  const cut = text.slice(0, Math.max(0, max - 1));
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * Join rendered lines into one message, dropping whole lines until it fits.
 * Cutting the joined string would be shorter but can slice an HTML entity or a
 * tag in half, which Telegram rejects as malformed markup.
 */
function joinClamped(lines: string[], max: number): string {
  const kept = [...lines];
  while (kept.length > 1 && kept.join('\n').length > max) kept.pop();
  return kept.join('\n');
}

export function clock(ms: number): string {
  const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = (n: number): string => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

/** A text progress bar; empty when the duration is unknown. */
export function bar(positionMs: number, durationMs: number, width = 12): string {
  if (!(durationMs > 0)) return '';
  const ratio = Math.min(1, Math.max(0, positionMs / durationMs));
  const filled = Math.min(width, Math.round(ratio * width));
  return `${'▬'.repeat(filled)}${'▭'.repeat(width - filled)}`;
}

/**
 * Stable 6-character handle for a track, used in callback data. FNV-1a is
 * enough: the only requirement is that the same URI yields the same handle
 * across restarts and processes, so a button queued an hour ago still resolves.
 */
export function trackHash(uri: string): string {
  let hash = 0x811c9dc5;
  const text = String(uri ?? '');
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(6, '0').slice(-6);
}

export function renderCard(q: JamQueue, opts: { panel?: boolean } = {}): string {
  const lines: string[] = [];
  const current = q.playing;
  if (!current) {
    lines.push(q.ended ? '🏁 <b>Set finished</b>' : '💤 <b>Nothing playing</b>');
    lines.push(q.queueTotal > 0 ? `${q.queueTotal} track(s) waiting.` : 'Send a song name to start.');
  } else {
    lines.push(`🎵 <b>${esc(clip(current.name, 90))}</b>`);
    if (current.artists) lines.push(esc(clip(current.artists, 90)));
    if (q.durationMs > 0) {
      lines.push(`<code>${bar(q.positionMs, q.durationMs)}</code> ${clock(q.positionMs)} / ${clock(q.durationMs)}`);
    }
    lines.push(q.playingNow ? '▶️ Playing' : '⏸ Paused');
    if (current.addedBy) lines.push(`🙋 ${esc(clip(current.addedBy, 24))}`);
  }

  const upNext = q.tracks.slice(0, 6);
  if (upNext.length > 0) {
    lines.push('');
    lines.push(`⏭ <b>Up next</b> · ${q.queueTotal} in the queue`);
    upNext.forEach((track, i) => {
      const artist = track.artists ? ` — ${esc(clip(track.artists, 28))}` : '';
      const dur = track.durationMs > 0 ? ` <code>${clock(track.durationMs)}</code>` : '';
      lines.push(`${i + 1}. ${esc(clip(track.name, 40))}${artist}${dur}`);
    });
  }
  if (opts.panel) lines.push('', '<i>Tap ▦ for the full panel.</i>');
  return joinClamped(lines, 3800);
}

/** Numbered ✖ buttons match the numbered list in `renderCard`. */
export function cardKeyboard(q: JamQueue, panelUrl?: string): TgInlineKeyboard {
  const rows: TgInlineKeyboard['inline_keyboard'] = [
    [
      { text: q.playingNow ? '⏸ Pause' : '▶️ Resume', callback_data: 't' },
      { text: '⏭ Skip', callback_data: 'n' },
      { text: '📜 Queue', callback_data: 'q' },
      { text: '🔄', callback_data: 'f' },
    ],
  ];
  const removable = q.tracks.slice(0, 3);
  if (removable.length > 0) {
    rows.push(
      removable.map((track, i) => ({
        text: `✖ ${i + 1}`,
        callback_data: `r:${trackHash(track.uri)}`,
      })),
    );
  }
  if (panelUrl) rows.push([{ text: '▦ Open panel', url: panelUrl }]);
  return { inline_keyboard: rows };
}

export function parseCallback(data: string | undefined): CardAction {
  const raw = (data ?? '').trim();
  if (raw === 't') return { kind: 'toggle' };
  if (raw === 'n') return { kind: 'next' };
  if (raw === 'q') return { kind: 'queue' };
  if (raw === 'f') return { kind: 'refresh' };
  if (raw.startsWith('r:')) {
    const hash = raw.slice(2);
    if (/^[0-9a-z]{4,10}$/.test(hash)) return { kind: 'remove', hash };
  }
  return { kind: 'unknown' };
}

/** What the caller compares to decide whether an edit is worth sending. */
export function fingerprint(q: JamQueue): string {
  const current = q.playing ? `${q.playing.uri}@${trackHash(q.playing.uri)}` : '-';
  const position = Math.floor(Math.max(0, q.positionMs) / 5000);
  return [
    current,
    q.playingNow ? '1' : '0',
    q.ended ? '1' : '0',
    position,
    q.queueTotal,
    q.tracks.map((t) => t.uri).join('|'),
  ].join('#');
}

/** `/queue` reply: the whole up-next list, clipped to one message. */
export function renderQueue(q: JamQueue): string {
  if (!q.playing && q.tracks.length === 0) return 'The queue is empty.';
  const lines: string[] = [];
  if (q.playing) lines.push(`Now: <b>${esc(clip(q.playing.name, 60))}</b>`);
  if (q.tracks.length === 0) lines.push('', 'Nothing up next — endless wave will pick if it is on.');
  else {
    lines.push('');
    q.tracks.forEach((track, i) => {
      const who = track.addedBy ? ` · ${esc(clip(track.addedBy, 16))}` : '';
      const dur = track.durationMs > 0 ? ` <code>${clock(track.durationMs)}</code>` : '';
      lines.push(`${i + 1}. ${esc(clip(track.name, 44))}${dur}${who}`);
    });
  }
  return joinClamped(lines, 3800);
}

/** Find the queue position of the track a remove button points at. */
export function indexOfHash(q: JamQueue, hash: string): { index: number; uri: string } | null {
  const found = q.tracks.findIndex((t) => trackHash(t.uri) === hash);
  if (found === -1) return null;
  return { index: found, uri: q.tracks[found]!.uri };
}
