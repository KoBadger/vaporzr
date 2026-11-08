import { config } from './config.js';

/**
 * AudD recognition for the tape's ears.
 *
 * `/tape` logs what Vaporzr plays for free — the queue already carries full
 * metadata. Music coming from *other* sources in the voice channel arrives as
 * bare PCM instead, so naming it means asking a recognition service. AudD takes
 * a short WAV upload and answers with artist/title/album, which is enough to
 * resolve a playable track afterwards.
 *
 * Two rules keep that worth doing. Uploading silence or room tone spends a
 * quota unit to be told "no match", so `AudioWindowBuilder` only releases whole
 * windows that clear an RMS floor. And recognition is an enhancement to a tape
 * that is already useful, so every failure here — no token, network error,
 * timeout, malformed reply — returns null rather than throwing into the voice
 * pipeline.
 */

export interface Recognition {
  artist: string;
  title: string;
  album?: string;
  releaseDate?: string;
  songLink?: string;
}

export interface RecognizeOptions {
  /** AudD token. Defaults to `config.auddToken`; an explicit '' forces it off. */
  token?: string;
  /** Budget for the upload + reply. Defaults to 15 s. */
  timeoutMs?: number;
  /** Injected by tests; the global fetch is used otherwise. */
  fetchImpl?: typeof fetch;
  /** Sample rate of the supplied PCM, declared in the WAV header. Defaults to 48 kHz. */
  sampleRate?: number;
}

const AUDD_URL = 'https://api.audd.io/';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_SAMPLE_RATE = 48_000;
/** AudD needs a handful of seconds to fingerprint; 12 s also keeps uploads small. */
const DEFAULT_WINDOW_MS = 12_000;
/**
 * About -40 dBFS. Decoded channel silence and codec noise sit far below it, while
 * music that is actually audible clears it comfortably.
 */
const DEFAULT_MIN_RMS = 0.01;
const BYTES_PER_SAMPLE = 2;
/** Mono 48 kHz: 96 bytes per millisecond, which is what the window maths assumes. */
const BYTES_PER_MS = (DEFAULT_SAMPLE_RATE * BYTES_PER_SAMPLE) / 1000;

/** True when a token is available, so callers can hide the feature when it is not. */
export function auddConfigured(token?: string): boolean {
  return !!(token ?? config.auddToken).trim();
}

function positiveOr(value: number | undefined, fallback: number): number {
  return value != null && Number.isFinite(value) && value > 0 ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** The useful non-empty form of a string field, or null for anything else. */
function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Parse the AudD search response (snake_case) into the shape the tape wants.
 *
 * AudD reports "no match" as status success with a null result, and every other
 * failure through the same 200 response, so the status/result checks here are
 * what turn a reply into a track or nothing at all.
 */
export function parseAuddResponse(json: unknown): Recognition | null {
  if (!isRecord(json) || json.status !== 'success' || !isRecord(json.result)) return null;
  const result = json.result;
  const artist = text(result.artist);
  const title = text(result.title);
  if (!artist || !title) return null;
  const out: Recognition = { artist, title };
  const album = text(result.album);
  const releaseDate = text(result.release_date);
  const songLink = text(result.song_link);
  if (album) out.album = album;
  if (releaseDate) out.releaseDate = releaseDate;
  if (songLink) out.songLink = songLink;
  return out;
}

/**
 * Wrap mono 16-bit PCM in a RIFF/WAVE container (default 48 kHz, one channel);
 * `channels` > 1 expects the samples to already be interleaved.
 *
 * The header fields are unsigned integers, so a zero or NaN rate would declare
 * a file no decoder can open — clamp to something playable instead.
 */
export function pcmToWav(pcm: Buffer, sampleRate = DEFAULT_SAMPLE_RATE, channels = 1): Buffer {
  const rate = Number.isFinite(sampleRate) ? Math.max(1, Math.floor(sampleRate)) : DEFAULT_SAMPLE_RATE;
  const chans = Number.isFinite(channels) ? Math.max(1, Math.min(65_535, Math.floor(channels))) : 1;
  const dataSize = pcm.length;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // fmt chunk size for PCM
  header.writeUInt16LE(1, 20); // format 1 = uncompressed 16-bit PCM
  header.writeUInt16LE(chans, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * chans * BYTES_PER_SAMPLE, 28); // average bytes per second
  header.writeUInt16LE(chans * BYTES_PER_SAMPLE, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * RMS energy of mono 16-bit PCM on the 0..1 scale. Linear rather than dB so the
 * window gate's `minRms` is in the same units the caller can reason about.
 */
export function pcmEnergy(pcm: Buffer): number {
  const samples = Math.floor(pcm.length / 2);
  if (samples === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const sample = pcm.readInt16LE(i * 2) / 32768;
    sum += sample * sample;
  }
  return Math.min(1, Math.sqrt(sum / samples));
}

/**
 * Identify a clip of mono 16-bit PCM through AudD. Best-effort: null for a
 * missing token, an empty clip, a timeout, a transport error, a non-2xx reply,
 * or a reply that does not name a track. Never throws.
 */
export async function recognizePcm(pcmMono48k: Buffer, opts: RecognizeOptions = {}): Promise<Recognition | null> {
  const token = (opts.token ?? config.auddToken).trim();
  // An empty upload cannot match anything, and AudD would charge a request to say so.
  if (!token || pcmMono48k.length === 0) return null;

  const form = new FormData();
  form.append('api_token', token);
  form.append('return', 'timecode,apple_music,spotify');
  // Buffer's ArrayBufferLike backing type is wider than BlobPart's
  // ArrayBufferView<ArrayBuffer> under newer @types/node; the bytes are a
  // plain WAV buffer, so narrow it for the Blob constructor.
  const wav = pcmToWav(pcmMono48k, opts.sampleRate ?? DEFAULT_SAMPLE_RATE);
  form.append('file', new Blob([wav as unknown as BlobPart], { type: 'audio/wav' }), 'clip.wav');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), positiveOr(opts.timeoutMs, DEFAULT_TIMEOUT_MS));
  try {
    const fetchImpl = opts.fetchImpl ?? fetch;
    const res = await fetchImpl(AUDD_URL, { method: 'POST', body: form, signal: controller.signal });
    if (!res.ok) return null;
    return parseAuddResponse(await res.json());
  } catch {
    // Timeouts, DNS/network failures and unreadable JSON all mean "not identified".
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Accumulates the room mix into fixed, non-overlapping windows and releases only
 * the ones worth uploading.
 *
 * Windows are anchored to the stream position rather than to quiet/loud edges:
 * AudD fingerprints a whole clip, so a window that starts mid-phrase is fine,
 * and a fixed grid keeps the cadence (and the API cost) predictable. A quiet
 * window is dropped, not buffered, so it cannot smear into the next one.
 */
export class AudioWindowBuilder {
  private readonly windowBytes: number;
  private readonly minRms: number;
  private chunks: Buffer[] = [];
  private buffered = 0;

  constructor(opts: { windowMs?: number; minRms?: number } = {}) {
    const windowMs = positiveOr(opts.windowMs, DEFAULT_WINDOW_MS);
    // A window shorter than one sample would make push() loop forever.
    this.windowBytes = Math.max(BYTES_PER_SAMPLE, Math.round(windowMs * BYTES_PER_MS));
    const minRms = opts.minRms ?? DEFAULT_MIN_RMS;
    this.minRms = Number.isFinite(minRms) ? Math.min(1, Math.max(0, minRms)) : DEFAULT_MIN_RMS;
  }

  /** Audio held back so far, in milliseconds — always less than one window. */
  get pendingMs(): number {
    return Math.round(this.buffered / BYTES_PER_MS);
  }

  /**
   * Add mono 48 kHz PCM and return every whole window it completes that clears
   * the energy gate. Below-gate windows are consumed too, so one quiet stretch
   * does not shift every boundary after it.
   */
  push(chunk: Buffer): Buffer[] {
    if (chunk.length > 0) {
      this.chunks.push(chunk);
      this.buffered += chunk.length;
    }
    const windows: Buffer[] = [];
    while (this.buffered >= this.windowBytes) {
      const window = this.take(this.windowBytes);
      if (pcmEnergy(window) >= this.minRms) windows.push(window);
    }
    return windows;
  }

  /** Drop the partial window as well as anything unread (voice channel left / ears off). */
  reset(): void {
    this.chunks = [];
    this.buffered = 0;
  }

  /** Remove exactly `bytes` from the head of the chunk queue. */
  private take(bytes: number): Buffer {
    const head = this.chunks[0];
    if (head.length >= bytes) {
      const out = head.subarray(0, bytes);
      if (head.length === bytes) this.chunks.shift();
      else this.chunks[0] = head.subarray(bytes);
      this.buffered -= bytes;
      return out;
    }
    // This window spans several pushed chunks; copy just the window out of them.
    const out = Buffer.allocUnsafe(bytes);
    let filled = 0;
    while (filled < bytes) {
      const chunk = this.chunks[0];
      const consumed = Math.min(chunk.length, bytes - filled);
      chunk.copy(out, filled, 0, consumed);
      filled += consumed;
      if (consumed === chunk.length) this.chunks.shift();
      else this.chunks[0] = chunk.subarray(consumed);
    }
    this.buffered -= bytes;
    return out;
  }
}
