import zlib from 'node:zlib';

/**
 * Panel button icons, Vaporzr style: white glyphs on transparent 128x128
 * PNGs — rasterized in pure Node (no image deps) and uploaded as custom
 * Discord emojis on startup. Every button falls back to Unicode if the
 * upload isn't possible.
 */

const SIZE = 128;

type InsideFn = (x: number, y: number) => boolean;

function rect(x0: number, y0: number, x1: number, y1: number): InsideFn {
  return (x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
}

function tri(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): InsideFn {
  const d1 = (px: number, py: number) => (bx - ax) * (py - ay) - (by - ay) * (px - ax);
  const d2 = (px: number, py: number) => (cx - bx) * (py - by) - (cy - by) * (px - bx);
  const d3 = (px: number, py: number) => (ax - cx) * (py - cy) - (ay - cy) * (px - cx);
  const hasNeg = (px: number, py: number) => d1(px, py) < 0 || d2(px, py) < 0 || d3(px, py) < 0;
  const hasPos = (px: number, py: number) => d1(px, py) > 0 || d2(px, py) > 0 || d3(px, py) > 0;
  return (x, y) => !(hasNeg(x, y) && hasPos(x, y));
}

function circle(cx: number, cy: number, r: number): InsideFn {
  return (x, y) => (x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r;
}

/** Thick line segment. */
function seg(x1: number, y1: number, x2: number, y2: number, halfW: number): InsideFn {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy || 1;
  return (x, y) => {
    const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / lenSq));
    const px = x1 + t * dx;
    const py = y1 + t * dy;
    return (x - px) * (x - px) + (y - py) * (y - py) <= halfW * halfW;
  };
}

/** Ring segment between rIn..rOut covering angles a0..a1 (degrees, 0=right, CW screen space). */
function ring(cx: number, cy: number, rIn: number, rOut: number, a0: number, a1: number): InsideFn {
  const lo = Math.min(a0, a1);
  const hi = Math.max(a0, a1);
  const norm = (a: number): number => {
    let v = a % 360;
    if (v < 0) v += 360;
    return v;
  };
  const span = hi - lo;
  return (x, y) => {
    const dx = x - cx;
    const dy = y - cy;
    const d2 = dx * dx + dy * dy;
    if (d2 < rIn * rIn || d2 > rOut * rOut) return false;
    let a = (Math.atan2(dy, dx) * 180) / Math.PI;
    a = norm(a);
    // Handle wraps like lo=290, hi=430.
    const rel = norm(a - lo);
    return rel <= span;
  };
}

function speaker(): InsideFn[] {
  // Classic speaker: fan-triangulated hexagon.
  return [
    tri(22, 50, 44, 50, 66, 32),
    tri(22, 50, 66, 32, 66, 96),
    tri(22, 50, 66, 96, 44, 78),
    tri(22, 50, 44, 78, 22, 78),
  ];
}

const ICONS: Record<string, InsideFn[]> = {
  vz_play: [tri(46, 34, 46, 94, 98, 64)],
  vz_pause: [rect(44, 34, 58, 94), rect(70, 34, 84, 94)],
  vz_stop: [rect(38, 38, 90, 90)],
  vz_prev: [rect(28, 36, 38, 92), tri(38, 64, 92, 36, 92, 92)],
  vz_next: [rect(90, 36, 100, 92), tri(90, 64, 36, 36, 36, 92)],
  vz_back10: [
    tri(34, 16, 34, 62, 84, 39), // left triangle, top half
    rect(44, 78, 56, 114), // digit "1"
    ring(82, 96, 9, 19, 0, 360), // digit "0"
  ],
  vz_fwd10: [
    tri(94, 16, 94, 62, 44, 39), // right triangle, top half
    rect(44, 78, 56, 114), // digit "1"
    ring(82, 96, 9, 19, 0, 360), // digit "0"
  ],
  vz_repeat: [
    ring(64, 64, 26, 38, 290, 610), // gap centered at the top
    tri(70, 16, 98, 30, 68, 46), // arrowhead at the gap's right edge
  ],
  vz_shuffle: [
    seg(30, 42, 98, 86, 5),
    seg(30, 86, 98, 42, 5),
    tri(92, 76, 112, 86, 92, 96),
    tri(92, 32, 112, 42, 92, 52),
  ],
  vz_voldown: [...speaker(), rect(76, 59, 98, 69)],
  vz_volup: [...speaker(), rect(76, 59, 98, 69), rect(83, 52, 91, 76)],
  vz_eject: [tri(30, 76, 98, 76, 64, 36), rect(30, 86, 98, 96)],
  vz_power: [ring(64, 64, 27, 39, 300, 600), seg(64, 22, 64, 60, 5)],
  vz_dj: [rect(28, 46, 40, 94), rect(50, 30, 62, 94), rect(72, 54, 84, 94), rect(94, 38, 106, 94)],
};

/** Unicode fallbacks if a custom emoji can't be created. */
export const PANEL_ICON_FALLBACKS: Record<string, string> = {
  vz_play: '▶',
  vz_pause: '⏸',
  vz_stop: '⏹',
  vz_prev: '⏮',
  vz_next: '⏭',
  vz_back10: '⏪',
  vz_fwd10: '⏩',
  vz_repeat: '🔁',
  vz_shuffle: '🔀',
  vz_voldown: '🔉',
  vz_volup: '🔊',
  vz_eject: '📤',
  vz_power: '⏻',
  vz_dj: '🎛️',
};

// ---- PNG encoding (pure Node) ----

let crcTable: number[] | null = null;
function crc32(buf: Buffer): number {
  if (!crcTable) {
    crcTable = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length);
  return out;
}

function encodePng(rgba: Buffer, w: number, h: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Rasterize a panel icon to a white-on-transparent PNG buffer. */
export function renderPanelIconPng(name: string): Buffer {
  const shapes = ICONS[name];
  if (!shapes) throw new Error(`unknown panel icon: ${name}`);
  const rgba = Buffer.alloc(SIZE * SIZE * 4);
  const offs = [-1 / 3, 0, 1 / 3];
  for (let py = 0; py < SIZE; py++) {
    for (let px = 0; px < SIZE; px++) {
      let hit = 0;
      for (const ox of offs) {
        for (const oy of offs) {
          const x = px + 0.5 + ox;
          const y = py + 0.5 + oy;
          for (const s of shapes) {
            if (s(x, y)) {
              hit++;
              break;
            }
          }
        }
      }
      const a = Math.round((hit / 9) * 255);
      const o = (py * SIZE + px) * 4;
      rgba[o] = 255;
      rgba[o + 1] = 255;
      rgba[o + 2] = 255;
      rgba[o + 3] = a;
    }
  }
  return encodePng(rgba, SIZE, SIZE);
}
