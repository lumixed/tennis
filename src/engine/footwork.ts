/**
 * How footwork modifies a shot.
 *
 * The avatar still runs to the ball — that decision is load-bearing and is not
 * being undone here. What footwork adds is *credit for covering the court
 * yourself*: step across for a ball pulling you wide and the shot comes off
 * better; stand rooted and it comes off worse.
 *
 * Absent stance is a no-op, so keyboard play is completely unaffected.
 */

import { COURT, playerRightX } from "./constants";
import { FOOTWORK } from "./config";

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Quality adjustment for a swing, in the same 0..1 units `gradeTiming` produces.
 *
 * Returns 0 for a ball hit straight at the player: demanding a side-step for a
 * ball already within reach would punish standing in the right place.
 */
export function footworkModifier(
  stance: number | undefined,
  landingX: number | null | undefined,
  side: "near" | "far"
): number {
  if (stance === undefined || landingX === null || landingX === undefined) {
    return 0;
  }

  // `stance` is the player's own left/right; the landing is in world x. They
  // have to be brought into the same frame before they can be compared, or the
  // near player gets penalised precisely for stepping the correct way.
  const wideness = clamp(
    (landingX * playerRightX(side)) / COURT.halfSinglesWidth,
    -1,
    1
  );
  const magnitude = Math.abs(wideness);
  if (magnitude < FOOTWORK.wideThreshold) return 0;

  // How much this particular ball demands movement at all, 0..1.
  const demand = clamp(
    (magnitude - FOOTWORK.wideThreshold) / (1 - FOOTWORK.wideThreshold),
    0,
    1
  );

  // 1 = stepped fully across, 0 = rooted, -1 = moved the wrong way entirely.
  const direction = Math.sign(wideness);
  const committed = clamp(stance * direction, -1, 1);

  // Rooted already costs a little; going the wrong way costs more on top.
  const modifier =
    committed >= 0
      ? -FOOTWORK.plantedPenalty +
        committed * (FOOTWORK.bonus + FOOTWORK.plantedPenalty)
      : -FOOTWORK.plantedPenalty + committed * FOOTWORK.wrongWayPenalty;

  return demand * modifier;
}
