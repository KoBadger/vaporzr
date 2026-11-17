import { describe, it, expect } from 'vitest';
import { youtubeFallbackResumeMs } from '../fallbackResume.js';

describe('youtubeFallbackResumeMs', () => {
  it('keeps a mid-track stall position', () => {
    expect(youtubeFallbackResumeMs(137_000, 32_000)).toBe(32_000);
  });

  it('never resumes inside the final second of the track', () => {
    // A stall at the very end must not seek past the last decodable frame —
    // that ended the track instantly on the first fallback attempt.
    expect(youtubeFallbackResumeMs(137_000, 136_500)).toBe(136_000);
    expect(youtubeFallbackResumeMs(137_000, 200_000)).toBe(136_000);
  });

  it('clamps negative and degenerate resumes to 0', () => {
    expect(youtubeFallbackResumeMs(137_000, -5)).toBe(0);
    // Duration shorter than the 1s tail margin: resume from the top.
    expect(youtubeFallbackResumeMs(500, 400)).toBe(0);
  });

  it('starts a fresh (non-stall) fallback at 0', () => {
    expect(youtubeFallbackResumeMs(137_000, 0)).toBe(0);
  });
});
