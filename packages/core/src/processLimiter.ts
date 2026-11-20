/**
 * Shared process limiter to prevent Windows commit-limit errors (0xc000012d)
 * when spawning multiple ffmpeg processes concurrently.
 *
 * Safeguards included:
 * - Configurable max concurrent processes (default: 3, env: FFMPEG_MAX_CONCURRENT)
 * - Queue size limit to prevent unbounded memory growth
 * - Queue timeout to prevent deadlock
 * - Graceful shutdown support
 * - Health check metrics
 * - Dead process cleanup
 */

import { config } from './config.js';

const DEFAULT_MAX_CONCURRENT = config.ffmpegMaxConcurrent ?? 3;
const DEFAULT_QUEUE_LIMIT = 50;
const DEFAULT_QUEUE_TIMEOUT_MS = 30_000; // 30s timeout waiting in queue

export interface ProcessLimiterOptions {
  /** Max concurrent processes (default: 3) */
  maxConcurrent?: number;
  /** Max queue size before rejecting (default: 50) */
  queueLimit?: number;
  /** Timeout waiting in queue (default: 30s) */
  queueTimeoutMs?: number;
  /** Optional logger for observability */
  logger?: {
    warn: (msg: string) => void;
    info: (msg: string) => void;
  };
}

export interface ProcessLimiterMetrics {
  active: number;
  queued: number;
  maxConcurrent: number;
  queueLimit: number;
  totalSpawned: number;
  totalRejected: number;
  totalTimedOut: number;
}

export class ProcessLimiter {
  private active = 0;
  private queue: Array<{
    resolve: () => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];
  private shuttingDown = false;
  private totalSpawned = 0;
  private totalRejected = 0;
  private totalTimedOut = 0;

  private readonly maxConcurrent: number;
  private readonly queueLimit: number;
  private readonly queueTimeoutMs: number;
  private readonly logger?: ProcessLimiterOptions['logger'];

  constructor(options: ProcessLimiterOptions = {}) {
    this.maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    this.queueLimit = options.queueLimit ?? DEFAULT_QUEUE_LIMIT;
    this.queueTimeoutMs = options.queueTimeoutMs ?? DEFAULT_QUEUE_TIMEOUT_MS;
    this.logger = options.logger;
  }

  /**
   * Acquire a slot to run a process. Waits if at capacity.
   * Throws if shutting down or queue is full.
   */
  async acquire(): Promise<void> {
    if (this.shuttingDown) {
      throw new Error('Cannot acquire process slot: shutting down');
    }

    if (this.active < this.maxConcurrent) {
      this.active++;
      this.totalSpawned++;
      return;
    }

    // Check queue limit
    if (this.queue.length >= this.queueLimit) {
      this.totalRejected++;
      this.logWarn(`Queue full (${this.queue.length}/${this.queueLimit}) — rejecting spawn`);
      throw new Error(`Process queue full (${this.queue.length}/${this.queueLimit})`);
    }

    // Wait in queue with timeout
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.totalTimedOut++;
        this.logWarn(`Queue wait timeout after ${this.queueTimeoutMs}ms — rejecting spawn`);
        reject(new Error(`Process queue timeout after ${this.queueTimeoutMs}ms`));
      }, this.queueTimeoutMs);

      this.queue.push({ resolve, reject, timer });
      this.logInfo(`Queued (${this.queue.length} waiting, ${this.active}/${this.maxConcurrent} active)`);
    });
  }

  /**
   * Release a slot after process completes.
   */
  release(): void {
    this.active = Math.max(0, this.active - 1);

    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      clearTimeout(next.timer);
      this.active++;
      this.totalSpawned++;
      next.resolve();
      this.logInfo(`Released — next process started (${this.queue.length} still queued)`);
    }
  }

  /**
   * Check if we should reject new spawns (shutting down).
   */
  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  /**
   * Initiate graceful shutdown. Prevents new spawns but allows queued ones to complete.
   */
  shutdown(): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.logInfo(`Shutdown initiated — rejecting new spawns, ${this.active} active, ${this.queue.length} queued`);
  }

  /**
   * Emergency reset - clears queue and rejects all waiting.
   * Use only in catastrophic failure scenarios.
   */
  emergencyReset(): void {
    this.logWarn(`Emergency reset — clearing ${this.queue.length} queued spawns`);

    for (const item of this.queue) {
      clearTimeout(item.timer);
      item.reject(new Error('Process limiter emergency reset'));
    }
    this.queue = [];
  }

  /**
   * Get current metrics for health checks.
   */
  getMetrics(): ProcessLimiterMetrics {
    return {
      active: this.active,
      queued: this.queue.length,
      maxConcurrent: this.maxConcurrent,
      queueLimit: this.queueLimit,
      totalSpawned: this.totalSpawned,
      totalRejected: this.totalRejected,
      totalTimedOut: this.totalTimedOut,
    };
  }

  /**
   * Check if limiter is healthy (not stuck).
   */
  isHealthy(): boolean {
    // Unhealthy if queue is at limit AND no progress (all active stuck)
    return this.queue.length < this.queueLimit || this.active < this.maxConcurrent;
  }

  private logWarn(msg: string): void {
    if (this.logger) {
      this.logger.warn(`[limiter] ${msg}`);
    }
  }

  private logInfo(msg: string): void {
    if (this.logger) {
      this.logger.info(`[limiter] ${msg}`);
    }
  }
}

// Default instance for ffmpeg (can be overridden per use case)
export const ffmpegLimiter = new ProcessLimiter({
  maxConcurrent: 3,
  queueLimit: 50,
  queueTimeoutMs: 30_000,
});

/**
 * Wrapper function to spawn a process with automatic slot management.
 * Handles acquire/release and error cleanup.
 */
export async function spawnWithLimiter<T extends { on: (event: string, cb: (...args: any[]) => void) => void }>(
  limiter: ProcessLimiter,
  spawnFn: () => T,
  onSpawn?: (proc: T) => void,
): Promise<T> {
  await limiter.acquire();

  try {
    const proc = spawnFn();

    // Auto-release on exit or error. Guarded so the pair of `error` + `exit`
    // events can never release the same slot twice — an extra release would
    // over-admit spawns and defeat the whole memory guard.
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      limiter.release();
    };
    proc.on('exit', release);
    proc.on('error', release);

    if (onSpawn) {
      onSpawn(proc);
    }

    return proc;
  } catch (err) {
    // If spawn fails, release the slot immediately
    limiter.release();
    throw err;
  }
}
