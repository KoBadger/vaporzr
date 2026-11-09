import { describe, expect, it, vi } from 'vitest';
import { isArchiveDetailsUrl, resolveInternetArchive } from '../internetArchive.js';

describe('isArchiveDetailsUrl', () => {
  it('matches archive.org details pages', () => {
    expect(isArchiveDetailsUrl('https://archive.org/details/gd1977-05-08')).toBe(true);
    expect(isArchiveDetailsUrl('https://archive.org/download/x/y.mp3')).toBe(false);
    expect(isArchiveDetailsUrl('https://example.com/details/x')).toBe(false);
  });
});

describe('resolveInternetArchive', () => {
  it('prefers VBR MP3 and builds a download URL', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        metadata: { title: 'Show', creator: ['Band'] },
        files: [
          { name: 'show.ogg', format: 'Ogg Vorbis', length: '10' },
          { name: 'show_vbr.mp3', format: 'VBR MP3', length: '180', title: 'Track 1' },
          { name: 'show.png', format: 'PNG' },
        ],
      }),
    })) as unknown as typeof fetch;
    expect(await resolveInternetArchive('https://archive.org/details/show', fetchImpl)).toEqual({
      id: 'show',
      title: 'Track 1',
      artist: 'Band',
      durationMs: 180_000,
      streamUrl: 'https://archive.org/download/show/show_vbr.mp3',
    });
  });

  it('throws when no audio exists', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ metadata: {}, files: [{ name: 'x.png', format: 'PNG' }] }),
    })) as unknown as typeof fetch;
    await expect(resolveInternetArchive('https://archive.org/details/x', fetchImpl)).rejects.toThrow();
  });
});
