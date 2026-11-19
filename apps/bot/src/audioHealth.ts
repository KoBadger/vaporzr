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

/**
 * Analyse one PCM window (48 kHz stereo s16le). Reads it as interleaved stereo
 * frames, counting zero crossings per channel.
 *
 * Per channel, not per sample: on real music the left and right channels differ
 * (panning, reverb, stereo width), so the interleaved L,R,L,R sequence crosses
 * zero almost every sample — a measured ZCR of 0.4–0.9 on perfectly good music.
 * That is why the monitor called every loud, bright track "broadband noise" and
 * gated it to silence.
 */
export function analyzePcmWindow(pcm: Buffer): PcmWindowStats {
  const frames = Math.floor(pcm.length / 4);
  const samples = frames * 2;
  let sumSq = 0;
  let maxAbs = 0;
  let zeroCrossings = 0;
  let prevL = 0;
  let prevR = 0;
  for (let i = 0; i < frames; i++) {
    const l = pcm.readInt16LE(i * 4);
    const r = pcm.readInt16LE(i * 4 + 2);
    const absL = Math.abs(l);
    const absR = Math.abs(r);
    if (absL > maxAbs) maxAbs = absL;
    if (absR > maxAbs) maxAbs = absR;
    sumSq += l * l + r * r;
    if (i > 0) {
      if ((prevL < 0 && l > 0) || (prevL > 0 && l < 0)) zeroCrossings += 1;
      if ((prevR < 0 && r > 0) || (prevR > 0 && r < 0)) zeroCrossings += 1;
    }
    prevL = l;
    prevR = r;
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
