/**
 * Coarse "edition" classification for a track title.
 *
 * WHY THIS EXISTS
 * The YouTube and Spotify rankers already sink live/acoustic/cover cuts below
 * the studio release, so a plain `/play Song` usually lands on the good version.
 * But a live cut still gets through when there is no studio upload, or when the
 * caller explicitly asks for one — and a live recording is the one thing that
 * audibly stands out in a voice channel. A small badge on the now-playing and
 * queue confirmations ("🎤 Live") tells the room *why* this one sounds like a
 * bootleg, instead of leaving them to notice mid-song.
 *
 * The vocabulary mirrors the markers those rankers already key on (see
 * `LIVE_RE` in youtube.ts and the variant regex in spotify.ts), so the badge
 * only fires on cuts the bot would otherwise have deprioritised.
 */

const ACOUSTIC_RE = /\b(acoustic|unplugged)\b/i;

const LIVE_PERFORMANCE_RE =
  /\b(live|concert|festival|tiny\s*desk|kexp|boiler\s*room|dj\s*set|live\s*set|radio\s*1|on\s*the\s*radio|bbc)\b/i;

const REMASTER_RE = /\b(remaster(ed)?|digital\s*(master|remaster)|anniversary\s*edition)\b/i;

export type EditionKind = 'live' | 'acoustic' | 'remastered';

/** Classify a title into a coarse edition bucket, or null for a plain studio
 *  track. Acoustic wins over live (an "unplugged" take reads as acoustic), and
 *  both win over "remastered", which still sounds like the studio cut. */
export function editionKind(name: string): EditionKind | null {
  const n = name ?? '';
  if (ACOUSTIC_RE.test(n)) return 'acoustic';
  if (LIVE_PERFORMANCE_RE.test(n)) return 'live';
  if (REMASTER_RE.test(n)) return 'remastered';
  return null;
}

/** Short human-facing label for an embed badge, or null for a studio track. */
export function editionBadge(name: string): string | null {
  switch (editionKind(name)) {
    case 'live':
      return '🎤 Live';
    case 'acoustic':
      return '🎸 Acoustic';
    case 'remastered':
      return '✨ Remastered';
    default:
      return null;
  }
}
