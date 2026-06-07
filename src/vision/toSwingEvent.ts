/**
 * Detected gesture -> engine input.
 *
 * The one place camera latency is undone. The engine grades swing timestamps at
 * face value, so if this does not subtract the pipeline delay, every shot from
 * the camera reads as late.
 */

import type { SwingArc, SwingEvent } from "../engine/shotTypes";
import type { SwingConfig } from "./swingConfig";
import type { DetectedSwing } from "./types";

/** Peak wrist speeds, in torso-lengths/s, mapping to zero and full power. */
export const POWER_RANGE: [number, number] = [3.0, 9.5];

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Classify the gesture's shape.
 *
 * Height wins over direction: a wrist well above the shoulders is an overhead
 * whatever path it took to get there.
 */
export function classifyArc(
  swing: DetectedSwing,
  config: SwingConfig
): SwingArc {
  if (swing.wristAboveShoulder >= config.overheadHeight) return "overhead";

  const vertical = Math.abs(swing.travel.y);
  const horizontal = Math.abs(swing.travel.x);
  const total = vertical + horizontal;
  if (total < 1e-6) return "flat";

  if (vertical / total >= config.arcVerticalRatio) {
    return swing.travel.y > 0 ? "low-to-high" : "high-to-low";
  }
  return "flat";
}

export function toSwingEvent(
  swing: DetectedSwing,
  config: SwingConfig
): SwingEvent {
  const [minSpeed, maxSpeed] = POWER_RANGE;
  const power = clamp(
    (swing.peakSpeed - minSpeed) / (maxSpeed - minSpeed),
    0,
    1
  );

  return {
    // Capture time of the peak, less the pipeline delay it took to get here.
    t: swing.peakT - config.latencyCompensationMs,
    arc: classifyArc(swing, config),
    power,
    lateralBias: clamp(swing.lean * config.leanGain, -1, 1),
    // Mirrored: the player's right hand appears on the left of a selfie view.
    side: swing.hand === "right" ? "forehand" : "backhand",
    // Only the camera can see where the player is actually standing.
    stance: swing.stance,
  };
}
