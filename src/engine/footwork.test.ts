import { describe, expect, it } from "vitest";
import { FOOTWORK } from "./config";
import { COURT, playerRightX } from "./constants";
import { footworkModifier } from "./footwork";

/** A world landing x at the given fraction of the singles half-width. */
const wide = (fraction: number) => fraction * COURT.halfSinglesWidth;

/** World landing x for a ball `fraction` towards the given player's right. */
const toRightOf = (side: "near" | "far", fraction: number) =>
  wide(fraction) * playerRightX(side);

describe("footworkModifier", () => {
  it("does nothing when stance is unknown", () => {
    // Keyboard and bot swings carry no stance, and must be unaffected.
    expect(footworkModifier(undefined, wide(0.9), "far")).toBe(0);
  });

  it("does nothing when the ball has no landing prediction", () => {
    expect(footworkModifier(0.8, null, "far")).toBe(0);
    expect(footworkModifier(0.8, undefined, "far")).toBe(0);
  });

  it("ignores balls hit straight at the player", () => {
    // Demanding a side-step for a ball already in reach would punish standing
    // in the right place.
    expect(footworkModifier(0, 0, "far")).toBe(0);
    expect(footworkModifier(-1, wide(0.1), "far")).toBe(0);
    expect(footworkModifier(1, wide(0.2), "near")).toBe(0);
  });

  it("rewards stepping towards a wide ball", () => {
    for (const side of ["near", "far"] as const) {
      expect(footworkModifier(1, toRightOf(side, 1), side)).toBeCloseTo(
        FOOTWORK.bonus,
        6
      );
      expect(footworkModifier(-1, toRightOf(side, -1), side)).toBeCloseTo(
        FOOTWORK.bonus,
        6
      );
    }
  });

  it("reads stance in the player's own frame, not the world's", () => {
    // Regression: stance is the player's left/right, the landing is world x,
    // and the near player faces the opposite way to the far one. Comparing them
    // raw penalised the near player for stepping the correct way.
    const nearBall = toRightOf("near", 0.9);
    const farBall = toRightOf("far", 0.9);

    // Same physical situation for both: ball to my right, I stepped right.
    expect(footworkModifier(1, nearBall, "near")).toBeGreaterThan(0);
    expect(footworkModifier(1, farBall, "far")).toBeGreaterThan(0);

    // And the two balls really are on opposite sides of the court.
    expect(Math.sign(nearBall)).toBe(-Math.sign(farBall));
  });

  it("penalises staying rooted on a wide ball", () => {
    expect(footworkModifier(0, toRightOf("near", 1), "near")).toBeCloseTo(
      -FOOTWORK.plantedPenalty,
      6
    );
  });

  it("penalises moving away from the ball hardest", () => {
    const ball = toRightOf("near", 1);
    const stepped = footworkModifier(1, ball, "near");
    const rooted = footworkModifier(0, ball, "near");
    const wrongWay = footworkModifier(-1, ball, "near");

    expect(stepped).toBeGreaterThan(rooted);
    expect(rooted).toBeGreaterThan(wrongWay);
    expect(wrongWay).toBeCloseTo(
      -FOOTWORK.plantedPenalty - FOOTWORK.wrongWayPenalty,
      6
    );
  });

  it("scales with how far the ball pulls the player", () => {
    const justWide = footworkModifier(
      1,
      toRightOf("far", FOOTWORK.wideThreshold + 0.05),
      "far"
    );
    const corner = footworkModifier(1, toRightOf("far", 1), "far");

    expect(justWide).toBeGreaterThan(0);
    expect(corner).toBeGreaterThan(justWide);
  });

  it("is symmetric across the court", () => {
    for (const stance of [-1, -0.4, 0, 0.4, 1]) {
      expect(footworkModifier(stance, wide(0.8), "far")).toBeCloseTo(
        footworkModifier(-stance, wide(-0.8), "far"),
        9
      );
    }
  });

  it("treats both halves of the court identically", () => {
    for (const stance of [-1, -0.4, 0, 0.4, 1]) {
      expect(footworkModifier(stance, toRightOf("near", 0.8), "near")).toBeCloseTo(
        footworkModifier(stance, toRightOf("far", 0.8), "far"),
        9
      );
    }
  });

  it("increases monotonically with commitment", () => {
    let previous = -Infinity;
    for (let stance = -1; stance <= 1.0001; stance += 0.1) {
      const value = footworkModifier(stance, toRightOf("far", 0.9), "far");
      expect(value).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = value;
    }
  });

  it("stays small enough not to swamp timing", () => {
    // Footwork should make a good player better, not replace the timing game.
    for (const stance of [-1, 0, 1]) {
      expect(
        Math.abs(footworkModifier(stance, toRightOf("far", 1), "far"))
      ).toBeLessThan(0.35);
    }
  });
});
