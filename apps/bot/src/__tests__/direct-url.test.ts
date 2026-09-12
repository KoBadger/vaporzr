import { describe, it, expect } from 'vitest';
import { isDirectMediaUrl } from '../discord.js';

describe('isDirectMediaUrl', () => {
  it('accepts common media extensions', () => {
    expect(isDirectMediaUrl('https://example.com/audio.wav')).toBe(true);
    expect(isDirectMediaUrl('https://example.com/audio.mp3')).toBe(true);
    expect(isDirectMediaUrl('https://example.com/audio.flac')).toBe(true);
    expect(isDirectMediaUrl('https://example.com/audio.ogg')).toBe(true);
    expect(isDirectMediaUrl('https://example.com/audio.m4a')).toBe(true);
    expect(isDirectMediaUrl('https://example.com/video.mp4')).toBe(true);
    expect(isDirectMediaUrl('https://example.com/video.webm')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isDirectMediaUrl('https://example.com/audio.WAV')).toBe(true);
    expect(isDirectMediaUrl('https://example.com/audio.Mp3')).toBe(true);
  });

  it('ignores query strings when checking the extension', () => {
    expect(isDirectMediaUrl('https://example.com/audio.wav?download=1&token=abc')).toBe(true);
  });

  it('accepts http as well as https', () => {
    expect(isDirectMediaUrl('http://example.com/audio.wav')).toBe(true);
  });

  it('rejects non-web URLs', () => {
    expect(isDirectMediaUrl('spotify:track:0123456789abcdefghijkl')).toBe(false);
    expect(isDirectMediaUrl('ftp://example.com/audio.wav')).toBe(false);
    expect(isDirectMediaUrl('')).toBe(false);
  });

  it('rejects URLs without a media extension', () => {
    expect(isDirectMediaUrl('https://example.com/audio')).toBe(false);
    expect(isDirectMediaUrl('https://example.com/page.html')).toBe(false);
    expect(isDirectMediaUrl('https://example.com/audio.wavx')).toBe(false);
  });

  it('rejects non-URL text and malformed input', () => {
    expect(isDirectMediaUrl('just some song lyrics')).toBe(false);
    expect(isDirectMediaUrl('https://')).toBe(false);
  });

  it('rejects YouTube URLs (they go through the normal resolver)', () => {
    expect(isDirectMediaUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(false);
    expect(isDirectMediaUrl('https://youtu.be/dQw4w9WgXcQ')).toBe(false);
  });
});