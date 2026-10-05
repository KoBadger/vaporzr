/**
 * Session audio FX — the EQ preset table and the chain builder shared by the
 * YouTube/Suno ffmpeg path (voice.ts) and the Spotify PCM resampler
 * (playback.ts RESAMPLE_ARGS). Both append the same `-af` stages, so the
 * sound of a preset is identical whichever source is playing.
 *
 * Kept pure (no imports) so it is trivially unit-testable.
 */

export const EQ_PRESETS = ['flat', 'bass', 'vocal', 'night', 'warm', 'lofi'] as const;
export type EqPreset = (typeof EQ_PRESETS)[number];

export function isEqPreset(v: string): v is EqPreset {
  return (EQ_PRESETS as readonly string[]).includes(v);
}

/** Per-preset filter chains. 'flat' adds nothing. Order: EQ shape the sound. */
const EQ_CHAINS: Record<EqPreset, string> = {
  flat: '',
  // Same shelf the /bassboost path uses at 8 dB, so V@eq bass matches V@bass 8.
  bass: 'bass=g=8:f=150:width_type=q:width=0.8',
  // Cut low-mud and lift presence so vocals sit forward.
  vocal: 'equalizer=f=250:t=q:w=1.1:g=-2,equalizer=f=3200:t=q:w=1.3:g=4',
  // Late-night listening: gentle low lift, soft top end.
  night: 'bass=g=4:f=110:width_type=q:width=0.7,treble=g=-3.5:f=6000',
  // A touch warmer than flat without losing detail.
  warm: 'bass=g=3:f=90:width_type=q:width=0.7,treble=g=-2:f=8000',
  // Soft-focus: gently band-limited, like a tape or FM broadcast.
  lofi: 'lowpass=f=11000,bass=g=2:f=80:width_type=q:width=0.7',
};

/**
 * Loudness normalization. Spotify normalizes playback around -14 LUFS, so a
 * YouTube source matched to the same integrated loudness stops jumping out
 * louder (or hiding quieter) between sources. loudnorm upsamples to 192 kHz
 * internally, so an explicit aresample back to 48k must follow it — without
 * that the s16le stream would announce the wrong rate and play as noise.
 */
export const LOUDNORM_CHAIN = 'loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000';

export interface AudioFxInput {
  /** EQ preset id (from PlaybackState.eq). Invalid ids are ignored. */
  eq?: string;
  /** True when loudness normalization is on (PlaybackState.loudnorm). */
  loudnorm?: boolean;
  /** Bass-boost gain in dB from the separate /bassboost control (0 = off). */
  bassBoostDb?: number;
  /** Tempo/pitch factor from /speed (1 = normal). */
  speedFactor?: number;
}

/** Build the `-af` stages appended after the base normalize + fade-in stage. */
export function buildAudioFxChain(input: AudioFxInput): string {
  const stages: string[] = [];
  if (input.loudnorm) stages.push(LOUDNORM_CHAIN);
  const eq = input.eq && isEqPreset(input.eq) ? EQ_CHAINS[input.eq] : '';
  if (eq) stages.push(eq);
  if ((input.bassBoostDb ?? 0) > 0) {
    // Corner at 150 Hz (not 100) so the shelf is actually audible on normal
    // speakers instead of only sub-bass. q=0.8 is a moderate, non-boomy slope.
    stages.push(`bass=g=${(input.bassBoostDb ?? 0).toFixed(1)}:f=150:width_type=q:width=0.8`);
  }
  if ((input.speedFactor ?? 1) !== 1) {
    // asetrate shifts the sample-rate *field* only (pitch + tempo move
    // together); pre-resample to a known 48k so the factor is exact
    // regardless of the source's native rate, then aresample back out.
    const shifted = Math.round(48000 * (input.speedFactor ?? 1));
    stages.push(`aresample=48000,asetrate=${shifted},aresample=48000`);
  }
  return stages.join(',');
}
