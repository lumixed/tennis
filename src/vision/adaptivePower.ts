/**
 * Learning the player's swing range while they play.
 *
 * "Swing harder" only means anything relative to yourself. A fixed power curve
 * has to guess someone's maximum effort, and guessing wrong is punishing in one
 * direction and boring in the other: a recorded session showed peaks of 4-7
 * against a curve built for 9.5, so every shot came out at 20-30% power — slow,
 * short sitters, and no way for the player to know why.
 *
 * Explicit calibration solves that too, but only for players who press the
 * button. This does it for everyone, silently, from the swings they are already
 * making.
 *
 * Pure, so it is tested against synthetic swing sequences.
 */

export type AdaptivePowerState = {
  /** Recent peak speeds, oldest first. */
  peaks: number[];
  /** Current mapping, blended towards the observed range. */
  min: number;
  max: number;
};

export type AdaptivePowerConfig = {
  /** Swings remembered. Long enough to be stable, short enough to track change. */
  window: number;
  /** Swings needed before the observed range is trusted at all. */
  minSamples: number;
  /** Fraction of the gap closed per swing, so the scale never lurches. */
  blend: number;
  /** Headroom above the hardest observed swing, so full power stays reachable. */
  ceilingMargin: number;
  /** Where a typical swing should sit, as a fraction of the median peak. */
  floorOfMedian: number;
  /** Guard rails, in torso-lengths per second. */
  absoluteMin: number;
  absoluteMax: number;
};

export const DEFAULT_ADAPTIVE_POWER: AdaptivePowerConfig = {
  window: 15,
  minSamples: 4,
  blend: 0.25,
  ceilingMargin: 1.06,
  floorOfMedian: 0.45,
  absoluteMin: 0.8,
  absoluteMax: 30,
};

export function createAdaptivePower(
  min: number,
  max: number
): AdaptivePowerState {
  return { peaks: [], min, max };
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
};

/**
 * Fold in one swing's peak speed and return the updated mapping.
 *
 * The ceiling follows the hardest swing in the window rather than the mean, so
 * a player who mostly rallies gently can still find full power by swinging as
 * hard as they actually can.
 */
export function observeSwing(
  state: AdaptivePowerState,
  peakSpeed: number,
  config: AdaptivePowerConfig = DEFAULT_ADAPTIVE_POWER
): AdaptivePowerState {
  if (!Number.isFinite(peakSpeed) || peakSpeed <= 0) return state;

  const peaks = [...state.peaks, peakSpeed];
  if (peaks.length > config.window) {
    peaks.splice(0, peaks.length - config.window);
  }

  if (peaks.length < config.minSamples) {
    return { ...state, peaks };
  }

  const hardest = Math.max(...peaks);
  const typical = median(peaks);

  const targetMax = clamp(
    hardest * config.ceilingMargin,
    config.absoluteMin + 1,
    config.absoluteMax
  );
  const targetMin = clamp(
    typical * config.floorOfMedian,
    config.absoluteMin,
    // Always leave a usable span, whatever the samples say.
    targetMax - 1
  );

  return {
    peaks,
    min: state.min + (targetMin - state.min) * config.blend,
    max: state.max + (targetMax - state.max) * config.blend,
  };
}

/** Map a peak speed to 0..1 using the learned range. */
export function powerFor(state: AdaptivePowerState, peakSpeed: number): number {
  const span = Math.max(0.1, state.max - state.min);
  return clamp((peakSpeed - state.min) / span, 0, 1);
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
