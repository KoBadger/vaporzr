import butterchurn, { type Visualizer } from 'butterchurn';
import butterchurnPresets from 'butterchurn-presets';
import type { CommandMessage, PlaybackState } from '@vaporzr/shared';
import { emptyState } from '@vaporzr/shared';
import { WsClient } from './wsClient';
import { SynthOverlay, type SynthLevels } from './synthwave';

const port = Number(new URLSearchParams(window.location.search).get('port') ?? '4876');
const OVERLAY = new URLSearchParams(window.location.search).get('overlay') === '1';
const SCREENSAVER = new URLSearchParams(window.location.search).get('screensaver') === '1';

const canvas = document.getElementById('viz') as HTMLCanvasElement;
const ewCanvas = document.getElementById('ew') as HTMLCanvasElement;
const ewVideo = document.getElementById('ew-video') as HTMLVideoElement;
const btnSynth = document.getElementById('btn-synth') as HTMLButtonElement;
const status = document.getElementById('status') as HTMLDivElement;
const streamCanvas = document.createElement('canvas');
const streamCtx = streamCanvas.getContext('2d')!;
streamCanvas.width = 960;
streamCanvas.height = 540;

const pip = document.getElementById('pip') as HTMLDivElement;
const pipTitle = document.getElementById('pip-title') as HTMLSpanElement;
const pipClose = document.getElementById('pip-close') as HTMLButtonElement;
const pipVideo = document.getElementById('pip-video') as HTMLVideoElement;
const pipVideoB = document.getElementById('pip-video-b') as HTMLVideoElement;
const pipArt = document.getElementById('pip-art') as HTMLImageElement;
const pipBadge = document.getElementById('pip-badge') as HTMLSpanElement;

const controls = document.getElementById('controls') as HTMLDivElement;
const controlsToggle = document.getElementById('controls-toggle') as HTMLButtonElement;
const ctrlTitle = document.getElementById('ctrl-title') as HTMLSpanElement;
const ctrlMeta = document.getElementById('ctrl-meta') as HTMLSpanElement;
const ctrlSeek = document.getElementById('ctrl-seek') as HTMLInputElement;
const ctrlTime = document.getElementById('ctrl-time') as HTMLSpanElement;
const btnPlay = document.getElementById('btn-play') as HTMLButtonElement;
const btnPrev = document.getElementById('btn-prev') as HTMLButtonElement;
const btnNext = document.getElementById('btn-next') as HTMLButtonElement;
const btnShuffle = document.getElementById('btn-shuffle') as HTMLButtonElement;
const btnPreset = document.getElementById('btn-preset') as HTMLButtonElement;
const btnSfx = {
  airhorn: document.getElementById('btn-sfx-airhorn') as HTMLButtonElement,
  drop: document.getElementById('btn-sfx-drop') as HTMLButtonElement,
  riser: document.getElementById('btn-sfx-riser') as HTMLButtonElement,
  reverse: document.getElementById('btn-sfx-reverse') as HTMLButtonElement,
  boom: document.getElementById('btn-sfx-boom') as HTMLButtonElement,
  zap: document.getElementById('btn-sfx-zap') as HTMLButtonElement,
  applause: document.getElementById('btn-sfx-applause') as HTMLButtonElement,
  countdown: document.getElementById('btn-sfx-countdown') as HTMLButtonElement,
};
const btnDjToggle = document.getElementById('btn-dj-toggle') as HTMLButtonElement;
const ctrlVol = document.getElementById('ctrl-vol') as HTMLInputElement;
const winPass = document.getElementById('win-pass') as HTMLButtonElement;
const winHide = document.getElementById('win-hide') as HTMLButtonElement;

let visualizer: Visualizer | null = null;
let audioContext: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let streamEnabled = false;
let forwardEnabled = false;
let forwardSource: 'loopback' | 'pip' = 'loopback';
let frameTimer: number | null = null;
let stateTimer: number | null = null;
let presets: Record<string, unknown> = {};
let presetNames: string[] = [];
let currentPresetIndex = 0;
let presetCycle: number | null = null;

// YouTube playback state (two video elements enable crossfade between tracks)
let ytUri: string | null = null;
let ytTitle = '';
let ytImage = '';
let ytVolume = 100;
let pipVisible = false;
let activeVideo: HTMLVideoElement = pipVideo;
let videoGainA: GainNode | null = null;
let videoGainB: GainNode | null = null;
/** Preloaded (buffered) next video, ready to crossfade to instantly. */
let preloaded: { video: HTMLVideoElement; uri: string } | null = null;

// ---- Bridge PCM streaming (Option C: bridge feeds primary guild audio to butterchurn) ----
let loopbackGain: GainNode | null = null;
let sensitivityGain: GainNode | null = null;
let currentSensitivity = 1.0;
let bridgePcmActive = false;
let pcmSilenceTimer: number | null = null;
let pcmSourceNode: AudioBufferSourceNode | null = null;
let pcmQueue: AudioBuffer[] = [];
let pcmPlaying = false;
const PCM_MAX_QUEUE = 12;
const PCM_SILENCE_MS = 2000;

const client = new WsClient({
  port,
  role: 'visualizer',
  name: 'vaporzr-visualizer',
  onMessage: (msg) => {
    if (msg.type === 'visuals:enabled') {
      streamEnabled = msg.enabled;
      if (streamEnabled) startFrameStream();
      else stopFrameStream();
    } else if (msg.type === 'audio:forward') {
      forwardEnabled = msg.enabled;
      if (!forwardEnabled && audioContext && audioContext.state === 'running') {
        // keep the analyser alive for visuals; no-op
      }
      log(forwardEnabled ? 'Forwarding audio to Discord voice' : 'Audio forwarding disabled');
    } else if (msg.type === 'theme') {
      applyTheme(msg.theme);
    } else if (msg.type === 'burst:start') {
      void captureBurst(msg.durationMs ?? 3000);
    } else if (msg.type === 'cmd') {
      handleCmd(msg as CommandMessage);
    } else if (msg.type === 'state:update') {
      handleState(msg.state);
    } else if (msg.type === 'endlesswave') {
      handleEndlessWave(msg.active);
    } else if (msg.type === 'snapshot') {
      setDjEnabled(!!msg.djEnabled);
      // A snapshot only ever AUTO-ENABLES the scene (EW is on) — same rule as
      // the web visualizer: only a live 'endlesswave' broadcast may turn it off.
      if (msg.endlesswave === true) handleEndlessWave(true);
    } else if (msg.type === 'dj:update') {
      setDjEnabled(msg.enabled);
    } else if (msg.type === 'audio:pcm') {
      queueBridgePcm(msg.data);
    } else if (msg.type === 'visuals:sensitivity') {
      applySensitivity(msg.multiplier);
    }
  },
});

function log(msg: string): void {
  console.log('[vaporzr-visualizer]', msg);
  status.textContent = msg;
}

// ---- DJ soundboard ----

let djEnabled = false;

function setDjEnabled(enabled: boolean): void {
  djEnabled = enabled;
  btnDjToggle.classList.toggle('active', enabled);
  btnDjToggle.textContent = enabled ? '🎛' : '🎚';
  btnDjToggle.title = enabled ? 'DJ soundboard ON — click to disable' : 'DJ soundboard OFF — click to enable';
  for (const btn of Object.values(btnSfx)) {
    btn.classList.toggle('disabled', !enabled);
  }
}

// ---- Sensitivity ----

const SENSITIVITY_CURVE: Record<number, number> = {
  1.0:  0.82,
  1.10: 0.78,
  1.15: 0.74,
  1.25: 0.70,
  1.50: 0.60,
};

function applySensitivity(multiplier: number): void {
  currentSensitivity = multiplier;
  if (sensitivityGain) sensitivityGain.gain.value = multiplier;
  const smoothing = SENSITIVITY_CURVE[multiplier] ?? (0.82 - (multiplier - 1) * 0.44);
  if (analyser) analyser.smoothingTimeConstant = smoothing;
  try { localStorage.setItem('vaporzr.sensitivity', String(multiplier)); } catch {}
  log(`Sensitivity set to ${multiplier.toFixed(2)}x (smoothing ${smoothing.toFixed(2)})`);
}

// ---- Endless Wave synthwave scene (VISUALDON DeLorean) ----

let synthOverlay: SynthOverlay | null = null;
let synthActive = false;
let synthBars: number[] = new Array(24).fill(0);
let synthBass = 0;
let synthMid = 0;
let synthTreble = 0;
let synthPrevBass = 0;
let synthKickBoost = 0;
let synthKickAt = 0;
let synthBpm = 124;
let synthEnergy = 0;
let freqData: Uint8Array<ArrayBuffer> | null = null;
const prefersReducedMotion =
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Per-frame bass/mid/treble + kick/BPM estimate from the shared analyser. */
function sampleLevels(): SynthLevels {
  if (analyser) {
    if (!freqData || freqData.length !== analyser.frequencyBinCount) {
      freqData = new Uint8Array(analyser.frequencyBinCount);
    }
    analyser.getByteFrequencyData(freqData);
    const n = freqData.length;
    const data = freqData;
    const avg = (from: number, to: number): number => {
      const lo = Math.max(0, from);
      const hi = Math.min(n, to);
      if (hi <= lo) return 0;
      let s = 0;
      for (let i = lo; i < hi; i++) s += data[i];
      return s / (hi - lo) / 255;
    };
    // fftSize 2048 @ 48kHz -> ~23.4Hz/bin: bass 60-370Hz, mid 370Hz-3.1kHz,
    // treble 3.1-12kHz. Same smoothing + kick logic as the web visualizer.
    synthBass += (avg(2, 16) - synthBass) * 0.4;
    synthMid += (avg(16, 132) - synthMid) * 0.35;
    synthTreble += (avg(132, 512) - synthTreble) * 0.5;
    synthEnergy = (synthBass + synthMid + synthTreble) / 3;
    // 24 log-spaced spectrum bars for the overlay (mirrors the web feed shape).
    for (let i = 0; i < 24; i++) {
      const lo = Math.min(n - 1, Math.floor(2 * Math.pow(1.32, i)));
      const hi = Math.min(n, Math.max(lo + 1, Math.floor(2 * Math.pow(1.32, i + 1))));
      synthBars[i] += (avg(lo, hi) - synthBars[i]) * 0.35;
    }
    if (synthBass > 0.16 && synthBass - synthPrevBass >= 0.045) {
      const now = Date.now();
      if (now - synthKickAt > 250) {
        if (synthKickAt && now - synthKickAt > 400) {
          const iv = 60000 / (now - synthKickAt);
          synthBpm = Math.max(70, Math.min(180, synthBpm * 0.7 + iv * 0.3));
        }
        synthKickAt = now;
        synthKickBoost = Math.min(1, synthKickBoost + 1);
      }
    }
    synthPrevBass = synthBass;
  }
  return {
    bass: synthBass,
    mid: synthMid,
    treble: synthTreble,
    kickBoost: synthKickBoost,
    bpm: synthBpm,
    energy: synthEnergy,
  };
}

function setSynthActive(on: boolean): void {
  synthActive = on;
  ewCanvas.style.display = on ? 'block' : 'none';
  ewVideo.style.display = on ? 'block' : 'none';
  btnSynth.classList.toggle('active', on);
  if (on && !prefersReducedMotion) {
    void ewVideo.play().catch(() => {
      /* autoplay blocked until the next user gesture */
    });
  } else {
    ewVideo.pause();
  }
}

function handleEndlessWave(active: boolean): void {
  if (active) {
    btnSynth.classList.add('ew-revealed');
    if (!synthActive) setSynthActive(true);
  } else if (synthActive) {
    setSynthActive(false);
  }
}

// ---- Controls overlay ----

let latestState: PlaybackState = emptyState();
let controlsVisible = true;
let controlsTimer: number | null = null;

function sendCmd(command: CommandMessage['command'], extra: Partial<CommandMessage> = {}): void {
  client.send({ type: 'cmd', command, ...extra });
}

function fmtTime(ms: number): string {
  if (!isFinite(ms) || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function setControlsVisible(visible: boolean): void {
  controlsVisible = visible;
  controls.classList.toggle('visible', visible);
  controlsToggle.classList.toggle('on', visible);
}

function updateControls(): void {
  const st = latestState;
  const track = st.track;
  ctrlTitle.textContent = track?.name || 'Nothing playing';
  ctrlMeta.textContent = track ? (track.artists?.join(', ') || 'Unknown artist') : '';
  btnPlay.textContent = st.playing ? '⏸' : '▶';
  btnShuffle.classList.toggle('active', st.shuffle);

  const durMs = st.durationMs || 0;
  const max = Math.max(1, Math.round(durMs / 1000));
  if (!ctrlSeek.matches(':active')) {
    let pos = st.positionMs || 0;
    if (st.playing) pos += Math.max(0, Date.now() - (st.updatedAt || Date.now()));
    ctrlSeek.value = String(Math.min(max, Math.round(pos / 1000)));
  }
  ctrlTime.textContent = `${fmtTime(Number(ctrlSeek.value) * 1000)} / ${fmtTime(durMs)}`;
  ctrlSeek.max = String(max);
  if (document.activeElement !== ctrlVol) ctrlVol.value = String(st.volume ?? 50);
  btnShuffle.classList.toggle('disabled', !track);
  btnPlay.classList.toggle('disabled', !track);
  btnPrev.classList.toggle('disabled', !track);
  btnNext.classList.toggle('disabled', !track);
}

function wireControls(): void {
  btnPlay.addEventListener('click', () => sendCmd('toggle'));
  btnPrev.addEventListener('click', () => sendCmd('previous'));
  btnNext.addEventListener('click', () => sendCmd('next'));
  btnShuffle.addEventListener('click', () => sendCmd('shuffle', { shuffle: !latestState.shuffle }));
  btnPreset.addEventListener('click', () => cyclePreset());
  btnSynth.addEventListener('click', () => setSynthActive(!synthActive));
  btnDjToggle.addEventListener('click', () => sendCmd('dj', { djEnabled: !djEnabled }));
  for (const [id, btn] of Object.entries(btnSfx)) {
    btn.addEventListener('click', () => sendCmd('sfx', { sfxId: id }));
  }

  ctrlSeek.addEventListener('input', () => {
    ctrlTime.textContent = `${fmtTime(Number(ctrlSeek.value) * 1000)} / ${fmtTime(latestState.durationMs || 0)}`;
  });
  ctrlSeek.addEventListener('change', () => {
    sendCmd('seek', { positionMs: Number(ctrlSeek.value) * 1000 });
  });

  ctrlVol.addEventListener('input', () => {
    if (latestState.track) sendCmd('volume', { volume: Number(ctrlVol.value) });
  });

  controlsToggle.addEventListener('click', () => setControlsVisible(!controlsVisible));

  window.addEventListener('keydown', (e) => {
    if (!controlsVisible && e.key !== 'c' && e.key !== 'C' && e.key !== 'h' && e.key !== 'H') return;
    if (e.target instanceof HTMLInputElement) return;
    switch (e.key) {
      case ' ':
        e.preventDefault();
        sendCmd('toggle');
        break;
      case 's':
      case 'S':
        sendCmd('shuffle', { shuffle: !latestState.shuffle });
        break;
      case 'p':
      case 'P':
        cyclePreset();
        break;
      case 'e':
      case 'E':
        setSynthActive(!synthActive);
        break;
      case 'ArrowUp':
        e.preventDefault();
        sendCmd('volume', { volume: Math.min(100, (latestState.volume ?? 50) + 10) });
        break;
      case 'ArrowDown':
        e.preventDefault();
        sendCmd('volume', { volume: Math.max(0, (latestState.volume ?? 50) - 10) });
        break;
      case 'ArrowRight':
        e.preventDefault();
        sendCmd('seek', { positionMs: (latestState.positionMs || 0) + 10000 });
        break;
      case 'ArrowLeft':
        e.preventDefault();
        sendCmd('seek', { positionMs: Math.max(0, (latestState.positionMs || 0) - 10000) });
        break;
      case 'c':
      case 'C':
      case 'Escape':
        setControlsVisible(!controlsVisible);
        break;
      case 'h':
      case 'H':
        toggleChromeAutoHide();
        break;
    }
  });

  controlsTimer = window.setInterval(updateControls, 500);
}

// ---- Chrome auto-hide (window strip, PIP title bar, controls, status) ----

const vaporzrWindow = window as unknown as {
  vaporzr?: {
    minimizeWindow?: () => void;
    closeWindow?: () => void;
    setOverlayPassthrough?: (pass: boolean) => void;
    onOverlayPassthrough?: (cb: (pass: boolean) => void) => void;
    hideOverlay?: () => void;
  };
};
const winMin = document.getElementById('win-min') as HTMLButtonElement;
const winClose = document.getElementById('win-close') as HTMLButtonElement;

let chromeAutoHide = true;
let chromeVisible = true;
let chromeTimer: number | null = null;
const CHROME_TIMEOUT = 3000;

function setChromeVisible(visible: boolean): void {
  chromeVisible = visible;
  document.body.classList.toggle('chrome-hidden', !visible);
}

/** Show the chrome and (re)start the idle timeout. Called on mouse motion. */
function pokeChrome(): void {
  if (!chromeAutoHide) return;
  if (!chromeVisible) setChromeVisible(true);
  if (chromeTimer) window.clearTimeout(chromeTimer);
  chromeTimer = window.setTimeout(() => {
    chromeTimer = null;
    setChromeVisible(false);
  }, CHROME_TIMEOUT);
}

function toggleChromeAutoHide(): void {
  chromeAutoHide = !chromeAutoHide;
  try {
    localStorage.setItem('vaporzr.chromeAutoHide', chromeAutoHide ? '1' : '0');
  } catch {
    /* storage unavailable */
  }
  if (chromeAutoHide) pokeChrome();
  else setChromeVisible(true);
  log(`Chrome auto-hide ${chromeAutoHide ? 'on' : 'off'} (${chromeAutoHide ? 'H to lock visible' : 'H to auto-hide'})`);
}

// ---- PIP / mini player ----

function showPip(): void {
  pip.classList.remove('hidden');
  pipVisible = true;
}

function hidePip(): void {
  pip.classList.add('hidden');
  pipVisible = false;
}

function setPipVideo(v: HTMLVideoElement): void {
  pipArt.classList.remove('visible');
  pipVideo.classList.remove('visible');
  pipVideoB.classList.remove('visible');
  v.classList.add('visible');
  pipBadge.textContent = '▶️ YOUTUBE';
}

function setPipArt(title: string, image: string, badge = '🎵 SPOTIFY'): void {
  pipVideo.classList.remove('visible');
  pipVideoB.classList.remove('visible');
  pipTitle.textContent = title;
  if (image) {
    pipArt.src = image;
    pipArt.classList.add('visible');
  } else {
    pipArt.removeAttribute('src');
    pipArt.classList.remove('visible');
  }
  pipBadge.textContent = badge;
}

function setPipTitle(title: string): void {
  pipTitle.textContent = title;
}

function handleState(state: PlaybackState): void {
  latestState = state;
  updateControls();
  if (OVERLAY) updateOverlayIdle(state.playing);
  const idle = !state.playing;
  document.body.classList.toggle('idle', idle);
  const v = document.getElementById('idle-video') as HTMLVideoElement;
  if (idle) void v.play().catch(() => {});
  else if (!v.paused) v.pause();
  if (ytUri) return; // an active YouTube video owns the PIP
  const src = state.track?.source;
  if (src === 'spotify' && state.track?.image) {
    setPipArt(state.track.name, state.track.image);
    showPip();
  } else if (src === 'spotify') {
    setPipArt(state.track?.name ?? 'Spotify', '');
    showPip();
  } else if (src === 'youtube' && state.track?.image) {
    // Audio is server-side now; show the thumbnail instead of a black <video>.
    setPipArt(state.track.name, state.track.image, '▶️ YOUTUBE');
    showPip();
  } else if (state.playing) {
    showPip();
  } else {
    hidePip();
  }
}

function otherVideo(v: HTMLVideoElement): HTMLVideoElement {
  return v === pipVideo ? pipVideoB : pipVideo;
}

function gainFor(v: HTMLVideoElement): GainNode | null {
  return v === pipVideo ? videoGainA : videoGainB;
}

function stopYoutube(): void {
  forwardSource = 'loopback';
  for (const v of [pipVideo, pipVideoB]) {
    v.pause();
    v.removeAttribute('src');
    v.load();
    v.classList.remove('visible');
  }
  preloaded = null;
  ytUri = null;
  ytTitle = '';
  ytImage = '';
  activeVideo = pipVideo;
  hidePip();
}

function currentVideo(): HTMLVideoElement {
  return ytUri ? activeVideo : pipVideo;
}

function reportYoutubeState(): void {
  if (!ytUri) return;
  const v = currentVideo();
  const durMs = v.duration && isFinite(v.duration) ? v.duration * 1000 : 0;
  client.send({
    type: 'player:state',
    state: {
      source: 'youtube',
      playing: !v.paused && !v.ended,
      track: {
        uri: ytUri,
        name: ytTitle,
        artists: ['YouTube'],
        album: 'YouTube',
        durationMs: durMs,
        image: ytImage || undefined,
        source: 'youtube',
        addedBy: '',
        addedAt: 0,
      },
      positionMs: v.currentTime * 1000,
      durationMs: durMs,
      volume: ytVolume,
      shuffle: false,
      repeat: false,
      updatedAt: Date.now(),
    },
  });
}

/** Crossfade from the current video into `next` (already loaded with a src). */
function crossfadeTo(next: HTMLVideoElement): void {
  const from = activeVideo === next ? otherVideo(next) : activeVideo;
  const fromGain = gainFor(from);
  const toGain = gainFor(next);
  activeVideo = next;

  const ctx = audioContext;
  if (ctx && fromGain && toGain) {
    const now = ctx.currentTime;
    fromGain.gain.setValueAtTime(fromGain.gain.value, now);
    toGain.gain.setValueAtTime(toGain.gain.value, now);
    toGain.gain.linearRampToValueAtTime(1, now + 1.2);
    fromGain.gain.linearRampToValueAtTime(0, now + 1.2);
    window.setTimeout(() => {
      from.pause();
      from.removeAttribute('src');
      from.load();
      from.classList.remove('visible');
    }, 1300);
  } else {
    from.pause();
    from.removeAttribute('src');
    from.load();
    from.classList.remove('visible');
  }

  next.classList.add('visible');
  void next.play().catch(() => {
    /* autoplay should be allowed; retry on next state tick */
  });
}

function playYoutube(msg: CommandMessage): void {
  forwardSource = 'pip';
  const uri = msg.uris?.[0] ?? 'youtube:video:unknown';
  const title = msg.title ?? 'YouTube';
  const image = msg.image ?? '';

  // If a buffered preload matches, switch to it instantly.
  if (preloaded && preloaded.uri === uri) {
    const v = preloaded.video;
    preloaded = null;
    ytUri = uri;
    ytTitle = title;
    ytImage = image;
    setPipTitle(title);
    showPip();
    crossfadeTo(v);
    reportYoutubeState();
    return;
  }

  // Fresh track: load into the inactive element and crossfade to it.
  const v = otherVideo(activeVideo);
  v.src = msg.streamUrl!;
  ytUri = uri;
  ytTitle = title;
  ytImage = image;
  setPipTitle(title);
  setPipVideo(v);
  showPip();
  crossfadeTo(v);
  reportYoutubeState();
}

function handleCmd(msg: CommandMessage): void {
  switch (msg.command) {
    case 'play':
      if (msg.source === 'youtube' && msg.streamUrl) playYoutube(msg);
      break;
    case 'preload':
      if (msg.source === 'youtube' && msg.streamUrl) {
        const uri = msg.uris?.[0] ?? 'youtube:video:unknown';
        // Don't clobber a preload for a different upcoming track while it plays.
        const v = otherVideo(activeVideo);
        v.src = msg.streamUrl;
        v.load();
        preloaded = { video: v, uri };
      }
      break;
    case 'pause':
      if (ytUri) currentVideo().pause();
      reportYoutubeState();
      break;
    case 'resume':
      if (ytUri) void currentVideo().play().catch(() => {});
      reportYoutubeState();
      break;
    case 'seek':
      if (ytUri && msg.positionMs != null) currentVideo().currentTime = msg.positionMs / 1000;
      reportYoutubeState();
      break;
    case 'volume':
      if (ytUri && msg.volume != null) {
        ytVolume = msg.volume;
        pipVideo.volume = msg.volume / 100;
        pipVideoB.volume = msg.volume / 100;
      }
      break;
    case 'stop':
      stopYoutube();
      break;
    default:
      break;
  }
}

// ---- Visualizer (unchanged) ----

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
  audioContext = new AudioContext({ sampleRate: 48000 });
  if (audioContext.state === 'suspended') void audioContext.resume();
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.82;

  sensitivityGain = audioContext.createGain();
  sensitivityGain.gain.value = 1.0;
  sensitivityGain.connect(analyser);

  const stream = await getLoopbackStream();
  if (!stream) {
    // No loopback audio — feed the analyser silence so the visualizer still
    // runs and frames keep streaming to panels (flatline visuals) instead of
    // showing nothing at all.
    log('Loopback audio unavailable — visualizing silence');
    loopbackGain = audioContext.createGain();
    loopbackGain.gain.value = 0;
    const osc = audioContext.createOscillator();
    const mute = audioContext.createGain();
    mute.gain.value = 0;
    osc.connect(mute);
    mute.connect(loopbackGain);
    loopbackGain.connect(sensitivityGain);
    osc.start();
    return true;
  }

  const source = audioContext.createMediaStreamSource(stream);
  loopbackGain = audioContext.createGain();
  loopbackGain.gain.value = 1;
  source.connect(loopbackGain);
  loopbackGain.connect(sensitivityGain);

  // Tap the raw stream: convert Float32 (48kHz stereo) -> Int16 PCM and send
  // it to the bot for the Discord voice channel when forwarding is enabled.
  const processor = audioContext.createScriptProcessor(2048, 2, 2);
  const sink = audioContext.createGain();
  sink.gain.value = 0; // keep the processor alive without audible re-emission
  source.connect(processor);
  processor.connect(sink);
  sink.connect(audioContext.destination);
  processor.onaudioprocess = (e) => {
    if (forwardEnabled && forwardSource === 'loopback') sendPcm(e.inputBuffer);
  };

  // Direct tap on the YouTube PIP videos. Loopback capture can exclude the
  // capturing page's own audio, so route the video elements through the graph
  // and forward directly instead when a YouTube video is active. Two elements
  // with per-element gains allow crossfading between tracks (gapless).
  try {
    const videoProcessor = audioContext.createScriptProcessor(2048, 2, 2);
    const videoSink = audioContext.createGain();
    videoSink.gain.value = 0;
    for (const [vid, gain] of [
      [pipVideo, 'videoGainA'],
      [pipVideoB, 'videoGainB'],
    ] as Array<[HTMLVideoElement, 'videoGainA' | 'videoGainB']>) {
      const videoSource = audioContext.createMediaElementSource(vid);
      const g = audioContext.createGain();
      g.gain.value = vid === pipVideo ? 1 : 0; // A is active initially
      if (gain === 'videoGainA') videoGainA = g;
      else videoGainB = g;
      // Route everything (local speakers, analyser, AND the forwarded VC audio)
      // through the per-element gain so crossfades apply to Discord too.
      videoSource.connect(g);
      g.connect(audioContext.destination);
      g.connect(sensitivityGain!);
      g.connect(videoProcessor);
    }
    videoProcessor.connect(videoSink);
    videoSink.connect(audioContext.destination);
    videoProcessor.onaudioprocess = (e) => {
      if (forwardEnabled && forwardSource === 'pip') sendPcm(e.inputBuffer);
    };
  } catch {
    // If an element was already routed elsewhere, fall back to loopback only.
  }
  return true;
}

function sendPcm(input: AudioBuffer): void {
  const l = input.getChannelData(0);
  const r = input.getChannelData(1);
  const n = l.length;
  const pcm = new Int16Array(n * 2);
  for (let i = 0; i < n; i++) {
    let s = l[i];
    if (s > 1) s = 1;
    else if (s < -1) s = -1;
    pcm[i * 2] = s < 0 ? s * 0x8000 : s * 0x7fff;
    let s2 = r[i];
    if (s2 > 1) s2 = 1;
    else if (s2 < -1) s2 = -1;
    pcm[i * 2 + 1] = s2 < 0 ? s2 * 0x8000 : s2 * 0x7fff;
  }
  client.send({ type: 'audio:chunk', data: b64(pcm.buffer) });
}

// ---- Bridge PCM decode + streaming (Option C) ----

function decodeBridgePcm(b64Data: string): AudioBuffer | null {
  if (!audioContext) return null;
  const bin = atob(b64Data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const numSamples = bytes.length / 4; // 2 channels * 2 bytes
  const buf = audioContext.createBuffer(2, numSamples, 48000);
  const left = buf.getChannelData(0);
  const right = buf.getChannelData(1);
  const dv = new DataView(bytes.buffer);
  for (let i = 0; i < numSamples; i++) {
    left[i]  = dv.getInt16(i * 4,     true) / 32768;
    right[i] = dv.getInt16(i * 4 + 2, true) / 32768;
  }
  return buf;
}

function queueBridgePcm(b64Data: string): void {
  const buf = decodeBridgePcm(b64Data);
  if (!buf || !audioContext || !analyser) return;

  bridgePcmActive = true;

  // Mute loopback so only bridge PCM drives the visualizer.
  if (loopbackGain) loopbackGain.gain.value = 0;

  // Reset silence fallback timer.
  if (pcmSilenceTimer) clearTimeout(pcmSilenceTimer);
  pcmSilenceTimer = window.setTimeout(() => {
    bridgePcmActive = false;
    if (loopbackGain) loopbackGain.gain.value = 1;
    pcmPlaying = false;
    pcmSourceNode = null;
    pcmQueue.length = 0;
    log('Bridge PCM idle — visualizer follows loopback');
  }, PCM_SILENCE_MS);

  // Drop oldest chunks if the queue backs up.
  if (pcmQueue.length > PCM_MAX_QUEUE) pcmQueue.shift();
  pcmQueue.push(buf);
  if (!pcmPlaying) playNextBridgePcmChunk();
}

function playNextBridgePcmChunk(): void {
  if (pcmQueue.length === 0 || !audioContext || !analyser) {
    pcmPlaying = false;
    pcmSourceNode = null;
    return;
  }
  pcmPlaying = true;
  const buf = pcmQueue.shift()!;
  const src = audioContext.createBufferSource();
  src.buffer = buf;
  src.connect(sensitivityGain!);
  pcmSourceNode = src;
  src.onended = () => {
    src.disconnect();
    if (bridgePcmActive) playNextBridgePcmChunk();
    else { pcmPlaying = false; pcmSourceNode = null; }
  };
  src.start();
}

function cyclePreset(): void {
  if (!visualizer || presetNames.length === 0) return;
  currentPresetIndex = (currentPresetIndex + 1 + Math.floor(Math.random() * Math.max(1, presetNames.length - 1))) % presetNames.length;
  visualizer.loadPreset(presets[presetNames[currentPresetIndex]], 1.5);
}

function resize(): void {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth || 1280;
  const h = canvas.clientHeight || 720;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  // The EW canvas may be hidden (clientWidth 0) — mirror the main canvas size.
  ewCanvas.width = w * dpr;
  ewCanvas.height = h * dpr;
  visualizer?.setRendererSize(w, h, dpr);
}

function renderLoop(): void {
  const lv = sampleLevels();
  if (synthActive && synthOverlay) {
    const t = latestState.track;
    synthOverlay.render(
      Date.now(),
      lv,
      synthBars,
      t ? { name: t.name || '', artists: (t.artists || []).join(', ') } : null,
      prefersReducedMotion,
    );
  } else if (visualizer) {
    visualizer.render();
  }
  requestAnimationFrame(renderLoop);
}

/** Canvas currently on screen — frame forwarding follows the visible scene. */
function activeCanvas(): HTMLCanvasElement {
  return synthActive ? ewCanvas : canvas;
}

function sendFrame(): void {
  if (!streamEnabled || !analyser) return;
  if (synthActive && !synthOverlay) return;
  if (!synthActive && !visualizer) return;
  const src = activeCanvas();
  if (!src.width || !src.height) return;
  try {
    // Synth mode composites the wallpaper video under the overlay canvas.
    if (synthActive && ewVideo.readyState >= 2) {
      streamCtx.drawImage(ewVideo, 0, 0, streamCanvas.width, streamCanvas.height);
    }
    streamCtx.drawImage(src, 0, 0, streamCanvas.width, streamCanvas.height);
    client.send({ type: 'visuals:frame', data: streamCanvas.toDataURL('image/jpeg', 0.6) });
  } catch {
    /* tainted canvas (video CORS) — skip this frame rather than spamming errors */
  }
}

function b64(buf: ArrayBuffer): string {
  let bin = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
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

// ---- Theme, overlay, burst ----

function applyTheme(t: { accent: string; accent2: string; glow: string }): void {
  const root = document.documentElement.style;
  root.setProperty('--vz-accent', t.accent);
  root.setProperty('--vz-accent2', t.accent2);
  root.setProperty('--vz-glow', t.glow);
}

/** Capture a short WebM clip of the visuals and send it back to the bot (/burst). */
async function captureBurst(durationMs: number): Promise<void> {
  // Synth mode composites the wallpaper video under the overlay via a pump
  // canvas so the clip shows the full scene, not just the overlay layer.
  let pump: number | null = null;
  let captureSrc: HTMLCanvasElement = activeCanvas();
  if (synthActive && ewVideo.readyState >= 2 && ewCanvas.width > 0 && ewCanvas.height > 0) {
    try {
      const comp = document.createElement('canvas');
      comp.width = ewCanvas.width;
      comp.height = ewCanvas.height;
      const cctx = comp.getContext('2d');
      if (cctx) {
        captureSrc = comp;
        pump = window.setInterval(() => {
          try {
            cctx.drawImage(ewVideo, 0, 0, comp.width, comp.height);
            cctx.drawImage(ewCanvas, 0, 0, comp.width, comp.height);
          } catch {
            /* tainted video frame — keep the last good composite */
          }
        }, 33);
      }
    } catch {
      captureSrc = activeCanvas();
    }
  }
  const stopPump = (): void => {
    if (pump !== null) {
      window.clearInterval(pump);
      pump = null;
    }
  };
  const stream = captureSrc.captureStream(30);
  const mime =
    ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m)) ??
    'video/webm';
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 4_000_000 });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  rec.onstop = async () => {
    stopPump();
    stream.getTracks().forEach((t) => t.stop());
    const blob = new Blob(chunks, { type: mime });
    const buf = await blob.arrayBuffer();
    log(`Burst captured (${Math.round(buf.byteLength / 1024)} KB)`);
    client.send({ type: 'burst:data', data: b64(buf) });
  };
  rec.start(250);
  window.setTimeout(() => {
    try {
      rec.stop();
    } catch {
      /* already stopped */
    }
  }, Math.min(4000, Math.max(1000, durationMs)));
}

let lastPlayingAt = 0;
let idleCheck: number | null = null;
const OVERLAY_IDLE_MS = 5000;
const SCREENSAVER_QUIT_MS = 15000;

/** Fade the overlay out when nothing has played, close screensaver after a long idle. */
function updateOverlayIdle(playing: boolean): void {
  if (playing) lastPlayingAt = Date.now();
  if (idleCheck) return;
  idleCheck = window.setInterval(() => {
    const idleMs = Date.now() - lastPlayingAt;
    document.body.classList.toggle('overlay-idle', idleMs > OVERLAY_IDLE_MS);
    if (SCREENSAVER && idleMs > SCREENSAVER_QUIT_MS) {
      if (idleCheck) window.clearInterval(idleCheck);
      idleCheck = null;
      vaporzrWindow.vaporzr?.closeWindow?.();
    }
  }, 1000);
}

function init(): void {
  presets = butterchurnPresets.getPresets();
  presetNames = Object.keys(presets);
  log(`Loaded ${presetNames.length} presets`);

  wireControls();
  setControlsVisible(true);
  updateControls();
  try {
    synthOverlay = new SynthOverlay(ewCanvas);
  } catch (e) {
    log(`synthwave overlay unavailable: ${e instanceof Error ? e.message : String(e)}`);
    synthOverlay = null;
  }
  // Wallpaper video streams from the bot (same helper port as the WS link)
  // with CORS so frame forwarding stays untainted.
  try {
    ewVideo.crossOrigin = 'anonymous';
    ewVideo.src = `http://127.0.0.1:${port}/ew-bg.mp4`;
    ewVideo.poster = `http://127.0.0.1:${port}/ew-bg.jpg`;
  } catch {
    /* video layer stays on its static fallback */
  }

  pipClose.addEventListener('click', () => {
    // Close hides the mini player; the audio keeps playing.
    hidePip();
  });

  winMin.addEventListener('click', () => vaporzrWindow.vaporzr?.minimizeWindow?.());
  winClose.addEventListener('click', () => vaporzrWindow.vaporzr?.closeWindow?.());
  winHide.addEventListener('click', () => vaporzrWindow.vaporzr?.hideOverlay?.());

  if (OVERLAY) {
    document.body.classList.add('overlay');
    if (SCREENSAVER) document.body.classList.add('screensaver');
    chromeAutoHide = false;
    setChromeVisible(true);
    // Ctrl+Shift+V toggles passthrough; the renderer just reflects the state.
    vaporzrWindow.vaporzr?.onOverlayPassthrough?.((pass) => {
      document.body.classList.toggle('interactive', !pass);
    });
    winPass.addEventListener('click', () => vaporzrWindow.vaporzr?.setOverlayPassthrough?.(true));
  }

  try {
    chromeAutoHide = localStorage.getItem('vaporzr.chromeAutoHide') !== '0';
  } catch {
    /* storage unavailable */
  }
  if (chromeAutoHide) pokeChrome();
  else setChromeVisible(true);
  window.addEventListener('mousemove', pokeChrome, { passive: true });
  window.addEventListener('wheel', pokeChrome, { passive: true });

  pipVideo.addEventListener('ended', () => {
    reportYoutubeState();
  });
  pipVideoB.addEventListener('ended', () => {
    reportYoutubeState();
  });

  stateTimer = window.setInterval(reportYoutubeState, 2000);

  void initAudio().then((ok) => {
    if (!ok || !audioContext || !analyser) {
      log('Audio unavailable — showing idle visualizer');
      return;
    }
    try {
      const saved = localStorage.getItem('vaporzr.sensitivity');
      if (saved) applySensitivity(Number(saved));
    } catch {}
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
      visualizer.connectAudio(analyser);
      log('Visualizer running');
      presetCycle = window.setInterval(cyclePreset, 30000);
    } catch (e) {
      log(`butterchurn init failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  resize();
  renderLoop();
  window.addEventListener('resize', resize);
}

window.addEventListener('DOMContentLoaded', init);
