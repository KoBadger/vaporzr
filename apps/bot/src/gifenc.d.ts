declare module 'gifenc' {
  type RGB = [number, number, number];
  export interface GIFEncoderInstance {
    writeFrame(
      index: Uint8Array,
      width: number,
      height: number,
      opts: { palette: RGB[]; delay?: number },
    ): void;
    finish(): void;
    bytes(): Uint8Array;
  }
  const gifenc: {
    GIFEncoder(): GIFEncoderInstance;
    applyPalette(rgba: Uint8Array, palette: RGB[]): Uint8Array;
    quantize(rgba: Uint8Array, maxColors: number, options?: Record<string, unknown>): RGB[];
    nearestColorIndex(rgb: Uint8Array, palette: RGB[]): number;
  };
  export default gifenc;
}
