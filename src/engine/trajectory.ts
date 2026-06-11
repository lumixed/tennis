/**
 * Trajectory prediction shared by the shot solver, the bot and the rally engine.
 *
 * Everything here is a forward simulation of the same `stepBall` used in play,
 * so a prediction and the real thing can never drift apart.
 */

import { stepBall, type BallState } from "./ball";
import { COURT } from "./constants";
import { vec, type Vec3 } from "./vec3";

/** Net height at a given lateral offset; the cord sags towards the centre. */
export function netHeightAt(x: number): number {
  const t = Math.min(1, Math.abs(x) / COURT.netHalfWidth);
  return COURT.netHeightCentre + (COURT.netHeightPost - COURT.netHeightCentre) * t;
}

export type NetCrossing = {
  /** Ball height at the moment it crossed the net plane. */
  height: number;
  /** Lateral position at the crossing. */
  x: number;
  /** Net height at that lateral position. */
  netHeight: number;
  /** True when the ball passed below the cord. */
  blocked: boolean;
  t: number;
};

export type FlightPrediction = {
  /** Where the ball first touched down, or null if it never did. */
  landing: Vec3 | null;
  /** Ball state at first touchdown. */
  atLanding: BallState | null;
  /** Seconds until first touchdown. */
  timeToLand: number;
  /** Details of the net-plane crossing, if one happened before landing. */
  netCrossing: NetCrossing | null;
};

export type PredictOptions = {
  /** Integration step for the prediction. Coarser than play for speed. */
  dt?: number;
  maxTime?: number;
};

/**
 * Simulate forward until the ball first touches the court.
 *
 * Uses a coarser step than live physics because it runs inside search loops.
 * That makes predictions slightly approximate, which is fine and even desirable
 * for the bot — it should not have flawless foresight.
 */
export function predictFlight(
  initial: BallState,
  options: PredictOptions = {}
): FlightPrediction {
  const dt = options.dt ?? 1 / 120;
  const maxTime = options.maxTime ?? 6;

  let state = initial;
  let t = 0;
  let netCrossing: NetCrossing | null = null;

  const steps = Math.ceil(maxTime / dt);
  for (let i = 0; i < steps; i++) {
    const previous = state;
    const { state: next, bounces } = stepBall(state, dt);
    t += dt;

    // Net plane sits at z = 0; catch the step that straddles it.
    if (!netCrossing && Math.sign(previous.pos.z) !== Math.sign(next.pos.z)) {
      const span = next.pos.z - previous.pos.z;
      const frac = Math.abs(span) < 1e-9 ? 0 : -previous.pos.z / span;
      const height = previous.pos.y + (next.pos.y - previous.pos.y) * frac;
      const x = previous.pos.x + (next.pos.x - previous.pos.x) * frac;
      const netHeight = netHeightAt(x);
      netCrossing = {
        height,
        x,
        netHeight,
        blocked: height < netHeight,
        t: t - dt + dt * frac,
      };
    }

    state = next;

    if (bounces.length > 0) {
      return {
        landing: bounces[0]!.at,
        atLanding: next,
        timeToLand: t,
        netCrossing,
      };
    }
  }

  return { landing: null, atLanding: null, timeToLand: maxTime, netCrossing };
}

/** Horizontal unit vector from `from` towards `to`. */
export function horizontalDirection(from: Vec3, to: Vec3): Vec3 {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const len = Math.hypot(dx, dz);
  if (len < 1e-9) return vec(0, 0, 1);
  return vec(dx / len, 0, dz / len);
}

/** Horizontal distance between two points. */
export const horizontalDistance = (a: Vec3, b: Vec3): number =>
  Math.hypot(b.x - a.x, b.z - a.z);

/**
 * Spin vector for a shot travelling along `direction`.
 *
 * Positive `rate` is topspin, negative is slice. `sideRate` bends the ball
 * laterally. Expressed in world axes so the physics needs no special cases.
 */
export function spinVector(direction: Vec3, rate: number, sideRate = 0): Vec3 {
  // Topspin axis is up x direction.
  return vec(direction.z * rate, sideRate, -direction.x * rate);
}

/** Whether a landing point is inside the singles court on the given half. */
export function isInSinglesCourt(landing: Vec3, half: "near" | "far"): boolean {
  if (Math.abs(landing.x) > COURT.halfSinglesWidth) return false;
  if (half === "far") return landing.z > 0 && landing.z <= COURT.halfLength;
  return landing.z < 0 && landing.z >= -COURT.halfLength;
}

/**
 * Whether a serve landed in the correct service box.
 *
 * `deuce` means the box to the receiver's right, which is negative x on the far
 * side and positive x on the near side.
 */
export function isInServiceBox(
  landing: Vec3,
  half: "near" | "far",
  box: "deuce" | "ad"
): boolean {
  if (Math.abs(landing.x) > COURT.halfSinglesWidth) return false;

  if (half === "far") {
    if (landing.z <= 0 || landing.z > COURT.serviceLine) return false;
    return box === "deuce" ? landing.x < 0 : landing.x > 0;
  }

  if (landing.z >= 0 || landing.z < -COURT.serviceLine) return false;
  return box === "deuce" ? landing.x > 0 : landing.x < 0;
}
