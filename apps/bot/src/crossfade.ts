/**
 * Crossfade DSP (step B foundation).
 *
 * The bot streams 48 kHz stereo Int16 PCM. A real crossfade overlaps the tail of
 * the outgoing track with the head of the incoming one using complementary gain
 * curves. These helpers are pure so the arithmetic is unit-tested independently
 * of the streaming/pipes layer.
 */

/** Equal-power (constant-loudness) fade-in gain for progress t in [0,1]. */
export function equalPowerIn(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  return Math.sin((c * Math.PI) / 2);
}

/** Complementary equal-power fade-out gain for progress t in [0,1]. */
export function equalPowerOut(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  return Math.cos((c * Math.PI) / 2);
}

/** Linear ramp in [0,1]. */
export function linearIn(t: number): number {
  return Math.max(0, Math.min(1, t));
}

function clamp16(v: number): number {
  return Math.max(-32768, Math.min(32767, Math.round(v)));
}

/**
 * Apply a rising gain ramp to the first `ms` of 48 kHz stereo Int16 PCM, leaving
 * the rest untouched. Returns a new Buffer (input is not mutated).
 */
export function fadeInPcm(pcm: Buffer, ms: number, curve: 'equal-power' | 'linear' = 'equal-power'): Buffer {
  const frames = Math.floor(pcm.length / 4);
  const rampFrames = Math.min(frames, Math.max(0, Math.floor((ms / 1000) * 48000)));
  const out = Buffer.from(pcm);
  const gain = curve === 'linear' ? linearIn : equalPowerIn;
  for (let i = 0; i < rampFrames; i++) {
    const g = gain(rampFrames > 1 ? i / (rampFrames - 1) : 1);
    out.writeInt16LE(clamp16(pcm.readInt16LE(i * 4) * g), i * 4);
    out.writeInt16LE(clamp16(pcm.readInt16LE(i * 4 + 2) * g), i * 4 + 2);
  }
  return out;
}

/**
 * Overlay `b` (48 kHz stereo Int16) on top of `a` with complementary ramps over
 * `rampFrames` frames, then continue with whichever source is longer. Used to
 * blend the incoming track's head over the outgoing track's tail.
 */
export function crossfadePcm(a: Buffer, b: Buffer, rampFrames: number): Buffer {
  const out = Buffer.allocUnsafe(Math.max(a.length, b.length));
  const total = Math.min(a.length, b.length) / 4;
  const ramp = Math.max(1, Math.min(rampFrames, total));
  const frames = Math.floor(total);
  for (let i = 0; i < frames; i++) {
    const t = i < ramp ? i / (ramp - 1) : 1;
    const ga = equalPowerOut(t);
    const gb = equalPowerIn(t);
    const la = a.readInt16LE(i * 4);
    const ra = a.readInt16LE(i * 4 + 2);
    const lb = b.readInt16LE(i * 4);
    const rb = b.readInt16LE(i * 4 + 2);
    out.writeInt16LE(clamp16(la * ga + lb * gb), i * 4);
    out.writeInt16LE(clamp16(ra * ga + rb * gb), i * 4 + 2);
  }
  const tail = a.length > b.length ? a.subarray(frames * 4) : b.subarray(frames * 4);
  tail.copy(out, frames * 4);
  return out;
}
