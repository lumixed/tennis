/**
 * Turning a swing into a ball.
 *
 * The solver works forwards: pick a target, pick a launch speed from the swing's
 * power, then search for the elevation that lands there. Inverse-solving the
 * trajectory analytically is not possible once Magnus is in play, and searching
 * the real simulation means a predicted shot and a played shot cannot diverge.
 */

import type { BallState } from "./ball";
import { BALL, COURT } from "./constants";
import { ACCURACY, SHOT_PROFILES, SOLVER, TIMING } from "./config";
import { gaussian, type Rng } from "./rng";
import type { Side } from "./scoring";
import {
  ARC_TO_SHOT,
  type ShotKind,
  type SwingEvent,
  type TimingGrade,
} from "./shotTypes";
import {
  horizontalDirection,
  horizontalDistance,
  predictFlight,
  spinVector,
  type FlightPrediction,
} from "./trajectory";
import { add, scale, vec, type Vec3 } from "./vec3";

const DEG = Math.PI / 180;

const lerp = (range: [number, number], t: number): number =>
  range[0] + (range[1] - range[0]) * Math.max(0, Math.min(1, t));

export type LaunchSolution = {
  vel: Vec3;
  spin: Vec3;
  angleDeg: number;
  prediction: FlightPrediction;
  /** False when no searched elevation both cleared the net and reached far enough. */
  reachedTarget: boolean;
};

/**
 * Find a launch velocity from `from` that lands on `target`.
 *
 * Sweeps elevation from flat to lofted and takes the first angle that both
 * clears the net and carries far enough, so the flattest viable ball wins. When
 * nothing qualifies the best available attempt is returned rather than null —
 * a shot that dumps into the net is a legitimate outcome of a bad swing, not an
 * error the caller should have to handle.
 */
export function solveLaunch(params: {
  from: Vec3;
  target: Vec3;
  speed: number;
  spinRate: number;
  sideSpin?: number;
}): LaunchSolution {
  const { from, target, speed, spinRate } = params;
  const direction = horizontalDirection(from, target);
  const spin = spinVector(direction, spinRate, params.sideSpin ?? 0);
  const wanted = horizontalDistance(from, target);

  const attempt = (angleDeg: number) => {
    const rad = angleDeg * DEG;
    const vel = add(
      scale(direction, speed * Math.cos(rad)),
      vec(0, speed * Math.sin(rad), 0)
    );
    const state: BallState = { pos: from, vel, spin };
    const prediction = predictFlight(state, {
      dt: SOLVER.dt,
      maxTime: SOLVER.maxFlightSeconds,
    });
    const reach = prediction.landing
      ? horizontalDistance(from, prediction.landing)
      : Number.POSITIVE_INFINITY;
    const clears = !prediction.netCrossing?.blocked;
    return { angleDeg, vel, prediction, reach, clears };
  };

  let previous = attempt(SOLVER.minAngleDeg);
  let solution = previous;
  let found = false;

  for (
    let angle = SOLVER.minAngleDeg + SOLVER.sweepStepDeg;
    angle <= SOLVER.maxAngleDeg;
    angle += SOLVER.sweepStepDeg
  ) {
    const current = attempt(angle);

    if (current.clears && current.reach >= wanted) {
      // Bisect between the last failing angle and this one for a tight fit.
      let lo = previous.angleDeg;
      let hi = current.angleDeg;
      let best = current;
      for (let i = 0; i < SOLVER.bisectionSteps; i++) {
        const mid = (lo + hi) / 2;
        const probe = attempt(mid);
        if (probe.clears && probe.reach >= wanted) {
          best = probe;
          hi = mid;
        } else {
          lo = mid;
        }
      }
      solution = best;
      found = true;
      break;
    }

    // Track the furthest net-clearing attempt as a fallback.
    if (current.clears && (!solution.clears || current.reach > solution.reach)) {
      solution = current;
    }
    previous = current;
  }

  return {
    vel: solution.vel,
    spin,
    angleDeg: solution.angleDeg,
    prediction: solution.prediction,
    reachedTarget: found,
  };
}

/** Grade a swing's timing against the moment the ball reaches the strike zone. */
export function gradeTiming(
  swingTimeMs: number,
  idealTimeMs: number,
  latencyCompensationMs = TIMING.latencyCompensationMs
): { grade: TimingGrade; quality: number; errorMs: number } {
  const corrected = swingTimeMs - latencyCompensationMs;
  const errorMs = corrected - idealTimeMs;
  const magnitude = Math.abs(errorMs);

  if (magnitude <= TIMING.perfectMs) {
    return { grade: "perfect", quality: 1, errorMs };
  }
  if (magnitude <= TIMING.goodMs) {
    const span = TIMING.goodMs - TIMING.perfectMs;
    const t = (magnitude - TIMING.perfectMs) / span;
    return { grade: "good", quality: 1 - t * 0.35, errorMs };
  }
  if (magnitude <= TIMING.weakMs) {
    const span = TIMING.weakMs - TIMING.goodMs;
    const t = (magnitude - TIMING.goodMs) / span;
    return { grade: "weak", quality: 0.65 - t * 0.55, errorMs };
  }
  return { grade: "miss", quality: 0, errorMs };
}

/**
 * Pick the shot a swing produces, letting contact height veto the arc.
 *
 * A player scooping upwards at ankle height is not hitting a smash however
 * enthusiastic the gesture was, and a ball above the shoulder cannot be rolled
 * with topspin.
 */
export function chooseShotKind(
  swing: SwingEvent,
  contactHeight: number,
  limits: { low: number; smash: number }
): ShotKind {
  const requested = ARC_TO_SHOT[swing.arc];

  if (contactHeight >= limits.smash) {
    return requested === "slice" ? "slice" : "smash";
  }
  if (contactHeight <= limits.low) {
    // Nothing but a lifted ball is available this close to the ground.
    return requested === "slice" ? "slice" : "topspin";
  }
  if (requested === "smash") {
    // Overhead gesture on a low ball becomes a lob rather than a whiff.
    return "lob";
  }
  return requested;
}

export type ShotResult = {
  vel: Vec3;
  spin: Vec3;
  kind: ShotKind;
  /** Where the shot was aimed, before physics has its say. */
  target: Vec3;
  prediction: FlightPrediction;
};

/**
 * Resolve a swing into an outgoing ball.
 *
 * Timing quality drives both pace and scatter, so mistimed shots are weak and
 * wayward rather than simply failing to register.
 */
export function resolveShot(params: {
  contact: Vec3;
  hitter: Side;
  kind: ShotKind;
  swing: SwingEvent;
  quality: number;
  rng: Rng;
}): ShotResult {
  const { contact, hitter, kind, swing, quality, rng } = params;
  const profile = SHOT_PROFILES[kind];

  const power = Math.max(0, Math.min(1, swing.power));
  const powerScale =
    ACCURACY.minPowerScale + (1 - ACCURACY.minPowerScale) * quality;

  const speed = lerp(profile.speed, power) * powerScale;
  const spinRate = lerp(profile.spin, power);

  // Aim across the opponent's half. Depth is measured from the net.
  const towards = hitter === "near" ? 1 : -1;
  const depth = lerp(profile.depth, power);
  const lateral =
    swing.lateralBias * COURT.halfSinglesWidth * ACCURACY.aimReach;

  const scatterScale = 1 - quality;
  const lateralError =
    gaussian(rng) * ACCURACY.maxLateralScatterM * scatterScale;
  const depthError = gaussian(rng) * ACCURACY.maxDepthScatterM * scatterScale;

  const target = vec(
    lateral + lateralError,
    BALL.radius,
    towards * (depth + depthError)
  );

  const solution = solveLaunch({
    from: contact,
    target,
    speed,
    spinRate,
  });

  return {
    vel: solution.vel,
    spin: solution.spin,
    kind,
    target,
    prediction: solution.prediction,
  };
}
