import butterchurn, { type Visualizer } from 'butterchurn';
import butterchurnPresets from 'butterchurn-presets';
import type { CommandMessage, PlaybackState } from '@vaporzr/shared';
import { emptyState } from '@vaporzr/shared';
import { WsClient } from './wsClient';
import { moodColor, SynthOverlay, type SynthLevels } from './synthwave';
import { drawQr } from './qr';

const port = Number(new URLSearchParams(window.location.search).get('port') ?? '4876');
const OVERLAY = new URLSearchParams(window.location.search).get('overlay') === '1';
const SCREENSAVER = new URLSearchParams(window.location.search).get('screensaver') === '1';
/** Chromeless capture mode for OBS: no cursor, no controls, fixed window. */
const BROADCAST = new URLSearchParams(window.location.search).get('broadcast') === '1';
/** Explicit socket URL (wss://host/ws) for a bot on another machine. */
const WS_URL = new URLSearchParams(window.location.search).get('ws') ?? undefined;
/** Where to fetch the Endless Wave wallpaper + poster. Follows the socket host so
 *  a remote bot still serves its own assets; falls back to the local bot port. */
const ASSET_BASE = (() => {
  if (WS_URL) {
    try {
      const u = new URL(WS_URL);
      return `${u.protocol === 'wss:' ? 'https:' : 'http:'}//${u.host}`;
    } catch {
      /* malformed URL — fall through to the local bot */
    }
  }
  return `http://127.0.0.1:${port}`;
})();

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
const btnWave = document.getElementById('btn-wave') as HTMLButtonElement;
const btnPreset = document.getElementById('btn-preset') as HTMLButtonElement;
const btnPresetBack = document.getElementById('btn-preset-back') as HTMLButtonElement;
const btnPresetShuffle = document.getElementById('btn-preset-shuffle') as HTMLButtonElement;
const presetToast = document.getElementById('preset-toast') as HTMLDivElement;
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
// Visual controls (Phase 2 parity with the web visualizer).
const btnPace = document.getElementById('btn-pace') as HTMLButtonElement;
const btnCalm = document.getElementById('btn-calm') as HTMLButtonElement;
const btnLock = document.getElementById('btn-lock') as HTMLButtonElement;
const btnPresets = document.getElementById('btn-presets') as HTMLButtonElement;
const btnBars = document.getElementById('btn-bars') as HTMLButtonElement;
const btnJamQr = document.getElementById('btn-jamqr') as HTMLButtonElement;
const sensSlider = document.getElementById('sens') as HTMLInputElement;
const swatchBar = document.getElementById('swatches') as HTMLSpanElement;
const guildBar = document.getElementById('guild-bar') as HTMLDivElement;
const presetPicker = document.getElementById('preset-picker') as HTMLDivElement;
const presetSearch = document.getElementById('preset-search') as HTMLInputElement;
const presetList = document.getElementById('preset-list') as HTMLDivElement;
// Bar layer (a scene that needs neither butterchurn nor an audio device).
const barsCanvas = document.getElementById('bars') as HTMLCanvasElement;
const barCtx = barsCanvas.getContext('2d');
/** Bar layer on: the visuals stay alive with no audio coming in at all. */
let barMode = false;
/** Bar-layer palette, kept in step with the theme by applyTheme(). */
let barAccent = '#6a5cff';
let barAccent2 = '#22d3ee';
let barGlow = 'rgba(106, 92, 255, 0.45)';
const winPass = document.getElementById('win-pass') as HTMLButtonElement;
const winHide = document.getElementById('win-hide') as HTMLButtonElement;

let visualizer: Visualizer | null = null;
let audioContext: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let streamEnabled = false;
let forwardEnabled = false;
let forwardSource: 'loopback' | 'pip' = 'loopback';
let waveMode: 'off' | 'basic' | 'smart' = 'off';
let frameTimer: number | null = null;
let stateTimer: number | null = null;
let presets: Record<string, unknown> = {};
let presetNames: string[] = [];
let currentPresetIndex = 0;
let presetCycle: number | null = null;
/** Seconds each visual stays up before auto-advancing (panel-controlled). */
let presetCycleSec = 45;

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
/** Latest mood palette from the bot (V@mood), or null for the static theme. */
let moodPalette: { hue: number; sat: number; light: number } | null = null;
let bridgePcmActive = false;
let pcmSilenceTimer: number | null = null;
let pcmSourceNode: AudioBufferSourceNode | null = null;
let pcmQueue: AudioBuffer[] = [];
let pcmPlaying = false;
const PCM_MAX_QUEUE = 12;
const PCM_SILENCE_MS = 2000;

const client = new WsClient({
  port,
  url: WS_URL,
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
      setWaveMode(msg.mode ?? (msg.active ? 'smart' : 'off'));
    } else if (msg.type === 'snapshot') {
      setDjEnabled(!!msg.djEnabled);
      // Apply the server's current theme + reactivity up front. Without this the
      // player sat on its own defaults until someone happened to change them,
      // which is part of why it looked different from the web visualizer.
      if (msg.theme) applyTheme(msg.theme);
      if (typeof msg.sensitivity === 'number') applySensitivity(msg.sensitivity);
      // A snapshot only ever AUTO-ENABLES the scene (EW is on) — same rule as
      // the web visualizer: only a live 'endlesswave' broadcast may turn it off.
      if (msg.endlesswaveMode) setWaveMode(msg.endlesswaveMode);
      else if (msg.endlesswave === true) handleEndlessWave(true);
      if (typeof msg.presetCycle === 'number') setPresetCycle(msg.presetCycle, false);
      if (msg.guilds) setGuilds(msg.guilds, msg.primaryGuildId);
      // The bridge tells us when we connected without the share key. A guest has
      // every `cmd` dropped, so say it out loud instead of failing silently —
      // that silence is exactly what made the player look like it had no controls.
      if (msg.guest) {
        log('Guest mode — the bot is keyed, so controls are ignored. Restart with VAPORZR_KEY=… (or --key=…)');
      }
    } else if (msg.type === 'dj:update') {
      setDjEnabled(msg.enabled);
    } else if (msg.type === 'audio:pcm') {
      queueBridgePcm(msg.data);
    } else if (msg.type === 'visuals:sensitivity') {
      applySensitivity(msg.multiplier);
    } else if (msg.type === 'visuals:mood') {
      // Mood-reactive palette (V@mood). The web visualizer has always honoured
      // this; the player never handled it, so its colours stayed static.
      applyMood(msg.on === false ? null : { hue: msg.hue, sat: msg.sat, light: msg.light });
    } else if (msg.type === 'preset:nav') {
      if (msg.action === 'prev') previousPreset(1.2);
      else if (msg.action === 'shuffle') shufflePreset(1.5);
      else nextPreset(1.5);
    } else if (msg.type === 'preset:cycle') {
      setPresetCycle(msg.seconds);
    } else if (msg.type === 'jam:presence') {
      if (msg.joinPath) jamJoinPath = msg.joinPath;
      renderJamQr();
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

// The player keeps a smoother analyser than the web visualizer on purpose: it
// drives a full-window scene on a desktop GPU, where a lower smoothing constant
// reads as jitter rather than energy. An earlier change lowered this to match
// the web visualizer and made the player visibly choppier, so the original
// curve is restored — parity should flow from the player to the web, not the
// other way round.
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
  // Keep the slider honest when the value arrives from the bot (snapshot) or
  // another panel, not just from this window's own drag.
  if (sensSlider) sensSlider.value = String(multiplier);
  log(`Sensitivity set to ${multiplier.toFixed(2)}x (smoothing ${smoothing.toFixed(2)})`);
}

/** Lock the current visual: the carousel stops advancing (this viewer only). */
let presetLocked = false;

/** (Re)start the preset carousel at the configured pace. 0 = manual. */
function startPresetCycle(): void {
  if (presetCycle) window.clearInterval(presetCycle);
  presetCycle = null;
  if (presetCycleSec <= 0) return;
  presetCycle = window.setInterval(() => {
    // A locked visual stays put — the same rule the web visualizer uses.
    if (!presetLocked) nextPreset(2.5);
  }, presetCycleSec * 1000);
}

/** Panel-driven dwell time — the same global setting the web visualizer uses. */
function setPresetCycle(secs: number, persist = true): void {
  presetCycleSec = Math.max(0, Math.min(600, Math.round(secs || 0)));
  if (persist) { try { localStorage.setItem('vaporzr.presetCycle', String(presetCycleSec)); } catch {} }
  startPresetCycle();
  updateVisualButtons();
  log(`Preset pace: ${presetCycleSec > 0 ? `${presetCycleSec}s per visual` : 'manual'}`);
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
  // Kick pulses decay every frame so the glow breathes with the beat instead of
  // latching at max (matches drawSynth in the web visualizer).
  synthKickBoost = Math.max(0, synthKickBoost * 0.9);
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
    mood: moodPalette,
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

/** Update the autoplay cycler button + the Endless Wave scene. */
function setWaveMode(mode: 'off' | 'basic' | 'smart'): void {
  waveMode = mode;
  if (btnWave) {
    btnWave.textContent = mode === 'smart' ? '🌊' : mode === 'basic' ? '🎵' : '🚫';
    btnWave.classList.toggle('active', mode !== 'off');
    btnWave.title = `Autoplay: ${mode} — click to cycle`;
  }
  handleEndlessWave(mode !== 'off');
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

// ---- Visual controls (theme, reactivity, pace, calm, lock, browser) ----
//
// Parity with the web visualizer's dock: the Electron player used to only be a
// playback controller and could not touch its own visuals. Everything here
// mirrors apps/bot/public/viz.html — the server-backed bits (theme, reactivity,
// guild) send commands, the per-viewer bits (pace, calm, lock, browse) stay local.

/** The bot's themes, mirroring apps/bot/src/themes.ts. Swatches only send the
 *  id; the server resolves it and broadcasts the real palette back. */
const THEMES: Array<{ id: string; name: string; accent: string; accent2: string }> = [
  { id: 'vaporzr', name: 'Vaporzr', accent: '#6a5cff', accent2: '#22d3ee' },
  { id: 'sunset', name: 'Sunset Drive', accent: '#ff8a3d', accent2: '#ff3cac' },
  { id: 'neon', name: 'Neon Blast', accent: '#ff073a', accent2: '#1ed6ff' },
  { id: 'midnight', name: 'Midnight Club', accent: '#8a7dff', accent2: '#60a5fa' },
  { id: 'synthwave', name: 'Synthwave', accent: '#f472b6', accent2: '#fb923c' },
  { id: 'plasma', name: 'Plasma', accent: '#22d3ee', accent2: '#a78bfa' },
  { id: 'ultraviolet', name: 'Ultraviolet', accent: '#a855f7', accent2: '#6366f1' },
  { id: 'marshmallow', name: 'Marshmallow', accent: '#f472b6', accent2: '#e879f9' },
  { id: 'emerald', name: 'Emerald City', accent: '#34d399', accent2: '#22d3ee' },
];
let activeThemeId = 'vaporzr';

function buildSwatches(): void {
  swatchBar.innerHTML = '';
  for (const t of THEMES) {
    const b = document.createElement('button');
    b.title = t.name;
    b.style.background = `linear-gradient(135deg, ${t.accent}, ${t.accent2})`;
    b.classList.toggle('active', t.id === activeThemeId);
    b.onclick = () => sendCmd('theme', { themeId: t.id });
    swatchBar.appendChild(b);
  }
}

/** Record the active theme (from a click, a broadcast, or the connect snapshot). */
function setActiveTheme(id: string): void {
  activeThemeId = id;
  const kids = Array.from(swatchBar.children);
  if (!kids.length) return; // swatches not built yet — buildSwatches() reads the id
  for (const [i, b] of kids.entries()) b.classList.toggle('active', THEMES[i]?.id === id);
}

/** Preset pace: 15 → 30 → 45 → 60 → 90 → 2 min → manual → back (this viewer). */
const PACE_STEPS = [15, 30, 45, 60, 90, 120, 0];
function cyclePace(): void {
  const i = PACE_STEPS.indexOf(presetCycleSec);
  setPresetCycle(PACE_STEPS[(i < 0 ? 2 : i + 1) % PACE_STEPS.length], true);
}

/** Calm mode: gentler brightness and a stricter flash guard, per viewer. */
let calm = false;
function applyCalm(): void {
  document.body.classList.toggle('calm', calm);
  try { localStorage.setItem('vaporzr.calm', calm ? '1' : '0'); } catch { /* storage unavailable */ }
  updateVisualButtons();
  log(calm ? 'Calm mode on — gentler brightness, stricter flash guard' : 'Calm mode off');
}

function updateVisualButtons(): void {
  btnPace.textContent = presetCycleSec > 0 ? `⏱${presetCycleSec}` : '⏱∞';
  btnPace.title = presetCycleSec > 0
    ? `Preset pace: ${presetCycleSec}s per visual (click to change)`
    : 'Preset pace: manual — no auto-advance (click to change)';
  btnCalm.classList.toggle('on', calm);
  btnCalm.title = calm ? 'Calm mode on — click to disable' : 'Calm mode — gentler brightness, stricter flash guard';
  btnLock.textContent = presetLocked ? '🔒' : '🔓';
  btnLock.classList.toggle('on', presetLocked);
  btnLock.title = presetLocked ? 'Visual locked — click to unlock' : 'Lock the current visual';
  btnBars.classList.toggle('on', barMode);
  btnBars.title = barMode
    ? 'Bar visuals on — click for MilkDrop'
    : 'Bar visuals — move with the music even with no audio device';
  btnJamQr.classList.toggle('on', jamQrOn);
  btnJamQr.title = jamQrOn
    ? 'Jam QR on — viewers can scan to join (click to hide from the stream)'
    : 'Jam QR hidden — click to show the scan-to-join code';
}

/** Browse the loaded library; picking one locks it in (same as the web viz). */
function renderPresetList(query: string): void {
  const q = query.trim().toLowerCase();
  presetList.innerHTML = '';
  const out: string[] = [];
  for (const n of presetNames) {
    if (q && !n.toLowerCase().includes(q)) continue;
    out.push(n);
    if (out.length >= 400) break;
  }
  for (const n of out) {
    const b = document.createElement('button');
    b.textContent = n;
    b.classList.toggle('cur', presetNames[currentPresetIndex] === n);
    b.onclick = () => {
      const i = presetNames.indexOf(n);
      if (i >= 0) {
        loadPresetAt(i, 0.8);
        presetLocked = true;
        updateVisualButtons();
      }
      togglePresetPicker(false);
    };
    presetList.appendChild(b);
  }
  if (!out.length) {
    const d = document.createElement('div');
    d.className = 'empty';
    d.textContent = presetNames.length ? 'No matches.' : 'Loading the library…';
    presetList.appendChild(d);
  }
}

function togglePresetPicker(force?: boolean): void {
  const show = force ?? !presetPicker.classList.contains('show');
  presetPicker.classList.toggle('show', show);
  if (show) {
    presetSearch.value = '';
    renderPresetList('');
    window.setTimeout(() => presetSearch.focus(), 30);
  }
}

/** Guild switcher: shown only when the bot actually serves more than one server
 *  (a guest is told just "Server", so this stays hidden for anonymous viewers). */
function setGuilds(list: Array<{ id: string; name: string }>, primaryId?: string): void {
  guildBar.innerHTML = '';
  if (list.length < 2) {
    guildBar.classList.remove('visible');
    return;
  }
  guildBar.classList.add('visible');
  for (const g of list) {
    const b = document.createElement('button');
    b.textContent = g.name;
    b.classList.toggle('active', g.id === primaryId);
    b.onclick = () => sendCmd('switchGuild', { guildId: g.id });
    guildBar.appendChild(b);
  }
}

// ---- Jam QR (scan to join) ----
let jamJoinPath = '';
let jamQrOn = true;
let jamQrCanvas: HTMLCanvasElement | null = null;

/** Draw the join QR. The bot sends an origin-RELATIVE path (it is loopback-bound
 *  and cannot know the address a viewer reached it on), so the origin comes from
 *  the same base the wallpaper video is fetched from. */
function renderJamQr(): void {
  if (!jamQrCanvas) {
    const cv = document.createElement('canvas');
    cv.id = 'jam-qr';
    // Bottom-LEFT and translucent. It used to sit bottom-right, on top of the
    // control bar's 🎛 toggle, and at full opacity. It brightens on hover (so it
    // stays scannable) and clicking it hides it.
    cv.style.cssText =
      'position:fixed;left:16px;bottom:44px;z-index:12;padding:6px;border-radius:10px;' +
      'background:#fff;box-shadow:0 6px 30px rgba(0,0,0,.55);cursor:pointer;' +
      'opacity:.55;transition:opacity .3s';
    cv.title = 'Jam join code — click to hide';
    cv.addEventListener('click', () => setJamQr(false));
    cv.addEventListener('mouseenter', () => { cv.style.opacity = '1'; });
    cv.addEventListener('mouseleave', () => { cv.style.opacity = '.55'; });
    document.body.appendChild(cv);
    jamQrCanvas = cv;
  }
  const show = jamQrOn && !!jamJoinPath;
  jamQrCanvas.style.display = show ? 'block' : 'none';
  if (show) drawQr(jamQrCanvas, ASSET_BASE + jamJoinPath, 104);
}

function setJamQr(on: boolean): void {
  jamQrOn = on;
  renderJamQr();
  updateVisualButtons();
  try { localStorage.setItem('vaporzr.jamqr', on ? '1' : '0'); } catch { /* storage unavailable */ }
}

function wireControls(): void {
  btnPlay.addEventListener('click', () => sendCmd('toggle'));
  btnPrev.addEventListener('click', () => sendCmd('previous'));
  btnNext.addEventListener('click', () => sendCmd('next'));
  btnShuffle.addEventListener('click', () => sendCmd('shuffle', { shuffle: !latestState.shuffle }));
  btnWave.addEventListener('click', () => {
    const next = waveMode === 'off' ? 'basic' : waveMode === 'basic' ? 'smart' : 'off';
    sendCmd('endlesswave', { mode: next });
  });
  btnPreset.addEventListener('click', (e) => {
    if (e.shiftKey) {
      clearBlacklist();
      return;
    }
    nextPreset(1.5);
  });
  btnPresetBack.addEventListener('click', () => previousPreset(1.2));
  btnPresetShuffle.addEventListener('click', () => shufflePreset(1.5));
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

  // ---- Visual controls ----
  btnPace.addEventListener('click', cyclePace);
  btnCalm.addEventListener('click', () => {
    calm = !calm;
    applyCalm();
  });
  btnLock.addEventListener('click', () => {
    presetLocked = !presetLocked;
    updateVisualButtons();
  });
  btnBars.addEventListener('click', () => setBarMode(!barMode));
  btnJamQr.addEventListener('click', () => setJamQr(!jamQrOn));
  btnPresets.addEventListener('click', (e) => {
    e.stopPropagation();
    togglePresetPicker();
  });
  sensSlider.addEventListener('change', () => sendCmd('sensitivity', { sensitivity: Number(sensSlider.value) }));
  presetSearch.addEventListener('input', () => renderPresetList(presetSearch.value));
  // Click-away closes the browser (but not a click on its own toggle).
  document.addEventListener('click', (e) => {
    if (!presetPicker.classList.contains('show')) return;
    const t = e.target as HTMLElement | null;
    if (t && (presetPicker.contains(t) || t.id === 'btn-presets')) return;
    togglePresetPicker(false);
  });
  try { calm = localStorage.getItem('vaporzr.calm') === '1'; } catch { /* storage unavailable */ }
  document.body.classList.toggle('calm', calm);
  try { if (localStorage.getItem('vaporzr.bars') === '1') setBarMode(true); } catch { /* storage unavailable */ }
  try { if (localStorage.getItem('vaporzr.jamqr') === '0') setJamQr(false); } catch { /* storage unavailable */ }
  buildSwatches();
  updateVisualButtons();

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
        nextPreset(1.5);
        break;
      case 'r':
      case 'R':
        shufflePreset(1.5);
        break;
      case 'b':
      case 'B':
        previousPreset(1.2);
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
        // Alt+arrows are the prev/next track shortcuts the tooltips advertise;
        // bare arrows scrub, which is what people reach for while watching.
        if (e.altKey) sendCmd('next');
        else sendCmd('seek', { positionMs: (latestState.positionMs || 0) + 10000 });
        break;
      case 'ArrowLeft':
        e.preventDefault();
        if (e.altKey) sendCmd('previous');
        else sendCmd('seek', { positionMs: Math.max(0, (latestState.positionMs || 0) - 10000) });
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

// ---- Preset manager: curation, dead-visual watchdog, history ----

/** Presets that rendered black or never reacted — skipped on every future cycle. */
let presetBlacklist: Set<string> = new Set();
try {
  const raw = localStorage.getItem('vaporzr.presetBlacklist');
  if (raw) presetBlacklist = new Set(JSON.parse(raw) as string[]);
} catch {
  /* storage unavailable */
}

function persistBlacklist(): void {
  try {
    localStorage.setItem('vaporzr.presetBlacklist', JSON.stringify([...presetBlacklist]));
  } catch {
    /* storage unavailable */
  }
}

function blacklistPreset(name: string): void {
  if (!name || presetBlacklist.has(name)) return;
  presetBlacklist.add(name);
  persistBlacklist();
  log(`Skipped dead visual: ${name}`);
}

function clearBlacklist(): void {
  const n = presetBlacklist.size;
  presetBlacklist.clear();
  persistBlacklist();
  log(`Cleared ${n} skipped visual${n === 1 ? '' : 's'}`);
}

/** Recently shown presets, so shuffle doesn't immediately repeat itself. */
let presetRecent: string[] = [];
const PRESET_RECENT_MAX = 14;
/** Visit stack (last entry = current) powering the back button. */
let presetHistory: number[] = [];

let presetToastTimer: number | null = null;
function showPresetName(name: string): void {
  if (!presetToast) return;
  presetToast.textContent = name;
  presetToast.classList.add('visible');
  if (presetToastTimer) window.clearTimeout(presetToastTimer);
  presetToastTimer = window.setTimeout(() => presetToast.classList.remove('visible'), 3200);
}

function presetAvailable(name: string): boolean {
  return !presetBlacklist.has(name);
}

// ---- Curated preset library (projectM "cream of the crop") ----
//
// The web visualizer streams this library from the bot; the player only ever
// had the ~100 stock butterchurn-presets, so the two showed visibly different
// visuals. Fetch the same set (chunks script-loaded during idle time) and keep
// the bundled pack as the offline fallback.

let curatedNames: Set<string> | null = null;
let blankNames: Set<string> | null = null;

/** Curation gate, same rules as the web visualizer: presets the offline scan
 *  proved blank are dropped outright, and once curated.json is known anything
 *  not listed is ignored. */
function presetCurated(name: string): boolean {
  if (blankNames?.has(name)) return false;
  if (curatedNames && !curatedNames.has(name)) return false;
  return true;
}

/** Re-derive the playable list (curation + the watchdog's blacklist), keeping
 *  the on-screen visual selected by NAME because indices shift as chunks land. */
function refreshPresetNames(): void {
  const cur = presetNames[currentPresetIndex];
  presetNames = Object.keys(presets)
    .filter((n) => presetCurated(n) && presetAvailable(n))
    .sort();
  const i = cur ? presetNames.indexOf(cur) : -1;
  currentPresetIndex = i >= 0 ? i : presetNames.length ? 0 : -1;
  // The visit stack is index-based, so it cannot survive a re-sort.
  presetHistory = currentPresetIndex >= 0 ? [currentPresetIndex] : [];
}

function idleCallback(fn: () => void): void {
  const ric = (window as unknown as {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  }).requestIdleCallback;
  if (ric) ric(fn, { timeout: 4000 });
  else window.setTimeout(fn, 1800);
}

/** Load one chunk and merge its presets. Resolves false if the chunk failed. */
function loadPresetChunk(i: number, url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = url;
    s.async = true;
    s.onload = () => {
      const pack = (window as unknown as Record<string, unknown>)[`butterchurnPresetsChunk${i}`] as
        | { getPresets?: () => Record<string, unknown> }
        | undefined;
      if (pack && typeof pack.getPresets === 'function') {
        try {
          const next = pack.getPresets();
          // The curated chunks ARE the library — the web visualizer ships no
          // third-party packs beside them, so drop the bundled set on the first
          // chunk rather than diluting the pool with it.
          if (i === 0) presets = {};
          Object.assign(presets, next);
        } catch {
          /* malformed chunk — keep whatever we already have */
        }
      }
      refreshPresetNames();
      // First real library in with nothing on screen yet: start one.
      if (i === 0 && currentPresetIndex < 0 && presetNames.length && visualizer) {
        loadPresetAt(0, 1.5);
      }
      resolve(true);
    };
    s.onerror = () => resolve(false);
    document.head.appendChild(s);
  });
}

/** Stream the bot's curated projectM library in, chunk by chunk, while idle.
 *  Rotation only ever picks from presets that have already landed, so there is
 *  never a spinner, a black frame or a hard cut. */
async function loadCuratedPresets(): Promise<void> {
  const base = `${ASSET_BASE}/vendor/presets`;
  // Curation first — it decides what the chunks are allowed to contribute.
  try {
    const [c, b] = await Promise.all([
      fetch(`${base}/curated.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch(`${base}/blank.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    const cNames = (c as { names?: string[] } | null)?.names;
    const bNames = (b as { names?: string[] } | null)?.names;
    if (cNames?.length) curatedNames = new Set(cNames);
    if (bNames?.length) blankNames = new Set(bNames);
    if (curatedNames) refreshPresetNames();
  } catch {
    /* no curation files — accept everything the chunks provide */
  }

  let idx: { chunks?: string[] } | null = null;
  try {
    idx = (await fetch(`${base}/index.json`).then((r) => (r.ok ? r.json() : null))) as
      | { chunks?: string[] }
      | null;
  } catch {
    /* offline — the bundled pack stays */
  }
  const chunks = idx?.chunks;
  if (!chunks?.length) {
    log(`${presetNames.length} bundled visuals (curated library unavailable)`);
    return;
  }

  for (let i = 0; i < chunks.length; i++) {
    const ok = await new Promise<boolean>((resolve) => {
      idleCallback(() => void loadPresetChunk(i, `${base}/${chunks[i]}`).then(resolve));
    });
    // A missing chunk (index.json can list more than the image actually ships)
    // is skipped rather than fatal — keep whatever loaded.
    if (!ok) log(`Visual chunk ${i} unavailable — continuing`);
  }
  log(`${presetNames.length.toLocaleString()} curated visuals available`);
}

function loadPresetAt(index: number, blend: number, pushHistory = true): void {
  if (!visualizer || presetNames.length === 0) return;
  if (index < 0 || index >= presetNames.length) return;
  currentPresetIndex = index;
  const name = presetNames[index];
  try {
    visualizer.loadPreset(presets[name], blend);
  } catch (e) {
    log(`Visual failed to load: ${e instanceof Error ? e.message : String(e)}`);
    blacklistPreset(name);
    if (presetBlacklist.size < presetNames.length) {
      window.setTimeout(() => nextPreset(0.6), 60);
    }
    return;
  }
  if (pushHistory) {
    presetHistory.push(index);
    if (presetHistory.length > 200) presetHistory.shift();
  }
  presetRecent.push(name);
  if (presetRecent.length > PRESET_RECENT_MAX) presetRecent.shift();
  showPresetName(name);
  armPresetWatch(name);
  // Let the panel show which visual is on screen.
  client.send({ type: 'visuals:preset', name, index, total: presetNames.length });
}

/** Next visual, skipping anything the watchdog has condemned. */
function nextPreset(blend = 1.5): void {
  const n = presetNames.length;
  if (!n) return;
  for (let k = 1; k <= n; k++) {
    const i = (currentPresetIndex + k) % n;
    if (presetAvailable(presetNames[i])) {
      loadPresetAt(i, blend);
      return;
    }
  }
  // Everything condemned — fall back so the show never stalls.
  loadPresetAt((currentPresetIndex + 1) % n, blend);
}

/** Step back through the visit history. */
function previousPreset(blend = 1.2): void {
  if (presetHistory.length < 2) {
    log('No earlier visual');
    return;
  }
  presetHistory.pop(); // drop the one on screen
  const prev = presetHistory.pop();
  if (prev == null) return;
  loadPresetAt(prev, blend);
}

/** Random visual, avoiding recent picks and condemned presets. */
function shufflePreset(blend = 1.5): void {
  if (!presetNames.length) return;
  let pool = presetNames.filter((n) => presetAvailable(n) && !presetRecent.includes(n));
  if (!pool.length) pool = presetNames.filter(presetAvailable);
  if (!pool.length) pool = presetNames.slice();
  const name = pool[Math.floor(Math.random() * pool.length)];
  loadPresetAt(presetNames.indexOf(name), blend);
}

// ---- Dead-visual watchdog ----
// Butterchurn ships ~100 stock presets and a fair few of them render black or
// never react to the audio. Instead of guessing which, we watch the rendered
// canvas: a visual that stays black — or stays frozen while music is clearly
// playing — is condemned and skipped from then on (persisted in localStorage).

const sampleCanvas = document.createElement('canvas');
sampleCanvas.width = 32;
sampleCanvas.height = 18;
const sampleCtx = sampleCanvas.getContext('2d', { willReadFrequently: true });

interface PresetWatch {
  name: string;
  startedAt: number;
  lastSampleAt: number;
  samples: number[];
  sdSamples: number[];
  staticStrikes: number;
}
let presetWatch: PresetWatch | null = null;

function armPresetWatch(name: string): void {
  presetWatch = { name, startedAt: performance.now(), lastSampleAt: 0, samples: [], sdSamples: [], staticStrikes: 0 };
}

/** Mean luminance (0..1) and contrast (std-dev, 0..1) of the visual, or null. */
function sampleStats(): { mean: number; sd: number } | null {
  if (!sampleCtx || !visualizer) return null;
  try {
    sampleCtx.drawImage(canvas, 0, 0, sampleCanvas.width, sampleCanvas.height);
    const d = sampleCtx.getImageData(0, 0, sampleCanvas.width, sampleCanvas.height).data;
    const n = d.length / 4;
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < d.length; i += 4) {
      const l = (d[i] + d[i + 1] + d[i + 2]) / 765;
      sum += l;
      sumSq += l * l;
    }
    const mean = sum / n;
    return { mean, sd: Math.sqrt(Math.max(0, sumSq / n - mean * mean)) };
  } catch {
    return null;
  }
}

const WATCH_GRACE_MS = 3500;
const WATCH_SAMPLE_MS = 220;
const WATCH_BLACK = 0.014;
const WATCH_STATIC_DELTA = 0.0035;
const WATCH_STATIC_STRIKES = 2;
/** Contrast below this (std-dev of luminance) reads as a flat/blank frame. */
const WATCH_BLANK_SD = 0.012;

/** Called right after visualizer.render() while a butterchurn preset is on screen. */
function watchTick(levels: SynthLevels): void {
  const w = presetWatch;
  if (!w) return;
  const now = performance.now();
  if (now - w.lastSampleAt < WATCH_SAMPLE_MS) return;
  w.lastSampleAt = now;
  const st = sampleStats();
  if (!st) return;
  w.samples.push(st.mean);
  w.sdSamples.push(st.sd);
  if (w.samples.length > 18) w.samples.shift();
  if (w.sdSamples.length > 18) w.sdSamples.shift();
  if (now - w.startedAt < WATCH_GRACE_MS) return;
  if (w.samples.length < 8) return;

  let lo = Infinity;
  let hi = -Infinity;
  for (const s of w.samples) {
    if (s < lo) lo = s;
    if (s > hi) hi = s;
  }

  if (hi < (calm ? 0.02 : WATCH_BLACK)) {
    blacklistPreset(w.name);
    presetWatch = null;
    nextPreset(0.6);
    return;
  }

  // Flat frame while the track is clearly playing => a blank visual (white,
  // black or grey). Contrast, not brightness, is what separates a dead blank
  // from a legitimately bright scene, so a bright/blank preset is caught here
  // rather than sailing past the black check.
  let sdHi = -Infinity;
  for (const s of w.sdSamples) if (s > sdHi) sdHi = s;
  if (levels.energy > 0.07 && sdHi < (calm ? 0.02 : WATCH_BLANK_SD)) {
    blacklistPreset(w.name);
    presetWatch = null;
    nextPreset(0.6);
    return;
  }

  // Visible but frozen while the track is clearly playing => not reacting.
  if (levels.energy > 0.07 && hi - lo < WATCH_STATIC_DELTA) {
    w.staticStrikes += 1;
    w.samples.length = 0;
    if (w.staticStrikes >= WATCH_STATIC_STRIKES) {
      blacklistPreset(w.name);
      presetWatch = null;
      nextPreset(0.6);
    }
  }
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
  barsCanvas.width = w * dpr;
  barsCanvas.height = h * dpr;
  visualizer?.setRendererSize(w, h, dpr);
}

/** The bar layer: 24 mirrored bars with a dim floor reflection and a peak cap,
 *  drawn from the level data above so it needs no butterchurn and no audio
 *  device. Mirrors drawBars in apps/bot/public/viz.html, including the idle
 *  travelling wave that keeps a silent scene visibly alive. */
function drawBars(now: number): void {
  const c = barCtx;
  const W = barsCanvas.width;
  const H = barsCanvas.height;
  if (!c || W === 0 || H === 0) return;
  c.clearRect(0, 0, W, H);

  const n = Math.min(24, synthBars.length);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const baseY = H * 0.70;
  const maxH = H * 0.52;
  const slot = W / Math.max(1, n);
  const barW = Math.min(slot * 0.58, 30 * dpr);
  const live = Math.max(0, Math.min(1, synthEnergy));
  const active = synthEnergy > 0.04;
  const mood = prefersReducedMotion ? null : moodPalette;

  // 1. Background wash that breathes with the music.
  const bg = c.createLinearGradient(0, 0, 0, H);
  if (mood) {
    bg.addColorStop(0, moodColor(mood, 0, 0.1 + 0.12 * live, live));
    bg.addColorStop(0.55, 'rgba(0,0,0,0)');
    bg.addColorStop(1, moodColor(mood, 45, 0.03, live));
  } else {
    bg.addColorStop(0, barAccent + (live > 0.5 ? '1f' : '14'));
    bg.addColorStop(0.55, 'rgba(0,0,0,0)');
    bg.addColorStop(1, barAccent2 + '0a');
  }
  c.fillStyle = bg;
  c.fillRect(0, 0, W, H);

  // 2. Bars around the baseline, each with a reflection and a cap.
  for (let i = 0; i < n; i++) {
    // Nothing playing: a slow travelling wave instead of a near-black flatline.
    const v = active
      ? Math.max(0, Math.min(1, synthBars[i]))
      : 0.1 + 0.07 * Math.sin(now / 620 + i * 0.55) + 0.03 * Math.sin(now / 1430 - i * 0.31);
    const h = Math.max(2 * dpr, v * maxH);
    const x = i * slot + (slot - barW) / 2;
    const g = c.createLinearGradient(0, baseY, 0, baseY - h);
    if (mood) {
      g.addColorStop(0, moodColor(mood, 0, 0.9, live));
      g.addColorStop(0.6, moodColor(mood, 20, 0.96, live));
      g.addColorStop(1, moodColor(mood, 45, 1, live));
    } else {
      g.addColorStop(0, barAccent + 'dd');
      g.addColorStop(0.6, barAccent + 'f0');
      g.addColorStop(1, barAccent2 + 'f2');
    }
    c.fillStyle = g;
    c.shadowColor = mood ? moodColor(mood, 0, 0.65, live) : barGlow;
    c.shadowBlur = (12 + 18 * v) * dpr * (active ? 1 : 0.25);
    c.fillRect(x, baseY - h, barW, h);
    c.shadowBlur = 0;
    // Mirror below the baseline — dimmer and shorter, like a wet floor.
    c.globalAlpha = 0.26;
    c.fillRect(x, baseY + 1.5 * dpr, barW, Math.max(0, Math.min(h * 0.55, H - baseY - 3 * dpr)));
    c.globalAlpha = 1;
    // Peak cap.
    c.fillStyle = mood ? moodColor(mood, 45, 0.95, live) : 'rgba(246,250,255,0.92)';
    c.fillRect(x, baseY - h - 2 * dpr, barW, 2.5 * dpr);
  }

  // 3. Baseline glow.
  c.fillStyle = mood ? moodColor(mood, 0, 0.3, live) : barAccent + '40';
  c.fillRect(0, baseY - dpr, W, 1.5 * dpr);
}

/** Switch the scene between butterchurn and the bar layer. */
function setBarMode(on: boolean): void {
  barMode = on;
  barsCanvas.style.display = on ? 'block' : 'none';
  canvas.style.display = on ? 'none' : 'block';
  updateVisualButtons();
  try { localStorage.setItem('vaporzr.bars', on ? '1' : '0'); } catch { /* storage unavailable */ }
  log(on ? 'Bar visuals on' : 'Bar visuals off');
}

function renderLoop(): void {
  const lv = sampleLevels();
  const now = Date.now();
  if (synthActive && synthOverlay) {
    const t = latestState.track;
    synthOverlay.render(
      now,
      lv,
      synthBars,
      t ? { name: t.name || '', artists: (t.artists || []).join(', '), addedBy: t.addedBy } : null,
      prefersReducedMotion,
      ewVideo,
    );
  } else if (barMode) {
    // The bar layer renders straight from the level data, so a missing audio
    // device no longer leaves a flat scene on screen.
    drawBars(now);
  } else if (visualizer) {
    visualizer.render();
    watchTick(lv);
  }
  requestAnimationFrame(renderLoop);
}

/** Canvas currently on screen — frame forwarding follows the visible scene. */
function activeCanvas(): HTMLCanvasElement {
  if (synthActive) return ewCanvas;
  return barMode ? barsCanvas : canvas;
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
  // The bar layer paints on a canvas, so it needs the colours as values too.
  barAccent = t.accent;
  barAccent2 = t.accent2;
  barGlow = t.glow;
  // Keep the swatch row in step when the theme changes server-side (or arrives
  // in the connect snapshot) rather than from this window's own click.
  const id = (t as { id?: string }).id;
  if (id) setActiveTheme(id);
}

/** Mood-reactive palette: the current track's tone, broadcast by the bot while
 *  `V@mood` is on. Drives the ambient glow the same way the web visualizer does;
 *  `null` (V@mood off) falls back to the static theme. */
function applyMood(m: { hue?: number; sat?: number; light?: number } | null): void {
  const root = document.documentElement.style;
  if (!m || typeof m.hue !== 'number') {
    moodPalette = null;
    root.removeProperty('--vz-mood');
    root.removeProperty('--vz-mood-glow');
    document.body.classList.remove('mood');
    return;
  }
  const sat = Math.round(m.sat ?? 62);
  const light = Math.round(m.light ?? 52);
  const hue = Math.round(m.hue);
  // Fed to the Endless Wave overlay so its bars/glow take the same tone.
  moodPalette = { hue, sat, light };
  root.setProperty('--vz-mood', `hsl(${hue} ${sat}% ${light}%)`);
  root.setProperty('--vz-mood-glow', `hsla(${hue}, ${sat}%, ${light}%, 0.45)`);
  document.body.classList.add('mood');
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
  presetNames = Object.keys(presets).sort();
  log(`Loaded ${presetNames.length} presets`);
  // NOTE: the bot's curated projectM library is deliberately NOT auto-loaded.
  // It was tried and made the player's visuals worse — the bundled pack is what
  // the player looked good with. loadCuratedPresets() is still available (and
  // reachable from the preset browser's "curated" path) if that ever changes.

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
    ewVideo.src = `${ASSET_BASE}/ew-bg.mp4`;
    ewVideo.poster = `${ASSET_BASE}/ew-bg.jpg`;
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

  // Broadcast mode (OBS capture): start with the controls and pointer hidden so
  // a capture is clean, but keep the normal auto-hide behaviour — moving the
  // mouse reveals the bar (and the pointer) so the window is never a dead end.
  // Esc closes it.
  if (BROADCAST) {
    document.body.classList.add('broadcast');
    setChromeVisible(false);
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') window.close();
    });
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
      const pc = localStorage.getItem('vaporzr.presetCycle');
      if (pc != null) presetCycleSec = Math.max(0, Math.min(600, Number(pc) || 0));
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
      loadPresetAt(0, 0);
      visualizer.connectAudio(analyser);
      log('Visualizer running');
      presetCycle = null;
      startPresetCycle();
    } catch (e) {
      log(`butterchurn init failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  resize();
  renderLoop();
  window.addEventListener('resize', resize);
}

window.addEventListener('DOMContentLoaded', init);
