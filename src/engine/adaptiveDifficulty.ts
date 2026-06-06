/**
 * A bot that meets the player where they are.
 *
 * Three fixed presets leave gaps, and there is no reason the right rung should
 * happen to exist: a recorded player was shut out 0-6 by Club and then beat
 * Rookie 3-1. Neither match was a contest. This slides continuously along the
 * same axes instead, so the answer does not have to be one of three.
 *
 * Pure, so convergence can be measured against simulated opponents rather than
 * assumed.
 */

import type { BotDifficulty } from "./bot";
import { DIFFICULTIES } from "./bot";

export type AdaptiveConfig = {
  /**
   * Share of points the bot should win. Slightly under half: a player who edges
   * it is having a better time than one grinding out an exact draw.
   */
  targetWinRate: number;
  /** How far the level moves per point. */
  step: number;
  /** Points to play before adapting, so a fluke start does not set the tone. */
  settlePoints: number;
  /** Bounds on the level, 0 being the softest preset and 1 the hardest. */
  minLevel: number;
  maxLevel: number;
};

export const DEFAULT_ADAPTIVE_CONFIG: AdaptiveConfig = {
  targetWinRate: 0.46,
  step: 0.035,
  settlePoints: 4,
  minLevel: 0,
  maxLevel: 1,
};

export type AdaptiveState = {
  /** Current difficulty, 0..1. */
  level: number;
  /** Points resolved so far. */
  points: number;
  /** Points the bot has won. */
  botWins: number;
};

export function createAdaptiveState(level = 0.35): AdaptiveState {
  return { level, points: 0, botWins: 0 };
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Fold in one point's result.
 *
 * A staircase rather than a running average: step down when the bot wins, up
 * when it loses, with the step sizes split around the target. It converges on
 * the target rate without needing a window, and it keeps moving when the player
 * improves mid-session.
 */
export function observePoint(
  state: AdaptiveState,
  botWon: boolean,
  config: AdaptiveConfig = DEFAULT_ADAPTIVE_CONFIG
): AdaptiveState {
  const points = state.points + 1;
  const botWins = state.botWins + (botWon ? 1 : 0);

  if (points <= config.settlePoints) {
    return { ...state, points, botWins };
  }

  // Split the step around the target so the fixed point lands there: winning
  // costs the bot `target` and losing gains it `1 - target`.
  const delta = botWon
    ? -config.step * config.targetWinRate
    : config.step * (1 - config.targetWinRate);

  return {
    level: clamp(state.level + delta, config.minLevel, config.maxLevel),
    points,
    botWins,
  };
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function blend(a: BotDifficulty, b: BotDifficulty, t: number): BotDifficulty {
  return {
    name: `${Math.round(t * 100)}%`,
    reactionMs: lerp(a.reactionMs, b.reactionMs, t),
    timingJitterMs: lerp(a.timingJitterMs, b.timingJitterMs, t),
    aggression: lerp(a.aggression, b.aggression, t),
    basePower: lerp(a.basePower, b.basePower, t),
    coverage: lerp(a.coverage, b.coverage, t),
    precision: lerp(a.precision, b.precision, t),
  };
}

/**
 * The difficulty for a given level.
 *
 * Interpolates through the same three presets rather than inventing a new
 * curve, so the tuning that made Pro's precision and aggression move together
 * still holds everywhere in between.
 */
export function difficultyAt(level: number): BotDifficulty {
  const t = clamp(level, 0, 1);
  const rookie = DIFFICULTIES.rookie!;
  const club = DIFFICULTIES.club!;
  const pro = DIFFICULTIES.pro!;

  return t <= 0.5
    ? blend(rookie, club, t / 0.5)
    : blend(club, pro, (t - 0.5) / 0.5);
}

/** A short human-readable label, for the HUD. */
export function describeLevel(level: number): string {
  const t = clamp(level, 0, 1);
  if (t < 0.18) return "Gentle";
  if (t < 0.38) return "Easy";
  if (t < 0.62) return "Even";
  if (t < 0.82) return "Testing";
  return "Brutal";
}
