import { describe, expect, it } from 'vitest';
import { VoiceManager } from '../voice.js';

/** VoiceManager with only the connection field the join gates read. */
function voiceWithConnection(status: string | null): VoiceManager {
  const v = new VoiceManager();
  const raw = v as unknown as Record<string, unknown>;
  raw.connection = status === null ? null : { state: { status } };
  return v;
}

describe('VoiceManager connection readiness (the auto-join gate)', () => {
  it('counts only a Ready link as joinable', () => {
    expect(voiceWithConnection('ready').isConnectionReady()).toBe(true);
    for (const status of ['connecting', 'signalling', 'disconnected', 'destroyed']) {
      expect(voiceWithConnection(status).isConnectionReady()).toBe(false);
    }
    expect(voiceWithConnection(null).isConnectionReady()).toBe(false);
  });

  it('keeps isJoined() loose so the auto-resume poll still waits out a reconnect', () => {
    // Regression: the auto-join check used isJoined(), which accepts these
    // non-Ready states — V@p then replied "Added to queue" and never joined.
    expect(voiceWithConnection('connecting').isJoined()).toBe(true);
    expect(voiceWithConnection('disconnected').isJoined()).toBe(true);
    expect(voiceWithConnection('destroyed').isJoined()).toBe(false);
  });

  it('reports the raw link status for logs and /diag', () => {
    expect(voiceWithConnection('connecting').connectionStatus()).toBe('connecting');
    expect(voiceWithConnection('disconnected').connectionStatus()).toBe('disconnected');
    expect(voiceWithConnection(null).connectionStatus()).toBe('none');
  });
});
