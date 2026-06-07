/**
 * Lateral stance tracking.
 *
 * Distinct from the torso lean that drives aim: this reads the hips actually
 * *translating* across the frame, i.e. the player taking a step. Lean is a
 * shoulder rotation you can do standing still; a step is work.
 *
 * Pure, like the swing detector, so it can be tested against synthetic movement.
 */

export type FootworkConfig = {
  /** Sideways travel, in torso lengths, that counts as a full step. */
  stanceRangeTorso: number;
  /**
   * How fast the neutral centre drifts towards where the player is standing.
   *
   * Long on purpose. Without drift, a player who sets up slightly off-centre
   * reads as permanently mid-step and collects a free bonus all match; too
   * short and a genuine step is absorbed into "home" before they swing.
   */
  neutralTauMs: number;
};

export const DEFAULT_FOOTWORK_CONFIG: FootworkConfig = {
  stanceRangeTorso: 0.85,
  neutralTauMs: 5000,
};

export type FootworkState = {
  /** The player's slowly-adapting home position, in frame units. */
  neutralX: number | null;
  /** Where they are standing now, -1 (their left) .. 1 (their right). */
  stance: number;
  /** Lateral speed in torso-lengths per second. */
  speed: number;
  lastX: number | null;
  lastT: number | null;
};

export function createFootworkState(): FootworkState {
  return { neutralX: null, stance: 0, speed: 0, lastX: null, lastT: null };
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Fold in one frame's hip position.
 *
 * `hipMidX` and `torsoScale` are both in frame units, so their ratio is in
 * torso lengths and the result survives the player standing at any distance.
 */
export function updateFootwork(
  state: FootworkState,
  hipMidX: number,
  torsoScale: number,
  t: number,
  config: FootworkConfig = DEFAULT_FOOTWORK_CONFIG
): FootworkState {
  if (torsoScale < 1e-4) return state;

  if (state.neutralX === null || state.lastT === null) {
    return {
      neutralX: hipMidX,
      stance: 0,
      speed: 0,
      lastX: hipMidX,
      lastT: t,
    };
  }

  const dtMs = Math.max(0, t - state.lastT);
  const dt = dtMs / 1000;

  const speed =
    dt > 1e-4 && state.lastX !== null
      ? Math.abs(hipMidX - state.lastX) / torsoScale / dt
      : state.speed;

  // Time-based drift, for the same frame-rate reasons the swing filters use.
  const alpha =
    config.neutralTauMs <= 0 ? 1 : 1 - Math.exp(-dtMs / config.neutralTauMs);
  const neutralX = state.neutralX + (hipMidX - state.neutralX) * alpha;

  const offset = (hipMidX - neutralX) / torsoScale;
  const stance = clamp(offset / config.stanceRangeTorso, -1, 1);

  return { neutralX, stance, speed, lastX: hipMidX, lastT: t };
}
