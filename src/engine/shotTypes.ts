/**
 * The abstract input vocabulary of the game.
 *
 * Nothing here mentions cameras, keys or landmarks. The pose adapter, the
 * keyboard adapter and the bot all produce the same `SwingEvent`, which is what
 * keeps the engine testable headlessly and the bot from being a special case.
 */

export type SwingArc = "low-to-high" | "high-to-low" | "overhead" | "flat";

export type SwingSide = "forehand" | "backhand";

export type SwingEvent = {
  /** Engine time in ms at which the swing peaked. */
  t: number;
  arc: SwingArc;
  /** Normalised swing speed, 0..1. Calibration happens in the input adapter. */
  power: number;
  /** Lateral aim from torso lean, -1 (left) .. 1 (right). */
  lateralBias: number;
  side: SwingSide;
  /**
   * Where the player was standing relative to their neutral position, -1..1.
   *
   * Separate from `lateralBias`: lean is a shoulder rotation you can do rooted
   * to the spot, stance is the hips actually having moved. Optional because
   * only the camera can observe it — the keyboard and the bot leave it unset,
   * and an unset stance applies no modifier at all.
   */
  stance?: number;
};

export type ShotKind = "topspin" | "drive" | "slice" | "smash" | "lob" | "serve";

export type TimingGrade = "perfect" | "good" | "weak" | "miss";

/** Which shot a swing arc produces, before contact height overrides it. */
export const ARC_TO_SHOT: Record<SwingArc, ShotKind> = {
  "low-to-high": "topspin",
  "high-to-low": "slice",
  overhead: "smash",
  flat: "drive",
};
