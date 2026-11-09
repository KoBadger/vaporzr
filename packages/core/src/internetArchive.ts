/**
 * Internet Archive detail pages (`archive.org/details/<id>`) → playable audio.
 *
 * Uses the public metadata endpoint (no key) to pick an audio file, preferring
 * VBR MP3 and avoiding derivatives like spectrograms or torrents. Public-domain
 * concerts, old radio and films all work; the archive is a good legal source.
 */

export interface ArchiveTrack {
  id: string;
  title: string;
  artist: string;
  durationMs: number;
  streamUrl: string;
  image?: string;
}

export function isArchiveDetailsUrl(input: string): boolean {
  try {
    const u = new URL(input);
    return (u.hostname === 'archive.org' || u.hostname.endsWith('.archive.org')) && u.pathname.startsWith('/details/');
  } catch {
    return false;
  }
}

interface MetadataResponse {
  metadata?: { title?: string; creator?: string | string[]; identifier?: string };
  files?: Array<{ name?: string; format?: string; length?: string; title?: string; track?: string }>;
}

const AUDIO_FORMAT_RE = /(VBR MP3|MP3|Ogg Vorbis|Flac|64Kbps MP3|128Kbps MP3)/i;
const BAD_FILE_RE = /(spectrogram|_files\.xml|\.torrent|\.png|\.jpg|\.gif|\.pdf|\.txt|\.zip)$/i;

/** Resolve an archive.org details page to its first/best audio file. */
export async function resolveInternetArchive(input: string, fetchImpl: typeof fetch = fetch): Promise<ArchiveTrack> {
  const u = new URL(input);
  const id = decodeURIComponent(u.pathname.split('/')[2] ?? '');
  if (!id) throw new Error('That archive.org link has no item id.');
  const res = await fetchImpl(`https://archive.org/metadata/${encodeURIComponent(id)}`, {
    headers: { 'User-Agent': 'Vaporzr/1.0' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Internet Archive returned HTTP ${res.status}`);
  const json = (await res.json()) as MetadataResponse;
  const files = (json.files ?? []).filter(
    (f) => f.name && AUDIO_FORMAT_RE.test(String(f.format ?? '')) && !BAD_FILE_RE.test(String(f.name)),
  );
  // Prefer VBR MP3, then any MP3, then the first audio file.
  const ranked =
    files.find((f) => /VBR MP3/i.test(String(f.format))) ??
    files.find((f) => /MP3/i.test(String(f.format))) ??
    files[0];
  if (!ranked?.name) throw new Error('That archive.org item has no audio files.');
  const creator = json.metadata?.creator;
  return {
    id,
    title: String(ranked.title ?? json.metadata?.title ?? ranked.name),
    artist: String(Array.isArray(creator) ? (creator[0] ?? 'Internet Archive') : (creator ?? 'Internet Archive')),
    durationMs: Math.max(0, Number(ranked.length) || 0) * 1000,
    streamUrl: `https://archive.org/download/${encodeURIComponent(id)}/${ranked.name
      .split('/')
      .map(encodeURIComponent)
      .join('/')}`,
  };
}
