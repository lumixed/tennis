/**
 * Ball flight and bounce.
 *
 * Pure and deterministic: same state in, same state out, no globals, no clock.
 * This is what makes the rally engine testable headlessly and, later, what makes
 * shot-event netplay reproducible on both peers.
 */

import {
  AIR_DENSITY,
  BALL,
  BALL_AREA,
  DRAG_COEFFICIENT,
  GRAVITY,
  SPIN_DECAY_PER_SECOND,
  SURFACE,
} from "./constants";
import { add, cross, length, scale, vec, type Vec3 } from "./vec3";

export type BallState = {
  pos: Vec3;
  vel: Vec3;
  /** Angular velocity in rad/s. +x is topspin when travelling towards +z. */
  spin: Vec3;
};

export type BounceEvent = {
  /** Where the ball met the court. */
  at: Vec3;
  /** Downward speed at the moment of impact, m/s. */
  impactSpeed: number;
};

export type StepResult = {
  state: BallState;
  bounces: BounceEvent[];
};

/** Moment of inertia of a thin spherical shell. */
const INERTIA = BALL.inertiaFactor * BALL.mass * BALL.radius * BALL.radius;

/**
 * Acceleration from gravity, drag and Magnus.
 *
 * The Magnus term uses only the component of spin perpendicular to velocity —
 * spin aligned with the direction of travel is gyroscopic and produces no force.
 * The lift coefficient follows Stepanek's spin-parameter fit rather than a
 * constant, which is what gives topspin its late dip instead of a uniform sag.
 */
export function aeroAcceleration(state: BallState): Vec3 {
  const speed = length(state.vel);
  let acc = vec(0, -GRAVITY, 0);
  if (speed < 1e-6) return acc;

  // Dynamic pressure times frontal area — the shared factor of both aero forces.
  const q = 0.5 * AIR_DENSITY * BALL_AREA * speed * speed;

  const dragMag = (q * DRAG_COEFFICIENT) / BALL.mass;
  acc = add(acc, scale(state.vel, -dragMag / speed));

  const sideways = cross(state.spin, state.vel);
  const sidewaysLen = length(sideways);
  if (sidewaysLen > 1e-9) {
    // |omega x v| / |v| is the perpendicular spin magnitude.
    const spinParam = (BALL.radius * sidewaysLen) / (speed * speed);
    const liftCoefficient = 1 / (2 + 0.98 / spinParam);
    const liftMag = (q * liftCoefficient) / BALL.mass;
    acc = add(acc, scale(sideways, liftMag / sidewaysLen));
  }

  return acc;
}

/**
 * Vertical restitution, adjusted for how much topspin the ball carries.
 *
 * See `SURFACE.spinBounceGain` for why this is not derivable from the impulse
 * alone. Only the spin component about the axis perpendicular to travel counts,
 * so sidespin and gyroscopic spin leave rebound height untouched.
 */
function effectiveRestitution(state: BallState): number {
  const { vel, spin } = state;
  const horizontalSpeed = Math.hypot(vel.x, vel.z);
  if (horizontalSpeed < 1e-6) return SURFACE.restitution;

  const dx = vel.x / horizontalSpeed;
  const dz = vel.z / horizontalSpeed;
  // Topspin axis is up x travelDirection.
  const topspinRate = spin.x * dz - spin.z * dx;

  const signedSpinParam = (topspinRate * BALL.radius) / horizontalSpeed;
  const clamped = Math.max(
    -SURFACE.spinBounceClamp,
    Math.min(SURFACE.spinBounceClamp, signedSpinParam)
  );

  return SURFACE.restitution * (1 + SURFACE.spinBounceGain * clamped);
}

/**
 * Impulse-based bounce off a flat court.
 *
 * Friction at the contact patch couples spin and horizontal velocity, so topspin
 * kicks forward and up while backspin skids low and short. That coupling is the
 * whole point — without it, spin would only matter in the air.
 */
function resolveBounce(state: BallState): BallState {
  const { vel, spin } = state;

  // Velocity of the contact patch: v + omega x (-r * up).
  const contactX = vel.x + BALL.radius * spin.z;
  const contactZ = vel.z - BALL.radius * spin.x;
  const contactSpeed = Math.hypot(contactX, contactZ);

  const restitution = effectiveRestitution(state);
  const normalImpulse = -(1 + restitution) * BALL.mass * vel.y;

  // Tangential impulse that would exactly arrest sliding.
  const stickFactor = 1 / (1 + BALL.radius * BALL.radius * (BALL.mass / INERTIA));
  const impulseToStick = stickFactor * BALL.mass * contactSpeed;
  const maxFriction = SURFACE.friction * normalImpulse;

  let tangentImpulse: Vec3;
  if (contactSpeed < 1e-9) {
    tangentImpulse = vec();
  } else {
    const magnitude = Math.min(impulseToStick, maxFriction);
    tangentImpulse = vec(
      (-contactX / contactSpeed) * magnitude,
      0,
      (-contactZ / contactSpeed) * magnitude
    );
  }

  const nextVel = vec(
    vel.x + tangentImpulse.x / BALL.mass,
    -restitution * vel.y,
    vel.z + tangentImpulse.z / BALL.mass
  );

  // Angular impulse from (-r * up) x J, which expands to (-r*Jz, 0, +r*Jx).
  // A ball sliding forwards is driven towards rolling, i.e. it gains topspin.
  const nextSpin = vec(
    spin.x - (BALL.radius * tangentImpulse.z) / INERTIA,
    spin.y,
    spin.z + (BALL.radius * tangentImpulse.x) / INERTIA
  );

  return { pos: { ...state.pos, y: BALL.radius }, vel: nextVel, spin: nextSpin };
}

/** Integrate one substep with semi-implicit Euler, ignoring the ground. */
function integrate(state: BallState, dt: number): BallState {
  const acc = aeroAcceleration(state);
  const vel = add(state.vel, scale(acc, dt));
  const pos = add(state.pos, scale(vel, dt));
  const spin = scale(state.spin, Math.max(0, 1 - SPIN_DECAY_PER_SECOND * dt));
  return { pos, vel, spin };
}

/**
 * Fraction of `dt` at which the ball centre first reaches ground contact height,
 * solved against the constant-acceleration arc rather than a straight line so
 * the bounce point stays accurate near the apex of a steep drop.
 */
function timeToContact(state: BallState, accY: number, dt: number): number {
  const y0 = state.pos.y - BALL.radius;
  const v0 = state.vel.y;

  if (Math.abs(accY) < 1e-9) {
    if (Math.abs(v0) < 1e-9) return dt;
    const t = -y0 / v0;
    return t >= 0 && t <= dt ? t : dt;
  }

  const disc = v0 * v0 - 2 * accY * y0;
  if (disc < 0) return dt;
  const root = Math.sqrt(disc);
  const t1 = (-v0 - root) / accY;
  const t2 = (-v0 + root) / accY;

  let best = dt;
  for (const t of [t1, t2]) {
    if (t >= 0 && t <= dt && t < best) best = t;
  }
  return best;
}

/**
 * Advance the ball by `dt`, resolving any court bounces encountered on the way.
 *
 * `dt` is expected to be a fixed physics step; the caller owns the accumulator.
 */
export function stepBall(state: BallState, dt: number): StepResult {
  const bounces: BounceEvent[] = [];
  let current = state;
  let remaining = dt;

  // Guard against pathological input; a real step bounces at most once.
  for (let i = 0; i < 4 && remaining > 1e-9; i++) {
    const candidate = integrate(current, remaining);
    if (candidate.pos.y > BALL.radius) {
      current = candidate;
      remaining = 0;
      break;
    }

    const accY = aeroAcceleration(current).y;
    const tHit = timeToContact(current, accY, remaining);
    const atContact = tHit > 1e-9 ? integrate(current, tHit) : current;

    bounces.push({
      at: { x: atContact.pos.x, y: BALL.radius, z: atContact.pos.z },
      impactSpeed: Math.abs(atContact.vel.y),
    });

    current = resolveBounce(atContact);
    remaining -= tHit;
  }

  return { state: current, bounces };
}

/** True once the ball has essentially stopped and the point can be closed out. */
export function isAtRest(state: BallState): boolean {
  return state.pos.y <= BALL.radius + 1e-3 && length(state.vel) < 0.35;
}
