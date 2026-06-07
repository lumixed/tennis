import { describe, expect, it } from "vitest";
import { BALL, COURT, playerRightX } from "./constants";
import { RALLY, TIMING } from "./config";
import { chooseShotKind, gradeTiming, resolveShot, solveLaunch } from "./shot";
import { createRng } from "./rng";
import type { SwingEvent } from "./shotTypes";
import { horizontalDistance, isInSinglesCourt } from "./trajectory";
import { vec } from "./vec3";

const HEIGHT_LIMITS = {
  low: RALLY.lowContactHeight,
  smash: RALLY.smashContactHeight,
};

const swing = (over: Partial<SwingEvent> = {}): SwingEvent => ({
  t: 0,
  arc: "low-to-high",
  power: 0.7,
  lateralBias: 0,
  side: "forehand",
  ...over,
});

describe("solveLaunch", () => {
  const from = vec(0, 1.0, -12.5);

  it("lands on the requested target", () => {
    const cases = [
      { z: 8, speed: 20, spin: 300 },
      { z: 10, speed: 30, spin: 420 },
      { z: 10, speed: 30, spin: 80 },
      { z: 7, speed: 18, spin: -250 },
      { z: 11, speed: 24, spin: 200 },
    ];

    for (const { z, speed, spin } of cases) {
      const target = vec(0, BALL.radius, z);
      const solution = solveLaunch({ from, target, speed, spinRate: spin });

      expect(solution.reachedTarget).toBe(true);
      expect(solution.prediction.landing).not.toBeNull();
      const error =
        horizontalDistance(from, solution.prediction.landing!) -
        horizontalDistance(from, target);
      expect(Math.abs(error)).toBeLessThan(0.35);
    }
  });

  it("clears the net", () => {
    const solution = solveLaunch({
      from,
      target: vec(0, BALL.radius, 9),
      speed: 28,
      spinRate: 350,
    });
    const crossing = solution.prediction.netCrossing;
    expect(crossing).not.toBeNull();
    expect(crossing!.blocked).toBe(false);
    expect(crossing!.height).toBeGreaterThan(COURT.netHeightCentre);
  });

  it("aims across the court, not just down the middle", () => {
    const solution = solveLaunch({
      from: vec(-3, 1.0, -12.5),
      target: vec(3.2, BALL.radius, 9),
      speed: 28,
      spinRate: 380,
    });

    expect(solution.reachedTarget).toBe(true);
    expect(solution.prediction.landing!.x).toBeCloseTo(3.2, 1);
    expect(solution.prediction.landing!.z).toBeCloseTo(9, 1);
  });

  it("needs more elevation for topspin than for a flat drive", () => {
    const target = vec(0, BALL.radius, 9);
    const flat = solveLaunch({ from, target, speed: 28, spinRate: 60 });
    const heavy = solveLaunch({ from, target, speed: 28, spinRate: 450 });

    expect(heavy.angleDeg).toBeGreaterThan(flat.angleDeg);
  });

  it("still returns a usable attempt when the target is out of reach", () => {
    // Far too slow to carry the length of the court.
    const solution = solveLaunch({
      from,
      target: vec(0, BALL.radius, 11),
      speed: 8,
      spinRate: 0,
    });

    expect(solution.reachedTarget).toBe(false);
    expect(Number.isFinite(solution.vel.y)).toBe(true);
    expect(solution.prediction.landing).not.toBeNull();
  });

  it("cannot clear the cord when there is not enough pace to rise over it", () => {
    // Note this is the only way the solver itself fails on the net: it is free
    // to steepen the angle, so a low contact alone is not disqualifying. What
    // stops a player driving flat off their shoelaces is `chooseShotKind`,
    // which withholds the shot, not the launch search.
    const solution = solveLaunch({
      from: vec(0, 0.1, -0.4),
      target: vec(0, BALL.radius, 9),
      speed: 3,
      spinRate: 0,
    });

    expect(solution.reachedTarget).toBe(false);
    expect(solution.prediction.netCrossing?.blocked ?? true).toBe(true);
  });
});

describe("gradeTiming", () => {
  const latency = 0;

  it("grades a dead-on swing as perfect", () => {
    const result = gradeTiming(1000, 1000, latency);
    expect(result.grade).toBe("perfect");
    expect(result.quality).toBe(1);
  });

  it("widens through good and weak before missing", () => {
    expect(gradeTiming(1000 + 100, 1000, latency).grade).toBe("good");
    expect(gradeTiming(1000 + 220, 1000, latency).grade).toBe("weak");
    expect(gradeTiming(1000 + 400, 1000, latency).grade).toBe("miss");
  });

  it("is symmetric about the ideal moment", () => {
    const early = gradeTiming(1000 - 220, 1000, latency);
    const late = gradeTiming(1000 + 220, 1000, latency);
    expect(early.grade).toBe(late.grade);
    expect(early.quality).toBeCloseTo(late.quality, 9);
  });

  it("degrades quality monotonically with error", () => {
    let previous = 1.1;
    for (let error = 0; error <= TIMING.weakMs; error += 10) {
      const { quality } = gradeTiming(1000 + error, 1000, latency);
      expect(quality).toBeLessThanOrEqual(previous + 1e-9);
      previous = quality;
    }
  });

  it("credits a late swing as on-time once latency is compensated", () => {
    // The player swung on the ball; the pipeline reported it 90 ms afterwards.
    const reported = 1000 + 90;
    expect(gradeTiming(reported, 1000, 90).grade).toBe("perfect");
    expect(gradeTiming(reported, 1000, 0).grade).toBe("good");
  });
});

describe("chooseShotKind", () => {
  it("follows the swing arc at a normal contact height", () => {
    expect(chooseShotKind(swing({ arc: "low-to-high" }), 1.0, HEIGHT_LIMITS)).toBe(
      "topspin"
    );
    expect(chooseShotKind(swing({ arc: "flat" }), 1.0, HEIGHT_LIMITS)).toBe(
      "drive"
    );
    expect(chooseShotKind(swing({ arc: "high-to-low" }), 1.0, HEIGHT_LIMITS)).toBe(
      "slice"
    );
  });

  it("turns a high ball into a smash", () => {
    expect(chooseShotKind(swing({ arc: "flat" }), 2.2, HEIGHT_LIMITS)).toBe(
      "smash"
    );
  });

  it("refuses to smash off the floor, offering a lob instead", () => {
    expect(chooseShotKind(swing({ arc: "overhead" }), 0.9, HEIGHT_LIMITS)).toBe(
      "lob"
    );
  });

  it("forces a lifted ball when contact is very low", () => {
    expect(chooseShotKind(swing({ arc: "flat" }), 0.3, HEIGHT_LIMITS)).toBe(
      "topspin"
    );
    // Slice off a low ball is legitimate.
    expect(chooseShotKind(swing({ arc: "high-to-low" }), 0.3, HEIGHT_LIMITS)).toBe(
      "slice"
    );
  });
});

describe("resolveShot", () => {
  const contact = vec(0, 1.0, -12.5);

  it("puts a well-timed topspin ball in the court", () => {
    const result = resolveShot({
      contact,
      hitter: "near",
      kind: "topspin",
      swing: swing({ power: 0.7 }),
      quality: 1,
      rng: createRng(7),
    });

    expect(result.prediction.landing).not.toBeNull();
    expect(isInSinglesCourt(result.prediction.landing!, "far")).toBe(true);
    expect(result.prediction.netCrossing?.blocked).toBe(false);
  });

  it("is deterministic for a given seed", () => {
    const shoot = () =>
      resolveShot({
        contact,
        hitter: "near",
        kind: "topspin",
        swing: swing({ power: 0.6 }),
        quality: 0.4,
        rng: createRng(99),
      });

    expect(shoot().vel).toEqual(shoot().vel);
    expect(shoot().target).toEqual(shoot().target);
  });

  it("aims where the player leans", () => {
    // Averaged over many shots: base dispersion has a standard deviation
    // comparable to the aim offset itself, so a single sample proves nothing.
    const meanTargetX = (lateralBias: number) => {
      const rng = createRng(3);
      let total = 0;
      const n = 80;
      for (let i = 0; i < n; i++) {
        total += resolveShot({
          contact,
          hitter: "near",
          kind: "topspin",
          swing: swing({ lateralBias }),
          quality: 1,
          rng,
        }).target.x;
      }
      return total / n;
    };

    // Asserted in the hitter's own frame. The near player faces +z, so their
    // right is world -x; comparing raw world coordinates here would have hidden
    // the fact that "aim right" was sending the ball left on screen.
    const right = playerRightX("near");
    expect(meanTargetX(-0.9) * right).toBeLessThan(-2);
    expect(meanTargetX(0.9) * right).toBeGreaterThan(2);
  });

  it("sends a leaning shot to the correct side of the court", () => {
    const rng = createRng(3);
    const leanLeft = resolveShot({
      contact,
      hitter: "near",
      kind: "topspin",
      swing: swing({ lateralBias: -0.9 }),
      quality: 1,
      rng,
    });
    const leanRight = resolveShot({
      contact,
      hitter: "near",
      kind: "topspin",
      swing: swing({ lateralBias: 0.9 }),
      quality: 1,
      rng,
    });

    // Leaning right must put the ball to the hitter's right, in their frame.
    const right = playerRightX("near");
    expect(leanLeft.prediction.landing!.x * right).toBeLessThan(
      leanRight.prediction.landing!.x * right
    );
  });

  it("scatters more and hits softer as timing degrades", () => {
    const spread = (quality: number) => {
      const rng = createRng(2024);
      const xs: number[] = [];
      let speedSum = 0;
      for (let i = 0; i < 60; i++) {
        const shot = resolveShot({
          contact,
          hitter: "near",
          kind: "topspin",
          swing: swing({ power: 0.8 }),
          quality,
          rng,
        });
        xs.push(shot.target.x);
        speedSum += Math.hypot(shot.vel.x, shot.vel.y, shot.vel.z);
      }
      const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
      const variance =
        xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length;
      return { sd: Math.sqrt(variance), meanSpeed: speedSum / 60 };
    };

    const sharp = spread(1);
    const sloppy = spread(0.2);

    // Perfect timing is tighter, not perfect: every player has irreducible
    // dispersion, and without it two competent opponents rally forever.
    expect(sharp.sd).toBeGreaterThan(0);
    expect(sloppy.sd).toBeGreaterThan(sharp.sd * 1.8);
    expect(sloppy.meanSpeed).toBeLessThan(sharp.meanSpeed);
  });

  it("sends near and far players' shots to opposite halves", () => {
    const near = resolveShot({
      contact,
      hitter: "near",
      kind: "drive",
      swing: swing({ arc: "flat" }),
      quality: 1,
      rng: createRng(5),
    });
    const far = resolveShot({
      contact: vec(0, 1.0, 12.5),
      hitter: "far",
      kind: "drive",
      swing: swing({ arc: "flat" }),
      quality: 1,
      rng: createRng(5),
    });

    expect(near.target.z).toBeGreaterThan(0);
    expect(far.target.z).toBeLessThan(0);
  });

  it("hits deeper with more power", () => {
    const depthFor = (power: number) =>
      resolveShot({
        contact,
        hitter: "near",
        kind: "topspin",
        swing: swing({ power }),
        quality: 1,
        rng: createRng(11),
      }).prediction.landing!.z;

    expect(depthFor(0.9)).toBeGreaterThan(depthFor(0.2));
  });
});
