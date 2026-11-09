/**
 * Internet radio presets and Radio Browser search (free, no key).
 *
 * Streams are plain HTTP(S) audio, so they ride the existing direct-media path.
 * Nightwave Plaza / SomaFM fit the vaporwave/ambient brand; Radio Browser covers
 * everything else (https://www.radio-browser.info).
 */

export interface RadioStation {
  id: string;
  name: string;
  url: string;
  genre: string;
  homepage?: string;
}

export const RADIO_PRESETS: RadioStation[] = [
  {
    id: 'nightwave',
    name: 'Nightwave Plaza',
    url: 'https://radio.plaza.one/mp3',
    genre: 'vaporwave',
    homepage: 'https://plaza.one',
  },
  {
    id: 'groovesalad',
    name: 'SomaFM Groove Salad',
    url: 'https://ice1.somafm.com/groovesalad-128-mp3',
    genre: 'downtempo',
    homepage: 'https://somafm.com/groovesalad/',
  },
  {
    id: 'dronezone',
    name: 'SomaFM Drone Zone',
    url: 'https://ice1.somafm.com/dronezone-128-mp3',
    genre: 'ambient',
    homepage: 'https://somafm.com/dronezone/',
  },
  {
    id: 'lush',
    name: 'SomaFM Lush',
    url: 'https://ice1.somafm.com/lush-128-mp3',
    genre: 'vocal chill',
    homepage: 'https://somafm.com/lush/',
  },
  {
    id: 'radioparadise',
    name: 'Radio Paradise',
    url: 'https://stream.radioparadise.com/mp3-128',
    genre: 'eclectic',
    homepage: 'https://radioparadise.com',
  },
  {
    id: 'nts1',
    name: 'NTS Radio 1',
    url: 'https://stream-relay-geo.ntslive.net/stream',
    genre: 'eclectic',
    homepage: 'https://www.nts.live',
  },
  {
    id: 'nts2',
    name: 'NTS Radio 2',
    url: 'https://stream-relay-geo.ntslive.net/stream2',
    genre: 'eclectic',
    homepage: 'https://www.nts.live',
  },
];

/** Find a preset by id, exact name or substring. */
export function findRadioPreset(query: string): RadioStation | null {
  const q = String(query ?? '')
    .trim()
    .toLowerCase();
  if (!q) return null;
  return (
    RADIO_PRESETS.find((s) => s.id === q) ??
    RADIO_PRESETS.find((s) => s.name.toLowerCase() === q) ??
    RADIO_PRESETS.find((s) => s.name.toLowerCase().includes(q) || s.genre.toLowerCase().includes(q)) ??
    null
  );
}

interface BrowserStation {
  stationuuid?: string;
  name?: string;
  url_resolved?: string;
  tags?: string;
  homepage?: string;
}

/** Search the public Radio Browser directory. Never throws. */
export async function searchRadioBrowser(
  query: string,
  fetchImpl: typeof fetch = fetch,
  limit = 5,
): Promise<RadioStation[]> {
  const q = String(query ?? '').trim();
  if (q.length < 2) return [];
  try {
    const url =
      'https://de1.api.radio-browser.info/json/stations/search' +
      `?name=${encodeURIComponent(q)}&limit=${limit}&hidebroken=true&order=clickcount&reverse=true`;
    const res = await fetchImpl(url, {
      headers: { 'User-Agent': 'Vaporzr/1.0' },
      signal: AbortSignal.timeout(7000),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as BrowserStation[];
    if (!Array.isArray(json)) return [];
    return json
      .filter((s): s is BrowserStation & { url_resolved: string; name: string } =>
        Boolean(s?.url_resolved && s?.name && /^https?:\/\//i.test(s.url_resolved)),
      )
      .map((s) => ({
        id: String(s.stationuuid ?? s.name),
        name: String(s.name).trim(),
        url: String(s.url_resolved),
        genre: String(s.tags ?? 'radio')
          .split(',')
          .slice(0, 2)
          .join(', '),
        homepage: s.homepage,
      }));
  } catch {
    return [];
  }
}
