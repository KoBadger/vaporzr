import { describe, expect, it } from 'vitest';
import {
  AudioWindowBuilder,
  auddConfigured,
  parseAuddResponse,
  pcmEnergy,
  pcmToWav,
  recognizePcm,
} from '../recognize.js';

const RATE = 48_000;
const BYTES_PER_MS = (RATE * 2) / 1000;

/** Mono 16-bit PCM at 48 kHz: a square wave at `amplitude` of full scale. */
function pcmOf(ms: number, amplitude = 0.5): Buffer {
  const samples = Math.round((ms / 1000) * RATE);
  const value = Math.round(amplitude * 32767);
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) pcm.writeInt16LE(i % 2 === 0 ? value : -value, i * 2);
  return pcm;
}

interface FetchCall {
  url: string;
  init: RequestInit;
}

/** A fetch stand-in that records every call and answers with `reply`. */
function capturingFetch(reply: (call: FetchCall) => Response | Promise<Response>): {
  fetchImpl: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return reply(call);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const AUDD_HIT = {
  status: 'success',
  result: {
    artist: 'Burial',
    title: 'Archangel',
    album: 'Untrue',
    release_date: '2007-11-05',
    song_link: 'https://lis.tn/archangel',
  },
};

describe('auddConfigured', () => {
  it('is true only for a non-blank token', () => {
    expect(auddConfigured('an-audD-token')).toBe(true);
    expect(auddConfigured('  an-audD-token  ')).toBe(true);
    expect(auddConfigured('')).toBe(false);
    expect(auddConfigured('   ')).toBe(false);
  });
});

describe('parseAuddResponse', () => {
  it('maps a successful result onto a Recognition', () => {
    expect(parseAuddResponse(AUDD_HIT)).toStrictEqual({
      artist: 'Burial',
      title: 'Archangel',
      album: 'Untrue',
      releaseDate: '2007-11-05',
      songLink: 'https://lis.tn/archangel',
    });
  });

  it('trims whitespace and keeps only the fields that are present', () => {
    expect(parseAuddResponse({ status: 'success', result: { artist: ' Aphex Twin ', title: ' Xtal ' } })).toStrictEqual(
      {
        artist: 'Aphex Twin',
        title: 'Xtal',
      },
    );
  });

  it('ignores optional fields that are not usable strings', () => {
    expect(
      parseAuddResponse({
        status: 'success',
        result: { artist: 'A', title: 'T', album: 7, release_date: null, song_link: {} },
      }),
    ).toStrictEqual({ artist: 'A', title: 'T' });
  });

  it('returns null for the two "nothing found" shapes AudD uses', () => {
    expect(parseAuddResponse({ status: 'error', error: { error_code: 901, error_message: 'no match' } })).toBeNull();
    expect(parseAuddResponse({ status: 'success', result: null })).toBeNull();
  });

  it('returns null for malformed bodies', () => {
    const bodies: unknown[] = [
      null,
      undefined,
      'success',
      42,
      [],
      {},
      { status: 'success' },
      { status: 'success', result: 'Archangel' },
      { status: 'success', result: { title: 'Archangel' } },
      { status: 'success', result: { artist: 'Burial', title: '   ' } },
    ];
    for (const body of bodies) expect(parseAuddResponse(body)).toBeNull();
  });
});

describe('pcmToWav', () => {
  it('writes a complete 44-byte RIFF header ahead of the samples', () => {
    const pcm = Buffer.alloc(1_000, 7);
    const wav = pcmToWav(pcm);
    expect(wav.length).toBe(44 + pcm.length);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.readUInt32LE(4)).toBe(36 + pcm.length);
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.toString('ascii', 12, 16)).toBe('fmt ');
    expect(wav.readUInt32LE(16)).toBe(16);
    expect(wav.readUInt16LE(20)).toBe(1);
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(48_000);
    expect(wav.readUInt32LE(28)).toBe(48_000 * 2);
    expect(wav.readUInt16LE(32)).toBe(2);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.toString('ascii', 36, 40)).toBe('data');
    expect(wav.readUInt32LE(40)).toBe(pcm.length);
    expect(wav.subarray(44).equals(pcm)).toBe(true);
  });

  it('declares a caller-supplied sample rate and channel count', () => {
    const wav = pcmToWav(Buffer.alloc(400, 1), 16_000, 2);
    expect(wav.readUInt32LE(24)).toBe(16_000);
    expect(wav.readUInt16LE(22)).toBe(2);
    expect(wav.readUInt32LE(28)).toBe(16_000 * 2 * 2);
    expect(wav.readUInt16LE(32)).toBe(4);
  });

  it('still produces a readable header for an empty clip', () => {
    const wav = pcmToWav(Buffer.alloc(0));
    expect(wav.length).toBe(44);
    expect(wav.readUInt32LE(40)).toBe(0);
  });
});

describe('pcmEnergy', () => {
  it('is zero for silence and an empty clip', () => {
    expect(pcmEnergy(Buffer.alloc(1_000))).toBe(0);
    expect(pcmEnergy(Buffer.alloc(0))).toBe(0);
  });

  it('reads full scale as 1 and half scale as 0.5', () => {
    expect(pcmEnergy(pcmOf(100, 1))).toBeCloseTo(1, 3);
    expect(pcmEnergy(pcmOf(100, 0.5))).toBeCloseTo(0.5, 3);
    // A single int16 sits halfway between two normalised sample values, so
    // compare against the same binary fraction the sample actually encodes.
    const oneSample = Buffer.alloc(2);
    oneSample.writeInt16LE(16_384);
    expect(pcmEnergy(oneSample)).toBeCloseTo(16_384 / 32_768, 6);
  });
});

describe('AudioWindowBuilder', () => {
  it('releases nothing until a whole default window (12 s) has arrived', () => {
    const builder = new AudioWindowBuilder();
    expect(builder.push(pcmOf(11_900))).toEqual([]);
    expect(builder.pendingMs).toBe(11_900);
    const windows = builder.push(pcmOf(100));
    expect(windows).toHaveLength(1);
    expect(windows[0].length).toBe(12_000 * BYTES_PER_MS);
    expect(builder.pendingMs).toBe(0);
  });

  it('splits one large push into consecutive windows and keeps the remainder', () => {
    const builder = new AudioWindowBuilder({ windowMs: 1_000 });
    const windows = builder.push(pcmOf(2_500));
    expect(windows.map((w) => w.length)).toEqual([1_000 * BYTES_PER_MS, 1_000 * BYTES_PER_MS]);
    expect(builder.pendingMs).toBe(500);
  });

  it('stitches a window out of several smaller pushes in order', () => {
    const builder = new AudioWindowBuilder({ windowMs: 1_000, minRms: 0 });
    const first = Buffer.alloc(300 * BYTES_PER_MS, 1);
    const second = Buffer.alloc(700 * BYTES_PER_MS, 2);
    expect(builder.push(first)).toEqual([]);
    const windows = builder.push(second);
    expect(windows).toHaveLength(1);
    const window = windows[0];
    expect(window.length).toBe(1_000 * BYTES_PER_MS);
    expect(window[0]).toBe(1);
    expect(window[300 * BYTES_PER_MS - 1]).toBe(1);
    expect(window[300 * BYTES_PER_MS]).toBe(2);
    expect(window[window.length - 1]).toBe(2);
  });

  it('drops windows below minRms but still consumes them', () => {
    const builder = new AudioWindowBuilder({ windowMs: 1_000, minRms: 0.05 });
    expect(builder.push(pcmOf(1_000, 0))).toEqual([]);
    expect(builder.push(pcmOf(1_000, 0.03))).toEqual([]);
    // Both quiet windows were consumed, so the next loud one starts fresh.
    expect(builder.pendingMs).toBe(0);
    const windows = builder.push(pcmOf(1_000, 0.2));
    expect(windows).toHaveLength(1);
    expect(builder.pendingMs).toBe(0);
  });

  it('reset() drops the partial window', () => {
    const builder = new AudioWindowBuilder({ windowMs: 1_000 });
    builder.push(pcmOf(600));
    expect(builder.pendingMs).toBe(600);
    builder.reset();
    expect(builder.pendingMs).toBe(0);
    // The 400 ms after the reset must start a new window, not finish the old one.
    expect(builder.push(pcmOf(400))).toEqual([]);
    expect(builder.pendingMs).toBe(400);
    expect(builder.push(pcmOf(600))).toHaveLength(1);
  });

  it('clamps a nonsensical window length instead of looping forever', () => {
    const builder = new AudioWindowBuilder({ windowMs: 0 });
    expect(builder.push(pcmOf(100))).toEqual([]);
    expect(builder.pendingMs).toBe(100);
  });
});

describe('recognizePcm', () => {
  it('posts the clip as a WAV and parses the match', async () => {
    const { fetchImpl, calls } = capturingFetch(() => jsonResponse(AUDD_HIT));
    const clip = pcmOf(5_000, 0.4);
    const recognition = await recognizePcm(clip, { token: 'test-token', fetchImpl });
    expect(recognition).toStrictEqual({
      artist: 'Burial',
      title: 'Archangel',
      album: 'Untrue',
      releaseDate: '2007-11-05',
      songLink: 'https://lis.tn/archangel',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.audd.io/');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);

    const form = calls[0].init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get('api_token')).toBe('test-token');
    expect(form.get('return')).toBe('timecode,apple_music,spotify');
    const file = form.get('file');
    if (typeof file === 'string' || file === null) throw new Error('expected a file part');
    expect(file.name).toBe('clip.wav');
    expect(file.type).toBe('audio/wav');
    const wav = Buffer.from(await file.arrayBuffer());
    expect(wav.length).toBe(44 + clip.length);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.readUInt32LE(24)).toBe(48_000);
    expect(wav.subarray(44).equals(clip)).toBe(true);
  });

  it('declares a non-default sample rate in the uploaded WAV', async () => {
    const { fetchImpl, calls } = capturingFetch(() => jsonResponse(AUDD_HIT));
    const clip = Buffer.alloc(3_200, 3);
    await recognizePcm(clip, { token: 't', fetchImpl, sampleRate: 16_000 });
    const form = calls[0].init.body as FormData;
    const file = form.get('file');
    if (typeof file === 'string' || file === null) throw new Error('expected a file part');
    const wav = Buffer.from(await file.arrayBuffer());
    expect(wav.readUInt32LE(24)).toBe(16_000);
  });

  it('does not call fetch without a token', async () => {
    const { fetchImpl, calls } = capturingFetch(() => jsonResponse(AUDD_HIT));
    expect(await recognizePcm(pcmOf(1_000), { token: '', fetchImpl })).toBeNull();
    expect(await recognizePcm(pcmOf(1_000), { token: '   ', fetchImpl })).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('does not call fetch for an empty clip', async () => {
    const { fetchImpl, calls } = capturingFetch(() => jsonResponse(AUDD_HIT));
    expect(await recognizePcm(Buffer.alloc(0), { token: 't', fetchImpl })).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('returns null for a no-match reply', async () => {
    const { fetchImpl } = capturingFetch(() => jsonResponse({ status: 'success', result: null }));
    expect(await recognizePcm(pcmOf(1_000), { token: 't', fetchImpl })).toBeNull();
  });

  it('returns null when the HTTP request fails', async () => {
    const { fetchImpl } = capturingFetch(() => jsonResponse({ error: 'overloaded' }, 503));
    expect(await recognizePcm(pcmOf(1_000), { token: 't', fetchImpl })).toBeNull();
  });

  it('returns null when the transport throws', async () => {
    const { fetchImpl } = capturingFetch(() => {
      throw new Error('offline');
    });
    expect(await recognizePcm(pcmOf(1_000), { token: 't', fetchImpl })).toBeNull();
  });

  it('returns null when the reply body is not JSON', async () => {
    const { fetchImpl } = capturingFetch(() => new Response('<html>maintenance</html>', { status: 200 }));
    expect(await recognizePcm(pcmOf(1_000), { token: 't', fetchImpl })).toBeNull();
  });

  it('gives up when the request outlives timeoutMs', async () => {
    const fetchImpl = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as typeof fetch;
    const recognition = await recognizePcm(pcmOf(1_000), { token: 't', fetchImpl, timeoutMs: 5 });
    expect(recognition).toBeNull();
  });
});
