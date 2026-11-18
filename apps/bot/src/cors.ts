/**
 * CORS for the control server.
 *
 * The server used to answer every response with `Access-Control-Allow-Origin:
 * *`. That let any page on the internet read whatever a same-origin request
 * could — harmless for public JSON, wrong for the panel endpoints, and it also
 * made the access log look the same for our own pages and for a stranger's.
 *
 * Same-origin requests carry no `Origin` header and need no allowance. The cases
 * that do need one are explicit: the configured public bases, a loopback dev
 * origin, and `null` (the Electron visualizer loads over `file://`, and a null
 * origin cannot carry cookies anyway).
 */

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** The origin to echo back, or null when the request gets no CORS grant. */
export function allowedOrigin(
  origin: string | undefined,
  bases: Array<string | undefined | null>,
  opts: { allowNull?: boolean } = {},
): string | null {
  if (!origin) return null; // same-origin: the browser does not need a header
  if (origin === 'null') return opts.allowNull === false ? null : 'null';

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return null;
  }

  const allowed = new Set<string>();
  for (const base of bases) {
    if (!base) continue;
    try {
      allowed.add(new URL(base).origin);
    } catch {
      /* a malformed configured base grants nothing */
    }
  }
  if (allowed.has(parsed.origin)) return parsed.origin;
  if (LOOPBACK_HOSTS.has(parsed.hostname)) return parsed.origin;
  return null;
}
