/**
 * Where a stall-triggered YouTube fallback should resume.
 *
 * A stall recovery that restarts the song from 0 ("it skipped back to the
 * beginning") used to fall back without any position. The caller clamps the
 * resume point into `[0, durationMs - 1s]` so a stall in the final second
 * cannot seek past the last decodable frame and end the track instantly.
 *
 * Lives in its own module rather than next to the caller: importing
 * `playback.js` from a unit test would pull that whole orchestration file into
 * the coverage denominator and break the global ratchet.
 */
export function youtubeFallbackResumeMs(durationMs: number, resumeMs: number): number {
  return Math.min(Math.max(0, resumeMs), Math.max(0, durationMs - 1000));
}
