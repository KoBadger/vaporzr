/**
 * Web access sessions and invites.
 *
 * The old model was one long-lived master key (SHARE_KEY) pasted into cookies
 * and into every shared link, so it could not be revoked per device, leaked
 * into chat history and QR codes, and could not express "view only" versus
 * "control".
 *
 * This module replaces that with short-lived, named credentials:
 *  - a SESSION is what a browser gets after a valid key/invite; the cookie holds
 *    an opaque token, only its SHA-256 is stored, and every session can be
 *    listed and revoked on its own;
 *  - an INVITE is a single-use, expiring link (`?invite=...`) that trades
 *    itself for a session on first use. Scope is `view` (watch/listen) or
 *    `control` (panel actions).
 *
 * The master SHARE_KEY stays as the owner's recovery key: it mints a `control`
 * session but is never stored on disk by this module.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '@vaporzr/core/config';

export type AccessScope = 'request' | 'view' | 'control';

export interface AccessSession {
  /** Short id shown by /key list, used by /key revoke. */
  id: string;
  label: string;
  scope: AccessScope;
  /** True for sessions minted from the master key (may recover the key back). */
  owner: boolean;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
  /** Audit trail (masked address, short user agent). */
  lastIp?: string;
  lastUserAgent?: string;
}

export interface AccessInvite {
  id: string;
  label: string;
  scope: AccessScope;
  createdAt: number;
  expiresAt: number;
  /** 0 = reusable until expiry (jam cards); 1 = single-use device link. */
  maxUses: number;
  uses: number;
}

interface StoredSession extends AccessSession {
  tokenHash: string;
}
interface StoredInvite extends AccessInvite {
  tokenHash: string;
}

interface StoreData {
  sessions: StoredSession[];
  invites: StoredInvite[];
}

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const INVITE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
export const OWNER_LINK_TTL_MS = 60 * 60 * 1000; // 1 hour

/** request < view < control. Higher scopes satisfy lower needs. */
const SCOPE_RANK: Record<AccessScope, number> = { request: 1, view: 2, control: 3 };

export function scopeSatisfies(have: AccessScope, need: AccessScope): boolean {
  return SCOPE_RANK[have] >= SCOPE_RANK[need];
}

const hashToken = (token: string): string => crypto.createHash('sha256').update(token).digest('hex');
const mintToken = (): string => crypto.randomBytes(32).toString('base64url');
const mintId = (): string => crypto.randomBytes(4).toString('hex');

let storePathOverride: string | null = null;
let cache: StoreData | null = null;

/** Tests point this at a throwaway file so they never touch the bot's data dir. */
export function setAccessStorePathForTests(file: string | null): void {
  storePathOverride = file;
  cache = null;
}

/** Forget the in-memory copy (tests). */
export function resetAccessForTests(): void {
  cache = null;
}

function storePath(): string {
  return storePathOverride ?? path.join(config.dataDir, 'access.json');
}

function prune(data: StoreData, now: number): void {
  data.sessions = data.sessions.filter((s) => s.expiresAt > now);
  data.invites = data.invites.filter((i) => i.expiresAt > now);
}

function load(now = Date.now()): StoreData {
  if (cache) {
    prune(cache, now);
    return cache;
  }
  let data: StoreData = { sessions: [], invites: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath(), 'utf8')) as Partial<StoreData>;
    data = {
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
      invites: Array.isArray(parsed.invites) ? parsed.invites : [],
    };
  } catch {
    /* missing or corrupt: start clean */
  }
  prune(data, now);
  cache = data;
  return data;
}

let lastSaveAt = 0;

function save(data: StoreData): void {
  const file = storePath();
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
    lastSaveAt = Date.now();
  } catch (err) {
    console.warn(`[access] could not persist sessions: ${err instanceof Error ? err.message : err}`);
  }
}

/** Mint a session; the raw token is returned once and never stored. */
export function mintSession(
  scope: AccessScope,
  label: string,
  ttlMs = SESSION_TTL_MS,
  now = Date.now(),
  owner = false,
): { token: string; session: AccessSession } {
  const data = load(now);
  const token = mintToken();
  const session: StoredSession = {
    id: mintId(),
    label: label.slice(0, 80),
    scope,
    owner,
    createdAt: now,
    expiresAt: now + ttlMs,
    lastSeenAt: now,
    tokenHash: hashToken(token),
  };
  data.sessions.push(session);
  save(data);
  const { tokenHash: _drop, ...visible } = session;
  return { token, session: visible };
}

/** Mint an invite link token. `maxUses` 0 means reusable until it expires. */
export function mintInvite(
  scope: AccessScope,
  label: string,
  ttlMs = INVITE_TTL_MS,
  now = Date.now(),
  maxUses = 1,
): { token: string; invite: AccessInvite } {
  const data = load(now);
  const token = mintToken();
  const invite: StoredInvite = {
    id: mintId(),
    label: label.slice(0, 80),
    scope,
    createdAt: now,
    expiresAt: now + ttlMs,
    maxUses,
    uses: 0,
    tokenHash: hashToken(token),
  };
  data.invites.push(invite);
  save(data);
  const { tokenHash: _drop, ...visible } = invite;
  return { token, invite: visible };
}

/** Trade an invite for a session. Returns null if unknown, expired or exhausted. */
export function consumeInvite(token: string, now = Date.now()): { token: string; session: AccessSession } | null {
  if (!token) return null;
  const data = load(now);
  const hash = hashToken(token);
  const idx = data.invites.findIndex((i) => i.tokenHash === hash);
  if (idx < 0) return null;
  const invite = data.invites[idx];
  if (invite.expiresAt <= now) {
    data.invites.splice(idx, 1);
    save(data);
    return null;
  }
  invite.uses += 1;
  // maxUses 0 = reusable until expiry (jam cards); otherwise burn when used up.
  if (invite.maxUses > 0 && invite.uses >= invite.maxUses) data.invites.splice(idx, 1);
  save(data);
  return mintSession(invite.scope, invite.label, SESSION_TTL_MS, now);
}

/** Mask an address for display: never store a full client IP. */
export function maskIp(ip: string | undefined): string | undefined {
  if (!ip) return undefined;
  let value = ip.trim();
  if (value.startsWith('::ffff:')) value = value.slice('::ffff:'.length);
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) {
    const parts = value.split('.');
    return `${parts[0]}.${parts[1]}.${parts[2]}.x`;
  }
  const groups = value.split(':');
  if (groups.length > 2) return `${groups.slice(0, 2).join(':')}:...`;
  return value.slice(0, 24);
}

/** "Chrome on Windows" style summary for /key list; defensive about junk UAs. */
export function describeUserAgent(ua: string | undefined): string {
  if (!ua) return 'unknown';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\//.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : /curl\//i.test(ua)
              ? 'curl'
              : 'other';
  const os = /Android/.test(ua)
    ? 'Android'
    : /iPhone|iPad|iPod/.test(ua)
      ? 'iOS'
      : /Windows/.test(ua)
        ? 'Windows'
        : /Mac OS X/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : 'unknown';
  return `${browser} on ${os}`;
}

export interface SessionTouch {
  userAgent?: string;
  ip?: string;
}

/** Resolve a session cookie token. Unknown/expired tokens return null. */
export function resolveSession(
  token: string | undefined | null,
  now = Date.now(),
  touch?: SessionTouch,
): AccessSession | null {
  if (!token) return null;
  const data = load(now);
  const hash = hashToken(token);
  const session = data.sessions.find((s) => s.tokenHash === hash);
  if (!session || session.expiresAt <= now) return null;
  session.lastSeenAt = now;
  if (touch?.userAgent) session.lastUserAgent = touch.userAgent.slice(0, 160);
  if (touch?.ip) session.lastIp = maskIp(touch.ip);
  // Persist at most every 15 s: the audit trail matters, a write per request does not.
  if (now - lastSaveAt > 15_000) save(data);
  const { tokenHash: _drop, ...visible } = session;
  return visible;
}

export function revokeSession(id: string): boolean {
  const data = load();
  const before = data.sessions.length;
  data.sessions = data.sessions.filter((s) => s.id !== id);
  if (data.sessions.length !== before) {
    save(data);
    return true;
  }
  return false;
}

/** Revoke everything: every device, every live invite. Rotation uses this. */
export function revokeAll(): { sessions: number; invites: number } {
  const data = load();
  const counts = { sessions: data.sessions.length, invites: data.invites.length };
  data.sessions = [];
  data.invites = [];
  save(data);
  return counts;
}

export function listAccess(now = Date.now()): { sessions: AccessSession[]; invites: AccessInvite[] } {
  const data = load(now);
  return {
    sessions: data.sessions.map(({ tokenHash: _drop, ...s }) => s),
    invites: data.invites.map(({ tokenHash: _drop, ...i }) => i),
  };
}

/** Revoke the session a cookie token belongs to (used by the panel's sign-out). */
export function revokeSessionByToken(token: string | undefined | null): boolean {
  if (!token) return false;
  const data = load();
  const hash = hashToken(token);
  const before = data.sessions.length;
  data.sessions = data.sessions.filter((s) => s.tokenHash !== hash);
  if (data.sessions.length !== before) {
    save(data);
    return true;
  }
  return false;
}

/**
 * Tailnet-only mode (`WEB_ACCESS=tailnet`): the public tunnel host is refused,
 * whatever the credential. Allowed hosts are loopback, the CGNAT tailnet range
 * and MagicDNS/PUBLIC hosts ending in .ts.net / .tailscale.com.
 */
export function webAccessAllowed(hostHeader: string | undefined): boolean {
  if (config.webAccess !== 'tailnet') return true;
  const raw = (hostHeader ?? '').trim().toLowerCase();
  if (!raw) return false;
  const host = raw.startsWith('[') ? raw.slice(1, raw.indexOf(']')) : raw.split(':')[0];
  if (!host) return false;
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
  if (host.endsWith('.ts.net') || host.endsWith('.tailscale.com')) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (host.startsWith('fd7a:115c:a1e0:')) return true;
  return false;
}

/* ------------------------------------------------------------------ */
/* Failed-attempt throttle: 10 tries per minute per client address.    */
/* ------------------------------------------------------------------ */

const FAIL_WINDOW_MS = 60_000;
const FAIL_LIMIT = 10;
const failures = new Map<string, { count: number; windowStart: number }>();

export function authThrottle(ip: string, now = Date.now()): { allowed: boolean; retryAfterMs: number } {
  const entry = failures.get(ip);
  if (!entry || now - entry.windowStart > FAIL_WINDOW_MS) return { allowed: true, retryAfterMs: 0 };
  if (entry.count < FAIL_LIMIT) return { allowed: true, retryAfterMs: 0 };
  return { allowed: false, retryAfterMs: Math.max(0, FAIL_WINDOW_MS - (now - entry.windowStart)) };
}

export function noteAuthFailure(ip: string, now = Date.now()): void {
  // Bound the map: a rotating IP could otherwise grow it without limit.
  if (failures.size > 5000 && !failures.has(ip)) failures.clear();
  const entry = failures.get(ip);
  if (!entry || now - entry.windowStart > FAIL_WINDOW_MS) {
    failures.set(ip, { count: 1, windowStart: now });
    return;
  }
  entry.count += 1;
}

export function clearAuthFailures(ip: string): void {
  failures.delete(ip);
}

/** Read the `vz_sess` cookie value out of a raw Cookie header. */
export function tokenFromCookieHeader(cookie: string | undefined | null): string | undefined {
  if (!cookie) return undefined;
  const m = /(?:^|;\s*)vz_sess=([^;]+)/.exec(cookie);
  if (!m) return undefined;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

export const SESSION_COOKIE = 'vz_sess';
