/**
 * Natural-language vibe requests — "V@vibe chill like Bonobo", "V@vibe hype
 * workout", "V@vibe sad rainy acoustic". Maps mood adjectives to Spotify
 * audio-feature targets (the same steering Endless Wave uses) so the words
 * actually shape the *sound* of the picks, not just the search text.
 *
 * Kept pure so it is trivially unit-testable.
 */

/** Values Spotify's /recommendations accepts as target_*. */
export interface VibeTargets {
  energy?: number;
  valence?: number;
  danceability?: number;
  instrumentalness?: number;
  acousticness?: number;
  minTempo?: number;
  maxTempo?: number;
}

type TargetSet = Partial<VibeTargets>;

/** Adjective → feature targets. Multiple matches get averaged. */
const ADJECTIVES: Record<string, TargetSet> = {
  chill: { energy: 0.35, valence: 0.5, danceability: 0.5 },
  relaxed: { energy: 0.3, valence: 0.55 },
  mellow: { energy: 0.3, valence: 0.5, acousticness: 0.6 },
  calm: { energy: 0.25, valence: 0.5, acousticness: 0.6 },
  cozy: { energy: 0.3, valence: 0.65, acousticness: 0.6 },
  hype: { energy: 0.95, danceability: 0.85, valence: 0.8 },
  energetic: { energy: 0.9, danceability: 0.75 },
  party: { energy: 0.9, danceability: 0.9, valence: 0.85 },
  banger: { energy: 0.95, danceability: 0.8, valence: 0.7 },
  upbeat: { energy: 0.75, valence: 0.85, danceability: 0.7 },
  happy: { valence: 0.9, energy: 0.7, danceability: 0.65 },
  feelgood: { valence: 0.9, energy: 0.7 },
  sad: { valence: 0.15, energy: 0.3 },
  melancholy: { valence: 0.2, energy: 0.35, acousticness: 0.5 },
  moody: { valence: 0.25, energy: 0.5 },
  dark: { valence: 0.2, energy: 0.6 },
  emotional: { valence: 0.3, energy: 0.45 },
  angry: { valence: 0.15, energy: 0.9, maxTempo: 200 },
  heavy: { energy: 0.85, valence: 0.25 },
  dreamy: { energy: 0.3, instrumentalness: 0.6 },
  ethereal: { energy: 0.25, instrumentalness: 0.7, valence: 0.4 },
  focus: { instrumentalness: 0.85, energy: 0.25, valence: 0.35, danceability: 0.3 },
  study: { instrumentalness: 0.8, energy: 0.25, valence: 0.4 },
  work: { instrumentalness: 0.75, energy: 0.3 },
  dance: { danceability: 0.95, energy: 0.8, valence: 0.7 },
  groove: { danceability: 0.9, energy: 0.65, valence: 0.7 },
  romantic: { valence: 0.6, energy: 0.3, maxTempo: 110 },
  latenight: { valence: 0.4, energy: 0.45, maxTempo: 105 },
  nostalgic: { valence: 0.45, energy: 0.4, acousticness: 0.5 },
  workout: { energy: 0.9, minTempo: 130, maxTempo: 180 },
  run: { energy: 0.9, minTempo: 140, maxTempo: 190 },
  gym: { energy: 0.9, danceability: 0.7, minTempo: 125 },
  acoustic: { acousticness: 0.9, energy: 0.4 },
  unplugged: { acousticness: 0.85, energy: 0.45 },
  instrumental: { instrumentalness: 0.9 },
  ambient: { instrumentalness: 0.8, energy: 0.2, valence: 0.4 },
  euphoric: { valence: 0.95, energy: 0.8 },
};

/** Words that map to Spotify *seed genres* rather than feature targets. */
const GENRE_WORDS: Record<string, string> = {
  jazz: 'jazz',
  lofi: 'lofi',
  'lo-fi': 'lofi',
  hiphop: 'hip-hop',
  rap: 'hip-hop',
  techno: 'techno',
  house: 'house',
  edm: 'edm',
  rock: 'rock',
  metal: 'metal',
  punk: 'punk',
  funk: 'funk',
  soul: 'soul',
  rnb: 'r-n-b',
  'r&b': 'r-n-b',
  country: 'country',
  classical: 'classical',
  indie: 'indie',
  folk: 'folk',
  reggae: 'reggae',
  latin: 'latin',
  disco: 'disco',
  blues: 'blues',
  soundtrack: 'soundtracks',
  anime: 'anime',
  kpop: 'k-pop',
  'k-pop': 'k-pop',
  pop: 'pop',
  electronic: 'electronic',
  ambient: 'ambient',
  technoindustrial: 'industrial',
  goth: 'goth',
  sleep: 'sleep',
};

export interface ParsedVibe {
  /** Averaged audio-feature targets from the matched adjectives. */
  targets: VibeTargets;
  /** Spotify seed-genre ids from matched genre words. */
  genres: string[];
  /** Seed artist name after "like <x>" / "similar to <x>". */
  likeArtist?: string;
  /** How many tracks to queue (parsed trailing integer; default 3). */
  count: number;
  /** Matched mood words (for describing what was understood). */
  matched: string[];
}

/**
 * Parse a vibe phrase. `V@vibe chill like Bonobo 5` → targets(chill),
 * likeArtist 'Bonobo', count 5. Words that match nothing are ignored — the
 * caller decides what to do when nothing at all matched (fall back to the
 * classic mood/text-seed path).
 */
export function parseVibe(input: string): ParsedVibe {
  const words = input
    .toLowerCase()
    .replace(/[^\w&\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  const matched: string[] = [];
  const genres = new Set<string>();
  const sums: Record<string, { sum: number; n: number }> = {};
  let likeArtist: string | undefined;
  let count = 3;

  // "like <artist>" / "similar to <artist>" — everything after the marker is
  // the artist's name, not more mood words. Only mood words BEFORE the marker
  // steer the targets, so "hype like chill birds" is hype + artist "chill birds".
  let markerIdx = -1;
  let markerSkip = 0;
  for (let i = 0; i < words.length; i++) {
    if (words[i] === 'like') {
      markerIdx = i;
      markerSkip = 1;
      break;
    }
    if (words[i] === 'similar' && words[i + 1] === 'to') {
      markerIdx = i;
      markerSkip = 2;
      break;
    }
  }
  const prefix = markerIdx >= 0 ? words.slice(0, markerIdx) : words.slice();
  const rest = markerIdx >= 0 ? words.slice(markerIdx + markerSkip) : [];

  // Trailing pure integer → queue count ("V@vibe chill 5", "V@vibe chill like Bonobo 5").
  if (words.length > 1 && /^\d+$/.test(words[words.length - 1])) {
    count = Math.max(1, Math.min(10, parseInt(words[words.length - 1], 10)));
    words.pop();
  }

  // The artist phrase stays verbatim (minus stray integers) — an artist can be
  // named "Daft Punk" or "Jazz" without the genre table eating their name.
  if (rest.length > 0) {
    likeArtist = rest.filter((w) => !/^\d+$/.test(w)).join(' ') || undefined;
  }

  for (const w of prefix) {
    if (w in GENRE_WORDS) {
      genres.add(GENRE_WORDS[w]);
      if (!(w in ADJECTIVES)) matched.push(w);
    }
    const adj = ADJECTIVES[w];
    if (adj) {
      matched.push(w);
      for (const [k, v] of Object.entries(adj)) {
        if (typeof v !== 'number') continue;
        const e = (sums[k] ??= { sum: 0, n: 0 });
        e.sum += v;
        e.n++;
      }
    }
  }

  const targets: VibeTargets = {};
  for (const [k, { sum, n }] of Object.entries(sums)) {
    const avg = sum / n;
    // min/max tempo average to a band only when they stay sane.
    if (k === 'minTempo' || k === 'maxTempo') {
      (targets as Record<string, number>)[k] = Math.round(avg);
    } else {
      (targets as Record<string, number>)[k] = Math.round(avg * 100) / 100;
    }
  }

  return {
    targets,
    genres: [...genres].slice(0, 3),
    likeArtist: likeArtist || undefined,
    count,
    matched,
  };
}

/** True when the parse found anything steer-able (targets, genres, artist). */
export function vibeIsSteerable(p: ParsedVibe): boolean {
  return p.matched.length > 0 || p.genres.length > 0 || !!p.likeArtist;
}
