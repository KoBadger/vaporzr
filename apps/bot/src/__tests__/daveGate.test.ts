import { describe, expect, it } from 'vitest';
import {
  DAVE_BYTES_PER_MS,
  DAVE_HOLD_MAX_MS,
  DAVE_RECONNECT_COOLDOWN_MS,
  DaveOutputGate,
  daveGateVerdict,
  shouldReconnectDave,
} from '../daveGate.js';

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

describe('DaveOutputGate', () => {
  const chunk = (n: number) => Buffer.alloc(3840, n);

  function makeGate(overrides: { ready?: boolean; protocolVersion?: number; maxHoldBytes?: number } = {}) {
    let clock = 0;
    let session: { ready: boolean; protocolVersion: number } | null =
      overrides.ready === undefined && overrides.protocolVersion === undefined
        ? null
        : { ready: overrides.ready ?? false, protocolVersion: overrides.protocolVersion ?? 1 };
    const opened: number[] = [];
    const overflows: number[] = [];
    const gate = new DaveOutputGate({
      encryptionOn: () => true,
      session: () => session,
      maxHoldBytes: overrides.maxHoldBytes,
      now: () => clock,
      onOpen: (ms) => opened.push(ms),
      onOverflow: (n) => overflows.push(n),
    });
    return {
      gate,
      opened,
      overflows,
      advance: (ms: number) => {
        clock += ms;
      },
      setSession: (next: { ready: boolean; protocolVersion: number } | null) => {
        session = next;
      },
    };
  }

  it('releases nothing while the session is not ready', () => {
    const { gate } = makeGate({ ready: false });
    expect(gate.push(chunk(1))).toEqual([]);
    expect(gate.push(chunk(2))).toEqual([]);
    expect(gate.holding).toBe(true);
    expect(gate.stats()).toMatchObject({ open: false, overflows: 0, heldBytes: 7680 });
  });

  it('drain() does not release a backlog that is still waiting', () => {
    const { gate } = makeGate({ ready: false });
    gate.push(chunk(1));
    gate.push(chunk(2));
    expect(gate.drain()).toEqual([]);
    expect(gate.stats().open).toBe(false);
  });

  it('releases the backlog ahead of the new chunk once ready', () => {
    const { gate, setSession } = makeGate({ ready: false });
    gate.push(chunk(1));
    gate.push(chunk(2));
    setSession({ ready: true, protocolVersion: 1 });
    const out = gate.push(chunk(3));
    expect(out.map((b) => b[0])).toEqual([1, 2, 3]);
    expect(gate.holding).toBe(false);
    expect(gate.stats().open).toBe(true);
  });

  it('drain() releases the backlog when the session becomes ready', () => {
    const { gate, setSession, advance } = makeGate({ ready: false });
    gate.push(chunk(7));
    advance(900);
    setSession({ ready: true, protocolVersion: 1 });
    const out = gate.drain();
    expect(out).toHaveLength(1);
    expect(out[0][0]).toBe(7);
    expect(gate.stats().waitedMs).toBe(900);
  });

  it('opens when the channel is not E2EE', () => {
    const { gate } = makeGate({ protocolVersion: 0 });
    expect(gate.push(chunk(9))).toHaveLength(1);
  });

  it('assumes DAVE is off after the grace with no session object', () => {
    const { gate, advance } = makeGate();
    expect(gate.push(chunk(1))).toEqual([]);
    advance(2_000);
    expect(gate.push(chunk(2))).toHaveLength(2);
  });

  it('drops the backlog instead of growing without bound', () => {
    const { gate, overflows, advance } = makeGate({ ready: false, maxHoldBytes: 1000 });
    expect(gate.stats().lastOverflowAt).toBeNull();
    expect(gate.push(chunk(1))).toEqual([]);
    advance(50);
    expect(gate.push(chunk(2))).toEqual([]); // 3840 held > 1000 -> overflow
    expect(overflows).toEqual([1]);
    expect(gate.stats()).toMatchObject({ open: false, heldBytes: 0, overflows: 1, lastOverflowAt: 50 });
    expect(gate.holding).toBe(false);
  });
});

describe('shouldReconnectDave', () => {
  it('reconnects once a stalled handshake has overflowed and the cooldown has passed', () => {
    expect(
      shouldReconnectDave({
        encryptionOn: true,
        connectionStatus: 'ready',
        lastReconnectAt: 0,
        now: 1_000_000,
      }),
    ).toBe(true);
  });

  it('never reconnects inside the cooldown, however many backlogs are dropped', () => {
    const now = 1_000_000;
    // Same instant as the previous reconnect, and again one millisecond short of
    // the cooldown: without this the gate would rejoin Discord in a loop.
    expect(shouldReconnectDave({ encryptionOn: true, connectionStatus: 'ready', lastReconnectAt: now, now })).toBe(
      false,
    );
    expect(
      shouldReconnectDave({
        encryptionOn: true,
        connectionStatus: 'ready',
        lastReconnectAt: now,
        now: now + DAVE_RECONNECT_COOLDOWN_MS - 1,
      }),
    ).toBe(false);
    expect(
      shouldReconnectDave({
        encryptionOn: true,
        connectionStatus: 'ready',
        lastReconnectAt: now,
        now: now + DAVE_RECONNECT_COOLDOWN_MS,
      }),
    ).toBe(true);
  });

  it('does nothing on a channel that is not E2EE or a dead connection', () => {
    expect(shouldReconnectDave({ encryptionOn: false, connectionStatus: 'ready', lastReconnectAt: 0, now: 1 })).toBe(
      false,
    );
    expect(shouldReconnectDave({ encryptionOn: true, connectionStatus: 'destroyed', lastReconnectAt: 0, now: 1 })).toBe(
      false,
    );
  });
});
