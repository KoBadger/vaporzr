import dns from 'node:dns';
import type { Agent } from 'undici';

/**
 * Network guards for user-supplied media URLs.
 *
 * `/play` accepts arbitrary http(s) links and the bot then fetches them from
 * its own machine. Without validation that is a server-side request forgery
 * (SSRF) primitive: a link pointing at localhost, a LAN address, or the cloud
 * metadata service would be fetched with the bot's network position. These
 * helpers are shared by the play resolver (apps/bot discord.ts), the streaming
 * fetch (apps/bot voice.ts) and `/mix` downloads (mediaDownload.ts) so the
 * initial URL, every redirect hop, AND the resolved IP are checked before a
 * request goes out.
 */

/** Thrown when a URL is refused for policy reasons: private host, unsupported
 *  protocol, or a redirect loop. */
export class BlockedFetchError extends Error {}

/** True when a hostname (or resolved IP) names a machine only the bot itself
 *  can reach: loopback, private LAN, link-local (incl. cloud metadata), CGNAT,
 *  loopback/unique-local/link-local IPv6, and the common internal TLDs.
 *  WHATWG URL parsing normalizes legacy IPv4 forms (decimal/octal/hex) to
 *  dotted-quad and brackets IPv6, so the checks below see canonical text. */
export function isBlockedFetchHost(hostname: string): boolean {
  const host = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return true;
  }
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 0 || a === 10 || a === 127) return true; // this-network / private / loopback
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
    if (a === 169 && b === 254) return true; // link-local (169.254.169.254 = cloud metadata)
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a >= 224) return true; // multicast + reserved
    return false;
  }
  if (host === '::' || host === '::1') return true;
  if (host.startsWith('::ffff:')) return true; // IPv4-mapped literals (URL-normalized form)
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true; // fc00::/7 unique-local
  if (/^fe[89ab][0-9a-f]:/.test(host)) return true; // fe80::/10 link-local
  return false;
}

/** Keep only the resolved addresses that are safe to connect to.
 *
 *  A hostname check alone loses to DNS rebinding: the attacker's name answers
 *  with a public IP for our validation lookup, then a private one for the real
 *  connect. The guarded connector resolves ONCE, filters through here, and pins
 *  the validated address — so the check and the connection use the same DNS
 *  answer. */
export function filterPublicAddresses<T extends { address: string }>(records: readonly T[]): T[] {
  return records.filter((r) => !isBlockedFetchHost(r.address));
}

/** DNS lookup for the guarded connector: resolve, drop private answers, and
 *  hand the surviving addresses to undici to pin. */
function guardedLookup(
  hostname: string,
  options: dns.LookupOptions,
  callback: (err: Error | null, address?: string | dns.LookupAddress[], family?: number) => void,
): void {
  dns.lookup(hostname, { family: options?.family ?? 0, all: true }, (err, records) => {
    if (err) {
      callback(err);
      return;
    }
    const safe = filterPublicAddresses(records);
    if (safe.length === 0) {
      callback(new BlockedFetchError(`Refusing to connect to a private address (${hostname}).`));
      return;
    }
    if (options?.all) callback(null, safe);
    else callback(null, safe[0].address, safe[0].family);
  });
}

/** Lazily built (undici is a heavy import) shared connector. */
let guardedAgent: Promise<Agent> | null = null;

function guardedDispatcher(): Promise<Agent> {
  guardedAgent ??= (async () => {
    const { Agent } = await import('undici');
    return new Agent({ connect: { lookup: guardedLookup as never } });
  })();
  return guardedAgent;
}

/**
 * fetch() that validates the request URL — and every redirect hop — before a
 * request goes out, then pins the connection to a DNS answer that also passed
 * the private-address check. Redirects are followed manually so a public URL
 * cannot bounce the bot into an internal service. The caller's init (method,
 * headers, signal) is preserved on every hop; `redirect` is forced to 'manual'.
 */
export async function safeFetch(rawUrl: string, init: RequestInit = {}, maxHops = 5): Promise<Response> {
  let current = rawUrl;
  for (let hop = 0; hop <= maxHops; hop++) {
    let u: URL;
    try {
      u = new URL(current);
    } catch {
      throw new BlockedFetchError('That media URL is not a valid link.');
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw new BlockedFetchError(`Refusing to fetch a ${u.protocol} URL.`);
    }
    if (isBlockedFetchHost(u.hostname)) {
      throw new BlockedFetchError(`Refusing to fetch a private address (${u.hostname}).`);
    }
    let res: Response;
    try {
      res = await fetch(current, {
        ...init,
        redirect: 'manual',
        // The guarded dispatcher re-checks the DNS answer at connect time.
        dispatcher: await guardedDispatcher(),
      } as RequestInit & { dispatcher: unknown });
    } catch (err) {
      // A refusal raised inside the connector arrives wrapped in a fetch error.
      const cause = (err as { cause?: unknown } | null)?.cause;
      if (cause instanceof BlockedFetchError) throw cause;
      throw err;
    }
    if (res.status < 300 || res.status >= 400) return res;
    const loc = res.headers.get('location');
    try {
      await res.body?.cancel();
    } catch {
      /* ignore */
    }
    if (!loc) return res;
    current = new URL(loc, current).toString();
  }
  throw new BlockedFetchError('Too many redirects — check the link.');
}
