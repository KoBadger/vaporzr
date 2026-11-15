/**
 * Real-time PCM audio-quality monitor.
 *
 * Exists to catch the two failure modes reported by listeners:
 *   (1) "the bot played white noise instead of the song" — the bytes reaching
 *       @discordjs/voice are broadband noise, not decoded audio.
 *   (2) "I only hear the bot after I leave and rejoin" — the link or the DAVE
 *       session was not ready for audio delivery, so listeners end up with a
 *       broken or silent stream until a rejoin gives them a fresh session.
 *
 * Both are detectable without touching the listener's ears: (1) analysing the
 * mixed PCM stream this module taps; (2) waiting for the voice link to reach a
 * Ready state AND (when E2EE is on) for the DAVE session to be live before
 * declaring the link ready for audio.
 *
 * Everything here is pure and exported for unit testing; no Discord state leaks
 * into the analyser.
 */

/** Statistics computed over one 48 kHz stereo s16 PCM window. */
export interface PcmWindowStats {
  /** Root-mean-square of the samples. 0 = perfect digital silence. */
  rms: number;
  /** Maximum |sample|. 0 = perfect digital silence. */
  peak: number;
  /** Number of times the waveform crossed zero inside this window. */
  zeroCrossings: number;
  /** Number of interleaved samples analysed. */
  samples: number;
}

/** Analyse one PCM window (48 kHz stereo s16le) in-place. */
export function analyzePcmWindow(pcm: Buffer): PcmWindowStats {
  const samples = Math.floor(pcm.length / 2);
  let sumSq = 0;
  let maxAbs = 0;
  let zeroCrossings = 0;
  let px = 0;
  for (let i = 0; i < samples; i++) {
    const v = pcm.readInt16LE(i * 2);
    const abs = Math.abs(v);
    if (abs > maxAbs) maxAbs = abs;
    sumSq += v * v;
    if (i > 0 && ((px < 0 && v > 0) || (px > 0 && v < 0))) zeroCrossings += 1;
    px = v;
  }
  return {
    rms: samples ? Math.sqrt(sumSq / samples) : 0,
    peak: samples ? maxAbs : 0,
    zeroCrossings,
    samples,
  };
}

/** Report whether a PCM window looks like decoded audio or broadband noise. */
export type PcmVerdict = 'good' | 'noise' | 'silence';
export function classifyPcmWindow(stats: PcmWindowStats): PcmVerdict {
  if (stats.samples === 0) return 'silence';
  const zcr = stats.zeroCrossings / stats.samples;
  if (stats.rms > 4000 && zcr > 0.42) return 'noise';
  if (stats.rms < 48 && stats.zeroCrossings === 0) return 'silence';
  return 'good';
}
