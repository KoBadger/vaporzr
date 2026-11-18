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
 * is simply not E2EE. The session object normally appears within a few hundred
 * ms; 1.5 s covers a jittery handshake without stalling ordinary channels.
 */
export const DAVE_APPEAR_GRACE_MS = 1_500;

/** Longest stretch of audio we are willing to buffer while waiting. */
export const DAVE_HOLD_MAX_MS = 8_000;

/** 48 kHz stereo s16. */
export const DAVE_BYTES_PER_MS = 48_000 * 2 * 2;

export function daveGateVerdict(args: {
  encryptionOn: boolean;
  session: DaveSessionLike | null;
  /** Milliseconds since this stream started. */
  elapsedMs: number;
  heldBytes: number;
  appearGraceMs?: number;
  maxHoldBytes?: number;
}): DaveGateVerdict {
  if (!args.encryptionOn) return 'open';
  const { session } = args;
  if (session) {
    // protocolVersion 0 = DAVE off for this channel: plaintext is what listeners expect.
    if (session.protocolVersion === 0 || session.ready) return 'open';
  } else if (args.elapsedMs >= (args.appearGraceMs ?? DAVE_APPEAR_GRACE_MS)) {
    // No session at all after the grace period: the channel is not E2EE.
    return 'open';
  }
  if (args.heldBytes > (args.maxHoldBytes ?? DAVE_HOLD_MAX_MS * DAVE_BYTES_PER_MS)) return 'overflow';
  return 'hold';
}
