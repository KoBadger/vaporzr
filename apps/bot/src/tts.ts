import { spawn } from 'node:child_process';
import { config } from './config.js';

export interface TtsClip {
  /** 48 kHz stereo Int16 PCM, ready for the voice mixer. */
  pcm: Buffer;
  durationMs: number;
}

const MAX_TEXT = 220;
const CACHE_LIMIT = 64;

/** Strip anything a TTS voice can't say and clamp length. Exported for tests. */
export function sanitizeTtsText(text: string): string {
  return text
    .replace(/[^\p{L}\p{N} .,!?'’\-:&()]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TEXT);
}

/**
 * Optional DJ text-to-speech. Off unless TTS_PROVIDER is set to a real engine;
 * per-guild opt-in happens above this layer. Local/offline (espeak-ng) so it
 * never adds a network dependency or per-line cost, and results are cached so a
 * repeated "Now playing" line is free.
 */
export class TtsEngine {
  private cache = new Map<string, TtsClip>();
  private unavailable = false;

  get enabled(): boolean {
    return config.ttsProvider !== 'off' && !this.unavailable;
  }

  async synth(text: string): Promise<TtsClip | null> {
    if (!this.enabled) return null;
    const clean = sanitizeTtsText(text);
    if (!clean) return null;
    const key = `${config.ttsProvider}:${clean}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    if (config.ttsProvider === 'espeak') return this.synthEspeak(key, clean);
    return null;
  }

  private remember(key: string, clip: TtsClip): void {
    this.cache.set(key, clip);
    if (this.cache.size > CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
  }

  /** espeak-ng writes a WAV to stdout; ffmpeg resamples it to 48 kHz stereo PCM. */
  private synthEspeak(key: string, text: string): Promise<TtsClip | null> {
    return new Promise((resolve) => {
      let settled = false;
      const out: Buffer[] = [];
      const finish = (clip: TtsClip | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          engine.kill();
        } catch {
          /* ignore */
        }
        try {
          ff.kill();
        } catch {
          /* ignore */
        }
        if (clip) this.remember(key, clip);
        resolve(clip);
      };

      let engine: ReturnType<typeof spawn>;
      let ff: ReturnType<typeof spawn>;
      try {
        engine = spawn(config.espeakPath, ['--stdout', '-v', 'en-us', '-s', '165', text], { windowsHide: true });
        ff = spawn(
          config.ffmpegPath,
          ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-ac', '2', '-ar', '48000', '-f', 's16le', 'pipe:1'],
          { windowsHide: true },
        );
      } catch {
        this.unavailable = true;
        return;
      }

      const timer = setTimeout(() => finish(null), 12_000);
      timer.unref?.();

      engine.on('error', () => {
        // espeak-ng not installed / not executable — stop trying.
        this.unavailable = true;
        finish(null);
      });
      engine.stderr?.on('data', () => {});
      engine.stdout?.on('error', () => {});
      ff.on('error', () => finish(null));
      ff.stdin?.on('error', () => {}); // EPIPE when we kill ffmpeg early
      ff.stderr?.on('data', () => {});
      ff.stdout?.on('data', (d: Buffer) => {
        out.push(d);
      });
      ff.on('exit', () => {
        const pcm = Buffer.concat(out);
        if (!pcm.length) {
          finish(null);
          return;
        }
        finish({ pcm, durationMs: Math.round((pcm.length / 4 / 48000) * 1000) });
      });

      if (!engine.stdout) {
        finish(null);
        return;
      }
      engine.stdout.pipe(ff.stdin!);
    });
  }
}

/** Process-wide TTS engine (config-driven; disabled unless configured). */
export const ttsEngine = new TtsEngine();
