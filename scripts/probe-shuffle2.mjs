import { vibeDistance, orderByVibe } from '../apps/bot/src/smartShuffle.ts';

function rnd(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function makePlaylist(n, spread, seed) {
  const r = rnd(seed); const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ uri: `t${i}`, f: {
      energy: 0.5 - spread / 2 + r() * spread,
      valence: 0.5 - spread / 2 + r() * spread,
      tempo: 120 + (r() - 0.5) * 2 * (spread * 60),
      acousticness: r() * 0.3,
      key: Math.floor(r() * 12), mode: r() > 0.5 ? 1 : 0,
    }});
  }
  return out;
}
function meanAdj(list, mode) {
  let s = 0;
  for (let i = 1; i < list.length; i++) s += vibeDistance(list[i - 1].f, list[i].f, mode);
  return s / (list.length - 1);
}
console.log('The real test: does ordering REDUCE adjacent vibe distance vs the input order?');
console.log('spread | mode | input |  ordered |   change');
console.log('-------|------|-------|----------|---------');
for (const spread of [0.10, 0.25, 0.45]) {
  for (const mode of ['flow', 'arc', 'key']) {
    const pl = makePlaylist(40, spread, 42);
    const { ordered } = orderByVibe(pl, pl[0].f, mode, (t) => t.f);
    const a = meanAdj(pl, mode), b = meanAdj(ordered, mode);
    const pct = ((b - a) / a) * 100;
    console.log(`${spread.toFixed(2)}   | ${mode.padEnd(4)} | ${a.toFixed(4)} | ${b.toFixed(4)}  | ${pct >= 0 ? '+' : ''}${pct.toFixed(0)}%`);
  }
}
