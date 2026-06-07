/**
 * The computer opponent.
 *
 * The bot has no privileged access to the simulation: it reads the same strike
 * window the human's HUD reads, and answers with the same `SwingEvent` a camera
 * would produce. Difficulty is therefore a matter of *how well it swings*, never
 * of extra powers, which keeps it honest and keeps the engine free of branches.
 */

import { RALLY } from "./config";
import { COURT, playerRightX } from "./constants";
import { gaussian, next, type Rng } from "./rng";
import type { Side } from "./scoring";
import type { RallyState } from "./rally";
import type { SwingArc, SwingEvent } from "./shotTypes";

export type BotDifficulty = {
  name: string;
  /**
   * How long after the ball is struck before the bot can commit to a reply.
   * A ball that arrives sooner than this leaves it genuinely late.
   */
  reactionMs: number;
  /** Standard deviation of its timing error, in ms. */
  timingJitterMs: number;
  /** 0..1. Drives shot selection, pace and how close to the lines it aims. */
  aggression: number;
  /** Typical swing power, 0..1. */
  basePower: number;
  /**
   * 0..1 resistance to being pulled wide. At 1 a corner is no harder than a ball
   * hit straight at it; at 0 the stretch roughly doubles its timing error.
   */
  coverage: number;
  /**
   * Shot-making skill, fed into `RallyState.precision`. Above 1 is tighter than
   * the human baseline.
   *
   * Deliberately separate from `basePower`: power costs accuracy, so a
   * hard-hitting bot with no matching skill is just a wild one. Without this
   * axis the Pro preset lost to Club purely for swinging harder.
   */
  precision: number;
};

export const DIFFICULTIES: Record<string, BotDifficulty> = {
  rookie: {
    name: "Rookie",
    reactionMs: 430,
    timingJitterMs: 135,
    aggression: 0.15,
    basePower: 0.45,
    coverage: 0.25,
    precision: 0.55,
  },
  club: {
    name: "Club",
    reactionMs: 270,
    timingJitterMs: 72,
    aggression: 0.45,
    basePower: 0.62,
    coverage: 0.55,
    precision: 0.85,
  },
  pro: {
    name: "Pro",
    reactionMs: 150,
    timingJitterMs: 30,
    aggression: 0.78,
    basePower: 0.82,
    coverage: 0.88,
    /**
     * High precision only works paired with high aggression. Swept across
     * precision 1.15-1.6 against aggression 0.45-0.78: an accurate *and* patient
     * Pro plays endless rallies (84% of points ran past the cap at 1.45/0.45),
     * because it can neither miss nor be beaten. Going for the lines is what
     * finishes points, so the two knobs have to move together.
     */
    precision: 1.45,
  },
};

export type BotState = {
  difficulty: BotDifficulty;
  side: Side;
  rng: Rng;
  /** Identifies the situation the current plan was made for. */
  plannedKey: string | null;
  /** Engine time at which the planned swing fires. */
  swingAt: number | null;
  plan: SwingEvent | null;
  /** Where the opponent was last pulled to, used to hit behind them. */
  lastOpponentLandingX: number;
};

export function createBot(
  difficulty: BotDifficulty,
  side: Side,
  rng: Rng
): BotState {
  return {
    difficulty,
    side,
    rng,
    plannedKey: null,
    swingAt: null,
    plan: null,
    lastOpponentLandingX: 0,
  };
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Pause before serving, so points do not begin the instant the last one ends. */
const SERVE_DELAY_MS = 900;

function chooseArc(
  contactHeight: number,
  stretched: number,
  difficulty: BotDifficulty,
  rng: Rng
): SwingArc {
  if (contactHeight >= RALLY.smashContactHeight) return "overhead";

  // Under real pressure, get the ball back rather than going for a winner.
  if (stretched > 0.75 && next(rng) > difficulty.coverage) return "high-to-low";
  if (contactHeight <= RALLY.lowContactHeight) {
    return next(rng) < 0.5 ? "high-to-low" : "low-to-high";
  }

  return next(rng) < difficulty.aggression ? "flat" : "low-to-high";
}

/**
 * Decide when and how the bot will play the incoming ball.
 *
 * Timing error grows with how far the bot has been pulled off centre, which is
 * what makes the human's placement worth anything. Reaction delay is applied as
 * a floor on when the bot can act, so a genuinely quick ball beats it outright
 * rather than being magically returned.
 */
function planSwing(bot: BotState, rally: RallyState): BotState {
  const strike = rally.strike;
  if (!strike) return bot;

  const { difficulty, rng } = bot;
  const landing = strike.landing;

  // How far off centre this ball drags the bot, 0..1.
  const stretched = landing
    ? clamp(Math.abs(landing.x) / COURT.halfSinglesWidth, 0, 1)
    : 0;
  const stretchPenalty = 1 + stretched * 2 * (1 - difficulty.coverage);

  const jitter = gaussian(rng) * difficulty.timingJitterMs * stretchPenalty;

  // The bot cannot commit before it has reacted; a ball arriving inside that
  // window makes it late by the shortfall.
  const earliest = rally.timeMs + difficulty.reactionMs;
  const lateness = Math.max(0, earliest - strike.idealTimeMs);

  const swingAt = strike.idealTimeMs + jitter + lateness;

  const arc = chooseArc(strike.contact.y, stretched, difficulty, rng);

  // Aim away from where the opponent was last sent. That reasoning is in world
  // coordinates, but `lateralBias` is expressed from the hitter's own point of
  // view, so it has to be converted — otherwise the bot diligently hits every
  // ball straight back to where its opponent is already standing.
  const awayWorldX = bot.lastOpponentLandingX >= 0 ? -1 : 1;
  const intent =
    awayWorldX * playerRightX(bot.side) * (0.35 + difficulty.aggression * 0.55);
  const spray = gaussian(rng) * (0.35 * (1 - difficulty.aggression) + 0.12);
  const lateralBias = clamp(
    intent * (1 - stretched * 0.6) + spray,
    -1,
    1
  );

  const power = clamp(
    difficulty.basePower +
      (arc === "flat" ? 0.12 : 0) -
      stretched * 0.28 * (1 - difficulty.coverage) +
      gaussian(rng) * 0.06,
    0.1,
    1
  );

  return {
    ...bot,
    plannedKey: `${rally.phase}:${rally.hitCount}`,
    swingAt,
    plan: { t: swingAt, arc, power, lateralBias, side: "forehand" },
  };
}

function planServe(bot: BotState, rally: RallyState): BotState {
  const { difficulty, rng } = bot;
  const power = clamp(
    0.45 + difficulty.aggression * 0.45 + gaussian(rng) * 0.09,
    0.15,
    1
  );

  const swingAt = rally.timeMs + SERVE_DELAY_MS;
  return {
    ...bot,
    plannedKey: `${rally.phase}:${rally.hitCount}`,
    swingAt,
    plan: {
      t: swingAt,
      arc: "overhead",
      power,
      lateralBias: gaussian(rng) * 0.4,
      side: "forehand",
    },
  };
}

/**
 * Advance the bot one frame.
 *
 * Returns a swing on the frame its plan comes due; the caller feeds that into
 * `applySwing` exactly as it would a swing from the camera.
 */
export function updateBot(
  bot: BotState,
  rally: RallyState
): { bot: BotState; swing: SwingEvent | null } {
  let current = bot;

  // Track where the opponent is being pulled, for placement.
  if (rally.strike && rally.strike.striker !== bot.side && rally.strike.landing) {
    current = { ...current, lastOpponentLandingX: rally.strike.landing.x };
  }

  if (rally.phase === "point-over") {
    return {
      bot: { ...current, plannedKey: null, swingAt: null, plan: null },
      swing: null,
    };
  }

  const key = `${rally.phase}:${rally.hitCount}`;

  if (rally.phase === "awaiting-serve") {
    if (rally.match.server !== bot.side) {
      return { bot: { ...current, plannedKey: null, plan: null }, swing: null };
    }
    // Plan whenever there is no plan, rather than keying off the situation.
    // A fault or a let rewinds to a *fresh* awaiting-serve with hitCount still
    // 0, so a situation key cannot tell the replay apart from the serve that
    // was already struck — and the bot would stand there forever.
    if (!current.plan) current = planServe(current, rally);
  } else if (rally.strike?.striker === bot.side) {
    // One swing per incoming ball: if the bot whiffs, it does not get to flail
    // again, and the hitCount key is what enforces that.
    if (current.plannedKey !== key) current = planSwing(current, rally);
  } else {
    return { bot: current, swing: null };
  }

  if (
    current.plan &&
    current.swingAt !== null &&
    rally.timeMs >= current.swingAt
  ) {
    const swing = { ...current.plan, t: rally.timeMs };
    return {
      bot: { ...current, plan: null, swingAt: null },
      swing,
    };
  }

  return { bot: current, swing: null };
}
