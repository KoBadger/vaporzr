import type { AudioFeatures } from '@vaporzr/core/spotify';

/**
 * Smart shuffle: order the *upcoming* queue by musical flow instead of at
 * random. Uses the same audio features Endless Wave scores on (energy, valence,
 * tempo, key/mode), so no new analysis is needed.
 *
 *  - flow: nearest-neighbour — each track is the closest vibe to the one before.
 *  - arc:  builds a set curve (warm-up → peak → wind-down).
 *  - key:  harmonic mixing on the Camelot wheel, like a DJ.
 *
 * Tracks without features (e.g. a YouTube-only upload) keep their exact
 * position, so a shuffle never drops or piles them up.
 */
export type ShuffleMode = 'flow' | 'arc' | 'key';

export const SHUFFLE_MODE_LABEL: Record<ShuffleMode, string> = {
  flow: 'flow',
  arc: 'arc (warm-up → peak → wind-down)',
  key: 'harmonic key',
};

/** Camelot wheel: 1..12 + major/minor. */
const MINOR_CAMELOT = [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10];
const MAJOR_CAMELOT = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1];

interface Camelot {
  n: number;
  major: boolean;
}

function camelot(f: AudioFeatures): Camelot | null {
  const key = Math.round(f.key);
  const major = Math.round(f.mode) === 1;
  if (!Number.isFinite(key) || key < 0 || key > 11) return null;
  return { n: (major ? MAJOR_CAMELOT : MINOR_CAMELOT)[key], major };
}

/** 0 = identical/relative key, ~0.15 = a clean energy boost/drop, 1 = clashing. */
export function keyDistance(a: AudioFeatures, b: AudioFeatures): number {
  const ka = camelot(a);
  const kb = camelot(b);
  if (!ka || !kb) return 0.5; // unknown key — neutral, never a blocker
  if (ka.n === kb.n) return ka.major === kb.major ? 0 : 0.08; // same, or relative
  const apart = Math.min(Math.abs(ka.n - kb.n), 12 - Math.abs(ka.n - kb.n));
  if (apart === 1 && ka.major === kb.major) return 0.15; // adjacent, same mode
  return Math.min(1, apart / 5);
}

const WEIGHTS: Record<ShuffleMode, { energy: number; valence: number; tempo: number; acoustic: number; key: number }> = {
  // Energy and valence dominate deliberately: they are what a listener actually
  // perceives as "the vibe", and they are the only two features Spotify
  // guarantees. Tempo is scaled by /60 in vibeDistance, so its weight is already
  // an order of magnitude larger than the raw number suggests — keep it modest.
  flow: { energy: 0.5, valence: 0.35, tempo: 0.1, acoustic: 0.05, key: 0.1 },
  arc: { energy: 0.55, valence: 0.25, tempo: 0.1, acoustic: 0.05, key: 0.1 },
  key: { energy: 0.25, valence: 0.15, tempo: 0.1, acoustic: 0.1, key: 0.5 },
};

/** Weighted musical distance in 0..1 (0 = same vibe). */
export function vibeDistance(a: AudioFeatures, b: AudioFeatures, mode: ShuffleMode = 'flow'): number {
  const w = WEIGHTS[mode];
  const tempo = Math.min(1, Math.abs(a.tempo - b.tempo) / 60);
  return (
    w.energy * Math.abs(a.energy - b.energy) +
    w.valence * Math.abs(a.valence - b.valence) +
    w.tempo * tempo +
    w.acoustic * Math.abs(a.acousticness - b.acousticness) +
    w.key * keyDistance(a, b)
  );
}

/**
 * Tie-break noise. This exists only so two identical runs are not byte-identical;
 * it must stay well under the real score differences or the ordering becomes
 * random. The weights above produce best-vs-second-best gaps of ~0.02 on a
 * typical playlist, so anything near that swallows the signal entirely.
 */
const JITTER = 0.002;

interface Item<T> {
  item: T;
  f: AudioFeatures;
}

function greedyOrder<T>(pool: Item<T>[], anchor: AudioFeatures | null, mode: ShuffleMode): Item<T>[] {
  const left = [...pool];
  const out: Item<T>[] = [];
  let cur = anchor;
  while (left.length) {
    let best = 0;
    let bestScore = Infinity;
    for (let i = 0; i < left.length; i++) {
      // A whisper of jitter so two runs of the same queue aren't identical.
      const s = (cur ? vibeDistance(cur, left[i].f, mode) : 0) + Math.random() * JITTER;
      if (s < bestScore) {
        bestScore = s;
        best = i;
      }
    }
    const [chosen] = left.splice(best, 1);
    out.push(chosen);
    cur = chosen.f;
  }
  return out;
}

/** Energy target along the set: ramps up, peaks around 65%, eases back down. */
function arcTarget(i: number, n: number): number {
  const t = n <= 1 ? 0.5 : i / (n - 1);
  return t < 0.65 ? 0.35 + (t / 0.65) * 0.5 : 0.85 - ((t - 0.65) / 0.35) * 0.35;
}

function arcOrder<T>(pool: Item<T>[], anchor: AudioFeatures | null): Item<T>[] {
  const n = pool.length;
  const left = [...pool];
  const out: Item<T>[] = [];
  let cur = anchor;
  for (let i = 0; i < n; i++) {
    const want = arcTarget(i, n);
    let best = 0;
    let bestScore = Infinity;
    for (let j = 0; j < left.length; j++) {
      const f = left[j].f;
      const s =
        Math.abs(f.energy - want) + // sit on the curve
        (cur ? vibeDistance(cur, f, 'arc') * 0.6 : 0) + // and still flow
        Math.random() * JITTER;
      if (s < bestScore) {
        bestScore = s;
        best = j;
      }
    }
    const [chosen] = left.splice(best, 1);
    out.push(chosen);
    cur = chosen.f;
  }
  return out;
}

/**
 * Reorder `items` starting from the anchor's vibe. Featureless items keep their
 * original index; the rest are filled in around them.
 */
export function orderByVibe<T>(
  items: T[],
  anchor: AudioFeatures | null,
  mode: ShuffleMode,
  featOf: (t: T) => AudioFeatures | null,
): { ordered: T[]; withoutFeatures: number } {
  const withF: Item<T>[] = [];
  let withoutFeatures = 0;
  for (const item of items) {
    const f = featOf(item);
    if (f) withF.push({ item, f });
    else withoutFeatures++;
  }
  if (withF.length < 2) return { ordered: items, withoutFeatures };

  const ranked = (mode === 'arc' ? arcOrder(withF, anchor) : greedyOrder(withF, anchor, mode)).map((x) => x.item);
  let k = 0;
  const ordered = items.map((it) => (featOf(it) ? ranked[k++] : it));
  return { ordered, withoutFeatures };
}
