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
