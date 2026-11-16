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

/** VoiceManager whose link is Ready with a controllable DAVE session. */
function voiceWithDave(dave: unknown): VoiceManager {
  const v = new VoiceManager();
  const raw = v as unknown as Record<string, unknown>;
  raw.connection = { state: { status: 'ready', networking: { state: { dave } } } };
  return v;
}

describe('VoiceManager.waitForAudioReady (the DAVE white-noise gate)', () => {
  it('is ready at once when the DAVE session can encrypt', async () => {
    // Regression: the gate used to accept a merely *present* session object.
    // @discordjs/voice sends PASSTHROUGH frames until the inner davey session
    // reports ready, and DAVE clients decode those as broadband noise.
    const v = voiceWithDave({ protocolVersion: 1, session: { ready: true } });
    expect(await v.waitForAudioReady(200)).toBe(true);
  });

  it('treats a negotiated-off (protocol 0) channel as ready', async () => {
    const v = voiceWithDave({ protocolVersion: 0, session: { ready: false } });
    expect(await v.waitForAudioReady(200)).toBe(true);
  });

  it('refuses to call a link ready while the session cannot encrypt yet', async () => {
    const v = voiceWithDave({ protocolVersion: 1, session: { ready: false } });
    expect(await v.waitForAudioReady(250)).toBe(false);
  });

  it('does not strand a channel that never negotiates DAVE', async () => {
    const v = voiceWithDave(undefined);
    expect(await v.waitForAudioReady(900)).toBe(true);
  });
});
