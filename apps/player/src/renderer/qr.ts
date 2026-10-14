import qrcode from 'qrcode-generator';

/**
 * Paint `text` as a QR code into `canvas`.
 *
 * Drawn from the module matrix rather than an HTML/SVG string, so nothing is
 * ever injected as markup — the payload is a URL containing a key. A 4-module
 * quiet zone is included because that is the spec minimum scanners need to lock
 * on; without it a code that "looks fine" often will not read.
 *
 * Returns false when the text cannot be encoded (too long for any version).
 */
export function drawQr(canvas: HTMLCanvasElement, text: string, pixelSize = 96): boolean {
  let qr: ReturnType<typeof qrcode>;
  try {
    // 'M' tolerates ~15% damage — about right for a phone camera pointed at a
    // video stream.
    qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
  } catch {
    return false;
  }
  const count = qr.getModuleCount();
  const quiet = 4;
  const total = count + quiet * 2;
  const scale = Math.max(1, Math.floor(pixelSize / total));
  const px = total * scale;
  canvas.width = px;
  canvas.height = px;
  const c = canvas.getContext('2d');
  if (!c) return false;
  c.fillStyle = '#ffffff';
  c.fillRect(0, 0, px, px);
  c.fillStyle = '#0b0d18';
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) {
        c.fillRect((col + quiet) * scale, (row + quiet) * scale, scale, scale);
      }
    }
  }
  return true;
}
