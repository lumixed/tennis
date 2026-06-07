/**
 * Real-world constants. Everything is SI (metres, seconds, kilograms, radians).
 *
 * Coordinate system:
 *   +x  across the court (right, from the near player's view)
 *   +y  up
 *   +z  down the court, away from the near player
 *   origin sits on the ground at the centre of the net
 *
 * So the near (human) player defends negative z, the far (bot) player positive z.
 */

// ---------------------------------------------------------------------------
// Court — regulation ITF dimensions
// ---------------------------------------------------------------------------

export const COURT = {
  /** Baseline to baseline, 78 ft. */
  length: 23.77,
  halfLength: 23.77 / 2,
  /** Singles sidelines, 27 ft. */
  singlesWidth: 8.23,
  halfSinglesWidth: 8.23 / 2,
  /** Doubles sidelines, 36 ft. Rendered, but play is singles. */
  doublesWidth: 10.97,
  halfDoublesWidth: 10.97 / 2,
  /** Service line distance from the net. */
  serviceLine: 6.4,
  netHeightCentre: 0.914,
  netHeightPost: 1.07,
  /** Net posts sit outside the doubles sideline. */
  netHalfWidth: 10.97 / 2 + 0.914,
} as const;

// ---------------------------------------------------------------------------
// Ball — ITF spec
// ---------------------------------------------------------------------------

export const BALL = {
  mass: 0.057,
  radius: 0.0335,
  /**
   * Hollow ball, so the thin-shell moment of inertia (2/3 m r^2) is correct.
   * Using the solid-sphere 2/5 here would make bounces under-rotate.
   */
  inertiaFactor: 2 / 3,
} as const;

export const BALL_AREA = Math.PI * BALL.radius * BALL.radius;

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

export const GRAVITY = 9.81;
export const AIR_DENSITY = 1.21;

/** Tennis balls are fuzzy, so drag runs well above a smooth sphere's ~0.47. */
export const DRAG_COEFFICIENT = 0.55;

/**
 * Spin bleeds off in flight. Small over a ~1 s stroke, but it stops multi-bounce
 * rallies from accumulating unphysical spin.
 */
export const SPIN_DECAY_PER_SECOND = 0.12;

// ---------------------------------------------------------------------------
// Surface — hard court
// ---------------------------------------------------------------------------

export const SURFACE = {
  /** Normal coefficient of restitution for a spin-free ball. */
  restitution: 0.75,
  /** Coulomb friction between ball and court. */
  friction: 0.6,
  /**
   * How strongly topspin raises (and backspin flattens) the rebound.
   *
   * A rigid-body impulse leaves vertical rebound independent of spin, which is
   * wrong: real balls deform against the court, and the friction couple during
   * that contact lifts a topspin ball and kills a sliced one. This is the
   * empirical stand-in for that deformation. Tuned so heavy topspin kicks up
   * noticeably without turning the ball into a beach ball.
   */
  spinBounceGain: 0.2,
  /** Ceiling on the signed spin parameter feeding `spinBounceGain`. */
  spinBounceClamp: 0.8,
} as const;

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

/** Fixed physics timestep, decoupled from render rate. */
export const PHYSICS_HZ = 240;
export const PHYSICS_DT = 1 / PHYSICS_HZ;

/** Below this speed after a bounce the ball is treated as dead. */
export const REST_SPEED = 0.35;
