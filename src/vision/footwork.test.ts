import { describe, expect, it } from "vitest";
import {
  DEFAULT_FOOTWORK_CONFIG,
  createFootworkState,
  updateFootwork,
  type FootworkState,
} from "./footwork";

const TORSO = 0.25;
const config = DEFAULT_FOOTWORK_CONFIG;

/** Feed a series of hip positions at a fixed frame rate. */
function track(
  positions: number[],
  options: { fps?: number; startT?: number; torso?: number } = {}
): FootworkState {
  const fps = options.fps ?? 30;
  const frameMs = 1000 / fps;
  let state = createFootworkState();
  let t = options.startT ?? 1000;
  for (const x of positions) {
    state = updateFootwork(state, x, options.torso ?? TORSO, t, config);
    t += frameMs;
  }
  return state;
}

/** Hold still at `x` for `ms`, then step to `to` over `stepMs`. */
function stepSequence(x: number, to: number, ms = 600, stepMs = 260): number[] {
  const frameMs = 1000 / 30;
  const positions: number[] = [];
  for (let e = 0; e < ms; e += frameMs) positions.push(x);
  const steps = Math.ceil(stepMs / frameMs);
  for (let i = 1; i <= steps; i++) positions.push(x + (to - x) * (i / steps));
  return positions;
}

describe("stance tracking", () => {
  it("reads zero when the player has not moved", () => {
    const state = track(new Array(60).fill(0.5));
    expect(state.stance).toBeCloseTo(0, 3);
  });

  it("reads positive when the player steps to their right", () => {
    // A step of one full stanceRange in frame units.
    const to = 0.5 + config.stanceRangeTorso * TORSO;
    const state = track(stepSequence(0.5, to));
    expect(state.stance).toBeGreaterThan(0.6);
  });

  it("reads negative when the player steps the other way", () => {
    const to = 0.5 - config.stanceRangeTorso * TORSO;
    const state = track(stepSequence(0.5, to));
    expect(state.stance).toBeLessThan(-0.6);
  });

  it("stays inside -1..1 for an enormous step", () => {
    const state = track(stepSequence(0.5, 0.95));
    expect(state.stance).toBeLessThanOrEqual(1);
    expect(state.stance).toBeGreaterThanOrEqual(-1);
  });

  it("treats standing off-centre as neutral once settled", () => {
    // Regression guard on the drifting neutral: a player who simply sets up to
    // one side must not collect a free bonus for the whole match.
    const settled = track(new Array(30 * 40).fill(0.68));
    expect(Math.abs(settled.stance)).toBeLessThan(0.15);
  });

  it("still registers a step taken from an off-centre home", () => {
    const frameMs = 1000 / 30;
    let state = createFootworkState();
    let t = 1000;
    // Settle well off-centre...
    for (let i = 0; i < 30 * 30; i++) {
      state = updateFootwork(state, 0.68, TORSO, t, config);
      t += frameMs;
    }
    // ...then step further out.
    for (let i = 1; i <= 8; i++) {
      state = updateFootwork(state, 0.68 + 0.026 * i, TORSO, t, config);
      t += frameMs;
    }
    expect(state.stance).toBeGreaterThan(0.5);
  });

  it("measures the same step at different distances from the camera", () => {
    // Half the torso scale means half the pixel travel for the same real step.
    const near = track(stepSequence(0.5, 0.5 + config.stanceRangeTorso * TORSO), {
      torso: TORSO,
    });
    const far = track(
      stepSequence(0.5, 0.5 + config.stanceRangeTorso * TORSO * 0.5),
      { torso: TORSO * 0.5 }
    );

    expect(near.stance).toBeCloseTo(far.stance, 2);
  });

  it("measures the same step at 30 and 60 fps", () => {
    const to = 0.5 + config.stanceRangeTorso * TORSO;
    const at30 = track(stepSequence(0.5, to), { fps: 30 });

    // Same movement, same wall-clock duration, twice the samples.
    const frameMs = 1000 / 60;
    const positions: number[] = [];
    for (let e = 0; e < 600; e += frameMs) positions.push(0.5);
    const steps = Math.ceil(260 / frameMs);
    for (let i = 1; i <= steps; i++) positions.push(0.5 + (to - 0.5) * (i / steps));
    const at60 = track(positions, { fps: 60 });

    expect(at60.stance).toBeCloseTo(at30.stance, 1);
  });

  it("reports lateral speed in torso-lengths per second", () => {
    const state = track(stepSequence(0.5, 0.5 + TORSO, 300, 200));
    expect(state.speed).toBeGreaterThan(0);
    expect(Number.isFinite(state.speed)).toBe(true);
  });

  it("ignores a collapsed torso rather than dividing by it", () => {
    const state = updateFootwork(createFootworkState(), 0.5, 0, 1000, config);
    expect(state.stance).toBe(0);
    expect(Number.isFinite(state.stance)).toBe(true);
  });
});
