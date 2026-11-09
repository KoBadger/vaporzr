import crypto from 'node:crypto';

/**
 * Timing-safe string equality. `crypto.timingSafeEqual` requires equal-length
 * buffers and leaks length via its throw, so hash both sides to a fixed-size
 * digest first. Used for the shared access key (SHARE_KEY) so a remote caller
 * cannot recover it byte-by-byte from response timing.
 */
export function secretEquals(a: string | undefined | null, b: string | undefined | null): boolean {
  if (!a || !b) return false;
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * Verify the owner's human-memorable master password with a memory-hard KDF.
 * A plain SHA-256 comparison is timing-safe but cheap enough to brute-force
 * offline if a digest ever leaks; scrypt is the correct primitive for a
 * low-entropy password (and satisfies CodeQL's password-hashing rule).
 */
const MASTER_SALT = 'vaporzr-master-password-v1';
let cachedMaster: { password: string; digest: Buffer } | null = null;

export function masterPasswordEquals(value: string | undefined | null, expected: string | undefined | null): boolean {
  if (!value || !expected) return false;
  if (!cachedMaster || cachedMaster.password !== expected) {
    cachedMaster = { password: expected, digest: crypto.scryptSync(expected, MASTER_SALT, 32) };
  }
  const actual = crypto.scryptSync(value, MASTER_SALT, 32);
  return crypto.timingSafeEqual(actual, cachedMaster.digest);
}

/** Read the `vz_key` cookie value out of a raw Cookie header. */
export function keyFromCookieHeader(cookie: string | undefined | null): string | undefined {
  if (!cookie) return undefined;
  const m = /(?:^|;\s*)vz_key=([^;]+)/.exec(cookie);
  if (!m) return undefined;
  const raw = m[1];
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw; // malformed encoding — compare raw
  }
}

/** Read the `key` query parameter out of a request URL (path + query). */
export function keyFromRequestUrl(requestUrl: string | undefined | null): string | undefined {
  if (!requestUrl) return undefined;
  try {
    // Parse against a dummy origin so a bare `/ws?key=...` works.
    return new URL(requestUrl, 'http://localhost').searchParams.get('key') ?? undefined;
  } catch {
    return undefined; // malformed URL — treat as keyless
  }
}

/**
 * Does a WebSocket upgrade request carry the shared key? The cookie is
 * `HttpOnly`, so a panel opened from a bare URL (fresh profile, private window,
 * cleared storage) has no cookie and cannot read one to send back — the `?key=`
 * query parameter is the only route such a client has to re-authenticate.
 * Accept either, timing-safely.
 */
export function socketHasShareKey(
  requestUrl: string | undefined | null,
  cookieHeader: string | undefined | null,
  shareKey: string | undefined | null,
): boolean {
  if (!shareKey) return true; // unset key ⇒ open access (matches HTTP behaviour)
  return (
    secretEquals(keyFromCookieHeader(cookieHeader), shareKey) || secretEquals(keyFromRequestUrl(requestUrl), shareKey)
  );
}
