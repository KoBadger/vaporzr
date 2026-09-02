import {
  type AudioFeatures,
  type ResolvedTrack,
  type RecommendationParams,
  extractSpotifyId,
  getAudioFeatures,
  getRecommendations,
  searchTracks,
} from './spotify.js';
import { searchAndResolveYoutube } from './youtube.js';
import { deezerRelatedTracks } from './deezer.js';
import type { TrackInfo } from '@vaporzr/shared';

export type { AudioFeatures } from './spotify.js';

/* ---------- Types ---------- */

export interface EndlessWaveState {
  active: boolean;
  /** URI set of every track queued during this EW session — prevents exact repeats. */
  playedUris: Set<string>;
  /** Normalized names of tracks played (for remix/cover detection). */
  playedNames: Set<string>;
  /** Artists of recent tracks (most recent last) for cooldown tracking. */
  recentArtists: string[];
  /** Audio features of the last N tracks (most recent last). */
  recentFeatures: AudioFeatures[];
  /** Running average of recent features — drives the evolution targets. */
  avg: AudioFeatures;
  /** Current genre drift direction (updated every N tracks). */
  genreDrift: number;
  /** How many tracks have been auto-queued in this session. */
  generated: number;
  /** Cumulative no-candidate dead-ends (each set the 15s retry backoff). */
  deadEnds: number;
  /** Consecutive tracks queued since the last dead-end. */
  runStreak: number;
  /** Longest uninterrupted queued run this session. */
  longestRun: number;
  /** Distinct artists auto-queued this session. */
  artistSet: Set<string>;
}

export interface EndlessWaveSnapshot {
  active: boolean;
  generated: number;
  playedCount: number;
  deadEnds: number;
  runStreak: number;
  longestRun: number;
  artistCount: number;
}

export interface EWConfig {
  historyWindow: number;
  artistCooldown: number;
  evolveInterval: number;
  driftStep: number;
  maxDrift: number;
  dedupMax: number;
}

const DEFAULT_CONFIG: EWConfig = {
  historyWindow: 5,
  artistCooldown: 3,
  evolveInterval: 3,
  driftStep: 0.08,
  maxDrift: 0.35,
  dedupMax: 800,
};

/** Feature blending weights — most recent track has strongest influence. */
function weights(n: number): number[] {
  const base = [0.1, 0.15, 0.2, 0.25, 0.3];
  return base.slice(-n);
}

const DEFAULT_AVG: AudioFeatures = {
  danceability: 0.5,
  energy: 0.5,
  valence: 0.5,
  tempo: 120,
  acousticness: 0.3,
  instrumentalness: 0.1,
  liveness: 0.1,
  speechiness: 0.05,
  key: 0,
  mode: 1,
  time_signature: 4,
  duration_ms: 200_000,
};

/* ---------- State management ---------- */

export function createState(overrides?: Partial<EWConfig>): EndlessWaveState {
  return {
    active: false,
    playedUris: new Set(),
    playedNames: new Set(),
    recentArtists: [],
    recentFeatures: [],
    avg: { ...DEFAULT_AVG },
    genreDrift: 0,
    generated: 0,
    deadEnds: 0,
    runStreak: 0,
    longestRun: 0,
    artistSet: new Set(),
  };
}

export function activate(state: EndlessWaveState): void {
  state.active = true;
  state.playedUris.clear();
  state.playedNames.clear();
  state.recentArtists = [];
  state.recentFeatures = [];
  state.avg = { ...DEFAULT_AVG };
  state.genreDrift = 0;
  state.generated = 0;
  state.deadEnds = 0;
  state.runStreak = 0;
  state.longestRun = 0;
  state.artistSet.clear();
}

export function deactivate(state: EndlessWaveState): void {
  state.active = false;
}

export function snapshot(state: EndlessWaveState): EndlessWaveSnapshot {
  return {
    active: state.active,
    generated: state.generated,
    playedCount: state.playedUris.size,
    deadEnds: state.deadEnds,
    runStreak: state.runStreak,
    longestRun: state.longestRun,
    artistCount: state.artistSet.size,
  };
}

/** Record a successful auto-queue — advances the run streak and tracks artists. */
export function noteWaveQueued(state: EndlessWaveState, artists: string[]): void {
  state.runStreak++;
  if (state.runStreak > state.longestRun) state.longestRun = state.runStreak;
  for (const a of artists) {
    const norm = String(a ?? '').toLowerCase().trim();
    if (norm) state.artistSet.add(norm);
  }
}

/** Record a no-candidate dead-end — the wave hit its retry backoff. */
export function noteWaveDeadEnd(state: EndlessWaveState): void {
  state.deadEnds++;
  state.runStreak = 0;
}

/* ---------- Persistence ---------- */

/** JSON-safe shape of an EndlessWaveState (Sets are converted to arrays). */
export interface EndlessWavePersist {
  active: boolean;
  playedUris: string[];
  playedNames: string[];
  recentArtists: string[];
  recentFeatures: AudioFeatures[];
  avg: AudioFeatures;
  genreDrift: number;
  generated: number;
  deadEnds: number;
  runStreak: number;
  longestRun: number;
  artistSet: string[];
}

/** Flatten a live state for on-disk persistence. */
export function serializeState(state: EndlessWaveState): EndlessWavePersist {
  return {
    active: state.active,
    playedUris: [...state.playedUris],
    playedNames: [...state.playedNames],
    recentArtists: state.recentArtists,
    recentFeatures: state.recentFeatures,
    avg: state.avg,
    genreDrift: state.genreDrift,
    generated: state.generated,
    deadEnds: state.deadEnds,
    runStreak: state.runStreak,
    longestRun: state.longestRun,
    artistSet: [...state.artistSet],
  };
}

/** Rebuild a live state from persisted data (Sets back from arrays). */
export function restoreState(data: Partial<EndlessWavePersist>): EndlessWaveState {
  const s = createState();
  if (typeof data.active === 'boolean') s.active = data.active;
  for (const u of data.playedUris ?? []) s.playedUris.add(u);
  for (const n of data.playedNames ?? []) s.playedNames.add(n);
  s.recentArtists = Array.isArray(data.recentArtists) ? [...data.recentArtists] : [];
  s.recentFeatures = Array.isArray(data.recentFeatures) ? [...data.recentFeatures] : [];
  if (data.avg && typeof data.avg.energy === 'number') s.avg = { ...s.avg, ...data.avg };
  if (typeof data.genreDrift === 'number') s.genreDrift = data.genreDrift;
  if (typeof data.generated === 'number') s.generated = data.generated;
  if (typeof data.deadEnds === 'number') s.deadEnds = data.deadEnds;
  if (typeof data.runStreak === 'number') s.runStreak = data.runStreak;
  if (typeof data.longestRun === 'number') s.longestRun = data.longestRun;
  for (const a of data.artistSet ?? []) s.artistSet.add(String(a).toLowerCase().trim());
  return s;
}

/* ---------- Feature analysis ---------- */

/** Record a track's audio features and recompute the rolling average. */
export function recordFeatures(
  state: EndlessWaveState,
  features: AudioFeatures,
  artist?: string,
): void {
  state.recentFeatures.push(features);
  if (state.recentFeatures.length > DEFAULT_CONFIG.historyWindow) {
    state.recentFeatures.shift();
  }
  state.avg = computeAverage(state.recentFeatures);

  if (artist) {
    const norm = artist.toLowerCase().trim();
    state.recentArtists.push(norm);
    if (state.recentArtists.length > DEFAULT_CONFIG.artistCooldown + 2) {
      state.recentArtists.shift();
    }
  }

  if (state.generated > 0 && state.generated % DEFAULT_CONFIG.evolveInterval === 0) {
    evolveDirection(state);
  }
}

export function computeAverage(features: AudioFeatures[]): AudioFeatures {
  if (features.length === 0) return { ...DEFAULT_AVG };
  const w = weights(features.length);
  const wSum = w.reduce((a, b) => a + b, 0);
  const nw = w.map((x) => x / wSum);
  const avg: AudioFeatures = { ...DEFAULT_AVG };
  const numKeys: (keyof AudioFeatures)[] = [
    'danceability', 'energy', 'valence', 'acousticness',
    'instrumentalness', 'liveness', 'speechiness',
  ];
  for (const k of numKeys) {
    let sum = 0;
    for (let i = 0; i < features.length; i++) sum += features[i][k] * nw[i];
    (avg as any)[k] = Math.round(sum * 1000) / 1000;
  }
  let tSum = 0;
  for (let i = 0; i < features.length; i++) tSum += features[i].tempo * nw[i];
  avg.tempo = Math.round(tSum * 10) / 10;
  let dSum = 0;
  for (let i = 0; i < features.length; i++) dSum += features[i].duration_ms * nw[i];
  avg.duration_ms = Math.round(dSum);
  const last = features[features.length - 1];
  avg.key = last.key;
  avg.mode = last.mode;
  avg.time_signature = last.time_signature;
  return avg;
}

/* ---------- Evolution ---------- */

export function evolveDirection(state: EndlessWaveState): void {
  const nudge = (Math.random() - 0.5) * DEFAULT_CONFIG.driftStep * 2;
  state.genreDrift = Math.max(
    -DEFAULT_CONFIG.maxDrift,
    Math.min(DEFAULT_CONFIG.maxDrift, state.genreDrift + nudge),
  );
}

export function buildTargets(state: EndlessWaveState): Partial<RecommendationParams> {
  const a = state.avg;
  const d = state.genreDrift;
  return {
    targetEnergy: clamp(a.energy + d * 0.6),
    targetTempo: a.tempo + d * 15,
    targetValence: clamp(a.valence + d * 0.4),
    targetDanceability: clamp(a.danceability + d * 0.3),
    targetAcousticness: clamp(a.acousticness - d * 0.2),
    targetInstrumentalness: clamp(a.instrumentalness + d * 0.1),
    minTempo: Math.max(60, a.tempo - 30 + d * 10),
    maxTempo: Math.min(200, a.tempo + 30 + d * 10),
  };
}

/* ---------- Dedup / filtering ---------- */

/** Normalize a track name for remix/cover detection. */
export function normalizeTrackName(name: string): string {
  const n = String(name ?? '')
    .toLowerCase()
    .replace(/['']/g, '')
    // Strip parenthesized/bracketed version markers: (Remix), (Edit), (Movie Version), etc.
    .replace(/\s*[\(\[][^\)\]]*\b(remix|edit|vip|bootleg|flip|dub|radio edit|extended|club mix|sped up|slowed|reverb|movie version|film version|motion picture version|end credits|end title|closing credits|from the motion picture|from the film|soundtrack version|ost|single version|album version|bonus track|deluxe|remastered|remaster|anniversary edition|clean|explicit|radio version|video version)\b[^\)\]]*[\)\]]/gi, '')
    // Strip standalone dash version markers: - Remix, — Movie Version, etc.
    .replace(/\s*[-–—]\s*(remix|edit|vip|bootleg|flip|dub|mix|radio edit|extended|club mix|sped up|slowed|reverb|movie version|film version|motion picture version|end credits|soundtrack version|soundtrack|ost|single version|album version|bonus|deluxe|remastered|clean|explicit|radio version|video version)\s*$/gi, '')
    // Strip cover/live/acoustic markers in parens/brackets: (Acoustic), [Live], (Cover), etc.
    .replace(/\s*[\(\[][^\)\]]*\b(cover|acoustic|live|unplugged|demo|alternate version|alternate mix|original mix|instrumental|a cappella)\b[^\)\]]*[\)\]]/gi, '')
    // Strip YouTube upload noise so the same song under an "Official Audio" /
    // "(Lyrics)" / "(Music Video)" title still matches its clean Spotify name.
    .replace(/\s*[\(\[][^\)\]]*\b(official audio|official video|official music video|official lyric video|lyric video|lyrics|music video|visualizer|visualizer video|official visualizer)\b[^\)\]]*[\)\]]/gi, '')
    // Dash-form YouTube noise: "Song - Official Audio", "Song - Lyrics".
    .replace(/\s*[-–—]\s*(official audio|official video|official music video|official lyric video|lyric video|lyrics|music video|visualizer|visualizer video|official visualizer)\s*$/gi, '')
    // Strip feat/ft inside parens: (feat. Someone), (ft. Someone)
    .replace(/\s*[\(\[][^)\]]*\b(feat\.?|ft\.?|featuring)\b[^)\]]*[\)\]]/gi, '')
    // Strip bare feat/ft outside parens: feat. Someone, ft. Someone
    .replace(/\s*\b(feat\.?|ft\.?|featuring)\s+.*/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return n;
}


/** Check if a track is a remix/cover/variant of something already played.
 *  `artists` enables title-core matching: YouTube titles ("Nightcall - Kavinsky
 *  (Eewas Cesium Remix)") and Spotify titles ("Nightcall") normalize to
 *  different strings, but both reduce to "nightcall" once known artist names
 *  are stripped — so the same song published under different title
 *  conventions is still recognized as a repeat. */
export function isRemixOrCover(state: EndlessWaveState, name: string, artists?: string[]): boolean {
  const norm = normalizeTrackName(name);
  if (!norm) return false;
  return nameVariants(norm, artists, state.recentArtists).some((v) => state.playedNames.has(v));
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Reduce an already-normalized title by removing known artist names
 *  (candidate artists + recent history), e.g. "nightcall - kavinsky" → "nightcall". */
function titleCore(norm: string, artists: string[] | undefined, recentArtists: string[]): string {
  let core = norm;
  const names = new Set<string>();
  for (const a of artists ?? []) names.add(normalizeTrackName(a));
  for (const a of recentArtists) names.add(normalizeTrackName(a));
  for (const na of names) {
    if (na.length >= 3) core = core.replace(new RegExp(`\\b${escapeRe(na)}\\b`, 'g'), ' ');
  }
  return core.replace(/[-–—:,\s]+$/g, '').replace(/^[-–—:,\s]+/g, '').replace(/\s+/g, ' ').trim();
}

/** Every string a title could reasonably match against for repeat detection:
 *  the normalized title, the artist-stripped core, and the halves of an
 *  "A - B" title (covers "Song - Artist" YouTube titles vs bare Spotify ones). */
function nameVariants(norm: string, artists?: string[], recentArtists?: string[]): string[] {
  const out = new Set<string>([norm]);
  const core = titleCore(norm, artists, recentArtists ?? []);
  if (core) out.add(core);
  for (const part of norm.split(/\s+[-–—]\s+/)) {
    const p = part.trim();
    if (p.length >= 3) out.add(p);
  }
  return [...out];
}

/** Check if a track URI has already been played in this EW session. */
export function isDuplicate(state: EndlessWaveState, uri: string): boolean {
  return state.playedUris.has(uri);
}

/** Check if an artist is on cooldown (appeared too recently). */
export function isArtistOnCooldown(state: EndlessWaveState, artist: string): boolean {
  const normalArtist = artist.toLowerCase().trim();
  const recent = state.recentArtists.slice(-DEFAULT_CONFIG.artistCooldown);
  return recent.some((a) => a.toLowerCase().trim() === normalArtist);
}

/** The most recent artist NOT currently on cooldown — used as a "similar but
 *  different" search seed so a fallback never repeats the artist that just
 *  played, while still surfacing a related (earlier-session) artist's catalog. */
export function similarArtistSeed(state: EndlessWaveState): string {
  for (let i = state.recentArtists.length - 1; i >= 0; i--) {
    const a = state.recentArtists[i];
    if (a && !isArtistOnCooldown(state, a)) return a;
  }
  return '';
}

/** True when a candidate's TITLE mentions an on-cooldown artist — catches
 *  compilation/setlist uploads ("Best of Coldplay [Setlist]") whose artist
 *  field is empty, so they can't dodge the artist cooldown via a missing tag. */
export function titleMentionsCooldownArtist(state: EndlessWaveState, name: string): boolean {
  const norm = normalizeTrackName(name);
  if (!norm) return false;
  const cooldown = state.recentArtists.slice(-DEFAULT_CONFIG.artistCooldown);
  return cooldown.some((a) => a.length >= 3 && norm.includes(a));
}

/** EW should queue individual songs, not radio sets, DJ mixes, or full albums. */
function isLongFormMix(track: ResolvedTrack): boolean {
  const title = String(track.name ?? '').toLowerCase();
  if ((track.durationMs ?? 0) > 10 * 60 * 1000) return true;
  return /\b(essential mix|dj set|continuous mix|full album|compilation|boiler room|radio show|radio mix|meg amix|mixtape|live set|session)\b/i.test(title)
    || /\b\d+\s*(hour|hr|min)\b/i.test(title);
}

/** Mark a track as played. Trims old entries when the set gets huge. */
export function markPlayed(
  state: EndlessWaveState,
  uri: string,
  name: string,
  artists: string[],
): void {
  state.playedUris.add(uri);
  const norm = normalizeTrackName(name);
  // Store every matchable variant of the title (normalized, artist-stripped
  // core, "A - B" halves) so the same song under a different title convention
  // is still recognized as a repeat in either direction.
  for (const v of nameVariants(norm, artists, [])) state.playedNames.add(v);
  for (const a of artists) {
    const norm = a.toLowerCase().trim();
    state.recentArtists.push(norm);
  }
  if (state.recentArtists.length > DEFAULT_CONFIG.artistCooldown + 5) {
    state.recentArtists = state.recentArtists.slice(-DEFAULT_CONFIG.artistCooldown - 2);
  }
  if (state.playedUris.size > DEFAULT_CONFIG.dedupMax) {
    const toRemove = Math.floor(DEFAULT_CONFIG.dedupMax * 0.2);
    let count = 0;
    for (const u of state.playedUris) {
      if (count >= toRemove) break;
      state.playedUris.delete(u);
      count++;
    }
  }
  // Keep the normalized-name set bounded too (insertion order = oldest first).
  if (state.playedNames.size > DEFAULT_CONFIG.dedupMax) {
    const toRemove = Math.floor(DEFAULT_CONFIG.dedupMax * 0.2);
    let count = 0;
    for (const n of state.playedNames) {
      if (count >= toRemove) break;
      state.playedNames.delete(n);
      count++;
    }
  }
}

/* ---------- Scoring ---------- */

/** Normalized 0..1 distance between a track's audio features and the reco
 *  target. Each dimension is scaled to a comparable range (tempo/60, duration
 *  /240s) so no single feature dominates; missing sides are ignored. */
function featureDistance(f: AudioFeatures, t: Partial<RecommendationParams>): number {
  let d = 0;
  let n = 0;
  const add = (v: number | undefined, tv: number | undefined, scale: number): void => {
    if (v === undefined || tv === undefined) return;
    d += Math.abs(v - tv) / scale;
    n++;
  };
  add(f.energy, t.targetEnergy, 1);
  add(f.valence, t.targetValence, 1);
  add(f.danceability, t.targetDanceability, 1);
  add(f.acousticness, t.targetAcousticness, 1);
  add(f.instrumentalness, t.targetInstrumentalness, 1);
  add(f.tempo, t.targetTempo, 60);
  return n ? d / n : 0;
}

/** Lower = better fit. Feature-target distance + source + artist novelty + duration sanity.
 *  `features` is optional — when absent (e.g. a YouTube pick) it just scores on the
 *  heuristics below, so callers keep working without an API round-trip. */
export function scoreCandidate(
  track: ResolvedTrack,
  targets: Partial<RecommendationParams>,
  recentArtists: string[],
  features?: AudioFeatures,
): number {
  let score = 0;

  // Beat-feature coherence: pull the pick toward the evolving energy/tempo/valence
  // target. This is what keeps an Endless Wave flowing along a vibe instead of
  // lurching between wildly different songs. Mean distance scaled up so it
  // meaningfully competes with the durability/artist bonuses below.
  if (features) score += featureDistance(features, targets) * 40;

  // Spotify URI bonus (prefer known sources).
  if (track.uri.startsWith('spotify:')) score -= 10;

  // Duration sanity (prefer 2-7 min tracks).
  if (track.durationMs >= 120_000 && track.durationMs <= 420_000) score -= 5;
  else score += 10;

  // Artist novelty bonus — penalize if artist appeared recently.
  const trackArtist = (track.artists[0] ?? '').toLowerCase().trim();
  const recentNorm = recentArtists.slice(-DEFAULT_CONFIG.artistCooldown).map((a) => a.toLowerCase().trim());
  if (trackArtist && recentNorm.includes(trackArtist)) {
    score += 20; // strong penalty for on-cooldown artist
  } else if (trackArtist) {
    score -= 3; // small bonus for novel artist
  }

  // Small random tiebreaker to avoid deterministic picks.
  score += Math.random() * 2;

  return score;
}

/* ---------- Recommendation engine ---------- */

/** Context window around the current queue position: up to `before` recently
 *  played tracks (recommendation seeds) + `after` upcoming tracks (dedup).
 *  Played tracks are never removed from the queue array, so a naive
 *  slice(0, n) would grab the session's oldest tracks instead. */
export function pickContext(
  tracks: TrackInfo[],
  currentIndex: number,
  before = 3,
  after = 3,
): TrackInfo[] {
  if (tracks.length === 0) return [];
  const start = Math.max(0, currentIndex - before);
  const end = Math.min(tracks.length, currentIndex + after);
  return tracks.slice(start, end);
}

/** Extract Spotify IDs from recent tracks for seeding. Uses up to 3 tracks. */
export function extractSeeds(recentTracks: TrackInfo[]): string[] {
  const seeds: string[] = [];
  // Walk backwards through the queue to get the most recent.
  for (let i = recentTracks.length - 1; i >= Math.max(0, recentTracks.length - 3); i--) {
    const id = extractSpotifyId(recentTracks[i].uri);
    if (id) seeds.push(id);
  }
  return seeds;
}

/** Pick the next track. Returns null if nothing suitable was found.
 *  `excludeUris` lets callers reject candidates that already failed to resolve.
 *  `upcoming` is the full list of tracks still waiting in the queue — used to
 *  reject candidates that duplicate (or are a version of) anything already
 *  queued, so a lookahead buffer never stacks two takes of the same song. */
export async function pickNextTrack(
  state: EndlessWaveState,
  recentTracks: TrackInfo[],
  excludeUris?: ReadonlySet<string>,
  upcoming?: TrackInfo[],
): Promise<ResolvedTrack | null> {
  if (!state.active) return null;

  const targets = buildTargets(state);
  const seedIds = extractSeeds(recentTracks);

  // Filter: no URI dupes, no remix/cover variants of played OR queued tracks,
  // no on-cooldown artists, and never re-pick something already waiting.
  // Importantly, artists from already-queued upcoming tracks count as being on
  // cooldown too: otherwise a refill burst can queue "Coldplay - Magic" and
  // then "Best of Coldplay" (or two Paramore songs) before the first one ever
  // starts playing and updates state.recentArtists.
  const upTracks = upcoming ?? recentTracks;
  const upcomingUris = new Set(upTracks.map((t) => t.uri));
  const upcomingNames = new Set<string>();
  const upcomingArtists = new Set<string>();
  for (const t of upTracks) {
    for (const v of nameVariants(normalizeTrackName(t.name), t.artists, [])) upcomingNames.add(v);
    for (const a of t.artists) {
      const norm = a.toLowerCase().trim();
      if (norm.length >= 3) upcomingArtists.add(norm);
    }
  }
  const cooldownArtists = new Set<string>(
    state.recentArtists.slice(-DEFAULT_CONFIG.artistCooldown).map((a) => a.toLowerCase().trim()),
  );
  for (const a of upcomingArtists) cooldownArtists.add(a);
  const artistIsOnCooldown = (artist: string): boolean =>
    cooldownArtists.has(artist.toLowerCase().trim());
  const titleMentionsAnyCooldownArtist = (name: string): boolean => {
    const norm = normalizeTrackName(name);
    if (!norm) return false;
    return [...cooldownArtists].some((a) => a.length >= 3 && norm.includes(a));
  };

  const viable = (candidates: ResolvedTrack[]): ResolvedTrack[] =>
    candidates.filter((c) => {
      if (isLongFormMix(c)) { logReject(c.name, 'long-form mix/set'); return false; }
      if (isDuplicate(state, c.uri)) { logReject(c.name, 'already played this session'); return false; }
      if (upcomingUris.has(c.uri)) { logReject(c.name, 'already queued'); return false; }
      if (excludeUris?.has(c.uri)) { logReject(c.name, 'previously failed to resolve'); return false; }
      if (isRemixOrCover(state, c.name, c.artists)) { logReject(c.name, 'remix/cover of played track'); return false; }
      if (nameVariants(normalizeTrackName(c.name), c.artists, state.recentArtists).some((v) => upcomingNames.has(v))) { logReject(c.name, 'variant already queued'); return false; }
      const mainArtist = c.artists[0] ?? '';
      if (mainArtist && artistIsOnCooldown(mainArtist)) { logReject(c.name, `artist "${mainArtist}" on cooldown`); return false; }
      // Compilation/setlist uploads with an empty artist field still mention the
      // artist in the title — treat them as a cooldown repeat.
      if (titleMentionsAnyCooldownArtist(c.name)) { logReject(c.name, 'title mentions cooldown artist'); return false; }
      return true;
    });

  let candidates: ResolvedTrack[] = [];
  let survivors: ResolvedTrack[] = [];
  let stage = 0;
  const logReject = (name: string, reason: string) => {
    if (process.env.NODE_ENV === 'test') return;
    console.log(`[endlesswave] rejected candidate "${name}": ${reason}`);
  };

  // Strategy 1: Spotify recommendations (best quality, needs seed tracks).
  if (seedIds.length > 0) {
    stage = 1;
    try {
      candidates = await getRecommendations({
        seedTracks: seedIds,
        limit: 30,
        ...targets,
      });
    } catch {
      // Recommendations can fail on rate limits or missing seeds — fall through.
    }
    survivors = viable(candidates);
  }

  // Strategy 2: Spotify search fallback. Seed the query with the most recent
  // artist that is NOT on cooldown, so we surface a related artist's wider
  // catalog instead of repeating the artist that just played (or, failing that,
  // a same-title query whose remix/cover variants dedup then filters).
  if (survivors.length === 0 && recentTracks.length > 0) {
    stage = 2;
    candidates = [];
    try {
      const last = recentTracks[recentTracks.length - 1];
      const query = (similarArtistSeed(state) || last.artists[0] || last.name).trim();
      if (query) candidates = await searchTracks(query, 20);
    } catch {
      // ignore
    }
    survivors = viable(candidates);
  }

  // Strategy 3: YouTube search fallback (if nothing usable from Spotify).
  // Try the seed artist's catalog only — explicitly never query by the current
  // song title, since that always re-finds a remix-variant of the same song,
  // exactly what causes the same-audio repeat loop. Cooldown applies.
  if (survivors.length === 0 && recentTracks.length > 0) {
    stage = 3;
    const last = recentTracks[recentTracks.length - 1];
    const attempts: Array<{ q: string; opts: Parameters<typeof searchAndResolveYoutube>[1] }> = [];
    const byArtist = (last.artists[0] ?? '').trim();
    if (byArtist) attempts.push({ q: byArtist, opts: {} });
    for (const at of attempts) {
      try {
        const video = await searchAndResolveYoutube(at.q, at.opts);
        if (video) {
          candidates = [{
            uri: video.uri || `yt:${video.name}`,
            name: video.name,
            artists: video.artists,
            album: video.album,
            durationMs: video.durationMs,
            image: video.image,
            source: 'youtube',
            streamUrl: video.streamUrl,
          }];
          // Reject the same song outright (including its remix/cover variants).
          const v = candidates[0];
          if (!isRemixOrCover(state, v.name, v.artists)) {
            survivors = viable(candidates);
            if (survivors.length > 0) break;
          } else {
            logReject(v.name, 'remix/cover of played track');
          }
        }
      } catch {
        // ignore and try the next query
      }
    }
  }

  // Strategy 4 (relaxed fallback): as a last resort farm a Spotify search on
  // the seed artist (with cooldown gate) — a different song is better than a
  // wave-die. Never reuse prior candidates: same-song remix variant loops are
  // strictly worse than staying armed.
  if (survivors.length === 0 && recentTracks.length > 0) {
    stage = 4;
    const relax = (c: ResolvedTrack): boolean => {
      if (isLongFormMix(c)) { logReject(c.name, 'long-form mix/set'); return false; }
      if (isDuplicate(state, c.uri)) { logReject(c.name, 'already played this session'); return false; }
      if (upcomingUris.has(c.uri)) { logReject(c.name, 'already queued'); return false; }
      if (excludeUris?.has(c.uri)) { logReject(c.name, 'previously failed to resolve'); return false; }
      if (isRemixOrCover(state, c.name, c.artists)) { logReject(c.name, 'remix/cover of played track'); return false; }
      const variants = nameVariants(normalizeTrackName(c.name), c.artists, state.recentArtists);
      if (variants.some((v) => upcomingNames.has(v))) { logReject(c.name, 'same song already queued'); return false; }
      if (titleMentionsAnyCooldownArtist(c.name)) { logReject(c.name, 'title mentions cooldown artist'); return false; }
      return true;
    };
    const last = recentTracks[recentTracks.length - 1];
    // If every known artist is currently cooled, do not immediately fall back
    // to the current artist. Wait for a genuinely different recommendation;
    // same-artist tracks can re-enter naturally after the cooldown window.
    const q = (similarArtistSeed(state) || (state.recentArtists.length === 0 ? (last.artists[0] || last.name) : '')).trim();
    let pool: ResolvedTrack[] = [];
    if (q) {
      try {
        pool = await searchTracks(q, 20);
      } catch {
        // fall through — nothing usable from Spotify
      }
    }
    survivors = pool.filter(relax);
  }

  // Strategy 5 (outside-program fallback): when Spotify's own search/recs
  // dead-end — typical for DJ/producer seeds whose catalogs are mostly long
  // sets that the long-form filter rejects — ask Deezer (keyless, quota-free)
  // for individual tracks by related artists. Keeps the wave flowing without
  // touching any Spotify app quota.
  if (survivors.length === 0 && recentTracks.length > 0) {
    stage = 5;
    const last = recentTracks[recentTracks.length - 1];
    const artist = (similarArtistSeed(state) || last.artists[0] || '').trim();
    if (artist) {
      try {
        survivors = viable(await deezerRelatedTracks(artist));
      } catch {
        // fall through — Deezer is best-effort only
      }
    }
  }

  if (survivors.length === 0 && stage > 0) {
    console.warn(`[endlesswave] all ${stage} strategies exhausted with no viable candidate`);
  }

  // Score and pick the best surviving candidate. When the candidates are
  // Spotify tracks we batch-fetch their audio features (one API call) so the
  // pick is pulled toward the evolving energy/tempo/valence target — this is
  // what gives the wave a coherent musical arc instead of a random shuffle.
  if (survivors.length > 0) {
    let features: Map<string, AudioFeatures> | null = null;
    const ids = survivors
      .map((c) => extractSpotifyId(c.uri))
      .filter((id): id is string => id !== null);
    if (ids.length > 0) {
      try {
        features = (await getAudioFeatures(ids.slice(0, 50))) ?? null;
      } catch {
        features = null;
      }
    }
    const score = (c: ResolvedTrack): number =>
      scoreCandidate(
        c,
        targets,
        state.recentArtists,
        features?.get(extractSpotifyId(c.uri) ?? '') ?? c.estimatedFeatures,
      );
    survivors.sort((a, b) => score(a) - score(b));
    return survivors[0];
  }

  return null;
}

/* ---------- Resolve helper ---------- */

/** After picking a recommendation, resolve it to a queueable track with a stream URL. */
export async function resolveCandidate(track: ResolvedTrack): Promise<TrackInfo | null> {
  const isBadResult = (name: string, artists: string[]): boolean => {
    if (!name || name.trim().length < 2) return true;
    const mainArtist = artists[0] ?? '';
    // Reject results where the "artist" is a URL (common yt-dlp parsing glitch).
    if (/^https?:\/\//i.test(mainArtist.trim())) return true;
    return false;
  };

  try {
    if (track.uri.startsWith('spotify:')) {
      const query = `${track.name} ${track.artists.join(' ')}`.trim();
      const video = await searchAndResolveYoutube(query, {
        name: track.name,
        artists: track.artists,
        durationMs: track.durationMs,
      });
      if (video && !isBadResult(video.name, video.artists)) {
        return {
          uri: track.uri,
          name: track.name,
          artists: track.artists,
          album: track.album,
          durationMs: track.durationMs,
          image: track.image,
          source: 'spotify',
          streamUrl: video.streamUrl,
          addedBy: 'endless-wave',
          addedAt: Date.now(),
        };
      }
    }
    if (track.streamUrl && !isBadResult(track.name, track.artists)) {
      return {
        uri: track.uri,
        name: track.name,
        artists: track.artists,
        album: track.album,
        durationMs: track.durationMs,
        image: track.image,
        source: track.source,
        streamUrl: track.streamUrl,
        addedBy: 'endless-wave',
        addedAt: Date.now(),
      };
    }
    // Metadata-only pick (e.g. Deezer fallback): resolve a YouTube stream by
    // name+artist so it can actually play.
    if (!track.streamUrl && !isBadResult(track.name, track.artists)) {
      const query = `${track.name} ${track.artists.join(' ')}`.trim();
      const video = await searchAndResolveYoutube(query, {
        name: track.name,
        artists: track.artists,
        durationMs: track.durationMs,
      });
      if (video && !isBadResult(video.name, video.artists)) {
        return {
          uri: video.uri,
          name: track.name,
          artists: track.artists,
          album: track.album,
          durationMs: track.durationMs,
          image: video.image ?? track.image,
          source: 'youtube',
          streamUrl: video.streamUrl,
          addedBy: 'endless-wave',
          addedAt: Date.now(),
        };
      }
    }
  } catch {
    // ignore
  }
  return null;
}

/** Fetch audio features for a track, with best-effort fallback. */
export async function fetchFeatures(track: TrackInfo): Promise<AudioFeatures | null> {
  const id = extractSpotifyId(track.uri);
  if (!id) return null;
  try {
    const map = await getAudioFeatures([id]);
    return map.get(id) ?? null;
  } catch {
    return null;
  }
}

function clamp(v: number): number {
  return Math.max(0, Math.min(1, v));
}
