import { describe, expect, it } from 'vitest';
import { gatewayHealth, gatewayStatusName, type GatewayCounters } from '../gatewayHealth.js';

const NOW = 1_800_000_000_000;

function counters(over: Partial<GatewayCounters> = {}): GatewayCounters {
  return {
    wsStatus: 0,
    pingMs: 42,
    ready: true,
    readyAt: NOW - 3_600_000,
    disconnects: 0,
    disconnectTimes: [],
    resumes: 0,
    lastEventAt: NOW - 120_000,
    messagesSeen: 0,
    lastMessageAt: 0,
    emptyContentMessages: 0,
    ...over,
  };
}

describe('gatewayStatusName', () => {
  it('names every discord.js ws status code', () => {
    expect([0, 1, 2, 3, 4, 5].map(gatewayStatusName)).toEqual([
      'ready',
      'connecting',
      'reconnecting',
      'idle',
      'nearly',
      'disconnected',
    ]);
  });

  it('does not pretend an unknown code is healthy', () => {
    expect(gatewayStatusName(9)).toBe('unknown(9)');
  });
});

describe('gatewayHealth', () => {
  it('reports a settled session with its age and heartbeat', () => {
    const h = gatewayHealth(counters(), NOW);
    expect(h).toMatchObject({
      status: 'ready',
      ready: true,
      pingMs: 42,
      sessionAgeSec: 3600,
      lastEventAgoSec: 120,
    });
  });

  it('reports null ages when the session never reached READY', () => {
    // A process stuck in login-retry answers /health with uptime > 0 and an
    // empty guild cache, so "never ready" must be distinguishable from "ready
    // an hour ago" rather than silently reading as age 0.
    const h = gatewayHealth(counters({ ready: false, wsStatus: 1, readyAt: 0, lastEventAt: 0 }), NOW);
    expect(h.ready).toBe(false);
    expect(h.status).toBe('connecting');
    expect(h.sessionAgeSec).toBeNull();
    expect(h.lastEventAgoSec).toBeNull();
  });

  it('counts only disconnects inside the last hour', () => {
    const h = gatewayHealth(
      counters({
        disconnects: 4,
        disconnectTimes: [NOW - 5 * 60_000, NOW - 59 * 60_000, NOW - 61 * 60_000, NOW - 5 * 3_600_000],
        resumes: 2,
      }),
      NOW,
    );
    expect(h.disconnects).toBe(4);
    expect(h.disconnectsLastHour).toBe(2);
    expect(h.resumes).toBe(2);
  });

  it('ignores disconnect timestamps from the future and rounds the ping', () => {
    const h = gatewayHealth(
      counters({ disconnectTimes: [NOW + 5_000], pingMs: 12.6, messagesSeen: 7, lastMessageAt: NOW - 1_000 }),
      NOW,
    );
    expect(h.disconnectsLastHour).toBe(0);
    expect(h.pingMs).toBe(13);
    expect(h.messagesSeen).toBe(7);
    expect(h.lastMessageAgoSec).toBe(1);
  });

  it('exposes withheld-content messages, the silent death of a prefix bot', () => {
    // Content arrives empty when Discord withholds the Message Content intent:
    // every command is silently ignored and nothing else in /health changes.
    const h = gatewayHealth(counters({ messagesSeen: 40, emptyContentMessages: 3 }), NOW);
    expect(h.emptyContentMessages).toBe(3);
  });
});
