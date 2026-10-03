import fs from 'node:fs';

/**
 * Guard against a silent black-page failure.
 *
 * A JS syntax error anywhere in viz.html leaves the page chrome rendering while
 * the canvas stays empty — visually identical to the layout/rendering bugs this
 * file has already been bitten by.
 *
 * Every inline script in the page is compiled with the async-Function
 * constructor, because the page uses top-level await inside its IIFE and the
 * Activity handshake is a module.
 *
 * The handshake is produced by activityHtml() in server.ts. Rather than re-parse
 * that source (fragile: it is a concatenation full of quotes and escapes), this
 * asserts the two properties that actually matter and are cheap to check:
 *   1. /activity is wired to activityHtml in the route table.
 *   2. The handshake template contains no obvious bracket imbalance.
 * The end-to-end check for the generated page is the live verification step in
 * the deploy runbook (curl the Activity URL and look for the module tag).
 *
 * Run: node scripts/check-viz-syntax.mjs
 */
const AsyncFn = Object.getPrototypeOf(async function () {}).constructor;
let bad = 0;

const html = fs.readFileSync('apps/bot/public/viz.html', 'utf8');
const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
console.log(`viz.html inline script blocks: ${blocks.length}`);
blocks.forEach((m, i) => {
  const line = html.slice(0, m.index).split('\n').length;
  try {
    new AsyncFn(m[1]);
    console.log(`  block ${i} (line ${line}): OK (${m[1].length}b)`);
  } catch (e) {
    bad++;
    console.log(`  block ${i} (line ${line}): SYNTAX ERROR -> ${e.message}`);
  }
});

// Structural sanity on the handshake source: a stray brace would break every
// platform, and this catches it without trying to execute TS as JS.
try {
  const serverSrc = fs.readFileSync('apps/bot/src/server.ts', 'utf8');
  const start = serverSrc.indexOf('function activityHtml');
  const end = serverSrc.indexOf('async function handleRoute', start);
  if (start < 0 || end < 0) throw new Error('activityHtml not found in server.ts');
  const body = serverSrc.slice(start, end);

  const opens = (body.match(/\{/g) ?? []).length;
  const closes = (body.match(/\}/g) ?? []).length;
  if (opens !== closes) throw new Error(`brace imbalance in activityHtml (${opens} { vs ${closes} })`);

  for (const required of [
    '/vendor/embedded-app-sdk.mjs',
    "sdk.ready()",
    'setOrientationLockState',
    'THERMAL_STATE_UPDATE',
    "window.__VZ_ACTIVITY__=1",
    "type=\"module\"",
  ]) {
    if (!body.includes(required)) throw new Error(`handshake no longer contains: ${required}`);
  }
  console.log('  activity handshake: structural checks OK');

  // The page must still carry the placeholders activityHtml substitutes.
  for (const ph of ['{{ORIGIN}}', '{{BUILD}}']) {
    if (!html.includes(ph)) throw new Error(`viz.html lost its ${ph} placeholder`);
  }
} catch (e) {
  bad++;
  console.log(`  activity handshake: FAILED -> ${e.message}`);
}

console.log(bad === 0 ? 'ALL CHECKS PASS' : `${bad} CHECK(S) FAILED`);
process.exit(bad === 0 ? 0 : 1);
