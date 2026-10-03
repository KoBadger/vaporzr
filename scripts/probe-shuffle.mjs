// Reproduce the ordering behaviour on a realistic single-genre playlist.
// Features are drawn from a tight cluster, as one playlist normally is.
import { vibeDistance, orderByVibe, keyDistance } from '../apps/bot/src/smartShuffle.ts';

function rnd(seed) { // deterministic LCG
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function makePlaylist(n, spread, seed) {
  const r = rnd(seed);
  const out = [];
  for (let i = 0; i < n; i++) {
    const base = 0.5 - spread / 2 + r() * spread;
    out.push({
      uri: `spotify:track:t${i}`,
      f: {
        energy: base,
        valence: 0.5 - spread / 2 + r() * spread,
        tempo: 120 + (r() - 0.5) * 2 * (spread * 60),
        acousticness: r() * 0.3,
        key: Math.floor(r() * 12),
        mode: r() > 0.5 ? 1 : 0,
      },
    });
  }
  return out;
}

/** Fraction of adjacent pairs that changed position vs the original order. */
function displacement(orig, ordered) {
  const idx = new Map(orig.map((t, i) => [t.uri, i]));
  let moved = 0;
  ordered.forEach((t, i) => { if (idx.get(t.uri) !== i) moved++; });
  return moved / orig.length;
}

console.log('spread | mode |  displacement | mean adjacent vibeDistance');
console.log('-------|------|---------------|-------------------------');
for (const spread of [0.10, 0.25, 0.45]) {   // tight -> wide playlist
  for (const mode of ['flow', 'arc', 'key']) {
    const pl = makePlaylist(40, spread, 42);
    const featOf = (t) => t.f;
    const { ordered } = orderByVibe(pl, pl[0].f, mode, featOf);
    const disp = displacement(pl, ordered);
    let sum = 0;
    for (let i = 1; i < ordered.length; i++) sum += vibeDistance(ordered[i - 1].f, ordered[i].f, mode);
    const mean = sum / (ordered.length - 1);
    console.log(
      `${spread.toFixed(2)}   | ${mode.padEnd(4)} | ${(disp * 100).toFixed(0).padStart(13)}% | ${mean.toFixed(4)}`
    );
  }
}

// How large is the jitter relative to real score differences?
console.log('\nBest-vs-second-best score gap across the greedy pick (flow):');
{
  const pl = makePlaylist(40, 0.25, 7);
  let minGap = Infinity, sumGap = 0, n = 0;
  const left = [...pl];
  let cur = pl[0].f;
  while (left.length > 1) {
    let b1 = Infinity, b2 = Infinity;
    for (const it of left) {
      const s = vibeDistance(cur, it.f, 'flow');
      if (s < b1) { b2 = b1; b1 = s; } else if (s < b2) b2 = s;
    }
    const gap = b2 - b1;
    minGap = Math.min(minGap, gap); sumGap += gap; n++;
    const chosen = left.splice(left.findIndex((x) => vibeDistance(cur, x.f, 'flow') === b1), 1)[0];
    cur = chosen.f;
  }
  console.log(`  mean gap ${(sumGap / n).toFixed(4)}   min gap ${minGap.toFixed(4)}   jitter up to 0.0200`);
  console.log(`  -> jitter ${((0.02 / (sumGap / n)) * 100).toFixed(0)}% of the mean gap`);
}
