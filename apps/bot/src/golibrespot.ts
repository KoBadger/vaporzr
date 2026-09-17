import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import type { SpotifyBackend } from './librespot.js';

/**
 * Manages go-librespot as the bot's server-side Spotify Connect device.
 *
 * Unlike librespot-org (which pipes PCM over a TCP bridge), go-librespot plays
 * into a PulseAudio null-sink and we capture that sink's monitor with `parec`,
 * feeding the same raw 44.1 kHz stereo s16 PCM the voice pipeline expects.
 *
 * Its login is the remote device-code flow (spotify.com/pair?code=…), so it can
 * pair from a datacenter with no local-network discovery.
 */
export class GoLibrespotManager implements SpotifyBackend {
  private proc: ChildProcess | null = null;
  private parec: ChildProcess | null = null;
  private pcmHandler: ((data: Buffer) => boolean) | null = null;
  private stopped = true;
  private startedAt = 0;
  /** Watchdog that restarts go-librespot when its Spotify "dealer" link dies. */
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private lastHealthyAt = 0;
  private restarting = false;
  /** Last time PCM actually flowed out of the sink (i.e. audio is audible). */
  private lastPcmAt = 0;
  /** Total PCM bytes captured (44.1 kHz stereo s16 => 176400 B/s) for position tracking. */
  private pcmBytes = 0;
  private static readonly PCM_BYTES_PER_SEC = 44_100 * 2 * 2;

  /** Mirrors LibrespotManager so the two are interchangeable. */
  get enabled(): boolean {
    return Boolean(config.goLibrespotPath);
  }

  getPcmBytes(): number {
    return this.pcmBytes;
  }

  getPositionMs(): number {
    return Math.round((this.pcmBytes / GoLibrespotManager.PCM_BYTES_PER_SEC) * 1000);
  }

  resetPosition(): void {
    this.pcmBytes = 0;
  }

  setPositionMs(ms: number): void {
    this.pcmBytes = Math.round((Math.max(0, ms) / 1000) * GoLibrespotManager.PCM_BYTES_PER_SEC);
  }

  /** No-op (parec has no socket); present for LibrespotManager parity. */
  resumeSocket(): void {}
  pauseSocket(): void {}

  setPcmHandler(fn: ((data: Buffer) => boolean) | null): void {
    this.pcmHandler = fn;
  }

  isRunning(): boolean {
    return this.proc !== null && this.proc.exitCode === null;
  }

  getDeviceInfo(): {
    name: string;
    deviceId: string;
    running: boolean;
    enabled: boolean;
    uptimeMs: number;
    bitrate: number;
    stderrLog: string;
  } {
    return {
      name: config.librespotDeviceName,
      deviceId: 'go-librespot',
      running: this.isRunning(),
      enabled: true,
      uptimeMs: this.isRunning() && this.startedAt > 0 ? Date.now() - this.startedAt : 0,
      bitrate: config.librespotBitrate,
      stderrLog: path.join(config.goLibrespotConfigDir, 'stderr.log'),
    };
  }

  /** Local control API base URL. */
  private api(pathname: string): string {
    return `http://127.0.0.1:${config.goLibrespotApiPort}${pathname}`;
  }

  async start(): Promise<void> {
    if (this.isRunning()) return;
    this.stopped = false;
    // Pin PulseAudio's runtime dir BEFORE starting pulseaudio, so pulseaudio,
    // go-librespot and parec all agree on the socket path. Without this,
    // pulseaudio picks a random /tmp/pulse-XXXX dir and go-librespot can't find
    // the server ("dial unix pulse/native: no such file or directory").
    if (!process.env.XDG_RUNTIME_DIR) process.env.XDG_RUNTIME_DIR = '/tmp/vz-runtime';
    try {
      fs.mkdirSync(process.env.XDG_RUNTIME_DIR, { recursive: true });
    } catch {
      /* ignore */
    }
    fs.mkdirSync(config.goLibrespotConfigDir, { recursive: true });
    const cfgPath = path.join(config.goLibrespotConfigDir, 'config.yml');
    // Always (re)write the managed config so the audio backend can't drift
    // (e.g. a carried-over config with the FIFO pipe backend). Credentials live
    // in state.json, which is untouched.
    fs.writeFileSync(
      cfgPath,
      [
        'log_level: info',
        `device_name: "${config.librespotDeviceName}"`,
        'device_type: speaker',
        // 160 kbps buffers faster than 320 and is plenty for Discord voice.
        'bitrate: 160',
        // go-librespot plays its OWN autoplay picks after a track otherwise,
        // which the bot never queued (the "different song for 2s" glitch).
        'disable_autoplay: true',
        'crossfade_duration: 0',
        'audio_backend: pulseaudio',
        `audio_device: "${config.pulseSinkName}"`,
        // On-disk audio cache: repeat/known tracks start from local disk instead
        // of re-downloading from Spotify every time.
        'cache:',
        '  enabled: true',
        `  dir: "${path.join(config.goLibrespotConfigDir, 'cache')}"`,
        '  size_limit: "1GB"',
        'server:',
        '  enabled: true',
        '  address: 127.0.0.1',
        `  port: ${config.goLibrespotApiPort}`,
        'credentials:',
        '  type: device_auth',
        '',
      ].join('\n'),
    );
    await this.ensurePulse();
    const log = fs.openSync(path.join(config.goLibrespotConfigDir, 'stderr.log'), 'a');
    this.proc = spawn(config.goLibrespotPath, ['--config_dir', config.goLibrespotConfigDir], {
      stdio: ['ignore', log, log],
    });
    this.startedAt = Date.now();
    this.startCapture();
    this.startWatchdog();
    console.log('[golibrespot] started — pair via spotify.com/pair (device-code); see stderr.log');
  }

  /**
   * go-librespot's connection to Spotify's "dealer" (the WebSocket that keeps the
   * Connect device registered) can silently die — it logs "did not receive last
   * pong from dealer" forever and never reconnects. The device then disappears
   * and every play fails with "No Spotify device available". We can't fix
   * go-librespot's reconnect, but we can bounce it: if its local API stops
   * responding for a stretch, kill and respawn it so the device re-registers.
   */
  private startWatchdog(): void {
    if (this.watchdog) return;
    this.lastHealthyAt = Date.now();
    const t = setInterval(() => void this.healthCheck(), 10_000);
    t.unref?.();
    this.watchdog = t;
  }

  private async healthCheck(): Promise<void> {
    if (this.stopped || this.restarting) return;
    if (!this.isRunning()) {
      console.warn('[golibrespot] process is not running — restarting');
      await this.restart();
      return;
    }
    if (await this.pingApi()) {
      this.lastHealthyAt = Date.now();
      return;
    }
    // Music is still flowing out of the sink — never bounce the process mid-song,
    // that's exactly what cut tracks off. Defer recovery until playback stops;
    // the device re-registers then and the next play works.
    if (Date.now() - this.lastPcmAt < 15_000) {
      this.lastHealthyAt = Date.now();
      return;
    }
    // API unresponsive AND silent — the dealer link is likely wedged. Wait out a
    // short grace period (transient blips) before bouncing the process.
    if (Date.now() - this.lastHealthyAt > 25_000) {
      console.warn('[golibrespot] device API unresponsive and idle (dealer link lost?) — restarting to re-register');
      await this.restart();
    }
  }

  private async pingApi(): Promise<boolean> {
    // The AbortController alone is not enough: when go-librespot's API is
    // wedged, `fetch` can hang WITHOUT honouring the abort, which deadlocks
    // healthCheck before it ever reaches the restart logic. Race a hard timeout
    // so this always settles.
    const hardTimeout = new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(false), 6_000);
      t.unref?.();
    });
    const probe = (async (): Promise<boolean> => {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 5_000);
        t.unref?.();
        const r = await fetch(this.api('/status'), { signal: ctrl.signal });
        clearTimeout(t);
        if (!r.ok) return false;
        // A wedged dealer leaves the API answering 200 with an empty body, so
        // `r.ok` alone reads as healthy. Require an actual device_id.
        const j = (await r.json().catch(() => null)) as { device_id?: string } | null;
        return Boolean(j && j.device_id);
      } catch {
        return false;
      }
    })();
    return Promise.race([probe, hardTimeout]);
  }

  private async restart(): Promise<void> {
    if (this.restarting) return;
    this.restarting = true;
    try {
      this.stop();
      this.stopped = false;
      await this.start();
    } finally {
      this.restarting = false;
    }
  }

  /**
   * Public: guarantee the Spotify Connect device is registered before a caller
   * re-issues playback. A dropped dealer link leaves the API answering but the
   * device gone, which is exactly when a re-issue would otherwise fall back to
   * YouTube. Restart to re-register, then give it a moment to authenticate.
   */
  async ensureDevice(): Promise<void> {
    if (this.isRunning() && (await this.pingApi())) return;
    console.warn('[golibrespot] device not registered — restarting to recover before re-issuing');
    await this.restart();
    await new Promise((r) => {
      const t = setTimeout(r, 2_500);
      t.unref?.();
    });
  }

  /** Start PulseAudio and ensure the null-sink exists (retrying around startup races). */
  private async ensurePulse(): Promise<void> {
    await this.run('pulseaudio', ['--start', '--exit-idle-time=-1']);
    for (let i = 0; i < 12; i++) {
      if (await this.sinkExists()) {
        await this.run('pactl', ['set-default-sink', config.pulseSinkName]);
        return;
      }
      await this.run('pactl', [
        'load-module',
        'module-null-sink',
        `sink_name=${config.pulseSinkName}`,
        'sink_properties=device.description=Vaporzr',
      ]);
      await new Promise((r) => {
        const t = setTimeout(r, 500);
        t.unref?.();
      });
    }
  }

  private run(cmd: string, args: string[]): Promise<void> {
    return new Promise((resolve) => {
      const p = spawn(cmd, args, { stdio: 'ignore' });
      p.on('error', () => resolve());
      p.on('exit', () => resolve());
    });
  }

  private sinkExists(): Promise<boolean> {
    return new Promise((resolve) => {
      const p = spawn('pactl', ['list', 'short', 'sinks'], { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      p.stdout?.on('data', (d: Buffer) => (out += d.toString()));
      p.on('error', () => resolve(false));
      p.on('exit', () => resolve(out.includes(config.pulseSinkName)));
    });
  }

  private startCapture(): void {
    if (this.parec) return;
    const p = spawn(
      'parec',
      ['-d', `${config.pulseSinkName}.monitor`, '--format=s16le', '--rate=44100', '--channels=2', '--raw'],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    this.parec = p;
    p.stdout?.on('data', (d: Buffer) => {
      this.pcmBytes += d.length;
      this.lastPcmAt = Date.now();
      try {
        this.pcmHandler?.(d);
      } catch {
        /* ignore */
      }
    });
    p.on('error', () => {});
    p.on('exit', () => {
      this.parec = null;
      if (!this.stopped) {
        const t = setTimeout(() => this.startCapture(), 2000);
        t.unref?.();
      }
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
    try {
      this.parec?.kill();
    } catch {
      /* ignore */
    }
    this.parec = null;
    try {
      this.proc?.kill();
    } catch {
      /* ignore */
    }
    this.proc = null;
  }

  /** Set volume through go-librespot's local API (0-100). */
  async setVolume(v: number): Promise<void> {
    try {
      await fetch(this.api('/player/volume'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ volume: Math.max(0, Math.min(100, Math.round(v))) }),
      });
    } catch {
      /* ignore */
    }
  }

  /** Current playback state from the local API, or null. */
  async getState(): Promise<unknown> {
    try {
      const r = await fetch(this.api('/status'));
      return await r.json();
    } catch {
      return null;
    }
  }

  /** Start playback of a Spotify URI via the local API. */
  async playUri(uri: string): Promise<boolean> {
    return this.post('/player/play', { uri });
  }

  async pausePlayback(): Promise<void> {
    await this.post('/player/pause', {});
  }

  async resumePlayback(): Promise<void> {
    await this.post('/player/resume', {});
  }

  async seekMs(ms: number): Promise<void> {
    await this.post('/player/seek', { position: Math.max(0, Math.round(ms)) });
  }

  private async post(pathname: string, body: unknown): Promise<boolean> {
    try {
      const r = await fetch(this.api(pathname), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return r.ok;
    } catch {
      return false;
    }
  }

  /** Rename the device: rewrites config.yml and restarts go-librespot. */
  setDeviceName(name: string): void {
    const clean = name.replace(/[\r\n"]/g, '').slice(0, 32).trim() || 'Vaporzr';
    try {
      const cfgPath = path.join(config.goLibrespotConfigDir, 'config.yml');
      let cfg = fs.readFileSync(cfgPath, 'utf8');
      cfg = /^device_name:/m.test(cfg)
        ? cfg.replace(/^device_name:.*/m, `device_name: "${clean}"`)
        : `device_name: "${clean}"\n${cfg}`;
      fs.writeFileSync(cfgPath, cfg);
    } catch {
      /* ignore */
    }
    try {
      this.proc?.kill();
    } catch {
      /* ignore */
    }
    this.proc = null;
    try {
      this.parec?.kill();
    } catch {
      /* ignore */
    }
    this.parec = null;
    void this.start();
  }
}
