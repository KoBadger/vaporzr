import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { V_ALIASES, V_DISPATCH_ALIASES } from '../aliases.js';

/** Every `case '…':` label in the dispatcher sources (hyphens included, so
 *  `case 'cookie-refresh':` counts). */
function dispatcherCases(): Set<string> {
  const src = fs.readFileSync(new URL('../discord.ts', import.meta.url), 'utf8');
  return new Set([...src.matchAll(/case '([A-Za-z0-9_-]+)':/g)].map((m) => m[1]));
}

describe('V@ alias routing', () => {
  const cases = dispatcherCases();

  it('every shortcut resolves to a dispatcher case, directly or via a dispatch alias', () => {
    // An alias that resolves to no case only shared a cooldown bucket with the
    // real command and answered "Unknown command" — the regression this guards.
    const broken = Object.keys(V_ALIASES).filter((key) => !cases.has(V_DISPATCH_ALIASES[key] ?? key));
    expect(broken).toEqual([]);
  });

  it('every dispatch alias targets a real case', () => {
    const broken = Object.entries(V_DISPATCH_ALIASES).filter(([, target]) => !cases.has(target));
    expect(broken.map(([key]) => key)).toEqual([]);
  });

  it('keeps the jam card reachable as both V@jam and V@share', () => {
    expect(V_ALIASES.jam).toBe('jam');
    expect(V_ALIASES.share).toBe('jam');
    expect(V_DISPATCH_ALIASES.share).toBe('jam');
  });
});
