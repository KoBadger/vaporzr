/**
 * DAVE (E2EE) output gate.
 *
 * @discordjs/voice sends frames as PASSTHROUGH until the davey session reports
 * ready. On a DAVE-enabled channel a DAVE client decodes those plaintext bytes
 * as if they were ciphertext — heard as broadband static, not as "lower
 * quality". Nothing upstream can detect it: the damage happens after the PCM
 * tap, so the audio monitor sees clean samples the whole time.
 *
 * The bot used to deal with this in two mutually incompatible ways: wait at join
 * (and lose the track if the handshake was slow), or start anyway (and send
 * plaintext). Neither is right. The correct behaviour is to hold the outgoing
 * PCM until encryption is real, then play it — the listener loses nothing and
 * never hears static.
 *
 * Pure decision function, so the states are testable without a voice socket.
 */

export interface DaveSessionLike {
  /** The davey session has completed its MLS handshake and can encrypt. */
  ready: boolean;
  /** 0 means DAVE negotiated as off for this channel, so plain frames are correct. */
  protocolVersion: number;
}

export type DaveGateVerdict = 'open' | 'hold' | 'overflow';

/**
 * How long to keep assuming a channel might still be DAVE before concluding it
 * is simply not E2EE.
 *
 * Retired: absence of a session object is **not** evidence that the channel is
 * unencrypted. @discordjs/voice creates a DAVE session for every connection where
 * DAVE is enabled — including channels that negotiated protocol version 0 — so a
 * missing session means DAVE was disabled on the connection, never "plaintext is
 * expected here". Concluding otherwise is what allowed unencrypted frames onto a
 * DAVE channel, which listeners hear as static.
 */
export const DAVE_APPEAR_GRACE_MS = 1_500;

/** Longest stretch of audio we are willing to buffer while waiting. */
export const DAVE_HOLD_MAX_MS = 8_000;

/** Minimum gap between DAVE recovery reconnects. */
export const DAVE_RECONNECT_COOLDOWN_MS = 5 * 60_000;

/**
 * Whether a stalled handshake justifies asking for a new voice session.
 *
 * Pure so the throttle is testable: a gate that overflows repeatedly must not
 * reconnect repeatedly, and a non-DAVE channel must never reconnect at all.
 */
export function shouldReconnectDave(args: {
  encryptionOn: boolean;
  connectionStatus: string;
  lastReconnectAt: number;
  now: number;
  cooldownMs?: number;
}): boolean {
  if (!args.encryptionOn) return false;
  if (args.connectionStatus === 'destroyed') return false;
  return args.now - args.lastReconnectAt >= (args.cooldownMs ?? DAVE_RECONNECT_COOLDOWN_MS);
}

/** 48 kHz stereo s16. */
export const DAVE_BYTES_PER_MS = 48_000 * 2 * 2;

export function daveGateVerdict(args: {
  encryptionOn: boolean;
  session: DaveSessionLike | null;
  /** Milliseconds since this stream started. Unused: kept for callers/tests. */
  elapsedMs: number;
  heldBytes: number;
  maxHoldBytes?: number;
}): DaveGateVerdict {
  if (!args.encryptionOn) return 'open';
  const { session } = args;
  // Two, and only two, proven-safe cases. A missing session used to fall into a
  // timer-based "assume the channel is not encrypted" branch, which is the path
  // that put plaintext on a DAVE channel: the listener's client decoded it as
  // ciphertext and got broadband static. Absence of proof is never proof here.
  if (session && (session.protocolVersion === 0 || session.ready)) return 'open';
  if (args.heldBytes > (args.maxHoldBytes ?? DAVE_HOLD_MAX_MS * DAVE_BYTES_PER_MS)) return 'overflow';
  return 'hold';
}

export interface DaveGateStats {
  /** True once audio has actually been released for this stream. */
  open: boolean;
  /** Buffered bytes waiting for the handshake. */
  heldBytes: number;
  /** How long audio was held before the gate opened (0 while still shut). */
  waitedMs: number;
  /** Times the backlog had to be dropped because the handshake never settled. */
  overflows: number;
  /**
   * Wall-clock time of the most recent drop, or null if none. The cumulative
   * count alone keeps an old drop "true" for the life of the process, which
   * makes it useless for alerting on a *current* problem.
   */
  lastOverflowAt: number | null;
}

/**
 * Stateful wrapper around `daveGateVerdict`.
 *
 * The pure verdict is easy to satisfy; the bug that shipped was in the wiring —
 * a caller that decided "close enough" and handed frames to the encoder anyway.
 * Keeping the buffer here means the only way to get audio out is `push()` /
 * `drain()`, both of which refuse to release anything while the gate is shut.
 * Tests pin exactly that contract.
 */
export class DaveOutputGate {
  private held: Buffer[] = [];
  private heldBytes = 0;
  private opened = false;
  private waitedMs = 0;
  private overflows = 0;
  private lastOverflowAt: number | null = null;
  private readonly start: number;

  constructor(
    private readonly opts: {
      encryptionOn: () => boolean;
      session: () => DaveSessionLike | null;
      maxHoldBytes?: number;
      now?: () => number;
      onOpen?: (waitedMs: number) => void;
      onOverflow?: (heldChunks: number) => void;
    },
  ) {
    this.start = this.now();
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  private verdict(): DaveGateVerdict {
    return daveGateVerdict({
      encryptionOn: this.opts.encryptionOn(),
      session: this.opts.session(),
      elapsedMs: this.now() - this.start,
      heldBytes: this.heldBytes,
      maxHoldBytes: this.opts.maxHoldBytes,
    });
  }

  /** Audio is still waiting for the handshake. */
  get holding(): boolean {
    return this.held.length > 0;
  }

  private release(): void {
    if (!this.opened) {
      this.opened = true;
      this.waitedMs = this.now() - this.start;
      this.opts.onOpen?.(this.waitedMs);
    }
  }

  /**
   * Offer one chunk. Returns the chunks the encoder may send now (oldest
   * first), or an empty array while the gate is shut — never the chunk itself.
   */
  push(chunk: Buffer): Buffer[] {
    const verdict = this.verdict();
    if (verdict === 'overflow') {
      this.dropBacklog();
      return [];
    }
    if (verdict === 'hold') {
      this.held.push(chunk);
      this.heldBytes += chunk.length;
      return [];
    }
    this.release();
    const out = this.held.length ? [...this.held, chunk] : [chunk];
    this.held = [];
    this.heldBytes = 0;
    return out;
  }

  /** Re-check while holding (called from a timer). Same contract as `push`. */
  drain(): Buffer[] {
    if (this.held.length === 0) return [];
    const verdict = this.verdict();
    if (verdict === 'overflow') {
      this.dropBacklog();
      return [];
    }
    if (verdict === 'hold') return [];
    this.release();
    const out = this.held;
    this.held = [];
    this.heldBytes = 0;
    return out;
  }

  private dropBacklog(): void {
    if (this.held.length === 0) return;
    this.overflows++;
    this.lastOverflowAt = this.now();
    this.opts.onOverflow?.(this.held.length);
    this.held = [];
    this.heldBytes = 0;
  }

  stats(): DaveGateStats {
    return {
      open: this.opened,
      heldBytes: this.heldBytes,
      waitedMs: this.waitedMs,
      overflows: this.overflows,
      lastOverflowAt: this.lastOverflowAt,
    };
  }
}
