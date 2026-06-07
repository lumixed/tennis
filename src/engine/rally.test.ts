import { describe, expect, it } from "vitest";
import { BALL, COURT, playerRightX } from "./constants";
import { TIMING } from "./config";
import { createRng } from "./rng";
import { createMatch, type Side } from "./scoring";
import {
  applySwing,
  createRally,
  computeStrikeWindow,
  nextPoint,
  readyForNextPoint,
  serveBoxFor,
  step,
  type RallyEvent,
  type RallyState,
} from "./rally";
import { solveLaunch } from "./shot";
import type { SwingEvent } from "./shotTypes";
import { vec, type Vec3 } from "./vec3";
import { playPoint, playPoints } from "./__fixtures__/autoPlayer";

const swing = (over: Partial<SwingEvent> = {}): SwingEvent => ({
  t: 0,
  arc: "low-to-high",
  power: 0.65,
  lateralBias: 0,
  side: "forehand",
  ...over,
});

/** Build a live rally with the ball placed exactly where a test needs it. */
function inPlay(over: {
  pos: Vec3;
  vel: Vec3;
  spin?: Vec3;
  lastHitter: Side;
  striker?: Side;
  hitCount?: number;
  serveFaults?: number;
}): RallyState {
  const base = createRally(createMatch("near"), createRng(1));
  return {
    ...base,
    phase: "in-play",
    ball: { pos: over.pos, vel: over.vel, spin: over.spin ?? vec() },
    lastHitter: over.lastHitter,
    striker: over.striker ?? (over.lastHitter === "near" ? "far" : "near"),
    hitCount: over.hitCount ?? 2,
    serveFaults: over.serveFaults ?? 0,
  };
}

/** Step until the point resolves, returning everything that happened. */
function runToPoint(
  state: RallyState,
  maxMs = 15_000
): { state: RallyState; events: RallyEvent[] } {
  const events: RallyEvent[] = [];
  let current = state;
  for (let t = 0; t < maxMs && current.phase === "in-play"; t += 8) {
    const result = step(current, 8);
    current = result.state;
    events.push(...result.events);
  }
  return { state: current, events };
}

describe("serving", () => {
  it("puts the ball in play and hands the strike to the receiver", () => {
    const rally = createRally(createMatch("near"), createRng(4));
    const { state, events } = applySwing(rally, swing({ power: 0.6 }));

    expect(state.phase).toBe("in-play");
    expect(state.lastHitter).toBe("near");
    expect(state.striker).toBe("far");
    expect(state.hitCount).toBe(1);
    expect(events.some((e) => e.type === "serve")).toBe(true);
  });

  it("alternates service boxes within a game", () => {
    let match = createMatch("near");
    expect(serveBoxFor(match)).toBe("deuce");
    match = { ...match, points: { near: 1, far: 0 } };
    expect(serveBoxFor(match)).toBe("ad");
    match = { ...match, points: { near: 1, far: 1 } };
    expect(serveBoxFor(match)).toBe("deuce");
  });

  it("aims into the correct service box", () => {
    // Deuce court: the ball must land on the receiver's right, which is -x on
    // the far side.
    const rally = createRally(createMatch("near"), createRng(11));
    const served = applySwing(rally, swing({ power: 0.5 })).state;
    const { events } = runToPoint(served);

    const firstBounce = events.find((e) => e.type === "bounce");
    expect(firstBounce).toBeDefined();
    if (firstBounce?.type === "bounce") {
      expect(firstBounce.at.z).toBeGreaterThan(0);
      expect(firstBounce.at.z).toBeLessThanOrEqual(COURT.serviceLine + 1.5);
    }
  });

  it("counts a serve that lands beyond the service line as a fault", () => {
    const state = inPlay({
      pos: vec(0, 2.4, -COURT.halfLength),
      // Fast and flat: it will carry past the service line.
      vel: vec(0, 1.5, 42),
      lastHitter: "near",
      hitCount: 1,
    });

    const { state: after, events } = runToPoint(state);
    expect(events.some((e) => e.type === "fault")).toBe(true);
    expect(after.serveFaults).toBe(1);
    expect(after.phase).toBe("awaiting-serve");
    // A fault does not decide the point.
    expect(after.match.points).toEqual({ near: 0, far: 0 });
  });

  it("loses the point on a second fault", () => {
    const state = inPlay({
      pos: vec(0, 2.4, -COURT.halfLength),
      vel: vec(0, 1.5, 42),
      lastHitter: "near",
      hitCount: 1,
      serveFaults: 1,
    });

    const { state: after, events } = runToPoint(state);
    expect(after.phase).toBe("point-over");
    expect(after.outcome).toEqual({ winner: "far", reason: "double-fault" });
    expect(events.some((e) => e.type === "point")).toBe(true);
  });
});

describe("point adjudication", () => {
  it("gives the point away when the ball is dumped into the net", () => {
    const state = inPlay({
      pos: vec(0, 0.6, -3),
      // Heading for the net well below the cord.
      vel: vec(0, -0.5, 14),
      lastHitter: "near",
    });

    const { state: after, events } = runToPoint(state);
    expect(after.outcome).toEqual({ winner: "far", reason: "net" });
    expect(events.some((e) => e.type === "net")).toBe(true);
  });

  it("gives the point away when the ball lands long", () => {
    const state = inPlay({
      pos: vec(0, 1.2, -2),
      vel: vec(0, 6, 34),
      lastHitter: "near",
    });

    const { state: after } = runToPoint(state);
    expect(after.outcome?.winner).toBe("far");
    expect(after.outcome?.reason).toBe("out");
  });

  it("gives the point away when the ball lands wide", () => {
    const state = inPlay({
      pos: vec(0, 1.2, -2),
      vel: vec(22, 5, 16),
      lastHitter: "near",
    });

    const { state: after } = runToPoint(state);
    expect(after.outcome?.winner).toBe("far");
    expect(after.outcome?.reason).toBe("out");
  });

  it("awards the point on a double bounce", () => {
    const rally = createRally(createMatch("near"), createRng(4));
    const result = playPoint(rally, { passive: ["far"] });

    expect(result.state.outcome).toEqual({
      winner: "near",
      reason: "double-bounce",
    });
  });

  it("penalises a ball that never crosses the net", () => {
    // Struck downwards so it lands back on the hitter's own half.
    const state = inPlay({
      pos: vec(0, 1.0, -6),
      vel: vec(0, -2, 3),
      lastHitter: "near",
    });

    const { state: after } = runToPoint(state);
    expect(after.outcome?.winner).toBe("far");
    expect(after.outcome?.reason).toBe("net");
  });

  it("keeps the point alive on a legal deep ball", () => {
    // Built with the solver rather than hand-picked velocities, so "legal" is
    // guaranteed by construction instead of by my arithmetic.
    const from = vec(0, 1.0, -COURT.halfLength);
    const launch = solveLaunch({
      from,
      target: vec(1.5, BALL.radius, 8.5),
      speed: 27,
      spinRate: 380,
    });
    expect(launch.reachedTarget).toBe(true);

    const state = inPlay({
      pos: from,
      vel: launch.vel,
      spin: launch.spin,
      lastHitter: "near",
    });

    // Stop at the first bounce: left running, nobody returns it and the point
    // legitimately ends on the second.
    let current = state;
    let bounce: RallyEvent | undefined;
    for (let t = 0; t < 3000 && !bounce; t += 8) {
      const result = step(current, 8);
      current = result.state;
      bounce = result.events.find((e) => e.type === "bounce");
    }

    expect(bounce).toMatchObject({ type: "bounce", side: "far", inCourt: true });
    expect(current.phase).toBe("in-play");
    expect(current.striker).toBe("far");
  });
});

describe("strike windows", () => {
  it("targets the receiving side and sits in the future", () => {
    const rally = createRally(createMatch("near"), createRng(4));
    const served = applySwing(rally, swing({ power: 0.6 })).state;

    expect(served.strike).not.toBeNull();
    expect(served.strike!.striker).toBe("far");
    expect(served.strike!.idealTimeMs).toBeGreaterThan(served.timeMs);
    expect(served.strike!.contact.z).toBeGreaterThan(0);
  });

  it("gives the receiver meaningful preparation time", () => {
    const rally = createRally(createMatch("near"), createRng(4));
    const served = applySwing(rally, swing({ power: 0.6 })).state;
    const lead = served.strike!.idealTimeMs - served.timeMs;

    // The whole point of choosing tennis: the pose pipeline's ~100 ms of
    // latency has to be small next to this.
    expect(lead).toBeGreaterThan(TIMING.latencyCompensationMs * 3);
  });

  it("returns nothing when the ball is not coming to the striker", () => {
    const heading = {
      pos: vec(0, 1, -2),
      vel: vec(0, 3, 18),
      spin: vec(),
    };
    // The ball is travelling to the far side, so "near" has no window.
    expect(computeStrikeWindow(heading, 0, "near")).toBeNull();
    expect(computeStrikeWindow(heading, 0, "far")).not.toBeNull();
  });

  it("returns nothing for a ball that will not clear the net", () => {
    const netted = { pos: vec(0, 0.5, -2), vel: vec(0, -1, 12), spin: vec() };
    expect(computeStrikeWindow(netted, 0, "far")).toBeNull();
  });
});

describe("swinging", () => {
  it("ignores a swing from the side not on strike", () => {
    const rally = createRally(createMatch("near"), createRng(4));
    const served = applySwing(rally, swing({ power: 0.6 })).state;
    // "near" just served; the window belongs to "far".
    const wrongSide: RallyState = { ...served, striker: "near" };

    const result = applySwing(wrongSide, swing({ t: served.timeMs }));
    expect(result.state).toBe(wrongSide);
    expect(result.events).toEqual([]);
  });

  it("whiffs without ending the point when timing is hopeless", () => {
    const rally = createRally(createMatch("near"), createRng(4));
    const served = applySwing(rally, swing({ power: 0.6 })).state;

    const hopeless = served.strike!.idealTimeMs + 2000;
    const result = applySwing(served, swing({ t: hopeless }));

    expect(result.events).toEqual([
      expect.objectContaining({ type: "whiff", by: "far" }),
    ]);
    expect(result.state.phase).toBe("in-play");
    expect(result.state.hitCount).toBe(served.hitCount);
  });

  it("returns the ball and flips the strike when timed well", () => {
    const rally = createRally(createMatch("near"), createRng(4));
    let state = applySwing(rally, swing({ power: 0.6 })).state;

    // Advance to the ideal contact moment.
    while (state.timeMs < state.strike!.idealTimeMs) {
      state = step(state, 8).state;
    }

    const result = applySwing(
      state,
      swing({ t: state.timeMs })
    );

    expect(result.events[0]).toMatchObject({ type: "hit", by: "far" });
    expect(result.state.striker).toBe("near");
    expect(result.state.lastHitter).toBe("far");
    expect(result.state.hitCount).toBe(2);
    expect(result.state.bouncesSinceHit).toBe(0);
  });

  it("clears the serve fault count once a rally is under way", () => {
    const rally = createRally(createMatch("near"), createRng(4));
    let state = applySwing(
      { ...rally, serveFaults: 1 },
      swing({ power: 0.5 })
    ).state;

    while (state.timeMs < state.strike!.idealTimeMs) {
      state = step(state, 8).state;
    }
    state = applySwing(
      state,
      swing({ t: state.timeMs })
    ).state;

    expect(state.serveFaults).toBe(0);
  });
});

describe("footwork", () => {
  /** A live rally with `near` on strike against a ball landing to their right. */
  function wideToNear(stance: number | undefined): RallyState {
    const base = createRally(createMatch("near"), createRng(5));
    const landingX = COURT.halfSinglesWidth * 0.9 * playerRightX("near");
    return {
      ...base,
      phase: "in-play",
      striker: "near",
      lastHitter: "far",
      hitCount: 2,
      ball: { pos: vec(landingX, 1.0, -9), vel: vec(0, 0, 0), spin: vec() },
      strike: {
        striker: "near",
        idealTimeMs: base.timeMs,
        contact: vec(landingX, 1.0, -9),
        landing: vec(landingX, BALL.radius, -8),
      },
      // Held constant so the only variable is stance.
      rng: createRng(5),
    };
  }

  const speedAfter = (stance: number | undefined): number => {
    const state = wideToNear(stance);
    const result = applySwing(
      state,
      swing({ t: state.timeMs, arc: "flat", power: 0.7, stance })
    );
    const { x, y, z } = result.state.ball.vel;
    return Math.hypot(x, y, z);
  };

  it("makes a stepped shot better than a rooted one", () => {
    expect(speedAfter(1)).toBeGreaterThan(speedAfter(0));
  });

  it("makes a rooted shot better than moving the wrong way", () => {
    expect(speedAfter(0)).toBeGreaterThan(speedAfter(-1));
  });

  it("leaves swings without stance completely unaffected", () => {
    // Keyboard and bot swings carry no stance and must play exactly as before.
    const state = wideToNear(undefined);
    const withoutStance = applySwing(
      state,
      swing({ t: state.timeMs, arc: "flat", power: 0.7 })
    );

    const control = wideToNear(undefined);
    const explicitZero = applySwing(
      control,
      swing({ t: control.timeMs, arc: "flat", power: 0.7, stance: 0 })
    );

    // An absent stance is a no-op; an explicit rooted stance is a penalty.
    expect(withoutStance.state.ball.vel).not.toEqual(
      explicitZero.state.ball.vel
    );
    expect(speedAfter(undefined)).toBeGreaterThan(speedAfter(0));
  });

  it("still connects however bad the footwork", () => {
    // Footwork changes how well the ball comes off, never whether it connects.
    for (const stance of [-1, -0.5, 0, 0.5, 1]) {
      const state = wideToNear(stance);
      const result = applySwing(
        state,
        swing({ t: state.timeMs, arc: "flat", power: 0.7, stance })
      );
      expect(result.events[0]).toMatchObject({ type: "hit", by: "near" });
    }
  });
});

describe("rallies", () => {
  it("sustains an exchange between two well-timed players", () => {
    const rally = createRally(createMatch("near"), createRng(42));
    const result = playPoint(rally, {}, 20_000);

    // Neither side errs, so the rally should still be alive at the buzzer.
    expect(result.state.hitCount).toBeGreaterThan(6);
    expect(result.timedOut).toBe(true);
  });

  it("is deterministic for a given seed", () => {
    const run = () =>
      playPoint(createRally(createMatch("near"), createRng(1234)), {}, 6000);

    const a = run();
    const b = run();
    expect(a.state.hitCount).toBe(b.state.hitCount);
    expect(a.state.ball.pos).toEqual(b.state.ball.pos);
  });

  it("diverges between seeds", () => {
    const at = (seed: number) =>
      playPoint(createRally(createMatch("near"), createRng(seed)), {}, 6000)
        .state.ball.pos;

    expect(at(1)).not.toEqual(at(2));
  });

  it("settles before the next point may be served", () => {
    const rally = createRally(createMatch("near"), createRng(4));
    const finished = playPoint(rally, { passive: ["far"] }).state;

    expect(finished.phase).toBe("point-over");
    expect(readyForNextPoint(finished)).toBe(false);

    let settled = finished;
    for (let i = 0; i < 200 && !readyForNextPoint(settled); i++) {
      settled = step(settled, 16).state;
    }
    expect(readyForNextPoint(settled)).toBe(true);

    const served = nextPoint(settled);
    expect(served.phase).toBe("awaiting-serve");
    expect(served.outcome).toBeNull();
    expect(served.timeMs).toBeGreaterThan(0);
  });

  it("carries the score forward across points", () => {
    const rally = createRally(createMatch("near"), createRng(9));
    const result = playPoints(rally, 4, { passive: ["far"] });

    expect(result.timedOut).toBe(false);
    // Four straight points to the server is a game.
    expect(result.state.match.games.near).toBe(1);
    expect(
      result.events.filter((e) => e.type === "point")
    ).toHaveLength(4);
  });
});
