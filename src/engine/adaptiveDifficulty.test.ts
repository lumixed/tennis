import { describe, expect, it } from "vitest";
import {
  DEFAULT_ADAPTIVE_CONFIG,
  createAdaptiveState,
  describeLevel,
  difficultyAt,
  observePoint,
  type AdaptiveState,
} from "./adaptiveDifficulty";
import { DIFFICULTIES } from "./bot";
import { createRng, next } from "./rng";

/**
 * A stand-in opponent of fixed strength.
 *
 * The bot's chance of taking a point rises as its level passes the player's,
 * which is the only property the controller actually depends on.
 */
const botWinChance = (level: number, playerSkill: number): number =>
  Math.max(0.05, Math.min(0.95, 0.5 + (level - playerSkill) * 1.6));

/** Play `points` against a player of the given skill and return the arc. */
function simulate(playerSkill: number, points = 500, seed = 5) {
  const rng = createRng(seed);
  let state = createAdaptiveState();
  const levels: number[] = [];
  let wins = 0;

  for (let i = 0; i < points; i++) {
    const botWon = next(rng) < botWinChance(state.level, playerSkill);
    if (botWon) wins++;
    state = observePoint(state, botWon);
    levels.push(state.level);
  }

  // Measure the settled half, not the approach.
  const tail = levels.slice(Math.floor(points / 2));
  return {
    state,
    settledLevel: tail.reduce((a, b) => a + b, 0) / tail.length,
    overallWinRate: wins / points,
  };
}

describe("adaptive difficulty", () => {
  it("holds still while it settles", () => {
    let state = createAdaptiveState(0.4);
    for (let i = 0; i < DEFAULT_ADAPTIVE_CONFIG.settlePoints; i++) {
      state = observePoint(state, true);
    }
    expect(state.level).toBe(0.4);
    expect(state.points).toBe(DEFAULT_ADAPTIVE_CONFIG.settlePoints);
  });

  it("eases off against a player it is beating", () => {
    let state = createAdaptiveState(0.8);
    for (let i = 0; i < 60; i++) state = observePoint(state, true);
    expect(state.level).toBeLessThan(0.8);
  });

  it("pushes harder against a player beating it", () => {
    let state = createAdaptiveState(0.2);
    for (let i = 0; i < 60; i++) state = observePoint(state, false);
    expect(state.level).toBeGreaterThan(0.2);
  });

  it("finds the level of whoever it is playing", () => {
    // The exact case from the recordings: one player crushed by Club and
    // comfortable against Rookie should end up somewhere between the two.
    for (const skill of [0.15, 0.35, 0.55, 0.8]) {
      const { settledLevel } = simulate(skill);
      expect(Math.abs(settledLevel - skill)).toBeLessThan(0.15);
    }
  });

  it("lands near the target win rate rather than a rout", () => {
    for (const skill of [0.2, 0.5, 0.75]) {
      const { overallWinRate } = simulate(skill);
      expect(overallWinRate).toBeGreaterThan(0.3);
      expect(overallWinRate).toBeLessThan(0.62);
    }
  });

  it("follows a player who improves mid-session", () => {
    const rng = createRng(11);
    let state = createAdaptiveState();
    for (let i = 0; i < 200; i++) {
      state = observePoint(state, next(rng) < botWinChance(state.level, 0.2));
    }
    const early = state.level;

    for (let i = 0; i < 300; i++) {
      state = observePoint(state, next(rng) < botWinChance(state.level, 0.75));
    }
    expect(state.level).toBeGreaterThan(early + 0.2);
  });

  it("stays inside its bounds even against a hopeless or unbeatable player", () => {
    let low: AdaptiveState = createAdaptiveState();
    let high: AdaptiveState = createAdaptiveState();
    for (let i = 0; i < 400; i++) {
      low = observePoint(low, true);
      high = observePoint(high, false);
    }
    expect(low.level).toBe(DEFAULT_ADAPTIVE_CONFIG.minLevel);
    expect(high.level).toBe(DEFAULT_ADAPTIVE_CONFIG.maxLevel);
  });

  it("is deterministic", () => {
    expect(simulate(0.4).settledLevel).toBe(simulate(0.4).settledLevel);
  });
});

describe("difficultyAt", () => {
  it("matches the presets at their anchors", () => {
    expect(difficultyAt(0).reactionMs).toBeCloseTo(
      DIFFICULTIES.rookie!.reactionMs,
      6
    );
    expect(difficultyAt(0.5).reactionMs).toBeCloseTo(
      DIFFICULTIES.club!.reactionMs,
      6
    );
    expect(difficultyAt(1).reactionMs).toBeCloseTo(DIFFICULTIES.pro!.reactionMs, 6);
  });

  it("moves every axis monotonically with level", () => {
    let previous = difficultyAt(0);
    for (let level = 0.05; level <= 1.0001; level += 0.05) {
      const current = difficultyAt(level);
      // Sharper: faster reaction, less jitter, more of everything else.
      expect(current.reactionMs).toBeLessThanOrEqual(previous.reactionMs + 1e-9);
      expect(current.timingJitterMs).toBeLessThanOrEqual(
        previous.timingJitterMs + 1e-9
      );
      expect(current.aggression).toBeGreaterThanOrEqual(previous.aggression - 1e-9);
      expect(current.precision).toBeGreaterThanOrEqual(previous.precision - 1e-9);
      expect(current.coverage).toBeGreaterThanOrEqual(previous.coverage - 1e-9);
      previous = current;
    }
  });

  it("keeps precision and aggression moving together", () => {
    // The Pro tuning depends on this: an accurate but patient bot never ends
    // points, and a wild aggressive one loses to a weaker opponent.
    const soft = difficultyAt(0.2);
    const hard = difficultyAt(0.9);
    expect(hard.precision).toBeGreaterThan(soft.precision);
    expect(hard.aggression).toBeGreaterThan(soft.aggression);
  });

  it("clamps out-of-range levels", () => {
    expect(difficultyAt(-1)).toEqual(difficultyAt(0));
    expect(difficultyAt(9)).toEqual(difficultyAt(1));
  });
});

describe("describeLevel", () => {
  it("gives a label across the range", () => {
    const labels = [0, 0.25, 0.5, 0.7, 0.95].map(describeLevel);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
