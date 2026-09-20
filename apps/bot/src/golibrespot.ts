import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import type { SpotifyBackend } from './librespot.js';

/**
 * Manages go-librespot as the bot's server-side Spotify Connect device.
 *
 * Unlike librespot-org (which pipes PCM over a TCP bridge), go-librespot writes
 * decoded PCM straight to a named pipe (FIFO) via its `pipe` audio backend, and
 * we read that FIFO — feeding the same raw 44.1 kHz stereo s16 PCM the voice
 * pipeline expects. The pipe backend is deliberate: go-librespot's PulseAudio
 * backend deadlocks in `PlaybackStream.Start` on the 2nd stream (track switch),
 * whereas the pipe output opens the FIFO once and only toggles Pause/Resume.
 *
 * Its login is the remote device-code flow (spotify.com/pair?code=…), so it can
 * pair from a datacenter with no local-network discovery.
 */
export class GoLibrespotManager implements SpotifyBackend {
  private proc: ChildProcess | null = null;
  /** Read fd for the go-librespot PCM FIFO (replaces the old parec capture). */
  private captureFd: number | null = null;
  /** Named pipe go-librespot writes decoded PCM to (audio_backend: pipe). */
  private readonly fifoPath = path.join(config.goLibrespotConfigDir, 'audio.fifo');
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

  /** No-op (the PCM FIFO has no socket); present for LibrespotManager parity. */
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
    // Always (re)write the managed config so the audio backend can't drift.
    // Credentials live in state.json, which is untouched.
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
        // Decoded PCM out to a FIFO. The PulseAudio backend hangs in
        // PlaybackStream.Start on the 2nd stream (track switch); the pipe
        // backend opens the FIFO once and only toggles Pause/Resume.
        'audio_backend: pipe',
        `audio_output_pipe: "${this.fifoPath}"`,
        'audio_output_pipe_format: s16le',
        'audio_output_pipe_wait_for_reader: true',
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
    // Create the FIFO and open our read end BEFORE spawning go-librespot, so its
    // blocking (wait_for_reader) writer open always finds a reader and never
    // wedges startup.
    this.ensureFifo();
    this.startCapture();
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
    const t = setInterval(() => void this.healthCheck(), 3_000);
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
    if (Date.now() - this.lastPcmAt < 3_000) {
      this.lastHealthyAt = Date.now();
      return;
    }
    // API unresponsive AND silent — the dealer link is likely wedged. Wait out a
    // short grace period (transient blips) before bouncing the process.
    if (Date.now() - this.lastHealthyAt > 5_000) {
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
      const t = setTimeout(() => resolve(false), 3_000);
      t.unref?.();
    });
    const probe = (async (): Promise<boolean> => {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 2_500);
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

  /** Create the PCM FIFO if it is missing (or replace a stale non-FIFO file). */
  private ensureFifo(): void {
    try {
      fs.mkdirSync(path.dirname(this.fifoPath), { recursive: true });
      let isFifo = false;
      try {
        isFifo = fs.statSync(this.fifoPath).isFIFO();
      } catch {
        /* missing */
      }
      if (!isFifo) {
        try {
          fs.rmSync(this.fifoPath, { force: true });
        } catch {
          /* ignore */
        }
        spawnSync('mkfifo', [this.fifoPath]);
      }
    } catch {
      /* ignore */
    }
  }

  /**
   * Read decoded PCM from go-librespot's FIFO. Opening the read end unblocks
   * go-librespot's (wait_for_reader) writer; we keep it open across tracks so a
   * stream switch never sees a closed pipe.
   *
   * We read with `fs.read` rather than `fs.createReadStream`: a FIFO reports
   * size 0, and the stream helper treats a 0-size file as already empty (opens
   * then immediately ends), so it would never drain the pipe — go-librespot
   * would fill the buffer, block on write and pause the track.
   */
  private startCapture(): void {
    if (this.captureFd !== null) return;
    this.ensureFifo();
    const bufSize = 1 << 16;
    const retry = (): void => {
      if (this.stopped) return;
      const t = setTimeout(() => this.startCapture(), 2000);
      t.unref?.();
    };
    fs.open(this.fifoPath, 'r', (err, fd) => {
      if (err) {
        retry();
        return;
      }
      if (this.stopped) {
        try {
          fs.close(fd, () => {});
        } catch {
          /* ignore */
        }
        return;
      }
      this.captureFd = fd;
      // go-librespot's pipe output is UNPACED: it decodes and writes as fast as
      // it can (observed ~30x realtime). Reading that fast would race the bot's
      // realtime position model (bytes / 176400/s) to the end of the track
      // instantly. So read at most 1x realtime; the FIFO buffer then fills and
      // go-librespot blocks on write, pacing itself to our read rate.
      const rt = GoLibrespotManager.PCM_BYTES_PER_SEC;
      const maxBurst = Math.round(rt * 0.5); // allow a 500 ms catch-up burst
      let budget = 0;
      let last = Date.now();
      const refill = (): void => {
        const now = Date.now();
        budget += ((now - last) / 1000) * rt;
        last = now;
        if (budget > maxBurst) budget = maxBurst;
      };
      const readLoop = (): void => {
        if (this.captureFd !== fd) return;
        refill();
        const want = Math.min(bufSize, Math.floor(budget));
        if (want < 4096) {
          const t = setTimeout(readLoop, 20);
          t.unref?.();
          return;
        }
        const buf = Buffer.allocUnsafe(want);
        fs.read(fd, buf, 0, want, null, (rerr, bytesRead) => {
          if (this.captureFd !== fd) return;
          if (rerr || bytesRead === 0) {
            // Error or writer closed (go-librespot exited) — reopen shortly.
            try {
              fs.close(fd, () => {});
            } catch {
              /* ignore */
            }
            if (this.captureFd === fd) this.captureFd = null;
            retry();
            return;
          }
          budget -= bytesRead;
          this.pcmBytes += bytesRead;
          this.lastPcmAt = Date.now();
          try {
            this.pcmHandler?.(buf.subarray(0, bytesRead));
          } catch {
            /* ignore */
          }
          readLoop();
        });
      };
      readLoop();
    });
  }

  private closeCapture(): void {
    const fd = this.captureFd;
    this.captureFd = null;
    if (fd !== null) {
      try {
        fs.close(fd, () => {});
      } catch {
        /* ignore */
      }
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
    this.closeCapture();
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
    this.closeCapture();
    void this.start();
  }
}
