import { describe, expect, it } from 'vitest';
import { secretEquals, keyFromCookieHeader, keyFromRequestUrl, socketHasShareKey } from '../secretCompare.js';

describe('secretEquals', () => {
  it('accepts matching values', () => {
    expect(secretEquals('s3cret-key', 's3cret-key')).toBe(true);
  });

  it('rejects differing values, including different lengths', () => {
    expect(secretEquals('s3cret-key', 's3cret-ke')).toBe(false);
    expect(secretEquals('s3cret-key', 'other-value')).toBe(false);
  });

  it('rejects empty or missing values (never treats blank as a match)', () => {
    expect(secretEquals('', '')).toBe(false);
    expect(secretEquals(undefined, 'x')).toBe(false);
    expect(secretEquals('x', undefined)).toBe(false);
    expect(secretEquals(null, null)).toBe(false);
  });
});

describe('keyFromCookieHeader', () => {
  it('extracts vz_key among other cookies', () => {
    expect(keyFromCookieHeader('a=1; vz_key=abc123; b=2')).toBe('abc123');
  });

  it('extracts a leading or sole vz_key', () => {
    expect(keyFromCookieHeader('vz_key=abc123')).toBe('abc123');
    expect(keyFromCookieHeader('vz_key=abc123; other=x')).toBe('abc123');
  });

  it('decodes percent-encoding', () => {
    expect(keyFromCookieHeader('vz_key=a%20b%2Bc')).toBe('a b+c');
  });

  it('falls back to the raw value when encoding is malformed', () => {
    expect(keyFromCookieHeader('vz_key=100%')).toBe('100%');
  });

  it('returns undefined when absent or empty', () => {
    expect(keyFromCookieHeader('other=1')).toBeUndefined();
    expect(keyFromCookieHeader('')).toBeUndefined();
    expect(keyFromCookieHeader(undefined)).toBeUndefined();
  });

  it('does not match a lookalike cookie name', () => {
    expect(keyFromCookieHeader('xvz_key=nope')).toBeUndefined();
  });
});

describe('keyFromRequestUrl', () => {
  it('reads ?key= from a bare socket path', () => {
    expect(keyFromRequestUrl('/ws?key=abc123')).toBe('abc123');
  });

  it('reads ?key= alongside other params', () => {
    expect(keyFromRequestUrl('/ws?port=4876&key=abc123')).toBe('abc123');
  });

  it('returns undefined without a key', () => {
    expect(keyFromRequestUrl('/ws')).toBeUndefined();
    expect(keyFromRequestUrl('/ws?port=4876')).toBeUndefined();
    expect(keyFromRequestUrl(undefined)).toBeUndefined();
  });
});

describe('socketHasShareKey', () => {
  const KEY = 's3cret-key';

  it('accepts the cookie alone', () => {
    expect(socketHasShareKey('/ws', `vz_key=${KEY}`, KEY)).toBe(true);
  });

  it('accepts the query param alone (the HttpOnly-cookie recovery path)', () => {
    expect(socketHasShareKey(`/ws?key=${KEY}`, undefined, KEY)).toBe(true);
    expect(socketHasShareKey(`/ws?key=${KEY}`, 'lang=en', KEY)).toBe(true);
  });

  it('accepts the query param when a stale cookie is also present', () => {
    expect(socketHasShareKey(`/ws?key=${KEY}`, 'vz_key=stale', KEY)).toBe(true);
  });

  it('rejects a wrong key in either place', () => {
    expect(socketHasShareKey('/ws?key=wrong', 'vz_key=wrong', KEY)).toBe(false);
    expect(socketHasShareKey('/ws?key=wrong', `vz_key=${KEY}`, KEY)).toBe(true);
  });

  it('rejects a keyless connection', () => {
    expect(socketHasShareKey('/ws', undefined, KEY)).toBe(false);
    expect(socketHasShareKey('/ws?port=1', 'other=1', KEY)).toBe(false);
  });

  it('rejects a near-miss of the key', () => {
    expect(socketHasShareKey(`/ws?key=${KEY}x`, undefined, KEY)).toBe(false);
    expect(socketHasShareKey(`/ws?key=${KEY.slice(0, -1)}`, undefined, KEY)).toBe(false);
  });

  it('does not let an unrelated param carry the key', () => {
    expect(socketHasShareKey(`/ws?notkey=${KEY}`, undefined, KEY)).toBe(false);
  });

  it('treats an unset share key as open access', () => {
    expect(socketHasShareKey('/ws', undefined, undefined)).toBe(true);
    expect(socketHasShareKey('/ws', undefined, '')).toBe(true);
  });
});
