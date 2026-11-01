/**
 * Helpers for the Weasel's live voice-channel ears (`V@w listen on`).
 *
 * Kept dependency-free so they can be unit-tested without a voice connection.
 */

/**
 * Lift a quiet microphone capture closer to full scale before transcription.
 *
 * Discord applies no AGC on the receive side, so a soft mic — or someone
 * sitting back from it — produces a clip that speech models report as
 * "no speech". This only ever *boosts*, and caps the gain so room noise is not
 * blown up: a loud clip is returned untouched.
 */
export function normalizeCapturePcm(pcm: Buffer): { pcm: Buffer; peak: number; gain: number } {
  const samples = Math.floor(pcm.length / 2);
  let peak = 0;
  for (let i = 0; i < samples; i++) {
    const v = Math.abs(pcm.readInt16LE(i * 2));
    if (v > peak) peak = v;
  }
  if (peak === 0 || peak >= 8000) return { pcm, peak, gain: 1 };
  const gain = Math.min(4, 14000 / peak);
  if (gain <= 1.05) return { pcm, peak, gain: 1 };
  const out = Buffer.allocUnsafe(samples * 2);
  for (let i = 0; i < samples; i++) {
    const v = Math.round(pcm.readInt16LE(i * 2) * gain);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, v)), i * 2);
  }
  return { pcm: out, peak, gain };
}
