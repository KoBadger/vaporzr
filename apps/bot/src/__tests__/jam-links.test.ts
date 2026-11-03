import { rmSync } from 'node:fs';
import { afterAll, describe, expect, it, vi } from 'vitest';

// Short codes persist next to the invites in config.dataDir, so point DATA_DIR
// at a throwaway directory before ../jamLinks.js (and its config) loads.
vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMPDIR || '/tmp';
  process.env.DATA_DIR = `${base}/vaporzr-jam-links-test-${process.pid}`;
});

import { resolveJamCode } from '../jamLinks.js';

afterAll(() => {
  const dir = process.env.DATA_DIR;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('jam short codes', () => {
  it('mints six-character codes from an unambiguous alphabet', async () => {
    const { JAM_CODE_ALPHABET, JAM_CODE_LENGTH, codeFor } = await import('../jamLinks.js');
    expect(JAM_CODE_LENGTH).toBe(6);
    // The glyphs people misread at distance: no 0/O, no 1/I/L.
    expect(/[0OIL1]/.test(JAM_CODE_ALPHABET)).toBe(false);
    const code = codeFor('token-a', Date.now() + 60_000);
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
  });

  it('hands back the same code for the same live token', async () => {
    const { codeFor } = await import('../jamLinks.js');
    const now = Date.now();
    const one = codeFor('token-stable', now + 60_000, now);
    const two = codeFor('token-stable', now + 60_000, now);
    expect(two).toBe(one);
    expect(resolveJamCode(two)).toBe('token-stable');
  });

  it('gives different tokens different codes', async () => {
    const { codeFor } = await import('../jamLinks.js');
    const now = Date.now();
    const a = codeFor('token-x', now + 60_000, now);
    const b = codeFor('token-y', now + 60_000, now);
    expect(a).not.toBe(b);
  });

  it('resolves lowercase and whitespace input, rejects garbage', async () => {
    const { codeFor } = await import('../jamLinks.js');
    const now = Date.now();
    const code = codeFor('token-case', now + 60_000, now);
    expect(resolveJamCode(code.toLowerCase())).toBe('token-case');
    expect(resolveJamCode(`  ${code}  `)).toBe('token-case');
    expect(resolveJamCode('I0O11L')).toBeNull(); // wrong alphabet
    expect(resolveJamCode('TOOSHORT')).toBeNull(); // too long for the pattern
    expect(resolveJamCode('')).toBeNull();
    expect(resolveJamCode(null)).toBeNull();
    expect(resolveJamCode('ZZZZZZ')).toBeNull(); // nothing minted under that name
  });

  it('expires codes with their invites and lets the code be reused after', async () => {
    const { codeFor } = await import('../jamLinks.js');
    const now = Date.now();
    const code = codeFor('token-dead', now + 1_000, now);
    expect(resolveJamCode(code, now + 500)).toBe('token-dead');
    expect(resolveJamCode(code, now + 1_500)).toBeNull();

    // The freed code slot can be minted again for a new invite.
    const again = codeFor('token-fresh', now + 61_000, now + 2_000);
    expect(resolveJamCode(again, now + 2_000)).toBe('token-fresh');
  });

  it('survives a restart: codes are persisted next to the invites', async () => {
    const { codeFor } = await import('../jamLinks.js');
    const code = codeFor('token-across-boot', Date.now() + 3_600_000);
    expect(resolveJamCode(code)).toBe('token-across-boot');

    // Fresh module instance = a restarted process reading the same dataDir.
    vi.resetModules();
    const fresh = await import('../jamLinks.js');
    expect(fresh.resolveJamCode(code)).toBe('token-across-boot');
  });
});
