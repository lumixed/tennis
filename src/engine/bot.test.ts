import { describe, expect, it } from "vitest";
import { createBot, DIFFICULTIES, updateBot } from "./bot";
import { createRng } from "./rng";
import { applySwing, createRally, step, type RallyState } from "./rally";
import { createMatch } from "./scoring";
import { measureWinRate, playBotMatch } from "./__fixtures__/botMatch";

const { rookie, club, pro } = DIFFICULTIES as Record<
  "rookie" | "club" | "pro",
  (typeof DIFFICULTIES)[string]
>;

/** Run a bot against a rally state until it produces a swing. */
function swingWithin(
  bot: ReturnType<typeof createBot>,
  state: RallyState,
  maxMs = 5000
) {
  let current = state;
  let currentBot = bot;
  for (let t = 0; t < maxMs; t += 8) {
    const update = updateBot(currentBot, current);
    currentBot = update.bot;
    if (update.swing) return { swing: update.swing, state: current, bot: currentBot };
    current = step(current, 8).state;
  }
  return { swing: null, state: current, bot: currentBot };
}

describe("bot serving", () => {
  it("serves when it holds serve", () => {
    const rally = createRally(createMatch("near"), createRng(3));
    const bot = createBot(club, "near", createRng(9));

    const result = swingWithin(bot, rally);
    expect(result.swing).not.toBeNull();
    expect(result.swing!.arc).toBe("overhead");
  });

  it("does not serve when the opponent holds serve", () => {
    const rally = createRally(createMatch("far"), createRng(3));
    const bot = createBot(club, "near", createRng(9));

    expect(swingWithin(bot, rally, 3000).swing).toBeNull();
  });

  it("serves again after a fault", () => {
    // Regression: the plan key was `phase:hitCount`, and a fault rewinds to a
    // fresh awaiting-serve with hitCount still 0. The bot read that as "already
    // planned", never served again, and the match hung.
    const rally: RallyState = {
      ...createRally(createMatch("near"), createRng(3)),
      serveFaults: 1,
    };
    const bot = createBot(club, "near", createRng(9));

    const first = swingWithin(bot, rally);
    expect(first.swing).not.toBeNull();

    // Simulate the fault reset: fresh rally, fault count carried.
    const afterFault: RallyState = {
      ...createRally(rally.match, rally.rng),
      timeMs: first.state.timeMs,
      serveFaults: 2,
    };

    const second = swingWithin(first.bot, afterFault);
    expect(second.swing).not.toBeNull();
  });
});

describe("bot rallying", () => {
  it("stays still when the ball is not its to play", () => {
    const rally = createRally(createMatch("near"), createRng(3));
    const served = applySwing(
      rally,
      { t: 0, arc: "overhead", power: 0.6, lateralBias: 0, side: "forehand" }
    ).state;

    // "near" served, so the strike belongs to "far".
    const nearBot = createBot(club, "near", createRng(9));
    expect(swingWithin(nearBot, served, 1200).swing).toBeNull();
  });

  it("answers a served ball", () => {
    const rally = createRally(createMatch("near"), createRng(3));
    const served = applySwing(
      rally,
      { t: 0, arc: "overhead", power: 0.6, lateralBias: 0, side: "forehand" }
    ).state;

    const farBot = createBot(club, "far", createRng(9));
    const result = swingWithin(farBot, served);
    expect(result.swing).not.toBeNull();
    expect(result.swing!.power).toBeGreaterThan(0);
  });

  it("swings near the ideal moment on the hardest difficulty", () => {
    const rally = createRally(createMatch("near"), createRng(3));
    const served = applySwing(
      rally,
      { t: 0, arc: "overhead", power: 0.5, lateralBias: 0, side: "forehand" }
    ).state;

    const ideal = served.strike!.idealTimeMs;
    const farBot = createBot(pro, "far", createRng(21));
    const result = swingWithin(farBot, served);

    expect(result.swing).not.toBeNull();
    expect(Math.abs(result.swing!.t - ideal)).toBeLessThan(250);
  });
});

describe("difficulty balance", () => {
  const options = { maxPoints: 30 };

  it("orders the tiers by strength", () => {
    const proVsRookie = measureWinRate(pro, rookie, 3, options);
    const proVsClub = measureWinRate(pro, club, 3, options);
    const clubVsRookie = measureWinRate(club, rookie, 3, options);

    expect(proVsRookie.rate).toBeGreaterThan(0.65);
    expect(proVsClub.rate).toBeGreaterThan(0.52);
    expect(clubVsRookie.rate).toBeGreaterThan(0.6);

    // Regression: precision used to ride on basePower alone, so the hardest
    // hitter was also the wildest and Pro lost to Club.
    expect(proVsClub.rate).toBeGreaterThan(0.5);
  });

  it("is roughly even in a mirror match", () => {
    const mirror = measureWinRate(club, club, 3, options);
    // The near side serves first, so a small edge is expected.
    expect(mirror.rate).toBeGreaterThan(0.38);
    expect(mirror.rate).toBeLessThan(0.62);
  });

  it("finishes its rallies", () => {
    // Regression: with zero dispersion at good timing neither bot could miss,
    // and essentially every point ran past the cap unresolved.
    //
    // Asserted as a rate rather than zero — a rally lasting the full 45 s cap
    // is a legitimate if rare outcome, and measured rates sit at 0-10%.
    for (const difficulty of [rookie, club, pro]) {
      let stalled = 0;
      let played = 0;
      for (const seed of [77, 404, 5150]) {
        const result = playBotMatch(difficulty, difficulty, {
          seed,
          maxPoints: 25,
        });
        stalled += result.stalled;
        played += result.pointsPlayed;
      }

      expect(played).toBeGreaterThan(50);
      expect(stalled / (stalled + played)).toBeLessThan(0.25);
    }
  });

  it("produces plausible rally lengths", () => {
    const result = playBotMatch(club, club, { seed: 5, maxPoints: 40 });
    const mean =
      result.rallyLengths.reduce((a, b) => a + b, 0) / result.rallyLengths.length;

    // Real singles averages a handful of shots per point.
    expect(mean).toBeGreaterThan(2);
    expect(mean).toBeLessThan(12);
  });

  it("ends points by a mix of causes", () => {
    const result = playBotMatch(club, club, { seed: 5, maxPoints: 40 });
    const reasons = new Set(
      result.events.filter((e) => e.type === "point").map((e) => e.reason)
    );

    // A rally that only ever ends one way means something is degenerate.
    expect(reasons.size).toBeGreaterThanOrEqual(3);
  });
});

describe("determinism", () => {
  it("replays identically from the same seed", () => {
    const run = () => playBotMatch(club, club, { seed: 31, maxPoints: 12 });
    const a = run();
    const b = run();

    expect(a.rallyLengths).toEqual(b.rallyLengths);
    expect(a.state.match.points).toEqual(b.state.match.points);
    expect(a.state.ball.pos).toEqual(b.state.ball.pos);
  });

  it("diverges between seeds", () => {
    const a = playBotMatch(club, club, { seed: 1, maxPoints: 12 });
    const b = playBotMatch(club, club, { seed: 2, maxPoints: 12 });
    expect(a.rallyLengths).not.toEqual(b.rallyLengths);
  });
});
