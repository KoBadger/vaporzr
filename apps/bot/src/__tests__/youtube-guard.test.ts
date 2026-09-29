import { describe, it, expect } from 'vitest';
import {
  decidePublish,
  isBotWall,
  isClearlyWrongMatch,
  isProxyError,
  scoreHit,
  shouldRetryYtDlp,
} from '../youtube.js';
import type { ResolvedVideo } from '../youtube.js';

describe('alert confirmation (decidePublish)', () => {
  const fresh = () => ({ published: 'ok' as const, pending: null as null | string });

  it('does not announce the first sighting of a failure', () => {
    const r = decidePublish('proxy', fresh() as never);
    expect(r.publish).toBeNull();
    expect(r.state.pending).toBe('proxy');
  });

  it('announces the failure once a second probe agrees', () => {
    const r = decidePublish('proxy', { published: 'ok', pending: 'proxy' });
    expect(r.publish).toBe('proxy');
    expect(r.state.published).toBe('proxy');
  });

  it('does not repeat a failure that is already being announced', () => {
    expect(decidePublish('proxy', { published: 'proxy', pending: null }).publish).toBeNull();
  });

  it('never announces a blip that cleared before confirmation', () => {
    const first = decidePublish('proxy', fresh() as never);
    expect(first.publish).toBeNull();
    // Back to ok next probe: no failure was announced, so no "recovered" notice.
    expect(decidePublish('ok', first.state).publish).toBeNull();
  });

  it('announces recovery after a confirmed failure', () => {
    expect(decidePublish('ok', { published: 'auth', pending: null }).publish).toBe('ok');
  });

  it('stays silent for the first ok after startup', () => {
    expect(decidePublish('ok', { published: 'unknown', pending: null }).publish).toBeNull();
  });
});

describe('yt-dlp retry policy', () => {
  const opts = (over: Partial<{ attempt: number; maxAttempts: number; hasProxy: boolean }> = {}) => ({
    attempt: 0,
    maxAttempts: 3,
    hasProxy: true,
    ...over,
  });

  it('retries a wall when a rotating proxy is configured (a fresh exit usually works)', () => {
    expect(shouldRetryYtDlp("Sign in to confirm you're not a bot", opts())).toBe(true);
  });

  it('does NOT retry a wall without a proxy — the datacenter IP is the problem', () => {
    expect(shouldRetryYtDlp("Sign in to confirm you're not a bot", opts({ hasProxy: false }))).toBe(false);
  });

  it('retries proxy-side failures once, then gives up so a dead proxy fails fast', () => {
    expect(shouldRetryYtDlp('ProxyError: tunnel connection failed', opts({ attempt: 0 }))).toBe(true);
    expect(shouldRetryYtDlp('ProxyError: tunnel connection failed', opts({ attempt: 1 }))).toBe(false);
    expect(shouldRetryYtDlp('ERROR: Requested format is not available', opts())).toBe(true);
  });

  it('stops once the attempts are exhausted, and ignores unrelated errors', () => {
    expect(shouldRetryYtDlp("Sign in to confirm you're not a bot", opts({ attempt: 3 }))).toBe(false);
    expect(shouldRetryYtDlp('Could not parse that YouTube link.', opts())).toBe(false);
  });
});

describe('YouTube failure classification', () => {
  // The anti-bot wall is not proof of expired cookies — it also appears for a
  // flagged IP or a missing PO token. Misreading it as "cookies expired" sent an
  // admin to re-export a perfectly good cookie file while the cause was the IP.
  it('recognises the anti-bot wall', () => {
    expect(
      isBotWall(
        "ERROR: [youtube] abc: Sign in to confirm you're not a bot. Use --cookies-from-browser or --cookies for the authentication.",
      ),
    ).toBe(true);
    expect(isBotWall('ERROR: [youtube] abc: not a bot check triggered')).toBe(true);
  });

  it('recognises proxy-side failures', () => {
    expect(isProxyError('ERROR: Unable to connect to proxy tunnel')).toBe(true);
    expect(isProxyError('HTTP Error 407: Proxy Authentication Required')).toBe(true);
    expect(isProxyError('ProxyError: connection refused')).toBe(true);
  });

  it('never reports a wall as a proxy error, or the reverse', () => {
    const wall = "Sign in to confirm you're not a bot";
    expect(isProxyError(wall)).toBe(false);
    expect(isBotWall('ERROR: Unable to connect to proxy tunnel')).toBe(false);
    expect(isProxyError('ERROR: Requested format is not available')).toBe(false);
  });
});

describe('scoreHit (live/edition ranking)', () => {
  const opts = { name: 'Liquid Game', artists: ['Sweeps'], durationMs: 200_000 };
  const query = 'Liquid Game Sweeps';

  it('ranks the studio/audio upload above a live version', () => {
    const studio = scoreHit(
      { videoId: 'a', title: 'Liquid Game', channel: 'Sweeps - Topic', durationSec: 200 },
      0,
      query,
      opts,
    );
    const live = scoreHit(
      { videoId: 'b', title: 'Liquid Game (Live at Coachella)', channel: 'Sweeps', durationSec: 210 },
      0,
      query,
      opts,
    );
    expect(studio).toBeGreaterThan(live);
  });

  it('ranks an official audio upload above a concert video', () => {
    const audio = scoreHit(
      { videoId: 'a', title: 'Liquid Game (Official Audio)', channel: 'Sweeps - Topic', durationSec: 200 },
      1,
      query,
      opts,
    );
    const concert = scoreHit(
      { videoId: 'b', title: 'Liquid Game - Live Concert', channel: 'Sweeps Live', durationSec: 205 },
      0,
      query,
      opts,
    );
    expect(audio).toBeGreaterThan(concert);
  });

  it('still prefers a live version when the query asks for one', () => {
    const liveOpts = { name: 'Liquid Game (Live)', artists: ['Sweeps'], durationMs: 210_000 };
    const live = scoreHit(
      { videoId: 'b', title: 'Liquid Game (Live at Coachella)', channel: 'Sweeps', durationSec: 210 },
      0,
      'Liquid Game Live',
      liveOpts,
    );
    const studio = scoreHit(
      { videoId: 'a', title: 'Liquid Game', channel: 'Sweeps - Topic', durationSec: 200 },
      1,
      'Liquid Game Live',
      liveOpts,
    );
    expect(live).toBeGreaterThan(studio);
  });
});

function video(overrides: Partial<ResolvedVideo>): ResolvedVideo {
  return {
    videoId: 'abc123',
    uri: 'youtube:video:abc123',
    name: 'Song Name - Artist',
    artists: ['Artist'],
    album: 'YouTube',
    durationMs: 200_000,
    source: 'youtube',
    streamUrl: 'https://example.com/stream',
    channel: 'Artist - Topic',
    ...overrides,
  };
}

describe('isClearlyWrongMatch (speed fallback guard)', () => {
  it('accepts an exact title/artist match', () => {
    const v = video({ name: 'End Of Summer - Tame Impala', channel: 'Tame Impala - Topic' });
    expect(isClearlyWrongMatch(v, 'End Of Summer', { name: 'End Of Summer', artists: ['Tame Impala'], durationMs: 432_000 })).toBe(false);
  });

  it('accepts a near-exact match (case/punctuation differences)', () => {
    const v = video({ name: 'End Of Summer (Official Audio) - Tame Impala', channel: 'Tame Impala - Topic' });
    expect(isClearlyWrongMatch(v, 'End Of Summer', { name: 'End Of Summer', artists: ['Tame Impala'], durationMs: 432_000 })).toBe(false);
  });

  it('rejects a completely unrelated video', () => {
    const v = video({ name: 'GRANT LEADS THE UNION ARMY TO VICTORY | Documentary', channel: 'History' });
    expect(isClearlyWrongMatch(v, 'Grant Fix It', { name: 'Fix It', artists: ['Grant'], durationMs: 198_000 })).toBe(true);
  });

  it('rejects a different song by the same artist (name phrase missing)', () => {
    // The artist matches but the song name is different — the phrase check catches it.
    const v = video({ name: 'Untitled Forever - Grant', channel: 'Grant - Topic' });
    expect(isClearlyWrongMatch(v, 'Fix It', { name: 'Fix It', artists: ['Grant'], durationMs: 198_000 })).toBe(true);
  });

  it('rejects an egregiously longer cut (album-length mix vs a single)', () => {
    const v = video({ name: 'End Of Summer - Tame Impala (Full Album Mix)', durationMs: 2400_000, channel: 'Some Channel' });
    expect(isClearlyWrongMatch(v, 'End Of Summer', { name: 'End Of Summer', artists: ['Tame Impala'], durationMs: 432_000 })).toBe(true);
  });

  it('rejects a non-music video that matches the song name (esports/podcast)', () => {
    const v = video({
      name: 'AN ABBEBACKDOOR! 100 Thieves REVERSE SWEEP Team Liquid | Plays of the Week',
      durationMs: 960_000,
      channel: 'Esports Highlights',
    });
    expect(isClearlyWrongMatch(v, 'liquid game', { name: 'liquid game', artists: ['Sweeps'], durationMs: 195_000 })).toBe(true);
  });

  it('rejects a 12-minute video for a 4-minute song', () => {
    const v = video({ name: 'Liquid Game - Sweeps (Full Set)', durationMs: 720_000, channel: 'Sweeps - Topic' });
    expect(isClearlyWrongMatch(v, 'liquid game', { name: 'liquid game', artists: ['Sweeps'], durationMs: 240_000 })).toBe(true);
  });

  it('still accepts a legitimately longer upload', () => {
    const v = video({ name: 'End Of Summer - Tame Impala (Official Audio)', durationMs: 270_000, channel: 'Tame Impala - Topic' });
    expect(isClearlyWrongMatch(v, 'End Of Summer', { name: 'End Of Summer', artists: ['Tame Impala'], durationMs: 240_000 })).toBe(false);
  });

  it('accepts a plausible same-title remix (not an obvious mismatch)', () => {
    const v = video({ name: 'End Of Summer (Remix) - Tame Impala', channel: 'Tame Impala - Topic' });
    expect(isClearlyWrongMatch(v, 'End Of Summer', { name: 'End Of Summer', artists: ['Tame Impala'], durationMs: 432_000 })).toBe(false);
  });

  it('accepts the real song when the upload words the edition differently (regression)', () => {
    const opts = { name: 'All Night Long (All Night) - Single Version', artists: ['Lionel Richie'], durationMs: 259_000 };
    const query = 'All Night Long (All Night) - Single Version Lionel Richie';
    for (const title of [
      'Lionel Richie - All Night Long (All Night) [Single Version] [Audio HQ]',
      'All Night Long (All Night) (Single Version)',
      'Lionel Richie - All Night Long (All Night)',
    ]) {
      const v = video({ name: title, channel: 'Lionel Richie', durationMs: 259_000 });
      expect(isClearlyWrongMatch(v, query, opts)).toBe(false);
    }
  });

  it('accepts a remix the user explicitly asked for (regression)', () => {
    const opts = { name: 'Is This Love - Montmartre Remix', artists: ['Bob Marley & The Wailers'], durationMs: 300_000 };
    const v = video({ name: 'Bob Marley - Is This Love (Montmartre Remix)', channel: 'Bob Marley', durationMs: 300_000 });
    expect(isClearlyWrongMatch(v, 'Is This Love - Montmartre Remix Bob Marley & The Wailers', opts)).toBe(false);
  });
});