import { Buffer } from 'node:buffer';
import gifencPkg from 'gifenc';

const { GIFEncoder, applyPalette } = gifencPkg;

const WIDTH = 320;
const HEIGHT = 180;
const BARS = 24;
const FFT_SIZE = 2048;
const SAMPLE_RATE = 48000;
const FRAME_MS = 125; // 8 fps snapshot history
const HISTORY_SNAPSHOTS = 64; // ~8s of bars
const F_MIN = 60;
const F_MAX = 12000;

/** Fixed 256-color palette: index 0 = background, 1..254 = hue gradient, 255 = white. */
const PALETTE: Array<[number, number, number]> = buildPalette();

/** Static background layer (RGBA), copied into every frame. */
const BACKGROUND = renderBackground();

const BUCKETS: Array<[number, number]> = [];
for (let b = 0; b < BARS; b++) {
  BUCKETS.push([F_MIN * Math.pow(F_MAX / F_MIN, b / BARS), F_MIN * Math.pow(F_MAX / F_MIN, (b + 1) / BARS)]);
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let rgb: [number, number, number];
  if (h < 60) rgb = [c, x, 0];
  else if (h < 120) rgb = [x, c, 0];
  else if (h < 180) rgb = [0, c, x];
  else if (h < 240) rgb = [0, x, c];
  else if (h < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return [Math.round((rgb[0] + m) * 255), Math.round((rgb[1] + m) * 255), Math.round((rgb[2] + m) * 255)];
}

function buildPalette(): Array<[number, number, number]> {
  const pal: Array<[number, number, number]> = [[12, 10, 20]];
  for (let i = 0; i < 254; i++) {
    const hue = 260 - (230 * i) / 253; // purple -> magenta -> orange
    pal.push(hslToRgb(hue, 0.85, 0.55));
  }
  pal.push([250, 250, 250]);
  return pal;
}

function gradientColor(t: number): [number, number, number] {
  const idx = Math.max(1, Math.min(254, Math.round(t * 253)));
  return PALETTE[idx];
}

function renderBackground(): Uint8Array {
  const data = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++) {
    const shade = Math.round(1 - (y / HEIGHT) * 0.35);
    for (let x = 0; x < WIDTH; x++) {
      const o = (y * WIDTH + x) * 4;
      data[o] = 12 * shade;
      data[o + 1] = 10 * shade;
      data[o + 2] = 20 * shade;
      data[o + 3] = 255;
    }
  }
  return data;
}

function renderFrame(bars: number[]): Uint8Array {
  const data = new Uint8Array(BACKGROUND);
  const marginBottom = 24;
  const topMargin = 10;
  const usableH = HEIGHT - marginBottom - topMargin;
  const slot = WIDTH / BARS;
  const barW = Math.max(2, Math.floor(slot * 0.55));
  for (let b = 0; b < BARS; b++) {
    const v = Math.max(0, Math.min(1, bars[b] ?? 0));
    const h = Math.max(2, Math.round(v * usableH));
    const x0 = Math.floor(b * slot + (slot - barW) / 2);
    const y0 = HEIGHT - marginBottom - h;
    const [r, g, bl] = gradientColor(b / (BARS - 1));
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < barW; x++) {
        const o = ((y0 + y) * WIDTH + x0 + x) * 4;
        data[o] = r;
        data[o + 1] = g;
        data[o + 2] = bl;
        data[o + 3] = 255;
      }
    }
    if (h >= 2) {
      for (let x = 0; x < barW; x++) {
        const o = (y0 * WIDTH + x0 + x) * 4;
        data[o] = 250;
        data[o + 1] = 250;
        data[o + 2] = 250;
        data[o + 3] = 255;
      }
    }
  }
  return data;
}

function encodeGif(frames: Uint8Array[], delay: number): Buffer {
  const gif = GIFEncoder();
  for (const rgba of frames) {
    const index = applyPalette(rgba, PALETTE);
    gif.writeFrame(index, WIDTH, HEIGHT, { palette: PALETTE, delay });
  }
  gif.finish();
  return Buffer.from(gif.bytes());
}

/** Radix-2 iterative FFT in place. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curR = 1;
      let curI = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = re[i + k];
        const b = im[i + k];
        const c = re[i + k + len / 2];
        const d = im[i + k + len / 2];
        const tR = c * curR - d * curI;
        const tI = c * curI + d * curR;
        re[i + k] = a + tR;
        im[i + k] = b + tI;
        re[i + k + len / 2] = a - tR;
        im[i + k + len / 2] = b - tI;
        const nextR = curR * wr - curI * wi;
        curI = curR * wi + curI * wr;
        curR = nextR;
      }
    }
  }
}

const HANN: Float64Array = (() => {
  const w = new Float64Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)));
  return w;
})();

class RingBuffer {
  private buf: Float32Array;
  private head = 0;
  private count = 0;
  constructor(size: number) {
    this.buf = new Float32Array(size);
  }
  push(v: number): void {
    this.buf[this.head] = v;
    this.head = (this.head + 1) % this.buf.length;
    if (this.count < this.buf.length) this.count++;
  }
  /** k-th most recent sample (0 = newest). */
  get(k: number): number {
    if (k >= this.count) return 0;
    return this.buf[(this.head - 1 - k + this.buf.length * 2) % this.buf.length];
  }
}

const ring = new RingBuffer(SAMPLE_RATE * 6); // 6s of mono history
const barHistory: Array<{ at: number; bars: number[] }> = [];
let smoothed = new Array<number>(BARS).fill(0);
let lastPcmAt = 0;
let ticker: NodeJS.Timeout | null = null;

function computeBars(): { bars: number[]; quiet: boolean } {
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  let sumSq = 0;
  for (let i = 0; i < FFT_SIZE; i++) {
    const s = ring.get(FFT_SIZE - 1 - i);
    sumSq += s * s;
    re[i] = s * HANN[i];
  }
  fft(re, im);
  const mags = new Float32Array(FFT_SIZE / 2);
  for (let k = 0; k < FFT_SIZE / 2; k++) mags[k] = Math.hypot(re[k], im[k]) / (FFT_SIZE / 2);

  const raw = new Array<number>(BARS).fill(0);
  const binHz = SAMPLE_RATE / FFT_SIZE;
  for (let b = 0; b < BARS; b++) {
    const [f0, f1] = BUCKETS[b];
    const k0 = Math.max(1, Math.floor(f0 / binHz));
    const k1 = Math.min(FFT_SIZE / 2 - 1, Math.ceil(f1 / binHz));
    let acc = 0;
    for (let k = k0; k <= k1; k++) acc += mags[k];
    raw[b] = Math.log1p(acc / (k1 - k0 + 1));
  }
  const mx = Math.max(...raw, 1e-6);
  const rms = Math.sqrt(sumSq / FFT_SIZE);
  const quiet = rms < 0.004;
  const bars = raw.map((v) => (quiet ? 0 : Math.max(0, Math.min(1, v / mx))));
  return { bars, quiet };
}

function tick(): void {
  const { bars, quiet } = computeBars();
  for (let i = 0; i < BARS; i++) smoothed[i] = smoothed[i] + 0.35 * (bars[i] - smoothed[i]);
  barHistory.push({ at: Date.now(), bars: [...smoothed] });
  if (barHistory.length > HISTORY_SNAPSHOTS) barHistory.shift();
  if (Date.now() - lastPcmAt > 3000) {
    if (smoothed.every((v) => v < 0.02)) stopTicker();
  }
}

function ensureTicker(): void {
  if (ticker) return;
  ticker = setInterval(tick, FRAME_MS);
  ticker.unref?.();
}

function stopTicker(): void {
  if (ticker) {
    clearInterval(ticker);
    ticker = null;
  }
}

function renderGif(ms = 2400, fps = 8): Buffer | null {
  if (barHistory.length === 0) return null;
  const frameMs = Math.round(1000 / fps);
  const now = Date.now();
  const start = now - ms + frameMs;
  const frames: Uint8Array[] = [];
  for (let t = start; t <= now; t += frameMs) {
    let best = barHistory[barHistory.length - 1];
    for (let i = barHistory.length - 1; i >= 0; i--) {
      if (barHistory[i].at <= t) {
        best = barHistory[i];
        break;
      }
    }
    frames.push(renderFrame(best.bars));
  }
  if (frames.length === 0) return null;
  return encodeGif(frames, frameMs);
}

export const analyzer = {
  feedPcm(buf: Buffer): void {
    lastPcmAt = Date.now();
    const n = Math.floor(buf.length / 4);
    for (let i = 0; i < n; i++) {
      const s = buf.readInt16LE(i * 4) + buf.readInt16LE(i * 4 + 2);
      ring.push((s / 2) / 32768);
    }
    ensureTicker();
  },

  hasData(): boolean {
    return Date.now() - lastPcmAt < 4000 && smoothed.some((v) => v > 0.02);
  },

  currentBars(): number[] {
    return [...smoothed];
  },

  /** Animated GIF of the last ~2.4s of spectrum, or null when silent. */
  renderGif(): Buffer | null {
    if (!this.hasData()) return null;
    return renderGif();
  },
};
