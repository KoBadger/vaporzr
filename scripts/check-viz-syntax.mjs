import fs from 'node:fs';
const html = fs.readFileSync('apps/bot/public/viz.html', 'utf8');
// The main inline IIFE is the last <script> block without a src.
const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
console.log(`inline script blocks: ${blocks.length}`);
let bad = 0;
blocks.forEach((m, i) => {
  const code = m[1];
  const line = html.slice(0, m.index).split('\n').length;
  try {
    new Function(code);
    console.log(`  block ${i} (starts line ${line}, ${code.length}b): OK`);
  } catch (e) {
    bad++;
    console.log(`  block ${i} (starts line ${line}): SYNTAX ERROR -> ${e.message}`);
  }
});
console.log(bad === 0 ? 'ALL INLINE SCRIPTS PARSE' : `${bad} BLOCK(S) FAILED`);
process.exit(bad === 0 ? 0 : 1);
