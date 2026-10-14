declare module 'butterchurn' {
  export interface Visualizer {
    render(): void;
    connectAudio(analyser: AnalyserNode): void;
    loadPreset(preset: unknown, transitionDuration?: number): void;
    setRendererSize(width: number, height: number, pixelRatio?: number): void;
    destroy(): void;
  }

  function createVisualizer(
    audioContext: AudioContext,
    canvas: HTMLCanvasElement,
    options: { width: number; height: number; pixelRatio?: number },
  ): Visualizer;

  const butterchurn: { createVisualizer: typeof createVisualizer };
  export default butterchurn;
}

declare module 'butterchurn-presets' {
  const butterchurnPresets: {
    getPresets: () => Record<string, unknown>;
  };
  export default butterchurnPresets;
}

declare module 'butterchurn-presets/lib/butterchurnPresetsExtra.min.js' {
  const butterchurnPresetsExtra: {
    getPresets: () => Record<string, unknown>;
  };
  export default butterchurnPresetsExtra;
}

declare module 'butterchurn-presets/lib/butterchurnPresetsExtra2.min.js' {
  const butterchurnPresetsExtra2: {
    getPresets: () => Record<string, unknown>;
  };
  export default butterchurnPresetsExtra2;
}
