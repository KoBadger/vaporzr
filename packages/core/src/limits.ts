/**
 * Small primitives for the three failure modes that keep reappearing here:
 *
 *   1. a public request triggering unbounded work        → `burst`
 *   2. the same work started twice while the first runs  → `singleFlight`
 *   3. a cache that only ever grows                      → `TTLMap`
 *
 * They are deliberately tiny and dependency-free; the point is that adopting
 * one is cheaper than hand-rolling another `Map` with a `size > N && clear()`.
 */

/* ------------------------------------------------------------------ */
/* burst — per-key rate limit                                          */
/* ------------------------------------------------------------------ */

interface BurstEntry {
  count: number;
  windowStart: number;
}

const bursts = new Map<string, BurstEntry>();
/** Bound the key space: a rotating client address must not grow it forever. */
const BURST_MAX_KEYS = 5000;

/**
 * Count one hit against `key` and report whether it is allowed.
 *
 * Fixed window, because that is what every hand-rolled copy in this codebase
 * already does (pairing, the request gate, auth failures) and a sliding window
 * buys nothing at these limits.
 *
 * ```ts
 * if (!burst(`search:${ip}`, 30, 60_000)) return tooManyRequests(res);
 * ```
 */
export function burst(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
  if (bursts.size > BURST_MAX_KEYS && !bursts.has(key)) bursts.clear();
  const entry = bursts.get(key);
  if (!entry || now - entry.windowStart > windowMs) {
    bursts.set(key, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= limit) return false;
  entry.count += 1;
  return true;
}

/** Milliseconds until `key`'s window resets (0 when it is not throttled). */
export function burstRetryAfterMs(key: string, limit: number, windowMs: number, now = Date.now()): number {
  const entry = bursts.get(key);
  if (!entry || entry.count < limit) return 0;
  return Math.max(0, windowMs - (now - entry.windowStart));
}

/** Test/rotation helper. */
export function resetBursts(): void {
  bursts.clear();
}

/* ------------------------------------------------------------------ */
/* singleFlight — one in-flight promise per key                        */
/* ------------------------------------------------------------------ */

const flights = new Map<string, Promise<unknown>>();

/**
 * Run `fn` once for `key` while it is in flight; every concurrent caller gets
 * the same promise.
 *
 * This is the fix for refresh-token races: two guild sessions noticing an
 * expired token at the same moment used to refresh with the same refresh token,
 * and Spotify can rotate it — so one of the two wrote a dead credential back.
 * The flight is removed as soon as it settles, so a failure can be retried.
 */
export function singleFlight<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = flights.get(key);
  if (existing) return existing as Promise<T>;
  const promise = Promise.resolve()
    .then(fn)
    .finally(() => {
      if (flights.get(key) === promise) flights.delete(key);
    });
  flights.set(key, promise as Promise<unknown>);
  return promise;
}

/** How many flights are in progress (diagnostics / tests). */
export function singleFlightCount(): number {
  return flights.size;
}

/* ------------------------------------------------------------------ */
/* TTLMap — bounded, expiring Map                                      */
/* ------------------------------------------------------------------ */

/**
 * A `Map` with a maximum size and an optional per-entry TTL.
 *
 * Insertion order doubles as age order, so eviction is oldest-first and costs
 * nothing extra. Use it for anything keyed by video id, user id or request URL.
 */
export class TTLMap<K, V> {
  private readonly data = new Map<K, { value: V; at: number }>();

  constructor(
    private readonly max: number,
    private readonly ttlMs = 0,
  ) {
    if (max < 1) throw new Error('TTLMap max must be at least 1');
  }

  get size(): number {
    return this.data.size;
  }

  /** The live value, or undefined when missing/expired. */
  get(key: K, now = Date.now()): V | undefined {
    const entry = this.data.get(key);
    if (!entry) return undefined;
    if (this.ttlMs > 0 && now - entry.at >= this.ttlMs) {
      this.data.delete(key);
      return undefined;
    }
    return entry.value;
  }

  /** True when a live value exists (does not return it). */
  has(key: K, now = Date.now()): boolean {
    return this.get(key, now) !== undefined;
  }

  set(key: K, value: V, now = Date.now()): void {
    // Re-inserting moves the entry to the newest position.
    this.data.delete(key);
    this.data.set(key, { value, at: now });
    while (this.data.size > this.max) {
      const oldest = this.data.keys().next();
      if (oldest.done) break;
      this.data.delete(oldest.value);
    }
  }

  delete(key: K): boolean {
    return this.data.delete(key);
  }

  clear(): void {
    this.data.clear();
  }

  keys(): IterableIterator<K> {
    return this.data.keys();
  }
}

/* ------------------------------------------------------------------ */
/* withTimeout — reject instead of hanging                             */
/* ------------------------------------------------------------------ */

/**
 * Reject when `promise` takes longer than `ms`.
 *
 * `AbortSignal.timeout` only helps when the callee accepts a signal; this
 * covers the rest (a callback wrapped in a promise, an SDK call, a DNS lookup).
 * The timer is always cleared, so a fast result cannot keep the process awake.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label = 'operation'): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
