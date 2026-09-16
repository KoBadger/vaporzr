import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

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
export class GoLibrespotManager {
  private proc: ChildProcess | null = null;
  private parec: ChildProcess | null = null;
  private pcmHandler: ((data: Buffer) => boolean) | null = null;
  private stopped = true;
  private startedAt = 0;
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
    fs.mkdirSync(config.goLibrespotConfigDir, { recursive: true });
    const cfgPath = path.join(config.goLibrespotConfigDir, 'config.yml');
    if (!fs.existsSync(cfgPath)) {
      fs.writeFileSync(
        cfgPath,
        [
          'log_level: info',
          `device_name: "${config.librespotDeviceName}"`,
          'device_type: speaker',
          'audio_backend: pulseaudio',
          `audio_device: "${config.pulseSinkName}"`,
          'server:',
          '  enabled: true',
          '  address: 127.0.0.1',
          `  port: ${config.goLibrespotApiPort}`,
          'credentials:',
          '  type: device_auth',
          '',
        ].join('\n'),
      );
    }
    this.ensurePulse();
    const log = fs.openSync(path.join(config.goLibrespotConfigDir, 'stderr.log'), 'a');
    this.proc = spawn(config.goLibrespotPath, ['--config_dir', config.goLibrespotConfigDir], {
      stdio: ['ignore', log, log],
    });
    this.startedAt = Date.now();
    this.startCapture();
    console.log('[golibrespot] started — pair via spotify.com/pair (device-code); see stderr.log');
  }

  private ensurePulse(): void {
    // Best-effort: start the audio server and make sure the null sink exists.
    spawn('pulseaudio', ['--start', '--exit-idle-time=-1'], { stdio: 'ignore' }).on('error', () => {});
    const load = spawn('pactl', ['load-module', 'module-null-sink', `sink_name=${config.pulseSinkName}`], {
      stdio: 'ignore',
    });
    load.on('error', () => {});
    spawn('pactl', ['set-default-sink', config.pulseSinkName], { stdio: 'ignore' }).on('error', () => {});
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
