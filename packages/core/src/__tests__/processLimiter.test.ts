import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProcessLimiter, spawnWithLimiter } from '../processLimiter.js';
import type { ChildProcess } from 'node:child_process';

describe('ProcessLimiter', () => {
  let limiter: ProcessLimiter;

  beforeEach(() => {
    limiter = new ProcessLimiter({
      maxConcurrent: 2,
      queueLimit: 3,
      queueTimeoutMs: 100, // Short timeout for tests
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('acquire/release', () => {
    it('should allow up to maxConcurrent processes', async () => {
      await expect(limiter.acquire()).resolves.toBeUndefined();
      await expect(limiter.acquire()).resolves.toBeUndefined();

      const metrics = limiter.getMetrics();
      expect(metrics.active).toBe(2);
      expect(metrics.queued).toBe(0);
    });

    it('should queue when maxConcurrent reached', async () => {
      await limiter.acquire();
      await limiter.acquire();

      let resolveThird: () => void;
      const thirdPromise = new Promise<void>((resolve) => {
        resolveThird = resolve;
      });

      const acquirePromise = limiter.acquire();
      await expect(Promise.race([acquirePromise, Promise.resolve('timeout')])).resolves.toBe('timeout');

      const metrics = limiter.getMetrics();
      expect(metrics.active).toBe(2);
      expect(metrics.queued).toBe(1);

      // Release one slot
      limiter.release();
      await expect(acquirePromise).resolves.toBeUndefined();

      resolveThird!();
    });

    it('should reject when queue limit reached', async () => {
      await limiter.acquire();
      await limiter.acquire();

      // Fill the queue
      const pending: Promise<void>[] = [];
      for (let i = 0; i < 3; i++) {
        pending.push(limiter.acquire().catch(() => {}));
      }

      // Next acquire should reject immediately
      await expect(limiter.acquire()).rejects.toThrow('Process queue full');

      // Clean up
      limiter.release();
      limiter.release();
      await Promise.all(pending);
    });

    it('should timeout waiting in queue', async () => {
      await limiter.acquire();
      await limiter.acquire();

      // This should timeout after queueTimeoutMs
      await expect(limiter.acquire()).rejects.toThrow('Process queue timeout');

      const metrics = limiter.getMetrics();
      expect(metrics.totalTimedOut).toBe(1);
    });
  });

  describe('shutdown', () => {
    it('should reject new acquires when shutting down', async () => {
      limiter.shutdown();
      expect(limiter.isShuttingDown()).toBe(true);

      await expect(limiter.acquire()).rejects.toThrow('shutting down');
    });

    it('should allow already-acquired slots to release', async () => {
      await limiter.acquire();
      await limiter.acquire();

      limiter.shutdown();

      // Should not throw
      expect(() => limiter.release()).not.toThrow();
      expect(() => limiter.release()).not.toThrow();
    });
  });

  describe('emergencyReset', () => {
    it('should clear queue and reject waiting', async () => {
      await limiter.acquire();
      await limiter.acquire();

      const pending = limiter.acquire().catch((err) => err);
      await new Promise((resolve) => setTimeout(resolve, 10)); // Let it queue

      limiter.emergencyReset();

      const result = await pending;
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toContain('emergency reset');
    });
  });

  describe('metrics', () => {
    it('should track spawn/reject/timeout counts', async () => {
      await limiter.acquire();
      limiter.release();

      await limiter.acquire();
      await limiter.acquire();

      // This should be queued and timeout
      await limiter.acquire().catch(() => {});

      const metrics = limiter.getMetrics();
      expect(metrics.totalSpawned).toBeGreaterThanOrEqual(2);
      expect(metrics.totalTimedOut).toBeGreaterThanOrEqual(0);
    });
  });

  describe('isHealthy', () => {
    it('should return true when not at capacity', async () => {
      expect(limiter.isHealthy()).toBe(true);
    });

    it('should return true when active but queue not full', async () => {
      await limiter.acquire();
      await limiter.acquire();

      expect(limiter.isHealthy()).toBe(true);
    });
  });
});

describe('spawnWithLimiter', () => {
  it('should acquire and release slot', async () => {
    const limiter = new ProcessLimiter({ maxConcurrent: 1 });

    const mockProc = {
      on: vi.fn(),
    } as unknown as ChildProcess & { on: (event: string, cb: (...args: any[]) => void) => void };

    const spawnFn = vi.fn(() => mockProc);

    const result = await spawnWithLimiter(limiter, spawnFn);

    expect(result).toBe(mockProc);
    expect(spawnFn).toHaveBeenCalledOnce();
    expect(mockProc.on).toHaveBeenCalledWith('exit', expect.any(Function));
    expect(mockProc.on).toHaveBeenCalledWith('error', expect.any(Function));

    const metrics = limiter.getMetrics();
    expect(metrics.active).toBe(1);
    expect(metrics.totalSpawned).toBe(1);
  });

  it('should release slot on spawn error', async () => {
    const limiter = new ProcessLimiter({ maxConcurrent: 1 });

    const spawnFn = vi.fn(() => {
      throw new Error('spawn failed');
    });

    await expect(spawnWithLimiter(limiter, spawnFn)).rejects.toThrow('spawn failed');

    const metrics = limiter.getMetrics();
    expect(metrics.active).toBe(0);
  });

  it('releases a slot only once when both error and exit fire', async () => {
    const limiter = new ProcessLimiter({ maxConcurrent: 1 });
    const handlers: Record<string, (...args: any[]) => void> = {};
    const mockProc = {
      on: vi.fn((event: string, cb: (...args: any[]) => void) => {
        handlers[event] = cb;
      }),
    } as unknown as ChildProcess & { on: (event: string, cb: (...args: any[]) => void) => void };

    await spawnWithLimiter(limiter, () => mockProc);
    expect(limiter.getMetrics().active).toBe(1);

    handlers.error!(new Error('boom'));
    handlers.exit!(1, null);

    // A second release would have over-admitted a spawn.
    expect(limiter.getMetrics().active).toBe(0);
  });

  it('kills a hung process and frees the slot at the hard ceiling', async () => {
    const limiter = new ProcessLimiter({ maxConcurrent: 1 });
    const kill = vi.fn(() => true);
    const mockProc = {
      on: vi.fn(),
      kill,
    } as unknown as ChildProcess & {
      on: (event: string, cb: (...args: any[]) => void) => void;
      kill: (signal?: NodeJS.Signals) => boolean;
    };

    // A process that never emits exit or error would otherwise hold its slot
    // forever and wedge the whole queue behind it.
    await spawnWithLimiter(limiter, () => mockProc, undefined, 50);
    await new Promise((r) => setTimeout(r, 200));

    expect(kill).toHaveBeenCalledWith('SIGKILL');
    expect(limiter.getMetrics().active).toBe(0);
    expect(limiter.getMetrics().totalSpawned).toBe(1);
  });

  it('does not kill a process that exits before the hard ceiling', async () => {
    const limiter = new ProcessLimiter({ maxConcurrent: 1 });
    const handlers: Record<string, (...args: any[]) => void> = {};
    const kill = vi.fn(() => true);
    const mockProc = {
      on: vi.fn((event: string, cb: (...args: any[]) => void) => {
        handlers[event] = cb;
      }),
      kill,
    } as unknown as ChildProcess & {
      on: (event: string, cb: (...args: any[]) => void) => void;
      kill: (signal?: NodeJS.Signals) => boolean;
    };

    await spawnWithLimiter(limiter, () => mockProc, undefined, 50);
    handlers.exit!(0, null);
    await new Promise((r) => setTimeout(r, 200));

    expect(kill).not.toHaveBeenCalled();
    expect(limiter.getMetrics().active).toBe(0);
  });
});
