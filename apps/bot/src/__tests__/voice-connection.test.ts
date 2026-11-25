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

  it('starts anyway when the session never becomes ready, rather than dropping the track', async () => {
    // A slow MLS handshake used to time the gate out and make play() throw: the
    // track sat queued with no audio and the panel never showed "playing".
    // Once the link itself is Ready, starting is the lesser evil — the library
    // sends passthrough frames until the session settles.
    const v = voiceWithDave({ protocolVersion: 1, session: { ready: false } });
    expect(await v.waitForAudioReady(250)).toBe(true);
  });

  it('does not strand a channel that never negotiates DAVE', async () => {
    const v = voiceWithDave(undefined);
    expect(await v.waitForAudioReady(900)).toBe(true);
  });
});

describe('VoiceManager.daveSessionStatus (live E2EE telemetry)', () => {
  it('surfaces the stale-epoch shape that still encrypts and still sounds like static', () => {
    // `ready` true while the group is reinitialising (or the privacy code is
    // gone) is the one desync the send guard cannot see. /health must show it.
    const v = voiceWithDave({
      protocolVersion: 1,
      session: { ready: true },
      reinitializing: true,
      voicePrivacyCode: null,
      lastTransitionId: 7,
    });
    const s = v.daveSessionStatus();
    expect(s.protocolVersion).toBe(1);
    expect(s.ready).toBe(true);
    expect(s.reinitializing).toBe(true);
    expect(s.privacyCode).toBe(false);
    expect(s.lastTransitionId).toBe(7);
  });

  it('reports a negotiated-off (protocol 0) channel as healthy plaintext', () => {
    const v = voiceWithDave({ protocolVersion: 0, session: { ready: false }, voicePrivacyCode: 'abc' });
    const s = v.daveSessionStatus();
    expect(s.protocolVersion).toBe(0);
    expect(s.privacyCode).toBe(true);
  });

  it('returns nulls when the link has no DAVE session at all', () => {
    const v = voiceWithDave(undefined);
    const s = v.daveSessionStatus();
    expect(s.protocolVersion).toBeNull();
    expect(s.ready).toBeNull();
    expect(s.reinitializing).toBeNull();
  });

  it('reports whether this manager believes the link is encrypted', () => {
    const v = voiceWithDave({ protocolVersion: 0 });
    const raw = v as unknown as Record<string, unknown>;
    raw.daveEncryption = false;
    expect(v.daveSessionStatus().enabled).toBe(false);
    raw.daveEncryption = true;
    raw.daveConfirmedOff = false;
    expect(v.daveSessionStatus().enabled).toBe(true);
  });

  it('does not throw — and so does not hang /health — when the bot is not in voice', () => {
    // Regression from the first /health telemetry build: daveSessionState()
    // dereferenced a null connection. The throw escaped to the process-wide
    // uncaughtException handler *after* the /health socket opened, so the
    // endpoint hung (no bytes) instead of answering.
    const v = new VoiceManager();
    (v as unknown as Record<string, unknown>).connection = null;
    const s = v.daveSessionStatus();
    expect(s.protocolVersion).toBeNull();
    expect(s.ready).toBeNull();
    expect(s.enabled).toBe(false);
  });
});
