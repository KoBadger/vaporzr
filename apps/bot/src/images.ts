import { Buffer } from 'node:buffer';
import gifencPkg from 'gifenc';

const { GIFEncoder, quantize, applyPalette } = gifencPkg;

export interface RadarMetric {
  label: string;
  value: number; // 0..1
}

function intToRgb(n: number): [number, number, number] {
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function pointInPoly(x: number, y: number, poly: Array<[number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * A static "song DNA" radar card: a filled polygon over 5 axes, rendered as a
 * one-frame GIF. Labels stay in the Discord embed (no font renderer needed here).
 */
export function renderRadarGif(metrics: RadarMetric[], accent: number): Buffer {
  const W = 480;
  const H = 480;
  const data = new Uint8Array(W * H * 4);
  const cx = W / 2;
  const cy = H / 2;
  const R = 168;
  const n = Math.max(3, metrics.length);
  const ang = (i: number): number => -Math.PI / 2 + i * ((2 * Math.PI) / n);

  for (let i = 0; i < W * H; i++) {
    data[i * 4] = 14;
    data[i * 4 + 1] = 12;
    data[i * 4 + 2] = 22;
    data[i * 4 + 3] = 255;
  }
  const set = (x: number, y: number, r: number, g: number, b: number, a = 1): void => {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= W || yi >= H) return;
    const o = (yi * W + xi) * 4;
    data[o] = r;
    data[o + 1] = g;
    data[o + 2] = b;
    data[o + 3] = Math.round(a * 255);
  };
  const [ar, ag, ab] = intToRgb(accent);

  // Concentric rings.
  for (const rr of [0.25, 0.5, 0.75, 1]) {
    for (let a = 0; a < 360; a += 1) {
      const rad = (a * Math.PI) / 180;
      set(cx + Math.cos(rad) * R * rr, cy + Math.sin(rad) * R * rr, 62, 60, 86, 0.55);
    }
  }
  // Axes + vertices.
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    const a = ang(i);
    const v = clamp01(metrics[i].value);
    const ex = cx + Math.cos(a) * R;
    const ey = cy + Math.sin(a) * R;
    for (let t = 0; t <= 1; t += 0.008) set(cx + (ex - cx) * t, cy + (ey - cy) * t, 72, 70, 98, 0.6);
    pts.push([cx + Math.cos(a) * R * v, cy + Math.sin(a) * R * v]);
  }
  // Filled polygon.
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (pointInPoly(x, y, pts)) set(x, y, ar, ag, ab, 0.5);
    }
  }
  // Outline.
  for (let i = 0; i < n; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % n];
    for (let t = 0; t <= 1; t += 0.004) set(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, ar, ag, ab, 1);
  }
  // Vertex dots.
  for (const [vx, vy] of pts) {
    for (let dy = -5; dy <= 5; dy++) {
      for (let dx = -5; dx <= 5; dx++) {
        if (dx * dx + dy * dy <= 25) set(vx + dx, vy + dy, 245, 245, 250, 1);
      }
    }
  }

  const gif = GIFEncoder();
  const palette = quantize(data, 256);
  const index = applyPalette(data, palette);
  gif.writeFrame(index, W, H, { palette, delay: 1200 });
  gif.finish();
  return Buffer.from(gif.bytes());
}
