/**
 * Gameplay tunables.
 *
 * Physics constants live in `constants.ts` and describe reality. Everything here
 * describes the *game*, and is expected to be tuned by feel.
 */

import type { ShotKind } from "./shotTypes";

export type ShotProfile = {
  /** Launch speed in m/s at power 0 and power 1. */
  speed: [number, number];
  /** Topspin rate in rad/s at power 0 and power 1; negative is slice. */
  spin: [number, number];
  /** Target distance from the net, in metres, at power 0 and power 1. */
  depth: [number, number];
};

/**
 * Depth maxima stay inside the 11.885 m half-court so a well-struck ball lands
 * in. Going deeper is what the accuracy scatter is for.
 */
export const SHOT_PROFILES: Record<ShotKind, ShotProfile> = {
  topspin: { speed: [17, 31], spin: [260, 460], depth: [6.0, 10.4] },
  drive: { speed: [18, 33], spin: [40, 130], depth: [6.5, 10.8] },
  slice: { speed: [12, 23], spin: [-160, -330], depth: [4.8, 9.2] },
  smash: { speed: [24, 44], spin: [0, 160], depth: [3.0, 8.0] },
  // A lob looks gentle but still has to carry the length of the court, so it
  // needs real pace behind a steep launch. 15 m/s cannot reach a far baseline.
  lob: { speed: [19, 25], spin: [140, 260], depth: [8.6, 11.2] },
  serve: { speed: [30, 52], spin: [60, 320], depth: [4.2, 6.2] },
};

export const TIMING = {
  /**
   * Half-widths of the timing windows, in ms, either side of the ideal contact.
   * Deliberately generous: the pose pipeline costs ~100 ms before the engine
   * hears about a swing, so tight windows would punish the sensor, not the
   * player.
   */
  perfectMs: 70,
  goodMs: 165,
  weakMs: 300,

  /**
   * Subtracted from an incoming swing timestamp to undo pipeline latency.
   * Overridden at runtime once measured against a real camera.
   */
  latencyCompensationMs: 90,
};

export const ACCURACY = {
  /** Lateral scatter in metres at the worst legal timing. */
  maxLateralScatterM: 3.4,
  /** Depth scatter in metres at the worst legal timing. */
  maxDepthScatterM: 2.6,
  /** Fraction of full pace retained on a barely-legal swing. */
  minPowerScale: 0.55,
  /** How far across the court a full lateral lean aims, as a court fraction. */
  aimReach: 0.82,
};

export const RALLY = {
  /**
   * How far in front of the baseline the player makes contact. The avatar
   * auto-positions laterally, so only depth matters here.
   */
  contactDepthFromBaseline: 0.7,
  /** Below this contact height the player can only slice or lob. */
  lowContactHeight: 0.45,
  /** Contact above this height counts as a smash opportunity. */
  smashContactHeight: 1.9,
  /** Seconds after the second bounce before the point is closed out. */
  pointSettleSeconds: 0.6,
};

export const SOLVER = {
  minAngleDeg: -25,
  /** High enough to leave lobs room to arc without clipping the search. */
  maxAngleDeg: 70,
  sweepStepDeg: 2,
  bisectionSteps: 12,
  /** Integration step used inside the search. */
  dt: 1 / 120,
  maxFlightSeconds: 5,
} as const;
