import type { IncomingMessage } from 'node:http';

/** Loopback, including the IPv4-mapped IPv6 form Node reports on some hosts. */
const LOOPBACK = /^(127\.|::1$|::ffff:127\.)/;

function firstHeaderIp(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = (raw ?? '').trim();
  if (!trimmed || trimmed.length > 45) return null;
  // Accept only address-shaped values. Nothing here is ever parsed as a host,
  // and a header that is not an address is ignored rather than trusted.
  return /^[0-9a-fA-F:.]+$/.test(trimmed) ? trimmed.toLowerCase() : null;
}

/**
 * The client's address, accounting for the Cloudflare tunnel.
 *
 * The bot sits behind a local `cloudflared` connector, so EVERY request arrives
 * from loopback. Throttles keyed on `socket.remoteAddress` therefore collapsed
 * into one shared bucket: a jam guest could burn the ten failed logins and lock
 * the owner out of the panel for a minute, repeatedly.
 *
 * Forwarded headers are trusted ONLY when the socket itself is loopback. A
 * connection from a real remote address keeps its own socket address, so it
 * cannot spoof its way into — or out of — someone else's bucket.
 */
export function clientIp(req: IncomingMessage): string {
  const socket = req.socket.remoteAddress ?? 'unknown';
  if (!LOOPBACK.test(socket)) return socket;
  const cf = firstHeaderIp(req.headers['cf-connecting-ip']);
  if (cf) return cf;
  const xff = firstHeaderIp(String(req.headers['x-forwarded-for'] ?? '').split(',')[0]);
  if (xff) return xff;
  return socket;
}

/** True when `ip` is one of the addresses a loopback connector proxies for. */
export function isLoopbackAddress(ip: string | undefined): boolean {
  return !!ip && LOOPBACK.test(ip);
}
