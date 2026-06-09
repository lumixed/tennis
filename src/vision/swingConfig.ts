/**
 * Swing detection thresholds.
 *
 * Every value here is a guess until it has been run against a real body, in real
 * lighting, at a real camera distance. That is exactly why the tuning overlay
 * exists and why this object is mutable — these get dragged on sliders while
 * playing, not derived from first principles.
 */

export type SwingConfig = {
  /**
   * Speed that arms a swing, in torso-lengths per second.
   *
   * Normalising by torso length rather than using raw pixels is what makes the
   * thresholds survive the player standing closer to or further from the camera.
   */
  enterSpeed: number;
  /** Speed below which an armed swing is considered finished. */
  exitSpeed: number;
  /** A swing is discarded if it never reached this peak speed. */
  minPeakSpeed: number;
  /** Minimum gap between accepted swings, in ms. */
  refractoryMs: number;
  /**
   * Landmark smoothing time constant, in ms.
   *
   * Expressed as a time constant rather than a per-frame blend factor on
   * purpose. A fixed per-frame alpha smooths twice as hard at 30 fps as at 60,
   * so the identical physical swing measured a peak of 7.8 on one webcam and
   * 8.9 on another — the player's shot power would depend on their hardware.
   */
  positionTauMs: number;
  /** Speed smoothing time constant, in ms. Same reasoning. */
  speedTauMs: number;
  /** Landmarks below this visibility are not trusted. */
  minVisibility: number;
  /**
   * Fraction of the travel that must be vertical for the swing to count as
   * lifted or chopped rather than flat.
   */
  arcVerticalRatio: number;
  /** Wrist height above the shoulders, in torso lengths, that reads as overhead. */
  overheadHeight: number;
  /** Multiplier turning torso lean into the engine's -1..1 aim. */
  leanGain: number;
  /**
   * Subtracted from the peak timestamp before the swing reaches the engine.
   *
   * Covers smoothing lag plus capture-to-callback delay. The engine applies no
   * compensation of its own, so this number is the only place pipeline latency
   * is accounted for.
   */
  latencyCompensationMs: number;
  /** Frames of speed history kept for the overlay trace. */
  traceLength: number;
};

export const DEFAULT_SWING_CONFIG: SwingConfig = {
  enterSpeed: 2.4,
  exitSpeed: 1.1,
  minPeakSpeed: 3.0,
  refractoryMs: 420,
  // Equivalent to the previous 0.45 / 0.50 per-frame blends at 30 fps.
  positionTauMs: 56,
  speedTauMs: 48,
  minVisibility: 0.5,
  arcVerticalRatio: 0.4,
  overheadHeight: 0.12,
  leanGain: 2.6,
  latencyCompensationMs: 90,
  traceLength: 90,
};

/** Live config the tuning overlay mutates. */
export const swingConfig: SwingConfig = { ...DEFAULT_SWING_CONFIG };

export function resetSwingConfig(): void {
  Object.assign(swingConfig, DEFAULT_SWING_CONFIG);
}
