import { describe, it, expect } from 'vitest';
import { scorePlayResult } from '@vaporzr/core/spotify';
import type { ResolvedTrack } from '@vaporzr/core/spotify';

function t(name: string, artists: string[], durationMs = 200_000): ResolvedTrack {
  return {
    uri: `spotify:track:${name}`,
    name,
    artists,
    album: 'Test',
    durationMs,
    source: 'spotify',
  } as ResolvedTrack;
}

describe('scorePlayResult prefers the original over a variant', () => {
  // Regression: `V@mashup Feel Good Inc. - Gorillaz | Seven Nation Army - The
  // White Stripes` rendered remixes for BOTH sides. Spotify's top hit for a
  // "song - artist" query is the remix (its title contains both), and the variant
  // penalty never fired because it required stripVersionSegments to have reduced
  // the name — but the dash form names the remixer first
  // (" - Stanton Warriors Remix"), so the strip missed it and `core === n`.
  it('ranks the original above a dash-form remix', () => {
    const q = 'feel good inc. - gorillaz';
    const original = scorePlayResult(t('Feel Good Inc.', ['Gorillaz']), q);
    const remix = scorePlayResult(t('Feel Good Inc. - Stanton Warriors Remix', ['Gorillaz', 'Stanton Warriors']), q);
    expect(original).toBeLessThan(remix);
  });

  it('ranks the original above a dash-form remix (second real case)', () => {
    const q = 'seven nation army - the white stripes';
    const original = scorePlayResult(t('Seven Nation Army', ['The White Stripes']), q);
    const remix = scorePlayResult(
      t('Seven Nation Army - The Glitch Mob Remix', ['The White Stripes', 'The Glitch Mob']),
      q,
    );
    expect(original).toBeLessThan(remix);
  });

  it('ranks the original above a parenthesised remix', () => {
    const q = 'nightcall kavinsky';
    const original = scorePlayResult(t('Nightcall', ['Kavinsky']), q);
    const remix = scorePlayResult(t('Nightcall (Emmit Fenn Remix)', ['Kavinsky', 'Emmit Fenn']), q);
    expect(original).toBeLessThan(remix);
  });

  it('sinks live and acoustic versions too', () => {
    const q = 'feel good inc. - gorillaz';
    const original = scorePlayResult(t('Feel Good Inc.', ['Gorillaz']), q);
    const live = scorePlayResult(t('Feel Good Inc. (Live at Coachella)', ['Gorillaz']), q);
    const acoustic = scorePlayResult(t('Feel Good Inc. - Acoustic', ['Gorillaz']), q);
    expect(original).toBeLessThan(live);
    expect(original).toBeLessThan(acoustic);
  });

  it('does not penalise a variant the user explicitly asked for', () => {
    const remixTrack = t('Feel Good Inc. - Stanton Warriors Remix', ['Gorillaz', 'Stanton Warriors']);
    const askedFor = scorePlayResult(remixTrack, 'feel good inc remix');
    const notAsked = scorePlayResult(remixTrack, 'feel good inc. - gorillaz');
    expect(askedFor).toBeLessThan(notAsked);
  });
});

describe('scorePlayResult keeps sequels apart', () => {
  // Regression: `V@bulk Phantom pt.1 - Justice; phantom pt.2 - Justice` queued
  // Pt. II twice. Every word matched both titles, so Spotify's own ordering won
  // and the duplicate guard then dropped one of them.
  const q1 = 'phantom pt.1 - justice';
  const q2 = 'phantom pt.2 - justice';

  it('picks Pt. I for a Pt. 1 query and Pt. II for a Pt. 2 query', () => {
    const one = t('Phantom Pt. I', ['Justice']);
    const two = t('Phantom Pt. II', ['Justice']);
    expect(scorePlayResult(one, q1)).toBeLessThan(scorePlayResult(two, q1));
    expect(scorePlayResult(two, q2)).toBeLessThan(scorePlayResult(one, q2));
  });

  it('reads arabic and roman part numbers as the same number', () => {
    const one = t('Phantom Pt. I', ['Justice']);
    const two = t('Phantom Pt. II', ['Justice']);
    // The headline score depends on the query text, so compare the ordering.
    expect(scorePlayResult(two, 'phantom part 2 justice')).toBeLessThan(scorePlayResult(one, 'phantom part 2 justice'));
    expect(scorePlayResult(two, 'phantom pt ii justice')).toBeLessThan(scorePlayResult(one, 'phantom pt ii justice'));
  });
});
