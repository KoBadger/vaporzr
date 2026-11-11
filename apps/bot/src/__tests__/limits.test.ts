import { describe, it, expect, beforeEach } from 'vitest';
import {
  burst,
  burstRetryAfterMs,
  resetBursts,
  singleFlight,
  singleFlightCount,
  TTLMap,
  withTimeout,
} from '@vaporzr/core/limits';

beforeEach(() => resetBursts());

describe('burst', () => {
  it('allows up to the limit inside one window', () => {
    const now = 1_000_000;
    for (let i = 0; i < 5; i++) expect(burst('k', 5, 60_000, now)).toBe(true);
    expect(burst('k', 5, 60_000, now)).toBe(false);
  });

  it('resets when the window rolls over', () => {
    const now = 1_000_000;
    for (let i = 0; i < 3; i++) burst('k', 3, 60_000, now);
    expect(burst('k', 3, 60_000, now)).toBe(false);
    expect(burst('k', 3, 60_000, now + 60_001)).toBe(true);
  });

  it('keeps keys independent', () => {
    for (let i = 0; i < 3; i++) burst('a', 3, 60_000, 0);
    expect(burst('a', 3, 60_000, 0)).toBe(false);
    expect(burst('b', 3, 60_000, 0)).toBe(true);
  });

  it('reports the retry delay only once throttled', () => {
    const now = 5_000;
    expect(burstRetryAfterMs('k', 2, 10_000, now)).toBe(0);
    burst('k', 2, 10_000, now);
    burst('k', 2, 10_000, now);
    expect(burstRetryAfterMs('k', 2, 10_000, now + 4_000)).toBe(6_000);
  });
});

describe('singleFlight', () => {
  it('runs concurrent callers of one key once', async () => {
    let calls = 0;
    const fn = async (): Promise<string> => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return 'token';
    };
    const [a, b, c] = await Promise.all([
      singleFlight('refresh', fn),
      singleFlight('refresh', fn),
      singleFlight('refresh', fn),
    ]);
    expect([a, b, c]).toEqual(['token', 'token', 'token']);
    expect(calls).toBe(1);
    expect(singleFlightCount()).toBe(0);
  });

  it('does not cache the result — a later call runs again', async () => {
    let calls = 0;
    const fn = async (): Promise<number> => ++calls;
    await singleFlight('k', fn);
    await singleFlight('k', fn);
    expect(calls).toBe(2);
  });

  it('clears the flight after a rejection so it can be retried', async () => {
    await expect(
      singleFlight('k', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(singleFlightCount()).toBe(0);
    await expect(singleFlight('k', async () => 'ok')).resolves.toBe('ok');
  });
});

describe('TTLMap', () => {
  it('evicts the oldest entry when full', () => {
    const m = new TTLMap<string, number>(2);
    m.set('a', 1);
    m.set('b', 2);
    m.set('c', 3);
    expect(m.size).toBe(2);
    expect(m.get('a')).toBeUndefined();
    expect(m.get('c')).toBe(3);
  });

  it('expires entries after the TTL', () => {
    const m = new TTLMap<string, number>(10, 1000);
    m.set('a', 1, 5_000);
    expect(m.get('a', 5_500)).toBe(1);
    expect(m.get('a', 6_000)).toBeUndefined();
    expect(m.size).toBe(0);
  });

  it('re-setting a key makes it the newest', () => {
    const m = new TTLMap<string, number>(2);
    m.set('a', 1);
    m.set('b', 2);
    m.set('a', 3);
    m.set('c', 4);
    expect(m.get('a')).toBe(3);
    expect(m.get('b')).toBeUndefined();
  });

  it('rejects a nonsensical capacity', () => {
    expect(() => new TTLMap(0)).toThrow();
  });
});

describe('withTimeout', () => {
  it('passes a fast result through', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 50)).resolves.toBe('ok');
  });

  it('rejects a slow one instead of hanging', async () => {
    await expect(withTimeout(new Promise((r) => setTimeout(r, 100)), 20, 'fetch')).rejects.toThrow(/fetch timed out/);
  });

  it('propagates the original rejection', async () => {
    await expect(withTimeout(Promise.reject(new Error('nope')), 50)).rejects.toThrow('nope');
  });
});
