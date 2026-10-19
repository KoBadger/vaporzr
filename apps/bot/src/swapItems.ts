/**
 * Descriptors for the "swap a wrong pick" buttons.
 *
 * A queue add is only correctable when the bot had to *guess* something. Three
 * inputs reach these helpers:
 *
 *  - typed search text (`V@p daft punk one more time`) — the user typed it, so
 *    every item shares that query and "Pick another" re-runs it verbatim;
 *  - a playlist / album link — nobody typed a per-track title, so each item
 *    falls back to its own `name artists` string, which is what a search would
 *    have been given anyway;
 *  - a single explicit link or upload — nothing was guessed, so there is
 *    nothing to correct and no row is offered (`null`).
 */
import type { ResolvedTrack } from '@vaporzr/core/spotify';

export interface SwapItem {
  uri: string;
  label: string;
  query?: string;
}

/** `Name — Artist A, Artist B`, the label every add embed already uses. */
export function swapLabel(track: Pick<ResolvedTrack, 'name' | 'artists'>): string {
  const artists = (track.artists ?? []).join(', ');
  return artists ? `${track.name} — ${artists}` : track.name;
}

/** The search text that would find this track again from scratch. */
export function trackQuery(track: Pick<ResolvedTrack, 'name' | 'artists'>): string {
  return [track.name, ...(track.artists ?? [])].filter(Boolean).join(' ').trim();
}

/**
 * Build the swap descriptors for one add, or `null` when the add cannot have
 * been a wrong guess (a single explicit link with no search text).
 */
export function buildSwapItems(tracks: ResolvedTrack[], query?: string): SwapItem[] | null {
  const typed = query?.trim();
  if (!typed && tracks.length <= 1) return null;
  return tracks.map((t) => {
    const item: SwapItem = { uri: t.uri, label: swapLabel(t) };
    // A typed query always wins: it is literally what the user asked for.
    const q = typed || trackQuery(t);
    if (q) item.query = q;
    return item;
  });
}
