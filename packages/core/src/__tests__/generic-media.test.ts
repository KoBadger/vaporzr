import { describe, expect, it } from 'vitest';
import { isGenericMediaUrl } from '../youtube.js';

describe('isGenericMediaUrl', () => {
  it('accepts arbitrary http(s) media pages so yt-dlp can try them', () => {
    expect(isGenericMediaUrl('https://feeds.simplecast.com/54nAGcIl')).toBe(true);
    expect(isGenericMediaUrl('https://vimeo.com/123456')).toBe(true);
    expect(isGenericMediaUrl('https://www.twitch.tv/videos/123')).toBe(true);
    expect(isGenericMediaUrl('https://example.com/movie-clip')).toBe(true);
    expect(isGenericMediaUrl('http://example.com/audio')).toBe(true);
  });

  it('keeps the hosts with dedicated resolvers out of the yt-dlp fallback', () => {
    expect(isGenericMediaUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(false);
    expect(isGenericMediaUrl('https://youtu.be/dQw4w9WgXcQ')).toBe(false);
    expect(isGenericMediaUrl('https://open.spotify.com/track/abc')).toBe(false);
    expect(isGenericMediaUrl('https://soundcloud.com/artist/track')).toBe(false);
    expect(isGenericMediaUrl('https://music.apple.com/us/album/x/1')).toBe(false);
    expect(isGenericMediaUrl('https://suno.com/song/abc')).toBe(false);
  });

  it('still accepts the original host allowlist through the generic path', () => {
    expect(isGenericMediaUrl('https://artist.bandcamp.com/track/song')).toBe(true);
    expect(isGenericMediaUrl('https://www.mixcloud.com/dj/set')).toBe(true);
  });

  it('rejects non-URLs and unsupported schemes', () => {
    expect(isGenericMediaUrl('just a search query')).toBe(false);
    expect(isGenericMediaUrl('ftp://example.com/song.mp3')).toBe(false);
    expect(isGenericMediaUrl('magnet:?xt=urn:btih:abc')).toBe(false);
  });
});
