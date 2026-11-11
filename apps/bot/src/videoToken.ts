import crypto from 'node:crypto';
import { config } from '@vaporzr/core/config';

/**
 * Short-lived grants for `/api/video/<id>`.
 *
 * That route cannot authenticate with a cookie: it is loaded by the Discord
 * Activity iframe, which has none. So instead of a session it takes a token
 * bound to one video id and a deadline, minted server-side and delivered with
 * the playback state the Activity already receives.
 *
 * The allowlist in `videoAllowList()` still works, and remains the fallback when
 * no secret is configured — a deployment without `SHARE_KEY`/`MASTER_PASSWORD`
 * keeps serving video exactly as before.
 */

/** An hour is longer than any track, so a token minted for a handoff survives it. */
const TTL_MS = 60 * 60 * 1000;

function secret(): string {
  return config.shareKey || config.masterPassword || '';
}

function sign(id: string, expiresAt: number, key: string): string {
  return crypto.createHmac('sha256', key).update(`${id}.${expiresAt}`).digest('base64url');
}

/** `null` when there is no secret: callers then leave the state field absent. */
export function mintVideoToken(id: string, now = Date.now()): string | null {
  const key = secret();
  if (!key || !id) return null;
  const expiresAt = now + TTL_MS;
  return `${expiresAt}.${sign(id, expiresAt, key)}`;
}

/** True only for this id, before the deadline, with an untampered signature. */
export function verifyVideoToken(id: string, token: string | null | undefined, now = Date.now()): boolean {
  const key = secret();
  if (!key || !id || !token) return false;
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const expiresAt = Number(token.slice(0, dot));
  const mac = token.slice(dot + 1);
  if (!Number.isFinite(expiresAt) || now > expiresAt) return false;
  const want = sign(id, expiresAt, key);
  // Lengths differ for a truncated signature; compare buffers of equal size only.
  if (mac.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want));
}
