/**
 * Hit-stop and slow motion.
 *
 * Scales the simulation's time step, never the wall clock: the engine stays
 * deterministic and simply receives smaller deltas, so nothing downstream needs
 * to know this exists.
 */

export type TimeControl = {
  /** Multiplier to apply to this frame's delta. */
  readonly scale: number;
  /** Freeze briefly on contact; `strength` is 0..1. */
  impact: (strength: number) => void;
  /** Drop into slow motion for a moment, e.g. on a point-winning shot. */
  slowMotion: (durationMs: number, scale?: number) => void;
  update: (dtMs: number) => void;
  reset: () => void;
};

/** Hit-stop has to be short enough to read as weight, not as a stutter. */
const IMPACT_MS = 55;
const IMPACT_SCALE = 0.12;

export function createTimeControl(): TimeControl {
  let impactLeft = 0;
  let slowLeft = 0;
  let slowScale = 1;
  let scale = 1;

  return {
    get scale() {
      return scale;
    },

    impact(strength) {
      const clamped = Math.max(0, Math.min(1, strength));
      impactLeft = Math.max(impactLeft, IMPACT_MS * (0.45 + clamped * 0.55));
    },

    slowMotion(durationMs, nextScale = 0.35) {
      slowLeft = Math.max(slowLeft, durationMs);
      slowScale = nextScale;
    },

    update(dtMs) {
      // Countdowns use unscaled time, or an effect would extend itself.
      if (impactLeft > 0) impactLeft = Math.max(0, impactLeft - dtMs);
      if (slowLeft > 0) slowLeft = Math.max(0, slowLeft - dtMs);

      if (impactLeft > 0) {
        scale = IMPACT_SCALE;
        return;
      }

      if (slowLeft > 0) {
        // Ease back to full speed over the last third, so the return to normal
        // does not snap.
        const eased = Math.min(1, slowLeft / 220);
        scale = slowScale + (1 - slowScale) * (1 - eased);
        return;
      }

      scale = 1;
    },

    reset() {
      impactLeft = 0;
      slowLeft = 0;
      scale = 1;
    },
  };
}
