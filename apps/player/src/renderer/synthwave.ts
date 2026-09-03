/**
 * Reactive overlay for the Endless Wave scene on the desktop player.
 * The base layer is the real VISUALDON wallpaper video (served by the bot at
 * /ew-bg.mp4, shown in a <video> element under this transparent canvas).
 * This module only draws what the video can't: beat glow, spectrum bars,
 * the NOW PLAYING caption, film grain, and vignette.
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

export class SynthOverlay {
  private ctx: CanvasRenderingContext2D;
  private grain: CanvasPattern | null = null;

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
  ): void {
    const c = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    if (W === 0 || H === 0) return;
    c.clearRect(0, 0, W, H);

    /* Beat glow breathing over the scene. */
    const kick = reducedMotion ? 0 : lv.kickBoost;
    const glow = kick * 0.10 + lv.bass * 0.05;
    if (glow > 0.004) {
      const gg = c.createRadialGradient(W / 2, H * 0.62, 0, W / 2, H * 0.62, Math.max(W, H) * 0.7);
      gg.addColorStop(0, 'rgba(255,60,170,' + Math.min(0.2, glow).toFixed(3) + ')');
      gg.addColorStop(1, 'rgba(255,60,170,0)');
      c.fillStyle = gg;
      c.fillRect(0, 0, W, H);
    }

    /* Spectrum bars along the bottom. */
    const n = Math.min(24, bars.length);
    const slot = W / Math.max(1, n);
    const barW = Math.min(slot * 0.5, 22);
    const baseY = H * 0.965;
    const maxH = H * 0.3;
    for (let i = 0; i < n; i++) {
      const v = Math.max(0, Math.min(1, bars[i]));
      const h = Math.max(2, v * maxH);
      const x = i * slot + (slot - barW) / 2;
      const y = baseY - h;
      const g = c.createLinearGradient(0, baseY, 0, baseY - maxH);
      g.addColorStop(0, 'rgba(255,80,180,0.85)');
      g.addColorStop(1, 'rgba(80,240,255,0.9)');
      c.fillStyle = g;
      c.shadowColor = 'rgba(255,80,180,0.55)';
      c.shadowBlur = 12 * (0.3 + v * 0.7);
      c.fillRect(x, y, barW, h);
    }
    c.shadowBlur = 0;

    /* NOW PLAYING caption. */
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

    /* Film grain. */
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

    /* Vignette. */
    const vig = c.createRadialGradient(W / 2, H / 2, H * 0.3, W / 2, H / 2, H * 0.8);
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(1, 'rgba(0,0,0,0.7)');
    c.fillStyle = vig;
    c.fillRect(0, 0, W, H);

    void nowMs;
  }
}
