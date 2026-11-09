/**
 * Odesli / Songlink — keyless cross-platform link resolution.
 *
 * Given any supported streaming URL it returns the same entity on other
 * platforms. Used as a fallback when a Spotify/YouTube link cannot be resolved
 * directly: finding the YouTube mirror often keeps the request playable.
 */

export interface SonglinkLinks {
  youtube?: string;
  youtubeMusic?: string;
  spotify?: string;
  appleMusic?: string;
  soundcloud?: string;
}

interface Response {
  linksByPlatform?: Record<string, { url?: string } | undefined>;
}

export async function resolveSonglink(url: string, fetchImpl: typeof fetch = fetch): Promise<SonglinkLinks | null> {
  try {
    const res = await fetchImpl(
      `https://api.song.link/v1-alpha.1/links?url=${encodeURIComponent(url)}&userCountry=US`,
      { headers: { 'User-Agent': 'Vaporzr/1.0' }, signal: AbortSignal.timeout(9000) },
    );
    if (!res.ok) return null;
    const json = (await res.json()) as Response;
    const at = (key: string): string | undefined => json.linksByPlatform?.[key]?.url;
    const links: SonglinkLinks = {
      youtube: at('youtube'),
      youtubeMusic: at('youtubeMusic'),
      spotify: at('spotify'),
      appleMusic: at('appleMusic'),
      soundcloud: at('soundcloud'),
    };
    return Object.values(links).some(Boolean) ? links : null;
  } catch {
    return null;
  }
}
