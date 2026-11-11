import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '@vaporzr/core/config';
import { mintVideoToken, verifyVideoToken } from '../videoToken.js';

/**
 * The video route is credential-free by necessity (the Activity iframe carries
 * no cookie), so the token IS the credential. These pin the three ways it can
 * be abused: replay after expiry, reuse on another id, and a mutated signature.
 */
describe('video tokens', () => {
  const original = { share: config.shareKey, master: config.masterPassword };

  beforeAll(() => {
    config.shareKey = 'share-secret';
    config.masterPassword = '';
  });

  afterAll(() => {
    config.shareKey = original.share;
    config.masterPassword = original.master;
  });

  it('accepts a token for the id it was minted for', () => {
    const token = mintVideoToken('dQw4w9WgXcQ', 1_000_000);
    expect(token).toBeTruthy();
    expect(verifyVideoToken('dQw4w9WgXcQ', token, 1_000_001)).toBe(true);
  });

  it('rejects the same token on a different id', () => {
    const token = mintVideoToken('dQw4w9WgXcQ', 1_000_000);
    expect(verifyVideoToken('aaaaaaaaaaa', token, 1_000_001)).toBe(false);
  });

  it('expires an hour after minting', () => {
    const now = 1_000_000;
    const token = mintVideoToken('dQw4w9WgXcQ', now)!;
    const expiresAt = Number(token.slice(0, token.indexOf('.')));
    expect(verifyVideoToken('dQw4w9WgXcQ', token, expiresAt)).toBe(true);
    expect(verifyVideoToken('dQw4w9WgXcQ', token, expiresAt + 1)).toBe(false);
  });

  it('rejects a tampered signature, a truncated one and garbage', () => {
    const token = mintVideoToken('dQw4w9WgXcQ', 1_000_000)!;
    const [exp, mac] = token.split('.');
    const flipped = mac[0] === 'A' ? 'B' : 'A';
    expect(verifyVideoToken('dQw4w9WgXcQ', `${exp}.${flipped}${mac.slice(1)}`, 1_000_001)).toBe(false);
    expect(verifyVideoToken('dQw4w9WgXcQ', `${exp}.${mac.slice(0, -2)}`, 1_000_001)).toBe(false);
    expect(verifyVideoToken('dQw4w9WgXcQ', 'nonsense', 1_000_001)).toBe(false);
    expect(verifyVideoToken('dQw4w9WgXcQ', '.', 1_000_001)).toBe(false);
    expect(verifyVideoToken('dQw4w9WgXcQ', null, 1_000_001)).toBe(false);
    expect(verifyVideoToken('dQw4w9WgXcQ', '', 1_000_001)).toBe(false);
  });

  it('refuses a token signed with a different secret', () => {
    const token = mintVideoToken('dQw4w9WgXcQ', 1_000_000)!;
    config.shareKey = 'rotated';
    expect(verifyVideoToken('dQw4w9WgXcQ', token, 1_000_001)).toBe(false);
    config.shareKey = 'share-secret';
    expect(verifyVideoToken('dQw4w9WgXcQ', token, 1_000_001)).toBe(true);
  });

  it('mints nothing when no secret is configured', () => {
    config.shareKey = '';
    config.masterPassword = '';
    expect(mintVideoToken('dQw4w9WgXcQ')).toBeNull();
    // ...and accepts nothing either, which is why the allowlist fallback exists.
    expect(verifyVideoToken('dQw4w9WgXcQ', 'anything.anything')).toBe(false);
  });

  it('uses MASTER_PASSWORD when no share key is set', () => {
    config.shareKey = '';
    config.masterPassword = 'master-secret';
    const token = mintVideoToken('dQw4w9WgXcQ', 1_000_000);
    expect(verifyVideoToken('dQw4w9WgXcQ', token, 1_000_001)).toBe(true);
    config.shareKey = 'share-secret';
    config.masterPassword = '';
  });
});
