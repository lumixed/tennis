/**
 * The shape the swing detector consumes.
 *
 * Deliberately not MediaPipe's types: the detector is pure and gets tested with
 * synthetic gestures, so it must not depend on the vision library at all.
 *
 * Coordinates are normalised to the frame, **y-up** — MediaPipe reports y-down,
 * and the adapter flips it so "low-to-high" means what it says.
 */

export type Point3 = { x: number; y: number; z: number };

export type PoseSample = {
  /** Capture timestamp in ms, on the same clock as the rest of the app. */
  t: number;
  wristLeft: Point3;
  wristRight: Point3;
  shoulderLeft: Point3;
  shoulderRight: Point3;
  hipLeft: Point3;
  hipRight: Point3;
  /** Lowest landmark visibility among the points above, 0..1. */
  visibility: number;
};

export type DetectedSwing = {
  /** Capture time of the peak frame, before latency compensation. */
  peakT: number;
  /** Which hand swung. */
  hand: "left" | "right";
  /** Peak speed in torso-lengths per second. */
  peakSpeed: number;
  /** Net wrist travel from swing start to peak, in torso lengths. */
  travel: Point3;
  /** Wrist height above the shoulder line at the peak, in torso lengths. */
  wristAboveShoulder: number;
  /** Torso lean at the peak, -1..1. */
  lean: number;
};

/** Live figures for the tuning overlay. */
export type DetectorDebug = {
  speed: number;
  smoothedSpeed: number;
  armed: boolean;
  torsoScale: number;
  visibility: number;
  hand: "left" | "right";
  lean: number;
  /** Recent speed history for the trace, oldest first. */
  trace: number[];
};
