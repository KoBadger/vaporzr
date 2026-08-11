import butterchurn, { type Visualizer } from 'butterchurn';
import butterchurnPresets from 'butterchurn-presets';
import { WsClient } from './wsClient';

const port = Number(new URLSearchParams(window.location.search).get('port') ?? '4876');

const canvas = document.getElementById('viz') as HTMLCanvasElement;
const status = document.getElementById('status') as HTMLDivElement;
const streamCanvas = document.createElement('canvas');
const streamCtx = streamCanvas.getContext('2d')!;
streamCanvas.width = 960;
streamCanvas.height = 540;

let visualizer: Visualizer | null = null;
let audioContext: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let streamEnabled = false;
let frameTimer: number | null = null;
let presets: Record<string, unknown> = {};
let presetNames: string[] = [];
let currentPresetIndex = 0;
let presetCycle: number | null = null;

const client = new WsClient({
  port,
  role: 'visualizer',
  name: 'vaporzr-visualizer',
  onMessage: (msg) => {
    if (msg.type === 'visuals:enabled') {
      streamEnabled = msg.enabled;
      if (streamEnabled) startFrameStream();
      else stopFrameStream();
    }
  },
});

function log(msg: string): void {
  console.log('[vaporzr-visualizer]', msg);
  status.textContent = msg;
}

async function getLoopbackStream(): Promise<MediaStream | null> {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    // We only need the audio. Stop the video tracks (must request video for loopback audio).
    for (const track of stream.getVideoTracks()) {
      track.stop();
      stream.removeTrack(track);
    }
    if (stream.getAudioTracks().length === 0) {
      log('Loopback stream had no audio tracks');
      return null;
    }
    return stream;
  } catch (e) {
    log(`Could not capture system audio: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

async function initAudio(): Promise<boolean> {
  const stream = await getLoopbackStream();
  if (!stream) return false;

  audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(stream);
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.82;
  source.connect(analyser);
  return true;
}

function cyclePreset(): void {
  if (!visualizer || presetNames.length === 0) return;
  currentPresetIndex = (currentPresetIndex + 1 + Math.floor(Math.random() * Math.max(1, presetNames.length - 1))) % presetNames.length;
  visualizer.loadPreset(presets[presetNames[currentPresetIndex]], 1.5);
}

function resize(): void {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = canvas.clientWidth * dpr;
  canvas.height = canvas.clientHeight * dpr;
  visualizer?.setRendererSize(canvas.clientWidth, canvas.clientHeight, dpr);
}

function renderLoop(): void {
  if (visualizer) visualizer.render();
  requestAnimationFrame(renderLoop);
}

function sendFrame(): void {
  if (!streamEnabled || !visualizer || !analyser) return;
  streamCtx.drawImage(canvas, 0, 0, streamCanvas.width, streamCanvas.height);
  client.send({ type: 'visuals:frame', data: streamCanvas.toDataURL('image/jpeg', 0.6) });
}

function startFrameStream(): void {
  if (frameTimer) return;
  frameTimer = window.setInterval(sendFrame, 150);
}

function stopFrameStream(): void {
  if (frameTimer) {
    window.clearInterval(frameTimer);
    frameTimer = null;
  }
}

function init(): void {
  presets = butterchurnPresets.getPresets();
  presetNames = Object.keys(presets);
  log(`Loaded ${presetNames.length} presets`);

  void initAudio().then((ok) => {
    if (!ok || !audioContext || !analyser) {
      log('Audio unavailable — showing idle visualizer');
      return;
    }
    try {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = canvas.clientWidth || 1280;
      const h = canvas.clientHeight || 720;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      visualizer = butterchurn.createVisualizer(audioContext, canvas, {
        width: w,
        height: h,
        pixelRatio: dpr,
      });
      visualizer.loadPreset(presets[presetNames[0]], 0);
      log('Visualizer running');
      renderLoop();
      presetCycle = window.setInterval(cyclePreset, 30000);
    } catch (e) {
      log(`butterchurn init failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  window.addEventListener('resize', resize);
}

window.addEventListener('DOMContentLoaded', init);
