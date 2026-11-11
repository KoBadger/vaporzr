import { describe, expect, it } from 'vitest';
import { CrowdVote, crowdSkipNeeded, sanitizeVoter } from '../crowdSkip.js';

describe('crowdSkipNeeded', () => {
  it('floors at two so one listener cannot skip alone', () => {
    expect(crowdSkipNeeded(1)).toBe(2);
    expect(crowdSkipNeeded(0)).toBe(2);
    expect(crowdSkipNeeded(-5)).toBe(2);
  });

  it('is a strict majority of the room', () => {
    expect(crowdSkipNeeded(2)).toBe(2);
    expect(crowdSkipNeeded(3)).toBe(2);
    expect(crowdSkipNeeded(4)).toBe(3);
    expect(crowdSkipNeeded(5)).toBe(3);
    expect(crowdSkipNeeded(10)).toBe(6);
  });
});

describe('sanitizeVoter', () => {
  it('strips control characters, trims, caps and lowercases', () => {
    expect(sanitizeVoter('  Alice\u0007  ')).toBe('alice');
    expect(sanitizeVoter('A'.repeat(100))).toBe('a'.repeat(24));
  });

  it('falls back to a stable guest key', () => {
    expect(sanitizeVoter()).toBe('guest');
    expect(sanitizeVoter('')).toBe('guest');
    expect(sanitizeVoter('   ')).toBe('guest');
  });
});

describe('CrowdVote', () => {
  it('counts distinct voters and skips only at the threshold', () => {
    const room = () => 4; // needed = 3
    const vote = new CrowdVote(room);

    expect(vote.vote('alice', 'spotify:track:one')).toMatchObject({ votes: 1, needed: 3, skipped: false });
    expect(vote.vote('alice', 'spotify:track:one')).toMatchObject({ votes: 1, skipped: false }); // dup
    expect(vote.vote('bob', 'spotify:track:one')).toMatchObject({ votes: 2, skipped: false });
    expect(vote.vote('carol', 'spotify:track:one')).toMatchObject({ votes: 3, skipped: true });
  });

  it('resets when the track changes', () => {
    const vote = new CrowdVote(() => 4);
    vote.vote('alice', 'spotify:track:one');
    vote.vote('bob', 'spotify:track:one');
    // A new track: the previous two votes are gone.
    expect(vote.vote('carol', 'spotify:track:two')).toMatchObject({ votes: 1, skipped: false });
  });

  it('clears after a successful skip', () => {
    const vote = new CrowdVote(() => 2);
    vote.vote('alice', 'spotify:track:one');
    expect(vote.vote('bob', 'spotify:track:one')).toMatchObject({ skipped: true });
    // The state was consumed, so the next track starts clean.
    expect(vote.vote('alice', 'spotify:track:two')).toMatchObject({ votes: 1, skipped: false });
  });
});
