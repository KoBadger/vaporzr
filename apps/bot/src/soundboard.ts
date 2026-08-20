import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { config } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface SfxSound {
  id: string;
  name: string;
  emoji: string;
}

export const SFX_LIST: SfxSound[] = [
  { id: 'riser', name: 'Riser', emoji: '📈' },
  { id: 'reverse', name: 'Reverse', emoji: '↩️' },
  { id: 'drop', name: 'Drop', emoji: '💥' },
  { id: 'boom', name: 'Boom', emoji: '💣' },
  { id: 'zap', name: 'Zap', emoji: '⚡' },
  { id: 'airhorn', name: 'Air horn', emoji: '📣' },
  { id: 'applause', name: 'Applause', emoji: '👏' },
  { id: 'countdown', name: 'Countdown', emoji: '🔟' },
];

export function sfxById(id: string): SfxSound | undefined {
  return SFX_LIST.find((s) => s.id === id);
}

/** Measure the loudest sample (0..1) of a WAV via ffmpeg's volumedetect. */
function detectPeak(filePath: string): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn(
      config.ffmpegPath,
      ['-hide_banner', '-loglevel', 'info', '-i', filePath, '-af', 'volumedetect', '-f', 'null', '-'],
      { windowsHide: true },
    );
    let stderr = '';
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('error', () => resolve(1));
    proc.on('exit', () => {
      const m = /max_volume:\s*([-\d.]+)\s*dB/.exec(stderr);
      resolve(m ? Math.pow(10, Number(m[1]) / 20) : 1);
    });
  });
}

/**
 * Decode a WAV into 48 kHz stereo Int16 PCM via ffmpeg. The bundled samples
 * are quiet (~-20 dB), so each is normalized to a consistent peak — otherwise
 * they're inaudible over the music and sound washed out.
 */
async function decodePcm(filePath: string): Promise<Buffer> {
  const peak = await detectPeak(filePath);
  // Keep headroom (and cap the boost) so the SFX doesn't hard-clip the mix.
  const TARGET_PEAK = 0.55;
  const gain = Math.min(20, Math.max(1, TARGET_PEAK / Math.max(peak, 0.001)));
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const proc = spawn(
      config.ffmpegPath,
      ['-hide_banner', '-loglevel', 'error', '-i', filePath, '-af', `volume=${gain.toFixed(3)}`, '-ac', '2', '-ar', '48000', '-f', 's16le', 'pipe:1'],
      { windowsHide: true },
    );
    proc.stdout.on('data', (d) => chunks.push(d as Buffer));
    let stderr = '';
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('error', (err) => reject(err));
    proc.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg decode failed (${code}): ${stderr.slice(0, 200)}`));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
  });
}

/**
 * Per-guild DJ soundboard toggle (persisted). When enabled, /sfx, panel
 * buttons, and sound effects are allowed; otherwise playback stays clean.
 */
export class DjManager {
  private enabled = new Map<string, boolean>();
  private pcmCache = new Map<string, Buffer>();

  constructor() {
    this.load();
  }

  private file(): string {
    return path.join(config.dataDir, 'dj.json');
  }

  private load(): void {
    try {
      const data = JSON.parse(fs.readFileSync(this.file(), 'utf8')) as Record<string, boolean>;
      for (const [guildId, on] of Object.entries(data)) {
        if (typeof on === 'boolean') this.enabled.set(guildId, on);
      }
    } catch {
      /* no config yet */
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(config.dataDir, { recursive: true });
      fs.writeFileSync(this.file(), JSON.stringify(Object.fromEntries(this.enabled), null, 2), 'utf8');
    } catch {
      /* non-fatal */
    }
  }

  isEnabled(guildId: string): boolean {
    return this.enabled.get(guildId) ?? false;
  }

  setEnabled(guildId: string, on: boolean): void {
    this.enabled.set(guildId, on);
    this.save();
  }

  list(): SfxSound[] {
    return SFX_LIST;
  }

  /** Decoded 48 kHz stereo Int16 PCM for an effect (cached), or null if unknown. */
  async getPcm(id: string): Promise<Buffer | null> {
    if (this.pcmCache.has(id)) return this.pcmCache.get(id) ?? null;
    if (!sfxById(id)) return null;
    const filePath = path.join(__dirname, '..', 'assets', 'sfx', `${id}.wav`);
    if (!fs.existsSync(filePath)) return null;
    const pcm = await decodePcm(filePath);
    this.pcmCache.set(id, pcm);
    return pcm;
  }
}

export const dj = new DjManager();
