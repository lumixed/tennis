import { describe, expect, it } from "vitest";
import {
  DEFAULT_ADAPTIVE_POWER,
  createAdaptivePower,
  observeSwing,
  powerFor,
  type AdaptivePowerState,
} from "./adaptivePower";
import { DEFAULT_SWING_CONFIG } from "./swingConfig";

const START_MIN = DEFAULT_SWING_CONFIG.powerSpeedMin;
const START_MAX = DEFAULT_SWING_CONFIG.powerSpeedMax;

/** Feed a run of swings, returning the settled state. */
function playThrough(peaks: number[]): AdaptivePowerState {
  let state = createAdaptivePower(START_MIN, START_MAX);
  for (const peak of peaks) state = observeSwing(state, peak);
  return state;
}

/** A rally's worth of swings around `typical`, with a harder one now and then. */
function swings(typical: number, count: number, hardest = typical * 1.4): number[] {
  return Array.from({ length: count }, (_, i) =>
    i % 5 === 4 ? hardest : typical + ((i % 3) - 1) * typical * 0.08
  );
}

describe("adaptive power", () => {
  it("leaves the mapping alone until it has seen enough swings", () => {
    const state = playThrough([5, 5, 5]);
    expect(state.min).toBe(START_MIN);
    expect(state.max).toBe(START_MAX);
  });

  it("rescues a player whose swings never reach the shipped curve", () => {
    // The recorded session: peaks of 4-7 against a curve built for 9.5, which
    // left every shot at 20-30% power.
    const before = powerFor(createAdaptivePower(START_MIN, START_MAX), 5);
    expect(before).toBeLessThan(0.35);

    const after = powerFor(playThrough(swings(5, 30, 7)), 5);
    expect(after).toBeGreaterThan(0.45);
  });

  it("reins in a player who swings far harder than the default", () => {
    const state = playThrough(swings(16, 30, 22));
    // A typical swing must not sit pinned at full power.
    expect(powerFor(state, 16)).toBeLessThan(0.85);
    expect(powerFor(state, 16)).toBeGreaterThan(0.25);
  });

  it("puts a typical swing mid-range and the hardest near the top", () => {
    for (const typical of [3, 5, 9, 15]) {
      const hardest = typical * 1.5;
      const state = playThrough(swings(typical, 30, hardest));

      const mid = powerFor(state, typical);
      expect(mid).toBeGreaterThan(0.3);
      expect(mid).toBeLessThan(0.8);
      expect(powerFor(state, hardest)).toBeGreaterThan(0.85);
    }
  });

  it("keeps full power reachable", () => {
    const state = playThrough(swings(6, 30, 9));
    expect(state.max).toBeGreaterThan(9);
  });

  it("moves gradually rather than lurching on one swing", () => {
    let state = createAdaptivePower(START_MIN, START_MAX);
    for (let i = 0; i < DEFAULT_ADAPTIVE_POWER.minSamples; i++) {
      state = observeSwing(state, 5);
    }
    const first = state.max;
    // One freak swing must not redefine the scale.
    const jolted = observeSwing(state, 40);
    expect(Math.abs(jolted.max - first)).toBeLessThan(Math.abs(40 - first));
  });

  it("follows a player who warms up over a session", () => {
    let state = createAdaptivePower(START_MIN, START_MAX);
    for (const peak of swings(4, 20, 5)) state = observeSwing(state, peak);
    const cold = state.max;
    for (const peak of swings(9, 40, 12)) state = observeSwing(state, peak);
    expect(state.max).toBeGreaterThan(cold);
  });

  it("ignores nonsense samples", () => {
    const state = playThrough(swings(5, 20));
    for (const bad of [0, -3, NaN, Infinity]) {
      expect(observeSwing(state, bad)).toBe(state);
    }
  });

  it("always keeps a usable span", () => {
    // Every swing identical: the range must not collapse to nothing.
    const state = playThrough(new Array(20).fill(6));
    expect(state.max - state.min).toBeGreaterThan(0.5);
    expect(powerFor(state, 6)).toBeGreaterThanOrEqual(0);
    expect(powerFor(state, 6)).toBeLessThanOrEqual(1);
  });

  it("clamps power to 0..1 for any input", () => {
    const state = playThrough(swings(6, 20));
    for (const peak of [0.01, 1, 6, 100]) {
      const power = powerFor(state, peak);
      expect(power).toBeGreaterThanOrEqual(0);
      expect(power).toBeLessThanOrEqual(1);
    }
  });

  it("is deterministic", () => {
    const peaks = swings(6, 25);
    expect(playThrough(peaks)).toEqual(playThrough(peaks));
  });
});
