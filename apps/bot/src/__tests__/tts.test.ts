import { describe, expect, it } from 'vitest';
import { sanitizeTtsText, ttsEngine } from '../tts.js';

describe('sanitizeTtsText', () => {
  it('collapses whitespace and strips symbols a voice cannot read', () => {
    expect(sanitizeTtsText('Now   playing:  Song 🎵 <b>')).toBe('Now playing: Song b');
  });

  it('keeps ordinary punctuation', () => {
    expect(sanitizeTtsText("Don't Stop (Remix) - Yeah!")).toBe("Don't Stop (Remix) - Yeah!");
  });

  it('caps very long text', () => {
    expect(sanitizeTtsText('a'.repeat(500)).length).toBe(220);
  });

  it('returns empty for symbol-only input', () => {
    expect(sanitizeTtsText('🔥🔥')).toBe('');
  });
});

describe('TtsEngine', () => {
  it('is disabled and a no-op when no provider is configured (default)', async () => {
    expect(ttsEngine.enabled).toBe(false);
    expect(await ttsEngine.synth('hello world')).toBeNull();
  });
});
