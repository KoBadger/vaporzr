import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '@vaporzr/core/config';
import {
  authThrottle,
  clearAuthFailures,
  consumeInvite,
  describeUserAgent,
  listAccess,
  maskIp,
  mintInvite,
  mintSession,
  noteAuthFailure,
  resetAccessForTests,
  resolveSession,
  revokeAll,
  revokeSession,
  revokeSessionByToken,
  scopeSatisfies,
  setAccessStorePathForTests,
  tokenFromCookieHeader,
  webAccessAllowed,
} from '../access.js';

const dir = mkdtempSync(join(tmpdir(), 'vaporzr-access-'));
let seq = 0;

beforeEach(() => {
  seq += 1;
  setAccessStorePathForTests(join(dir, `access-${seq}.json`));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('session tokens', () => {
  it('mints a session that resolves with its scope', () => {
    const { token, session } = mintSession('control', 'owner link');
    expect(token.length).toBeGreaterThan(30);
    expect(session.scope).toBe('control');
    expect(session.id).toMatch(/^[0-9a-f]{8}$/);
    expect(resolveSession(token)?.scope).toBe('control');
  });

  it('stores only a hash of the token on disk', () => {
    const { token, session } = mintSession('view', 'phone');
    const raw = readFileSync(join(dir, `access-${seq}.json`), 'utf8');
    expect(raw).not.toContain(token);
    expect(raw).toContain(session.id);
    expect(raw).toMatch(/tokenHash/);
  });

  it('survives a process restart (cache reset)', () => {
    const { token } = mintSession('view', 'tablet');
    resetAccessForTests();
    expect(resolveSession(token)?.label).toBe('tablet');
  });

  it('rejects unknown and expired sessions', () => {
    expect(resolveSession('nope')).toBeNull();
    const now = 1_000_000;
    const { token } = mintSession('view', 'short', 1_000, now);
    expect(resolveSession(token, now + 500)?.scope).toBe('view');
    expect(resolveSession(token, now + 1_500)).toBeNull();
  });

  it('revokes one session by id, and all of them', () => {
    const a = mintSession('view', 'a');
    const b = mintSession('view', 'b');
    expect(revokeSession(a.session.id)).toBe(true);
    expect(resolveSession(a.token)).toBeNull();
    expect(resolveSession(b.token)?.label).toBe('b');
    expect(revokeSession('deadbeef')).toBe(false);
    const counts = revokeAll();
    expect(counts.sessions).toBeGreaterThanOrEqual(1);
    expect(resolveSession(b.token)).toBeNull();
  });
});

describe('invites', () => {
  it('is single use and carries its scope', () => {
    const { token, invite } = mintInvite('view', 'jam guest');
    expect(invite.scope).toBe('view');
    const first = consumeInvite(token);
    expect(first?.session.scope).toBe('view');
    expect(resolveSession(first!.token)?.label).toBe('jam guest');
    expect(consumeInvite(token)).toBeNull();
  });

  it('rejects expired invites and removes them', () => {
    const now = 5_000_000;
    const { token } = mintInvite('control', 'late', 1_000, now);
    expect(consumeInvite(token, now + 2_000)).toBeNull();
    expect(listAccess(now + 2_000).invites).toHaveLength(0);
  });

  it('lists sessions and invites without hashes', () => {
    mintSession('view', 'one');
    mintInvite('control', 'two');
    const list = listAccess();
    expect(list.sessions[0]).not.toHaveProperty('tokenHash');
    expect(list.invites[0]).not.toHaveProperty('tokenHash');
  });
});

describe('scopes', () => {
  it('control satisfies both, view satisfies only view', () => {
    expect(scopeSatisfies('control', 'control')).toBe(true);
    expect(scopeSatisfies('control', 'view')).toBe(true);
    expect(scopeSatisfies('view', 'view')).toBe(true);
    expect(scopeSatisfies('view', 'control')).toBe(false);
  });
});

describe('auth throttle', () => {
  it('allows ten failures then blocks for the rest of the minute', () => {
    const ip = '10.0.0.9';
    clearAuthFailures(ip);
    for (let i = 0; i < 10; i++) {
      expect(authThrottle(ip, 1_000).allowed).toBe(true);
      noteAuthFailure(ip, 1_000);
    }
    const blocked = authThrottle(ip, 1_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
    expect(authThrottle(ip, 62_000).allowed).toBe(true);
  });

  it('is per address', () => {
    clearAuthFailures('a');
    clearAuthFailures('b');
    for (let i = 0; i < 10; i++) noteAuthFailure('a', 2_000);
    expect(authThrottle('a', 2_000).allowed).toBe(false);
    expect(authThrottle('b', 2_000).allowed).toBe(true);
  });
});

describe('cookie parsing', () => {
  it('finds vz_sess among other cookies', () => {
    expect(tokenFromCookieHeader('a=1; vz_sess=tok123; b=2')).toBe('tok123');
    expect(tokenFromCookieHeader('vz_sess=tok%2Bval')).toBe('tok+val');
    expect(tokenFromCookieHeader('nvz_sess=no')).toBeUndefined();
    expect(tokenFromCookieHeader(undefined)).toBeUndefined();
  });
});

describe('invite reusability (jam cards)', () => {
  it('a reusable invite keeps working until it expires', () => {
    const now = 2_000_000;
    const { token, invite } = mintInvite('request', 'jam card', 6 * 60 * 60 * 1000, now, 0);
    expect(invite.maxUses).toBe(0);
    expect(consumeInvite(token, now + 1_000)?.session.scope).toBe('request');
    expect(consumeInvite(token, now + 2_000)?.session.scope).toBe('request');
    expect(listAccess(now + 2_000).invites).toHaveLength(1);
    expect(consumeInvite(token, now + 7 * 60 * 60 * 1000)).toBeNull();
  });

  it('counts uses for single-use invites', () => {
    const { token } = mintInvite('view', 'one', 60_000, 5_000, 1);
    expect(consumeInvite(token, 6_000)).not.toBeNull();
    expect(listAccess(6_000).invites).toHaveLength(0);
  });
});

describe('revoke by token', () => {
  it('kills the session behind a cookie value', () => {
    const { token } = mintSession('control', 'panel');
    expect(revokeSessionByToken(token)).toBe(true);
    expect(resolveSession(token)).toBeNull();
    expect(revokeSessionByToken('unknown')).toBe(false);
    expect(revokeSessionByToken(undefined)).toBe(false);
  });
});

describe('audit helpers', () => {
  it('masks addresses before storing them', () => {
    expect(maskIp('203.0.113.77')).toBe('203.0.113.x');
    expect(maskIp('::ffff:198.51.100.9')).toBe('198.51.100.x');
    expect(maskIp('2001:db8:1234:5678::1')).toBe('2001:db8:...');
    expect(maskIp(undefined)).toBeUndefined();
  });

  it('summarises user agents defensively', () => {
    expect(describeUserAgent('Mozilla/5.0 (Windows NT 10.0) Chrome/140.0 Safari/537.36')).toBe('Chrome on Windows');
    expect(describeUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Safari/604.1')).toBe('Safari on iOS');
    expect(describeUserAgent('curl/8.7.1')).toBe('curl on unknown');
    expect(describeUserAgent(undefined)).toBe('unknown');
  });

  it('records last seen metadata on resolve', () => {
    const now = 9_000_000;
    const { token } = mintSession('view', 'phone', 60_000, now);
    const seen = resolveSession(token, now + 1_000, {
      userAgent: 'Mozilla/5.0 (Linux; Android 15) Chrome/140',
      ip: '100.101.102.103',
    });
    expect(seen?.lastIp).toBe('100.101.102.x');
    expect(seen?.lastUserAgent).toContain('Chrome');
    expect(seen?.lastSeenAt).toBe(now + 1_000);
  });
});

describe('scope ordering with song requests', () => {
  it('request < view < control', () => {
    expect(scopeSatisfies('control', 'request')).toBe(true);
    expect(scopeSatisfies('view', 'request')).toBe(true);
    expect(scopeSatisfies('request', 'view')).toBe(false);
    expect(scopeSatisfies('request', 'control')).toBe(false);
    expect(scopeSatisfies('view', 'control')).toBe(false);
  });
});

describe('tailnet-only access', () => {
  const original = config.webAccess;
  afterAll(() => {
    config.webAccess = original;
  });

  it('is off by default for any host', () => {
    config.webAccess = 'public';
    expect(webAccessAllowed('vaporzr.duckdns.org')).toBe(true);
  });

  it('allows loopback, CGNAT and MagicDNS names only', () => {
    config.webAccess = 'tailnet';
    expect(webAccessAllowed('localhost:4876')).toBe(true);
    expect(webAccessAllowed('127.0.0.1:4876')).toBe(true);
    expect(webAccessAllowed('100.108.250.70')).toBe(true);
    expect(webAccessAllowed('vaporzr-bot.tail137f17.ts.net')).toBe(true);
    expect(webAccessAllowed('vaporzr.duckdns.org')).toBe(false);
    expect(webAccessAllowed('8.8.8.8')).toBe(false);
    expect(webAccessAllowed(undefined)).toBe(false);
  });
});
