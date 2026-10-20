import zlib from 'node:zlib';
import jsQR from 'jsqr';
import QRCode from 'qrcode';
import { describe, expect, it } from 'vitest';
import { CARD_H, CARD_W, renderJamCardPng, renderJamCardRgba } from '../jamCardArt.js';

const JOIN = 'https://vaporzr.example.com/jam?key=k1';

/** Minimal decoder for exactly what our encoder writes: filter-0 RGBA rows. */
function decodePng(png: Buffer): { rgba: Buffer; width: number; height: number } {
  expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  let pos = 8;
  const idat: Buffer[] = [];
  while (pos < png.length) {
    const len = png.readUInt32BE(pos);
    const type = png.subarray(pos + 4, pos + 8).toString('ascii');
    if (type === 'IDAT') idat.push(png.subarray(pos + 8, pos + 8 + len));
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const rgba = Buffer.alloc(width * height * 4);
  const stride = width * 4 + 1;
  for (let y = 0; y < height; y++) {
    expect(raw[y * stride]).toBe(0); // filter: none
    raw.copy(rgba, y * width * 4, y * stride + 1, (y + 1) * stride);
  }
  return { rgba, width, height };
}

describe('jam card art', () => {
  it('round-trips through the PNG encoder byte-for-byte', () => {
    const art = renderJamCardRgba(JOIN);
    const decoded = decodePng(renderJamCardPng(JOIN));
    expect(decoded.width).toBe(CARD_W);
    expect(decoded.height).toBe(CARD_H);
    expect(decoded.rgba.equals(art.rgba)).toBe(true);
  });

  it('draws every QR module in the right place, dark on light, with a quiet zone', () => {
    const art = renderJamCardRgba(JOIN);
    const { x, y, scale, modules, quiet, chip } = art.qr;
    // The chip covers ~7×7 centre modules, which is why correction is Q.
    const qr = QRCode.create(JOIN, { errorCorrectionLevel: 'Q' });
    expect(qr.modules.size).toBe(modules);
    const at = (px: number, py: number): number[] => {
      const o = (py * CARD_W + px) * 4;
      return [art.rgba[o], art.rgba[o + 1], art.rgba[o + 2], art.rgba[o + 3]];
    };
    const isDarkAt = (px: number, py: number): boolean => {
      const [r, g, b] = at(px, py);
      return r < 128 && g < 128 && b < 160;
    };
    const inChip = (px: number, py: number) => px >= chip.x0 && px <= chip.x1 && py >= chip.y0 && py <= chip.y1;
    const half = Math.floor(scale / 2);
    for (let row = 0; row < modules; row++) {
      for (let col = 0; col < modules; col++) {
        const px = x + (col + quiet) * scale + half;
        const py = y + (row + quiet) * scale + half;
        if (inChip(px, py)) continue; // the chip hides these on purpose
        expect(isDarkAt(px, py)).toBe(qr.modules.get(row, col) !== 0);
      }
    }
    // The quiet zone stays panel-light at all four corners of the code's box.
    const span = (modules + quiet * 2) * scale;
    for (const [px, py] of [
      [x + 2, y + 2],
      [x + span - 3, y + 2],
      [x + 2, y + span - 3],
      [x + span - 3, y + span - 3],
    ]) {
      expect(isDarkAt(px, py)).toBe(false);
    }
  });

  it('hides the code centre under a JAM chip with a pink rim', () => {
    const art = renderJamCardRgba(JOIN);
    const { chip } = art.qr;
    const at = (px: number, py: number): number[] => {
      const o = (py * CARD_W + px) * 4;
      return [art.rgba[o], art.rgba[o + 1], art.rgba[o + 2]];
    };
    const midX = Math.round((chip.x0 + chip.x1) / 2);
    const midY = Math.round((chip.y0 + chip.y1) / 2);
    // Pink rim, just inside the chip's left edge.
    const [r, g, b] = at(chip.x0 + 1, midY);
    expect(r).toBeGreaterThan(200);
    expect(g).toBeLessThan(120);
    expect(b).toBeGreaterThan(150);
    // Dark face, above the white JAM lettering.
    const [fr, fg, fb] = at(midX, chip.y0 + 5);
    expect(fr < 80 && fg < 80 && fb < 110).toBe(true);
  });

  it('still decodes with a strict QR reader after all the styling', () => {
    const art = renderJamCardRgba(JOIN);
    const data = new Uint8ClampedArray(art.rgba.buffer, art.rgba.byteOffset, art.rgba.length);
    expect(jsQR(data, CARD_W, CARD_H)?.data).toBe(JOIN);
  });

  it('is a compact banner — the code is far smaller than the old 620px square', () => {
    const art = renderJamCardRgba(JOIN);
    const qrPx = (art.qr.modules + art.qr.quiet * 2) * art.qr.scale;
    expect(qrPx).toBeLessThanOrEqual(200);
    expect(art.qr.scale).toBeGreaterThanOrEqual(2);
  });

  it('keeps a long join URL scannable too: the module scale shrinks but never below 2', () => {
    const long = `https://vaporzr.duckdns.org/jam?key=${'k'.repeat(64)}`;
    const art = renderJamCardRgba(long);
    expect(art.qr.scale).toBeGreaterThanOrEqual(2);
    const qrPx = (art.qr.modules + art.qr.quiet * 2) * art.qr.scale;
    expect(qrPx).toBeLessThanOrEqual(220);
  });
});
