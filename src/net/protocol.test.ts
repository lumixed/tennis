import { describe, expect, it } from "vitest";
import { createMatch, awardPoint, type MatchState } from "../engine/scoring";
import { vec } from "../engine/vec3";
import {
  decode,
  encode,
  mirrorEvent,
  mirrorMatch,
  mirrorSnapshot,
  PROTOCOL_VERSION,
  type NetEvent,
  type NetMessage,
  type NetSnapshot,
} from "./protocol";

const snapshot = (over: Partial<NetSnapshot> = {}): NetSnapshot => ({
  t: 1234,
  phase: "in-play",
  ball: {
    pos: vec(2, 1.5, -6),
    vel: vec(3, 4, 20),
    spin: vec(300, 50, -20),
  },
  striker: "far",
  lastHitter: "near",
  serveFaults: 1,
  strike: {
    striker: "far",
    idealTimeMs: 2000,
    contact: vec(1, 1, 8),
    landing: vec(1.5, 0.03, 7),
    landingTimeMs: 1800,
  },
  match: createMatch("near"),
  outcome: null,
  ...over,
});

describe("mirroring", () => {
  it("puts the ball on the other side of the court", () => {
    const mirrored = mirrorSnapshot(snapshot());
    expect(mirrored.ball.pos).toEqual(vec(-2, 1.5, 6));
    expect(mirrored.ball.vel).toEqual(vec(-3, 4, -20));
  });

  it("keeps the ball's height and vertical spin unchanged", () => {
    // A 180 degree turn about the vertical axis leaves y alone in both.
    const mirrored = mirrorSnapshot(snapshot());
    expect(mirrored.ball.pos.y).toBe(1.5);
    expect(mirrored.ball.spin.y).toBe(50);
    expect(mirrored.ball.spin).toEqual(vec(-300, 50, 20));
  });

  it("swaps who is on strike", () => {
    const mirrored = mirrorSnapshot(snapshot());
    expect(mirrored.striker).toBe("near");
    expect(mirrored.lastHitter).toBe("far");
    expect(mirrored.strike!.striker).toBe("near");
  });

  it("mirrors the strike window's geometry but not its timing", () => {
    const mirrored = mirrorSnapshot(snapshot());
    expect(mirrored.strike!.contact).toEqual(vec(-1, 1, -8));
    expect(mirrored.strike!.landing).toEqual(vec(-1.5, 0.03, -7));
    // Time is time on both machines.
    expect(mirrored.strike!.idealTimeMs).toBe(2000);
    expect(mirrored.strike!.landingTimeMs).toBe(1800);
  });

  it("survives a strike window with no landing", () => {
    const mirrored = mirrorSnapshot(
      snapshot({ strike: { striker: "near", idealTimeMs: 1, contact: vec(), landing: null, landingTimeMs: 0 } })
    );
    expect(mirrored.strike!.landing).toBeNull();
    expect(mirrored.strike!.striker).toBe("far");
  });

  it("swaps the score so each player reads their own on top", () => {
    let match: MatchState = createMatch("near");
    match = awardPoint(match, "near");
    match = awardPoint(match, "near");
    match = awardPoint(match, "far");

    const mirrored = mirrorMatch(match);
    expect(mirrored.points).toEqual({ near: 1, far: 2 });
    expect(mirrored.server).toBe("far");
  });

  it("swaps completed set scores too", () => {
    let match = createMatch("near");
    for (let i = 0; i < 24; i++) match = awardPoint(match, "near");
    expect(match.history.length).toBeGreaterThan(0);

    const mirrored = mirrorMatch(match);
    expect(mirrored.history[0]).toEqual({
      near: match.history[0]!.far,
      far: match.history[0]!.near,
    });
  });

  it("swaps the winner", () => {
    let match = createMatch("near");
    for (let i = 0; i < 100 && !match.winner; i++) match = awardPoint(match, "near");
    expect(match.winner).toBe("near");
    expect(mirrorMatch(match).winner).toBe("far");
  });

  it("is its own inverse", () => {
    // Mirroring twice must land exactly where it started, or the two players
    // are slowly drifting into different worlds.
    const original = snapshot();
    expect(mirrorSnapshot(mirrorSnapshot(original))).toEqual(original);
  });

  it("is its own inverse for a decided point", () => {
    const original = snapshot({
      phase: "point-over",
      outcome: { winner: "far", reason: "out" },
    });
    expect(mirrorSnapshot(mirrorSnapshot(original))).toEqual(original);
  });

  it("mirrors every kind of event", () => {
    const events: NetEvent[] = [
      { type: "bounce", at: vec(3, 0.03, 5), side: "far", inCourt: true },
      { type: "hit", by: "near", kind: "topspin", grade: "perfect", footwork: 0.2 },
      { type: "whiff", by: "far" },
      { type: "net", by: "near" },
      { type: "fault", by: "near", count: 1 },
      { type: "serve", by: "far" },
      { type: "point", winner: "near", reason: "out" },
    ];

    for (const event of events) {
      expect(mirrorEvent(mirrorEvent(event))).toEqual(event);
    }

    const bounce = mirrorEvent(events[0]!);
    expect(bounce).toMatchObject({ side: "near", at: vec(-3, 0.03, -5) });
    expect(mirrorEvent(events[6]!)).toMatchObject({ winner: "far" });
  });
});

describe("wire format", () => {
  it("round-trips every message kind", () => {
    const messages: NetMessage[] = [
      { t: "hello", version: PROTOCOL_VERSION, role: "host" },
      { t: "ready" },
      {
        t: "swing",
        swing: { t: 5, arc: "low-to-high", power: 0.6, lateralBias: -0.2, side: "forehand", stance: 0.4 },
      },
      { t: "state", snapshot: snapshot() },
      { t: "events", events: [{ type: "serve", by: "near" }] },
      { t: "bye", reason: "left" },
    ];

    for (const message of messages) {
      expect(decode(encode(message))).toEqual(message);
    }
  });

  it("refuses malformed input rather than throwing", () => {
    // A peer sending nonsense must not take the game down.
    for (const bad of ["", "{", "null", "[]", '"hi"', '{"t":"nope"}', "123"]) {
      expect(decode(bad)).toBeNull();
    }
  });

  it("keeps a state message small enough to send often", () => {
    // Sent many times a second; if this balloons, the channel is the problem.
    const bytes = encode({ t: "state", snapshot: snapshot() }).length;
    expect(bytes).toBeLessThan(1400);
  });
});
