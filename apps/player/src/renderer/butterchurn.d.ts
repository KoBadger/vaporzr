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
