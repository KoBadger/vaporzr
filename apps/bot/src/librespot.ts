import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import { config } from './config.js';

/**
 * librespot runs as the bot's own Spotify Connect device. We stream its raw
 * PCM back over a local TCP bridge so the bot can resample it to 48 kHz and
 * feed it straight into the Discord voice channel — no web player needed.
 *
 * librespot's `subprocess` backend spawns a command and pipes raw S16 (44.1 kHz
 * stereo) PCM to its stdin. That command is a tiny Node bridge we write to the
 * temp dir, which forwards stdin to a TCP socket the bot listens on. The bridge
 * path must be space-free (librespot splits the device command on spaces), and
 * os.tmpdir() is space-free on this machine (C:\Users\joshv\AppData\Local\Temp).
 */
const BRIDGE_SRC = `const net = require('net');
// librespot's subprocess backend splits the --device value on spaces, so a
// "node \"path\" port" command only ever passes the bare program name to the
// sink — the port arg is dropped and the bridge never connects. Read the port
// from an env var (librespot inherits its parent env) instead of argv.
const port = Number(process.env.VAPORZR_BRIDGE_PORT || 0);
let sock = null;
let needResume = false;
function connect() {
  if (sock && !sock.destroyed) return;
  sock = net.connect(port, '127.0.0.1');
  sock.on('drain', () => { if (needResume) { needResume = false; process.stdin.resume(); } });
  sock.on('connect', () => { if (needResume) { needResume = false; process.stdin.resume(); } });
  sock.on('error', () => { if (sock) sock.destroy(); sock = null; setTimeout(connect, 2000); });
  sock.on('close', () => { sock = null; setTimeout(connect, 2000); });
}
process.stdin.on('data', (d) => {
  if (sock && !sock.destroyed) {
    if (!sock.write(d)) { needResume = true; process.stdin.pause(); }
  }
});
process.stdin.on('end', () => process.exit(0));
connect();
`;

export function librespotDeviceId(name: string): string {
  return createHash('sha1').update(name).digest('hex');
}

export class LibrespotManager {
  private proc: ChildProcess | null = null;
  private tcpServer: net.Server | null = null;
  private bridgeDir = '';
  private socket: net.Socket | null = null;
  /** Port the bot listens on for this session's PCM (ephemeral, so stale bridges can't hijack it). */
  private bridgePort = config.librespotBridgePort;
  /** Returns false when the consumer is too slow; the TCP socket pauses until resumeSocket(). */
  private pcmHandler: ((data: Buffer) => boolean) | null = null;
  /** Raw 44.1 kHz S16 stereo PCM is 176,400 bytes/sec — track it for local position. */
  private static readonly PCM_BYTES_PER_SEC = 44_100 * 2 * 2;
  private baseMs = 0;
  private pcmBytes = 0;
  /** Auto-restart bookkeeping: a dead librespot forces every Spotify play
   *  through the slow YouTube fallback, so an unexpected exit must respawn. */
  private stopped = false;
  private restartTimer: NodeJS.Timeout | null = null;
  private restarts = 0;
  private bridgePath = '';
  /** Monotonic timestamp of the last successful spawn (for /device uptime). */
  private startedAt = 0;
  /** Periodic watchdog that detects a "zombie bridge" — a still-running librespot
   *  whose PCM socket silently dropped after connecting. That state reports
   *  !isRunning() and would otherwise force every Spotify track through the slow
   *  YouTube fallback until the next natural restart. */
  private heartbeatTimer: NodeJS.Timeout | null = null;
  /** File descriptor for capturing librespot stderr to disk. The bot's spawn pipe
   *  wasn't surfacing librespot's own errors, making silent exits impossible to
   *  diagnose. A persistent log lets us see auth/session/bridge errors. */
  private stderrFd: number | null = null;
  /**
   * The sink subprocess (bridge) may only be spawned at first playback, so a
   * never-connected socket is normal at idle. Once the bridge HAS connected,
   * a dead socket means the PCM path is broken — only then is the device
   * considered unavailable (avoids both silent stalls and idle false-negatives).
   */
  private bridgeEverConnected = false;

  get enabled(): boolean {
    return Boolean(config.librespotPath);
  }

  isRunning(): boolean {
    // A live librespot whose bridge DIED after connecting accepts play
    // commands but streams into the void — the silent-stall failure. Before
    // first connection the socket is legitimately null (lazy sink spawn).
    return (
      this.proc !== null &&
      !this.proc.killed &&
      (!this.bridgeEverConnected || this.socket !== null)
    );
  }

  /** Snapshot of the Spotify Connect device this bot registers as. */
  getDeviceInfo(): {
    name: string;
    deviceId: string;
    running: boolean;
    enabled: boolean;
    uptimeMs: number;
    bitrate: number;
    stderrLog: string;
  } {
    const name = config.librespotDeviceName;
    return {
      name,
      deviceId: librespotDeviceId(name),
      running: this.isRunning(),
      enabled: this.enabled,
      uptimeMs: this.isRunning() && this.startedAt > 0 ? Date.now() - this.startedAt : 0,
      bitrate: config.librespotBitrate,
      stderrLog: path.join(config.dataDir, 'librespot', 'stderr.log'),
    };
  }

  /**
   * Change the Connect device name (restarts librespot so Spotify re-registers
   * it under the new name). Useful when multiple bots share an account, or to
   * surface a friendlier name in the user's Spotify client. Persists for the
   * process lifetime only — set LIBRESPOT_DEVICE_NAME in .env to make it stick.
   */
  setDeviceName(name: string): void {
    const clean = name.trim().replace(/\s+/g, ' ').slice(0, 32);
    if (!clean || clean === config.librespotDeviceName) return;
    config.librespotDeviceName = clean;
    // Force a fresh registration. If we're mid-playback, the running session
    // keeps streaming to its existing socket; the rename applies server-side.
    this.restarts = 0;
    if (this.proc) {
      const old = this.proc;
      this.proc = null;
      try {
        old.kill();
      } catch {
        /* ignore */
      }
      this.scheduleRestart();
    } else if (this.bridgePath) {
      this.spawnLibrespot(this.bridgePath);
    }
  }

  /** The consumer that receives raw 44.1 kHz stereo S16 PCM. Set to null when not playing. */
  setPcmHandler(handler: ((data: Buffer) => boolean) | null): void {
    this.pcmHandler = handler;
    if (handler) this.resumeSocket();
  }

  /** Called by the consumer once its write buffer has drained so the socket can resume. */
  resumeSocket(): void {
    if (this.socket && this.socket.isPaused()) {
      this.socket.resume();
    }
  }

  /** Pause the PCM socket (e.g. when downstream errors occur). */
  pauseSocket(): void {
    if (this.socket && !this.socket.isPaused()) {
      this.socket.pause();
    }
  }

  /** Total raw PCM bytes received so far (used for position + end-of-track detection). */
  getPcmBytes(): number {
    return this.pcmBytes;
  }

  /**
   * Playback position derived from decoded PCM bytes, so the bot never has to
   * poll the rate-limited /me/player endpoint for progress. Bytes only advance
   * while librespot is actually streaming, so pause/end detection is free.
   */
  getPositionMs(): number {
    return this.baseMs + Math.floor(this.pcmBytes / (LibrespotManager.PCM_BYTES_PER_SEC / 1000));
  }

  /** Start a new track from zero. */
  resetPosition(): void {
    this.baseMs = 0;
    this.pcmBytes = 0;
  }

  /** Jump the tracked position (e.g. after a seek) without touching the API. */
  setPositionMs(ms: number): void {
    this.baseMs = Math.max(0, ms);
    this.pcmBytes = 0;
  }

  async start(): Promise<void> {
    if (!config.librespotPath) {
      console.warn('[librespot] LIBRESPOT_PATH not set — Spotify tracks will use the YouTube fallback.');
      return;
    }
    try {
      this.stopped = false;
      this.restarts = 0;
      this.bridgeDir = path.join(os.tmpdir(), 'vaporzr-bridge');
      fs.mkdirSync(this.bridgeDir, { recursive: true });
      const bridgePath = path.join(this.bridgeDir, 'bridge.cjs');
      fs.writeFileSync(bridgePath, BRIDGE_SRC);
      this.bridgePath = bridgePath;
      // A previous bot run (crash or tsx restart) can leave librespot and its
      // bridge orphaned. Stale librespots all register the same Connect device
      // (id = SHA1(name)) and make Spotify route play commands to the wrong
      // session — the source of wrong-track skips and silent stalls. Bridges that
      // outlived their librespot would otherwise keep reconnecting to our PCM port.
      // (killStale also runs inside spawnLibrespot on every respawn; it's idempotent.)
      await this.startTcpServer();
      this.spawnLibrespot(bridgePath);
    } catch (err) {
      console.warn('[librespot] failed to start:', err instanceof Error ? err.message : err);
    }
  }

  /**
   * Kill leftover librespot/bridge processes from prior runs so only one session
   * ever exists. Must complete before a new librespot spawns, or the taskkill
   * below would kill it too.
   */
  private async killStale(): Promise<void> {
    const run = (cmd: string, args: string[]): Promise<void> =>
      new Promise((resolve) => {
        try {
          const p = spawn(cmd, args, { windowsHide: true, stdio: 'ignore' });
          const timer = setTimeout(() => {
            try {
              p.kill();
            } catch {
              /* ignore */
            }
            resolve();
          }, 3000);
          p.on('exit', () => {
            clearTimeout(timer);
            resolve();
          });
          p.on('error', () => {
            clearTimeout(timer);
            resolve();
          });
        } catch {
          resolve();
        }
      });
    // Bridges first: their librespot may still be alive, and killing them forces
    // librespot's subprocess sink to give up too.
    await run('pkill', ['-f', 'bridge.cjs']);
    await run('pkill', ['-f', 'librespot']);
  }

  private startTcpServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => {
        this.socket = socket;
        this.bridgeEverConnected = true;
        socket.on('data', (d) => {
          this.pcmBytes += d.length;
          const ok = this.pcmHandler?.(d);
          if (ok === false && !socket.isPaused()) {
            socket.pause();
          }
        });
        socket.on('close', () => {
          if (this.socket === socket) {
            this.socket = null;
            // The bridge died under a still-running librespot (a stale bot's
            // killStale, or a node crash). Its subprocess sink can never
            // recover, so kill librespot — the exit handler respawns both.
            if (!this.stopped && this.proc) {
              console.warn('[librespot] PCM bridge lost — recycling librespot');
              const p = this.proc;
              this.proc = null;
              try {
                p.kill();
              } catch {
                /* ignore */
              }
              this.scheduleRestart();
            }
          }
        });
        socket.on('error', () => {});
      });
      server.on('error', (err) => {
        this.tcpServer = null;
        reject(err);
      });
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') this.bridgePort = addr.port;
        this.tcpServer = server;
        resolve();
      });
    });
  }

  private spawnLibrespot(bridgePath: string): void {
    this.bridgeEverConnected = false;
    // A stale librespot from a prior run (or a prior respawn that failed its
    // Connect registration) holds the same device id = SHA1(name) and can grab
    // play commands destined for this session — routing audio to a dead socket.
    // Kill zombies before every spawn, not just at startup, so a respawn never
    // inherits one. Await so the taskkill finishes before we fork.
    void this.killStale().finally(() => {
      if (this.stopped) return;
      this.spawnArgv(bridgePath);
    });
  }

  private spawnArgv(bridgePath: string): void {
    const args = [
      '--name',
      config.librespotDeviceName,
      '--backend',
      'subprocess',
      '--device',
      // librespot parses this with shell_words::split. That tool strips quotes and
      // backslashes, so a Windows path with spaces would break — hence forward
      // slashes (Node accepts them) and quotes around the bridge path. The port is
      // NOT passed as an arg (spaces/quoting across the split is fragile): the
      // bridge reads it from VAPORZR_BRIDGE_PORT, which librespot inherits via
      // spawn env below. Ephemeral per session so stale bridges can't hijack it.
      `node "${bridgePath.replace(/\\/g, '/')}"`,
      '--format',
      's16',
      '--bitrate',
      String(config.librespotBitrate),
      // With autoplay off, librespot stops after the queued track ends, so the
      // bot's end timer controls advancement (no runaway related-track playback).
      '--autoplay',
      'off',
      '--cache',
      path.join(config.dataDir, 'librespot'),
    ];
    // Note: librespot >= 0.8.0 no longer accepts --username/--password. It uses
    // cached OAuth credentials (run once with `--enable-oauth` to log in).

    console.log(
      `[librespot] starting: ${config.librespotPath} ${args
        .map((a, i) => (args[i - 1] === '--password' ? '***' : a))
        .join(' ')}`
    );
    // Rotate / open a persistent stderr log so librespot's own errors are
    // visible. The Node spawn pipe wasn't surfacing them, making silent exits
    // impossible to debug on Windows.
    this.closeStderrFd();
    const stderrPath = path.join(config.dataDir, 'librespot', 'stderr.log');
    try {
      fs.mkdirSync(path.dirname(stderrPath), { recursive: true });
      this.stderrFd = fs.openSync(stderrPath, 'a');
    } catch (err) {
      console.warn(`[librespot] could not open stderr log: ${err instanceof Error ? err.message : err}`);
    }
    const proc = spawn(config.librespotPath, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', this.stderrFd ?? 'pipe'],
      env: { ...process.env, VAPORZR_BRIDGE_PORT: String(this.bridgePort) },
    });
    this.startedAt = Date.now();
    this.proc = proc;
    proc.on('error', (err) => {
      console.warn(`[librespot] failed to start: ${err.message}`);
      if (this.proc === proc) this.proc = null;
      if (!this.stopped) this.scheduleRestart();
    });
    proc.on('exit', (code) => {
      console.warn(`[librespot] exited with code ${code}`);
      if (this.proc === proc) this.proc = null;
      // An unexpected exit (crash, Spotify auth drop) must respawn, otherwise
      // every Spotify play silently degrades to the slow YouTube fallback.
      if (!this.stopped) this.scheduleRestart();
    });
    // A process that stays up for a minute resets the restart backoff.
    setTimeout(() => {
      if (this.proc === proc) this.restarts = 0;
    }, 60_000).unref?.();
    proc.stdout?.on('data', (d) => console.log(`[librespot] ${String(d).trim()}`));
    this.startHeartbeat(proc);
  }

  private closeStderrFd(): void {
    if (this.stderrFd !== null) {
      try {
        fs.closeSync(this.stderrFd);
      } catch {
        /* ignore */
      }
      this.stderrFd = null;
    }
  }

  /** Start the zombie-bridge watchdog for this librespot process. */
  private startHeartbeat(proc: ChildProcess): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      // Not ours anymore (stop() or a newer spawn replaced it).
      if (this.proc !== proc || this.stopped) {
        this.stopHeartbeat();
        return;
      }
      // Once the bridge HAS connected, a null socket is a dead PCM path — the
      // classic silent-stall. Recycle librespot so its exit handler respawns a
      // fresh one; this is what restores `isRunning()` without waiting for the
      // next track or a full process restart.
      if (this.bridgeEverConnected && this.socket === null) {
        console.warn('[librespot] heartbeat lost bridge — recycling librespot');
        const p = this.proc;
        this.proc = null;
        this.stopHeartbeat();
        try {
          p?.kill();
        } catch {
          /* ignore */
        }
        this.scheduleRestart();
      }
    }, 5_000);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /** Re-spawn librespot with capped backoff after an unexpected exit. */
  private scheduleRestart(): void {
    if (this.restartTimer || !this.bridgePath || !config.librespotPath) return;
    this.restarts++;
    if (this.restarts > 10) {
      console.error('[librespot] giving up after repeated exits — Spotify plays will use the YouTube fallback');
      return;
    }
    const delay = Math.min(30_000, 2000 * this.restarts);
    console.warn(`[librespot] unexpected exit — restarting in ${delay / 1000}s (attempt ${this.restarts})`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.stopped || this.proc) return;
      this.spawnLibrespot(this.bridgePath);
    }, delay);
    this.restartTimer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    this.stopHeartbeat();
    this.closeStderrFd();
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.socket) {
      try {
        this.socket.destroy();
      } catch {
        /* ignore */
      }
      this.socket = null;
    }
    if (this.tcpServer) {
      try {
        this.tcpServer.close();
      } catch {
        /* ignore */
      }
      this.tcpServer = null;
    }
    if (this.proc) {
      try {
        this.proc.kill();
      } catch {
        /* ignore */
      }
      this.proc = null;
    }
  }
}
