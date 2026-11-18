import { describe, expect, it } from 'vitest';
import { DAVE_HOLD_MAX_MS, DAVE_BYTES_PER_MS, daveGateVerdict } from '../daveGate.js';

const maxHoldBytes = DAVE_HOLD_MAX_MS * DAVE_BYTES_PER_MS;

describe('daveGateVerdict', () => {
  it('opens immediately when E2EE is not in play', () => {
    expect(
      daveGateVerdict({
        encryptionOn: false,
        session: null,
        elapsedMs: 0,
        heldBytes: 0,
      }),
    ).toBe('open');
  });

  it('opens when the session is ready', () => {
    expect(
      daveGateVerdict({
        encryptionOn: true,
        session: { ready: true, protocolVersion: 1 },
        elapsedMs: 0,
        heldBytes: 0,
      }),
    ).toBe('open');
  });

  it('opens when the channel negotiated DAVE off (protocol 0)', () => {
    expect(
      daveGateVerdict({
        encryptionOn: true,
        session: { ready: false, protocolVersion: 0 },
        elapsedMs: 0,
        heldBytes: 0,
      }),
    ).toBe('open');
  });

  it('holds a not-ready session — plaintext would decode as static', () => {
    expect(
      daveGateVerdict({
        encryptionOn: true,
        session: { ready: false, protocolVersion: 1 },
        elapsedMs: 5_000,
        heldBytes: 0,
      }),
    ).toBe('hold');
  });

  it('holds before the grace period when no session object exists yet', () => {
    expect(
      daveGateVerdict({
        encryptionOn: true,
        session: null,
        elapsedMs: 200,
        heldBytes: 0,
      }),
    ).toBe('hold');
  });

  it('assumes DAVE is off once the grace passes with no session', () => {
    expect(
      daveGateVerdict({
        encryptionOn: true,
        session: null,
        elapsedMs: 2_000,
        heldBytes: 0,
      }),
    ).toBe('open');
  });

  it('overflows instead of buffering forever', () => {
    expect(
      daveGateVerdict({
        encryptionOn: true,
        session: { ready: false, protocolVersion: 1 },
        elapsedMs: 30_000,
        heldBytes: maxHoldBytes + 1,
      }),
    ).toBe('overflow');
  });
});
