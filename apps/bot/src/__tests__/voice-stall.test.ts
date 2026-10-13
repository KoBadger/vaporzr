import { describe, expect, it } from 'vitest';
import { VoiceManager } from '../voice.js';

/**
 * Build a VoiceManager with the private fields the real code sets. Only the
 * fields isStalled() reads are needed: connection, paused, ffmpeg, expectingPcm.
 */
function voiceWith(fields: {
  connected: boolean;
  paused: boolean;
  ffmpeg: unknown;
  expectingPcm: boolean;
}): VoiceManager {
  const v = new VoiceManager();
  const raw = v as unknown as Record<string, unknown>;
  raw.connection = fields.connected ? { state: { status: 'ready' } } : null;
  raw.paused = fields.paused;
  raw.ffmpeg = fields.ffmpeg;
  raw.expectingPcm = fields.expectingPcm;
  return v;
}

describe('VoiceManager.isStalled (the resume gate)', () => {
  it('does NOT report a stall while the Spotify PCM feed is armed', () => {
    // Regression: the Spotify feed has no ffmpeg at all, so `ffmpeg === null`
    // is its NORMAL state. Treating that as a stall made every resume() during
    // a Spotify track restart the song from the top — heard as a mid-song
    // cut-out and replay, followed by ~30s of silence.
    const v = voiceWith({ connected: true, paused: false, ffmpeg: null, expectingPcm: true });
    expect(v.isStalled()).toBe(false);
  });

  it('reports a stall when a server-side stream died', () => {
    // No ffmpeg and no PCM feed expected: the ffmpeg stream is gone.
    const v = voiceWith({ connected: true, paused: false, ffmpeg: null, expectingPcm: false });
    expect(v.isStalled()).toBe(true);
  });

  it('is not a stall while a server-side stream is running', () => {
    const v = voiceWith({ connected: true, paused: false, ffmpeg: {}, expectingPcm: false });
    expect(v.isStalled()).toBe(false);
  });

  it('is not a stall while paused or disconnected', () => {
    expect(
      voiceWith({ connected: false, paused: false, ffmpeg: null, expectingPcm: false }).isStalled(),
    ).toBe(false);
    expect(
      voiceWith({ connected: true, paused: true, ffmpeg: null, expectingPcm: false }).isStalled(),
    ).toBe(false);
  });
});
