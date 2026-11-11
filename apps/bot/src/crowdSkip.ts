/**
 * Crowd vote-to-skip.
 *
 * A jam guest listens through the web panel and has no Discord identity, so the
 * vote is keyed the same way the existing track upvotes are: a sanitised display
 * name. One person must not be able to kill the track, so it takes a majority of
 * the room with a floor of two, and the whole thing resets when the track
 * changes or a minute passes.
 */

/** Majority of a room, floored at two so a solo listener can't skip alone. */
export function crowdSkipNeeded(room: number): number {
  return Math.max(2, Math.floor(Math.max(1, room) / 2) + 1);
}

/** Normalise a voter name the same way the jam roster and upvotes do. */
export function sanitizeVoter(who?: string): string {
  return (
    (who ?? '')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .trim()
      .slice(0, 24)
      .toLowerCase() || 'guest'
  );
}

export interface CrowdVoteState {
  voters: Set<string>;
  trackUri: string;
}

/**
 * Tracks one vote-to-skip. Resets when the track changes; `room()` is read at
 * vote time so the threshold tracks who is actually present.
 */
export class CrowdVote {
  private state: CrowdVoteState | null = null;

  constructor(private readonly room: () => number) {}

  vote(voter: string, trackUri: string): { votes: number; needed: number; skipped: boolean } {
    const needed = crowdSkipNeeded(this.room());
    if (!this.state || this.state.trackUri !== trackUri) {
      this.state = { voters: new Set(), trackUri };
    }
    this.state.voters.add(sanitizeVoter(voter));
    const votes = this.state.voters.size;
    if (votes >= needed) {
      this.state = null;
      return { votes, needed, skipped: true };
    }
    return { votes, needed, skipped: false };
  }

  reset(): void {
    this.state = null;
  }
}
