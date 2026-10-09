/**
 * Reactive overlay for the Endless Wave scene on the desktop player.
 * The base layer is the real VISUALDON wallpaper video (served by the bot at
 * /ew-bg.mp4). When the video is available this module composites it into the
 * canvas itself, which is what lets the scene chromatically split on a kick;
 * the neon layer on top adds a beat flash, horizon pump, spectrum bars, kick
 * ripples, an aurora band, speed streaks, CRT scanlines, the NOW PLAYING
 * caption, film grain and a vignette.
 * Mirrors drawSynthOverlay in apps/bot/public/viz.html.
 */

export interface SynthLevels {
  bass: number;
  mid: number;
  treble: number;
  kickBoost: number;
  bpm: number;
  energy: number;
}

export interface SynthTrackInfo {
  name: string;
  artists: string;
}

interface Ripple {
  r: number;
  a: number;
}

export class SynthOverlay {
  private ctx: CanvasRenderingContext2D;
  private grain: CanvasPattern | null = null;
  private scan: CanvasPattern | null = null;
  /** Expanding kick rings, oldest first. */
  private ripples: Ripple[] = [];
  private lastKickAt = 0;
  /** Scratch buffer used to isolate one colour channel for the RGB split. */
  private chan: HTMLCanvasElement | null = null;
  private chanCtx: CanvasRenderingContext2D | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2d context unavailable');
    this.ctx = ctx;
  }

  render(
    nowMs: number,
    lv: SynthLevels,
    bars: readonly number[],
    track: SynthTrackInfo | null,
    reducedMotion: boolean,
    video?: HTMLVideoElement | null,
  ): void {
    const c = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    if (W === 0 || H === 0) return;
    c.clearRect(0, 0, W, H);

    const kick = reducedMotion ? 0 : lv.kickBoost;
    const energy = reducedMotion ? 0 : lv.energy;

    /* ---- Base scene: the wallpaper video, chromatically split on a kick ---- */
    if (video && video.readyState >= 2 && video.videoWidth > 0) {
      this.drawVideoSplit(c, video, W, H, kick);
    }

    /* ---- Kick flash: a hard, short brighten on every beat ---- */
    if (kick > 0.35) {
      c.fillStyle = 'rgba(255,235,255,' + (0.1 * kick).toFixed(3) + ')';
      c.fillRect(0, 0, W, H);
    }

    /* ---- Breathing beat glow from the horizon ---- */
    const glow = kick * 0.16 + lv.bass * 0.09;
    if (glow > 0.004) {
      const gg = c.createRadialGradient(W / 2, H * 0.62, 0, W / 2, H * 0.62, Math.max(W, H) * 0.72);
      gg.addColorStop(0, 'rgba(255,60,170,' + Math.min(0.34, glow).toFixed(3) + ')');
      gg.addColorStop(0.55, 'rgba(150,40,220,' + Math.min(0.18, glow * 0.5).toFixed(3) + ')');
      gg.addColorStop(1, 'rgba(255,60,170,0)');
      c.fillStyle = gg;
      c.fillRect(0, 0, W, H);
    }

    /* ---- Horizon line that pumps with the bass ---- */
    const hy = H * 0.62;
    const hbw = Math.max(1, 2.5 * (0.5 + lv.bass));
    const hg = c.createLinearGradient(0, hy - hbw, 0, hy + hbw);
    hg.addColorStop(0, 'rgba(255,120,220,0)');
    hg.addColorStop(0.5, 'rgba(255,180,240,' + (0.1 + 0.5 * lv.bass).toFixed(3) + ')');
    hg.addColorStop(1, 'rgba(255,120,220,0)');
    c.fillStyle = hg;
    c.fillRect(0, hy - hbw, W, hbw * 2);

    /* ---- Spectrum bars along the bottom (reflection + glowing cap) ---- */
    const n = Math.min(24, bars.length);
    const slot = W / Math.max(1, n);
    const barW = Math.min(slot * 0.56, 26);
    const baseY = H * 0.94;
    const maxH = H * 0.36 * (0.85 + 0.3 * lv.bass);
    for (let i = 0; i < n; i++) {
      const v = Math.max(0, Math.min(1, bars[i]));
      const h = Math.max(2, v * maxH);
      const x = i * slot + (slot - barW) / 2;
      const y = baseY - h;
      const g = c.createLinearGradient(0, baseY, 0, baseY - maxH);
      g.addColorStop(0, 'rgba(255,80,180,0.9)');
      g.addColorStop(0.7, 'rgba(200,120,255,0.95)');
      g.addColorStop(1, 'rgba(80,240,255,1)');
      c.fillStyle = g;
      c.shadowColor = 'rgba(255,80,180,0.7)';
      c.shadowBlur = 10 + 16 * v;
      c.fillRect(x, y, barW, h);
      c.shadowBlur = 0;
      c.globalAlpha = 0.22 * (0.4 + v);
      c.fillRect(x, baseY + 2, barW, Math.max(0, Math.min(h * 0.45, H - baseY - 2)));
      c.globalAlpha = 1;
      c.fillStyle = 'rgba(230,250,255,0.95)';
      c.fillRect(x, y - 2, barW, 2.5);
    }

    /* ---- NOW PLAYING caption ---- */
    if (track && track.name) {
      c.textAlign = 'left';
      c.textBaseline = 'alphabetic';
      c.shadowColor = 'rgba(255,60,160,0.85)';
      const capFs = Math.max(13, Math.min(22, W * 0.013));
      c.font = '600 ' + capFs + 'px Inter,system-ui,sans-serif';
      c.shadowBlur = 14;
      c.fillStyle = 'rgba(255,255,255,0.92)';
      c.fillText(track.name, 24, H - 42);
      c.font = '500 ' + Math.round(capFs * 0.66) + 'px Inter,system-ui,sans-serif';
      c.fillStyle = 'rgba(60,230,255,0.85)';
      c.shadowColor = 'rgba(0,200,255,0.7)';
      c.fillText(track.artists, 24, H - 20);
      c.shadowBlur = 0;
    }

    /* ---- Kick ripples: expanding rings from the horizon ---- */
    if (!reducedMotion && kick > 0.5 && nowMs - this.lastKickAt > 110) {
      this.lastKickAt = nowMs;
      this.ripples.push({ r: Math.max(W, H) * 0.05, a: 0.45 + 0.4 * kick });
      if (this.ripples.length > 10) this.ripples.shift();
    }
    for (let i = this.ripples.length - 1; i >= 0; i--) {
      const rp = this.ripples[i];
      rp.r += Math.max(2, W * 0.006 * (1 + lv.bass * 2));
      rp.a *= 0.96;
      if (rp.a < 0.02) {
        this.ripples.splice(i, 1);
        continue;
      }
      c.beginPath();
      c.arc(W / 2, H * 0.62, rp.r, 0, Math.PI * 2);
      c.lineWidth = Math.max(1.5, 3 * (0.4 + lv.bass));
      c.strokeStyle = 'rgba(120,240,255,' + rp.a.toFixed(3) + ')';
      c.shadowColor = 'rgba(255,80,180,0.6)';
      c.shadowBlur = 18;
      c.stroke();
    }
    c.shadowBlur = 0;

    /* ---- Aurora band: hue drifts, opacity follows treble ---- */
    const hue = (nowMs * 0.03) % 360;
    const aur = c.createLinearGradient(0, 0, W, H * 0.6);
    aur.addColorStop(0, 'hsla(' + hue + ',90%,60%,0)');
    aur.addColorStop(0.5, 'hsla(' + ((hue + 60) % 360) + ',90%,62%,' + (0.05 + lv.treble * 0.12).toFixed(3) + ')');
    aur.addColorStop(1, 'hsla(' + ((hue + 140) % 360) + ',90%,60%,0)');
    c.save();
    c.globalCompositeOperation = 'screen';
    c.fillStyle = aur;
    c.fillRect(0, 0, W, H * 0.6);
    c.restore();

    /* ---- Speed streaks: count and opacity follow overall energy ---- */
    if (energy > 0.02) {
      c.save();
      c.globalCompositeOperation = 'screen';
      c.strokeStyle = 'rgba(255,255,255,' + Math.min(0.18, energy * 0.5).toFixed(3) + ')';
      c.lineWidth = 1;
      const streaks = Math.round(6 + energy * 18);
      for (let i = 0; i < streaks; i++) {
        const sy = ((nowMs * 0.06 * (0.5 + energy) + (i * 97) % 1000) / 1000) % 1;
        const sx = ((i * 53) % 100) / 100;
        const len = W * (0.05 + 0.12 * energy);
        c.beginPath();
        c.moveTo(sx * W, sy * H);
        c.lineTo(sx * W + len, sy * H);
        c.stroke();
      }
      c.restore();
    }

    /* ---- Beat scanline sweeping down the screen ---- */
    const scanY = ((nowMs * 0.08) % 1) * H;
    c.save();
    c.globalCompositeOperation = 'screen';
    const sg = c.createLinearGradient(0, scanY - 40, 0, scanY + 40);
    sg.addColorStop(0, 'rgba(255,255,255,0)');
    sg.addColorStop(0.5, 'rgba(180,240,255,' + (0.05 + kick * 0.18).toFixed(3) + ')');
    sg.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = sg;
    c.fillRect(0, scanY - 40, W, 80);
    c.restore();

    /* ---- CRT scanlines (static pattern, zero per-frame cost beyond one fill) ---- */
    if (!this.scan) {
      const sc = document.createElement('canvas');
      sc.width = 1;
      sc.height = 3;
      const sctx = sc.getContext('2d');
      if (sctx) {
        sctx.fillStyle = 'rgba(4,0,10,0.16)';
        sctx.fillRect(0, 0, 1, 1);
        this.scan = c.createPattern(sc, 'repeat');
      }
    }
    if (this.scan) {
      c.fillStyle = this.scan;
      c.fillRect(0, 0, W, H);
    }

    /* ---- Film grain ---- */
    if (!this.grain) {
      const gc = document.createElement('canvas');
      gc.width = 100;
      gc.height = 100;
      const gx = gc.getContext('2d');
      if (gx) {
        const gid = gx.createImageData(100, 100);
        for (let gi = 0; gi < gid.data.length; gi += 4) {
          const gv = Math.random() * 255;
          gid.data[gi] = gv;
          gid.data[gi + 1] = gv;
          gid.data[gi + 2] = gv;
          gid.data[gi + 3] = 30;
        }
        gx.putImageData(gid, 0, 0);
        this.grain = c.createPattern(gc, 'repeat');
      }
    }
    if (this.grain) {
      c.save();
      c.globalCompositeOperation = 'overlay';
      c.globalAlpha = 0.4;
      c.fillStyle = this.grain;
      c.fillRect(0, 0, W, H);
      c.restore();
    }

    /* ---- Vignette (deepens with the bass) ---- */
    const vig = c.createRadialGradient(W / 2, H / 2, H * 0.3, W / 2, H / 2, H * 0.8);
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(1, 'rgba(0,0,0,' + (0.55 + 0.25 * Math.min(1, lv.bass * 1.6)).toFixed(2) + ')');
    c.fillStyle = vig;
    c.fillRect(0, 0, W, H);
  }

  /** Draw the wallpaper with `object-fit: cover` semantics. */
  private drawVideoCover(
    c: CanvasRenderingContext2D,
    video: HTMLVideoElement,
    W: number,
    H: number,
  ): void {
    const vw = video.videoWidth || 16;
    const vh = video.videoHeight || 9;
    const scale = Math.max(W / vw, H / vh);
    const dw = vw * scale;
    const dh = vh * scale;
    c.drawImage(video, (W - dw) / 2, (H - dh) / 2, dw, dh);
  }

  /**
   * Chromatic aberration: the scene plus red/blue copies pushed apart, scaled by
   * the kick. Below a pixel of travel it is skipped entirely, so the extra video
   * draws only happen on beats.
   */
  private drawVideoSplit(
    c: CanvasRenderingContext2D,
    video: HTMLVideoElement,
    W: number,
    H: number,
    kick: number,
  ): void {
    this.drawVideoCover(c, video, W, H);
    const split = W * 0.004 * kick;
    if (split < 0.5) return;

    if (!this.chan || this.chan.width !== W || this.chan.height !== H) {
      this.chan = document.createElement('canvas');
      this.chan.width = W;
      this.chan.height = H;
      this.chanCtx = this.chan.getContext('2d');
    }
    const tc = this.chanCtx;
    if (!tc) return;

    c.globalCompositeOperation = 'screen';
    const passes: Array<[string, number]> = [
      ['#ff0000', split],
      ['#0000ff', -split],
    ];
    for (const [colour, dx] of passes) {
      tc.globalCompositeOperation = 'source-over';
      tc.clearRect(0, 0, W, H);
      this.drawVideoCover(tc, video, W, H);
      // Keep one channel only: multiply the scene by pure red/blue.
      tc.globalCompositeOperation = 'multiply';
      tc.fillStyle = colour;
      tc.fillRect(0, 0, W, H);
      c.drawImage(this.chan, dx, 0);
    }
    c.globalCompositeOperation = 'source-over';
  }
}
