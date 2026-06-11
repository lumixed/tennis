/**
 * Deriving swing thresholds from the player's own swings.
 *
 * Shipping constants tuned against one body in one room is guesswork; someone
 * shorter, further from the camera, or simply gentler gets a game that either
 * ignores them or fires on nothing. This measures a handful of real swings and
 * sets the thresholds from those.
 *
 * Works on the *raw speed signal* rather than on detected swings, because if the
 * current thresholds are wrong then no swings are being detected — which is
 * exactly the situation calibration has to rescue.
 *
 * Pure, so it can be tested against synthetic traces.
 */

import type { SwingConfig } from "./swingConfig";

export type CalibrationSuggestion = {
  enterSpeed: number;
  exitSpeed: number;
  minPeakSpeed: number;
  /** Peak speeds mapping to zero and full shot power. */
  powerRange: [number, number];
};

export type CalibrationResult = {
  /** Peak speeds found, largest first. */
  peaks: number[];
  medianPeak: number;
  maxPeak: number;
  suggestion: CalibrationSuggestion;
};

export type CalibrationProblem =
  | "no-signal"
  | "too-few-swings"
  | "inconsistent";

/**
 * Fractions of the player's median peak swing speed.
 *
 * Arming well below the peak matters: the threshold has to be crossed on the way
 * *up*, long before the peak arrives, or the swing is only recognised after it
 * is already over.
 */
const ARM_AT = 0.38;
const RELEASE_AT = 0.18;
const MIN_PEAK_AT = 0.55;
/** A gentle rally swing should still register as meaningful power. */
const POWER_FLOOR_AT = 0.5;
const POWER_CEILING_AT = 1.12;

/**
 * Speed below which a bump is landmark jitter rather than a swing.
 *
 * Absolute, not a fraction of the largest peak. A relative floor fails twice
 * over: on an all-noise trace the noise becomes its own reference and every
 * wobble reads as a peak, and one huge spike — someone walking into frame —
 * raises the floor above the real swings and hides them entirely.
 */
const NOISE_FLOOR_SPEED = 0.6;

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
};

/**
 * Find swing peaks in a speed trace.
 *
 * `minGapSamples` merges the shoulders of one gesture into a single peak, so a
 * swing with a slightly bumpy profile is not counted twice.
 */
export function findPeaks(
  speeds: number[],
  minGapSamples = 8,
  floor = NOISE_FLOOR_SPEED
): number[] {
  if (speeds.length < 3) return [];

  const peaks: Array<{ index: number; value: number }> = [];
  for (let i = 1; i < speeds.length - 1; i++) {
    const value = speeds[i]!;
    if (value < floor) continue;
    if (value >= speeds[i - 1]! && value > speeds[i + 1]!) {
      const previous = peaks[peaks.length - 1];
      if (previous && i - previous.index < minGapSamples) {
        // Same gesture; keep whichever shoulder was higher.
        if (value > previous.value) peaks[peaks.length - 1] = { index: i, value };
      } else {
        peaks.push({ index: i, value });
      }
    }
  }

  return peaks.map((p) => p.value).sort((a, b) => b - a);
}

/**
 * Turn a recorded calibration trace into threshold suggestions.
 *
 * Returns a problem code rather than throwing, so the UI can say something
 * useful about what went wrong instead of silently applying nonsense.
 */
export function analyseCalibration(
  speeds: number[],
  expectedSwings = 5
): CalibrationResult | { problem: CalibrationProblem } {
  const peaks = findPeaks(speeds);
  if (peaks.length === 0 || Math.max(...speeds, 0) < 0.5) {
    return { problem: "no-signal" };
  }
  // Needing every requested swing would fail people who lose count; most is fine.
  if (peaks.length < Math.max(2, Math.ceil(expectedSwings * 0.6))) {
    return { problem: "too-few-swings" };
  }

  // Use the strongest `expectedSwings` peaks: stray small bumps between swings
  // would otherwise drag the median down and make the game hair-triggered.
  const used = peaks.slice(0, expectedSwings);
  const medianPeak = median(used);
  const maxPeak = used[0]!;

  // A wildly inconsistent set usually means the trace caught something other
  // than swings — walking into frame, adjusting the camera, and so on.
  if (medianPeak <= 0 || maxPeak / medianPeak > 4) {
    return { problem: "inconsistent" };
  }

  return {
    peaks: used,
    medianPeak,
    maxPeak,
    suggestion: {
      enterSpeed: round(medianPeak * ARM_AT),
      exitSpeed: round(medianPeak * RELEASE_AT),
      minPeakSpeed: round(medianPeak * MIN_PEAK_AT),
      powerRange: [
        round(medianPeak * POWER_FLOOR_AT),
        round(maxPeak * POWER_CEILING_AT),
      ],
    },
  };
}

const round = (value: number): number => Math.round(value * 100) / 100;

/** Apply a suggestion to the live config. */
export function applyCalibration(
  config: SwingConfig,
  suggestion: CalibrationSuggestion
): void {
  config.enterSpeed = suggestion.enterSpeed;
  config.exitSpeed = suggestion.exitSpeed;
  config.minPeakSpeed = suggestion.minPeakSpeed;
  config.powerSpeedMin = suggestion.powerRange[0];
  config.powerSpeedMax = suggestion.powerRange[1];
}
