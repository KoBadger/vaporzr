/**
 * The `/jam` invite card: a 560×260 vaporwave postcard — striped sunset over a
 * neon perspective grid, with the join QR on a tinted panel — drawn in pure Node
 * on top of the shared PNG encoder. No image dependencies, so it renders
 * anywhere the bot runs and the whole thing stays unit-testable.
 *
 * The QR is styled, not plain: near-black purple dots on a dim lavender panel,
 * square finder eyes, and a small JAM chip over the centre. It stays
 * dark-on-light with an integer module scale and a 4-module quiet zone, and
 * error correction is Q so the chip's ~7×7 modules are recoverable — a strict
 * QR reader (jsQR) decodes the rendered card in the tests.
 */
import QRCode from 'qrcode';
import { encodePng } from './png.js';

export const CARD_W = 560;
export const CARD_H = 260;

/** Where the sky meets the ground (the sun sits on this line). */
const HORIZON = 185;

/** The QR's light panel on the left, including its rounded-corner radius. */
const PANEL = { x: 20, y: 20, w: 220, h: 220, r: 18, pad: 14 };
/** Quiet-zone modules on each side of the code (the spec minimum is 4). */
const QR_QUIET = 4;

/** Horizontal centre of the right-hand text zone. */
const TX = 398;

const INK_TOP: Rgba = [0x3c, 0x0d, 0x74, 255]; // QR dots, top of the gradient
const INK_BOTTOM: Rgba = [0x18, 0x03, 0x38, 255]; // QR dots, bottom
const PAPER_TOP: Rgba = [0xb3, 0xa2, 0xe8, 255]; // QR panel (dim lavender), top
const PAPER_BOTTOM: Rgba = [0x96, 0x82, 0xd2, 255]; // QR panel, bottom
const PINK: Rgba = [0xff, 0x2f, 0xd6, 255]; // neon pink
const CYAN: Rgba = [0x2e, 0xf3, 0xff, 255]; // neon cyan
const OUTLINE: Rgba = [0x14, 0x03, 0x34, 255]; // text backdrop ink

type Rgba = [number, number, number, number];
type ColorFn = (x: number, y: number) => Rgba;
type InsideFn = (x: number, y: number) => boolean;

// ---- tiny rasterizer -------------------------------------------------------

function rgba(hex: number, alpha = 255): Rgba {
  return [(hex >> 16) & 0xff, (hex >> 8) & 0xff, hex & 0xff, alpha];
}

function mix(a: Rgba, b: Rgba, t: number): Rgba {
  const k = Math.max(0, Math.min(1, t));
  return [
    Math.round(a[0] + (b[0] - a[0]) * k),
    Math.round(a[1] + (b[1] - a[1]) * k),
    Math.round(a[2] + (b[2] - a[2]) * k),
    Math.round(a[3] + (b[3] - a[3]) * k),
  ];
}

/** Alpha-composite one pixel of `color` (scaled by `alpha`) onto the canvas. */
function put(buf: Buffer, x: number, y: number, color: Rgba, alpha = 1): void {
  const a = (color[3] / 255) * alpha;
  if (a <= 0) return;
  const o = (y * CARD_W + x) * 4;
  buf[o] = Math.round(color[0] * a + buf[o] * (1 - a));
  buf[o + 1] = Math.round(color[1] * a + buf[o + 1] * (1 - a));
  buf[o + 2] = Math.round(color[2] * a + buf[o + 2] * (1 - a));
  buf[o + 3] = Math.round(255 * a + buf[o + 3] * (1 - a));
}

/** Paint a shape over a bounding box: coverage comes from 2×2 supersampling so
 *  curves and diagonal lines get soft edges without any image library. */
function paint(
  buf: Buffer,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  inside: InsideFn,
  color: ColorFn,
  alpha = 1,
): void {
  for (let y = Math.max(0, y0); y < Math.min(CARD_H, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(CARD_W, x1); x++) {
      let hit = 0;
      for (const ox of [0.25, 0.75]) {
        for (const oy of [0.25, 0.75]) {
          if (inside(x + ox, y + oy)) hit++;
        }
      }
      if (hit) put(buf, x, y, color(x, y), (hit / 4) * alpha);
    }
  }
}

function roundInside(x: number, y: number, x0: number, y0: number, x1: number, y1: number, r: number): boolean {
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

/** Thick line segment, for the perspective grid. */
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

// ---- sky, sun, grid --------------------------------------------------------

const SKY_STOPS: { at: number; c: Rgba }[] = [
  { at: 0, c: rgba(0x0d022b) }, // deep indigo
  { at: 0.42, c: rgba(0x3d0f74) }, // purple
  { at: 0.72, c: rgba(0xa81c8c) }, // magenta
  { at: 1, c: rgba(0xff7759) }, // coral at the horizon
];

function skyAt(y: number): Rgba {
  const t = y / HORIZON;
  for (let i = 1; i < SKY_STOPS.length; i++) {
    const a = SKY_STOPS[i - 1];
    const b = SKY_STOPS[i];
    if (t <= b.at) return mix(a.c, b.c, (t - a.at) / (b.at - a.at));
  }
  return SKY_STOPS[SKY_STOPS.length - 1].c;
}

const SUN = { cx: 430, cy: HORIZON, r: 105 };
/** Horizontal slits, as fractions of the radius measured up from the centre. */
const SUN_CUTS: [number, number][] = [
  [0.62, 0.5],
  [0.42, 0.28],
  [0.18, 0.02],
];

function inSun(x: number, y: number): boolean {
  const dx = x - SUN.cx;
  const dy = y - SUN.cy;
  if (dx * dx + dy * dy > SUN.r * SUN.r) return false;
  const f = -dy / SUN.r; // 1 at the top, 0 at the centre, negative below
  for (const [hi, lo] of SUN_CUTS) if (f <= hi && f >= lo) return false;
  return true;
}

function sunColor(y: number): Rgba {
  const k = Math.max(0, Math.min(1, (y - (SUN.cy - SUN.r)) / (2 * SUN.r)));
  return k < 0.5 ? mix(rgba(0xfff0a0), rgba(0xffab54), k * 2) : mix(rgba(0xffab54), rgba(0xff4f6d), (k - 0.5) * 2);
}

/** Rows of the ground grid; spacing grows with depth for a cheap perspective. */
function gridRows(): number[] {
  const rows: number[] = [];
  let y = HORIZON;
  let gap = 4;
  while (y < CARD_H) {
    y += gap;
    rows.push(Math.round(y));
    gap += 2.2;
  }
  return rows;
}

// ---- 5×7 pixel font --------------------------------------------------------

const FONT: Record<string, string[]> = {
  V: ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  A: ['..#..', '.#.#.', '#...#', '#...#', '#####', '#...#', '#...#'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
  J: ['..###', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..'],
  M: ['#...#', '##.##', '#.#.#', '#...#', '#...#', '#...#', '#...#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  N: ['#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#', '#...#'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  I: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '#####'],
};

function textWidth(text: string, scale: number): number {
  return (text.length * 6 - 1) * scale;
}

interface TextOpts {
  fill: Rgba;
  outline?: Rgba;
  /** Outline thickness in canvas pixels. */
  outlineW?: number;
  shadow?: { dx: number; dy: number; color: Rgba };
}

/** Stamp pixel-font text; `x, y` is the top-left of the glyph box. */
function drawText(buf: Buffer, text: string, x: number, y: number, scale: number, opts: TextOpts): void {
  const gw = text.length * 6 - 1;
  const mask = new Uint8Array(gw * 7);
  for (let i = 0; i < text.length; i++) {
    const glyph = FONT[text[i]];
    if (!glyph) continue;
    for (let gy = 0; gy < 7; gy++) {
      for (let gx = 0; gx < 5; gx++) {
        if (glyph[gy][gx] === '#') mask[gy * gw + i * 6 + gx] = 1;
      }
    }
  }
  const on: InsideFn = (cx, cy) => {
    const gx = Math.floor((cx - x) / scale);
    const gy = Math.floor((cy - y) / scale);
    return gx >= 0 && gy >= 0 && gx < gw && gy < 7 && mask[gy * gw + gx] === 1;
  };
  const pad =
    2 + (opts.outlineW ?? 0) + (opts.shadow ? Math.max(Math.abs(opts.shadow.dx), Math.abs(opts.shadow.dy)) : 0);
  const x0 = x - pad;
  const y0 = y - pad;
  const x1 = x + gw * scale + pad;
  const y1 = y + 7 * scale + pad;

  if (opts.shadow) {
    const { dx, dy, color } = opts.shadow;
    paint(
      buf,
      x0,
      y0,
      x1,
      y1,
      (px, py) => on(px - dx, py - dy),
      () => color,
      color[3] / 255,
    );
  }
  const ow = opts.outlineW ?? 0;
  if (opts.outline && ow > 0) {
    paint(
      buf,
      x0,
      y0,
      x1,
      y1,
      (px, py) => {
        for (let ox = -ow; ox <= ow; ox++) {
          for (let oy = -ow; oy <= ow; oy++) if (on(px + ox, py + oy)) return true;
        }
        return false;
      },
      () => opts.outline!,
    );
  }
  paint(buf, x0, y0, x1, y1, on, () => opts.fill, opts.fill[3] / 255);
}

// ---- the card --------------------------------------------------------------

/** Where the QR landed, so tests (and future tweaks) can find it again. */
export interface JamCardQr {
  /** Top-left pixel of the code *including* its quiet zone. */
  x: number;
  y: number;
  /** Pixels per module. */
  scale: number;
  /** Modules per side, without the quiet zone. */
  modules: number;
  /** Quiet-zone modules on each side. */
  quiet: number;
  /** Pixel box the centre chip paints over (dark face plus pink rim). */
  chip: { x0: number; y0: number; x1: number; y1: number };
}

export interface JamCardArt {
  rgba: Buffer;
  width: number;
  height: number;
  qr: JamCardQr;
}

/** Compose the full card at 1:1 scale. Deterministic for a given URL. */
export function renderJamCardRgba(url: string): JamCardArt {
  const buf = Buffer.alloc(CARD_W * CARD_H * 4);

  // Sky.
  for (let y = 0; y <= HORIZON; y++) {
    const c = skyAt(y);
    for (let x = 0; x < CARD_W; x++) put(buf, x, y, c);
  }

  // Sun, clipped at the horizon (the ground covers anything below it).
  paint(buf, SUN.cx - SUN.r - 2, SUN.cy - SUN.r - 2, SUN.cx + SUN.r + 2, HORIZON + 1, inSun, (_, y) => sunColor(y));

  // Ground.
  for (let y = HORIZON; y < CARD_H; y++) {
    for (let x = 0; x < CARD_W; x++) put(buf, x, y, rgba(0x0d0424));
  }

  // Neon grid: depth rows plus lines converging under the sun.
  for (const gy of gridRows()) {
    for (let x = 0; x < CARD_W; x++) put(buf, x, gy, CYAN, 0.4);
  }
  for (let xb = -120; xb <= CARD_W + 120; xb += 40) {
    paint(buf, 0, HORIZON, CARD_W, CARD_H, seg(SUN.cx, HORIZON, xb, CARD_H, 0.55), () => CYAN, 0.3);
  }

  // Horizon glow.
  const glow: [number, number][] = [
    [-3, 0.08],
    [-2, 0.16],
    [-1, 0.34],
    [0, 0.8],
    [1, 0.28],
  ];
  for (const [dy, a] of glow) {
    for (let x = 0; x < CARD_W; x++) put(buf, x, HORIZON + dy, rgba(0xd8fbff), a);
  }

  // QR panel: soft shadow, pink glow, light face, neon rim.
  const px0 = PANEL.x;
  const py0 = PANEL.y;
  const px1 = PANEL.x + PANEL.w;
  const py1 = PANEL.y + PANEL.h;
  paint(
    buf,
    px0 - 8,
    py0 - 4,
    px1 + 8,
    py1 + 12,
    (x, y) => roundInside(x, y - 6, px0, py0, px1, py1, PANEL.r),
    () => rgba(0x060118),
    0.45,
  );
  paint(
    buf,
    px0 - 8,
    py0 - 8,
    px1 + 8,
    py1 + 8,
    (x, y) => roundInside(x, y, px0 - 7, py0 - 7, px1 + 7, py1 + 7, PANEL.r + 7),
    () => PINK,
    0.12,
  );
  paint(
    buf,
    px0 - 8,
    py0 - 8,
    px1 + 8,
    py1 + 8,
    (x, y) => roundInside(x, y, px0, py0, px1, py1, PANEL.r),
    (_, y) => mix(PAPER_TOP, PAPER_BOTTOM, (y - py0) / PANEL.h),
  );
  paint(
    buf,
    px0 - 4,
    py0 - 4,
    px1 + 4,
    py1 + 4,
    (x, y) =>
      roundInside(x, y, px0, py0, px1, py1, PANEL.r) &&
      !roundInside(x, y, px0 + 2.5, py0 + 2.5, px1 - 2.5, py1 - 2.5, PANEL.r - 2),
    () => PINK,
  );

  // The QR itself: integer-scale modules, dark on light. Data modules are dots
  // (~84% coverage — well past what a scanner needs), the finder eyes stay
  // square so the alignment features read clean, and the ink fades down the
  // panel. Error correction is Q to pay for the centre chip.
  const qr = QRCode.create(url, { errorCorrectionLevel: 'Q' });
  const n = qr.modules.size;
  const scale = Math.max(2, Math.floor((PANEL.w - PANEL.pad * 2) / (n + QR_QUIET * 2)));
  const size = (n + QR_QUIET * 2) * scale;
  const qx = PANEL.x + Math.floor((PANEL.w - size) / 2);
  const qy = PANEL.y + Math.floor((PANEL.h - size) / 2);
  const inFinder = (row: number, col: number) =>
    (row < 7 && col < 7) || (row < 7 && col >= n - 7) || (row >= n - 7 && col < 7);
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      if (!qr.modules.get(row, col)) continue;
      const mx = qx + (col + QR_QUIET) * scale;
      const my = qy + (row + QR_QUIET) * scale;
      const ink = mix(INK_TOP, INK_BOTTOM, (my + scale / 2 - qy) / size);
      if (inFinder(row, col)) {
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) put(buf, mx + dx, my + dy, ink);
        }
      } else {
        const cx = mx + scale / 2;
        const cy = my + scale / 2;
        const r = scale * 0.42;
        paint(
          buf,
          mx,
          my,
          mx + scale,
          my + scale,
          (x, y) => (x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r,
          () => ink,
        );
      }
    }
  }

  // The JAM chip hides ~7×7 centre modules; Q-level correction recovers them.
  const chipCx = qx + (QR_QUIET + n / 2) * scale;
  const chipCy = qy + (QR_QUIET + n / 2) * scale;
  const chipHalf = 3.5 * scale;
  const chipX0 = Math.round(chipCx - chipHalf);
  const chipY0 = Math.round(chipCy - chipHalf);
  const chipX1 = Math.round(chipCx + chipHalf);
  const chipY1 = Math.round(chipCy + chipHalf);
  paint(
    buf,
    chipX0 - 4,
    chipY0 - 4,
    chipX1 + 4,
    chipY1 + 4,
    (x, y) => roundInside(x, y, chipX0 - 2.5, chipY0 - 2.5, chipX1 + 2.5, chipY1 + 2.5, 7),
    () => PINK,
  );
  paint(
    buf,
    chipX0 - 4,
    chipY0 - 4,
    chipX1 + 4,
    chipY1 + 4,
    (x, y) => roundInside(x, y, chipX0, chipY0, chipX1, chipY1, 5),
    () => OUTLINE,
  );
  drawText(buf, 'JAM', Math.round(chipCx - textWidth('JAM', 1) / 2), Math.round(chipCy - 3.5), 1, {
    fill: rgba(0xffffff),
  });
  // Everything the chip paints over (rim included), so tests can skip it.
  const chip = { x0: chipX0 - 3, y0: chipY0 - 3, x1: chipX1 + 3, y1: chipY1 + 3 };

  // The right-hand text block.
  const vaporzr = 'VAPORZR';
  drawText(buf, vaporzr, TX - Math.round(textWidth(vaporzr, 4) / 2), 30, 4, {
    fill: rgba(0x8bf6ff),
    outline: OUTLINE,
    outlineW: 2,
    shadow: { dx: 2, dy: 3, color: rgba(0x140334, 160) },
  });

  const jam = 'JAM';
  drawText(buf, jam, TX - Math.round(textWidth(jam, 11) / 2), 72, 11, {
    fill: rgba(0xffffff),
    outline: OUTLINE,
    outlineW: 4,
    shadow: { dx: 4, dy: 5, color: rgba(0x140334, 170) },
  });

  const scan = 'SCAN TO JOIN';
  const scanScale = 2;
  const scanW = textWidth(scan, scanScale);
  const chipW = scanW + 36;
  const chipH = 28;
  const chipX = TX - Math.round(chipW / 2);
  const chipY = 156;
  paint(
    buf,
    chipX - 4,
    chipY - 4,
    chipX + chipW + 4,
    chipY + chipH + 4,
    (x, y) => roundInside(x, y, chipX, chipY, chipX + chipW, chipY + chipH, chipH / 2),
    () => rgba(0x140334),
    0.78,
  );
  paint(
    buf,
    chipX - 4,
    chipY - 4,
    chipX + chipW + 4,
    chipY + chipH + 4,
    (x, y) =>
      roundInside(x, y, chipX, chipY, chipX + chipW, chipY + chipH, chipH / 2) &&
      !roundInside(x, y, chipX + 1.5, chipY + 1.5, chipX + chipW - 1.5, chipY + chipH - 1.5, chipH / 2 - 1.5),
    () => CYAN,
    0.6,
  );
  drawText(
    buf,
    scan,
    chipX + Math.round((chipW - scanW) / 2),
    chipY + Math.round((chipH - 7 * scanScale) / 2),
    scanScale,
    {
      fill: rgba(0xffffff),
    },
  );

  // Frame: neon pink, with a thin cyan line inside.
  for (let y = 0; y < CARD_H; y++) {
    for (let x = 0; x < CARD_W; x++) {
      const d = Math.min(x, y, CARD_W - 1 - x, CARD_H - 1 - y);
      if (d < 3) put(buf, x, y, PINK);
      else if (d === 5) put(buf, x, y, CYAN, 0.45);
    }
  }

  return { rgba: buf, width: CARD_W, height: CARD_H, qr: { x: qx, y: qy, scale, modules: n, quiet: QR_QUIET, chip } };
}

/** The card as a PNG, ready to attach to the Discord message. */
export function renderJamCardPng(url: string): Buffer {
  const art = renderJamCardRgba(url);
  return encodePng(art.rgba, art.width, art.height);
}
