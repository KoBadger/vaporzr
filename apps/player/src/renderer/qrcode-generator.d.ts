declare module 'qrcode-generator' {
  interface QrCode {
    addData(data: string, mode?: string): void;
    make(): void;
    getModuleCount(): number;
    isDark(row: number, col: number): boolean;
  }
  /** typeNumber 0 = pick the smallest version that fits. */
  export default function qrcode(typeNumber: number, errorCorrectionLevel: string): QrCode;
}
