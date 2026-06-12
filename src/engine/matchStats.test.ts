import { describe, expect, it } from "vitest";
import {
  createMatchStats,
  foldEvents,
  timingAccuracy,
  type MatchStats,
} from "./matchStats";
import type { RallyEvent } from "./rally";
import type { TimingGrade } from "./shotTypes";
import { createRng } from "./rng";
import { createMatch } from "./scoring";
import { createRally } from "./rally";
import { vec } from "./vec3";
import { playPoints } from "./__fixtures__/autoPlayer";

const serve = (by: "near" | "far" = "near"): RallyEvent => ({
  type: "serve",
  by,
  box: "deuce",
});

const hit = (
  by: "near" | "far",
  grade: TimingGrade = "perfect"
): RallyEvent => ({
  type: "hit",
  by,
  kind: "topspin",
  grade,
  contact: vec(),
  errorMs: 0,
  footwork: 0,
});

const point = (
  winner: "near" | "far",
  reason: "out" | "net" | "double-bounce" | "double-fault"
): RallyEvent => ({ type: "point", winner, reason });

const fold = (events: RallyEvent[]): MatchStats =>
  foldEvents(createMatchStats(), events);

describe("match stats", () => {
  it("starts empty", () => {
    const stats = createMatchStats();
    expect(stats.totalPoints).toBe(0);
    expect(stats.longestRally).toBe(0);
    expect(timingAccuracy(stats)).toBeNull();
  });

  it("counts an unreturned serve as an ace", () => {
    const stats = fold([serve("near"), point("near", "double-bounce")]);
    expect(stats.near.aces).toBe(1);
    expect(stats.near.winners).toBe(0);
    expect(stats.near.pointsWon).toBe(1);
  });

  it("counts a rally the opponent could not reach as a winner", () => {
    const stats = fold([
      serve("near"),
      hit("far"),
      hit("near"),
      point("near", "double-bounce"),
    ]);
    expect(stats.near.winners).toBe(1);
    expect(stats.near.aces).toBe(0);
  });

  it("charges a ball put out or into the net to the player who hit it", () => {
    const stats = fold([
      serve("near"),
      hit("far"),
      point("far", "out"),
      serve("far"),
      hit("near"),
      point("near", "net"),
    ]);
    expect(stats.near.unforcedErrors).toBe(1);
    expect(stats.far.unforcedErrors).toBe(1);
    expect(stats.near.pointsWon).toBe(1);
    expect(stats.far.pointsWon).toBe(1);
  });

  it("counts double faults and the faults leading to them", () => {
    const stats = fold([
      { type: "fault", by: "near", count: 1 },
      { type: "fault", by: "near", count: 2 },
      point("far", "double-fault"),
    ]);
    expect(stats.near.faults).toBe(2);
    expect(stats.near.doubleFaults).toBe(1);
    expect(stats.far.pointsWon).toBe(1);
  });

  it("tracks the longest rally across points", () => {
    const stats = fold([
      serve("near"),
      hit("far"),
      hit("near"),
      hit("far"),
      point("far", "double-bounce"),
      serve("far"),
      hit("near"),
      point("near", "double-bounce"),
    ]);
    expect(stats.longestRally).toBe(4);
  });

  it("resets the rally counter between points", () => {
    const stats = fold([
      serve("near"),
      hit("far"),
      hit("near"),
      point("near", "double-bounce"),
      serve("far"),
      point("far", "double-bounce"),
    ]);
    // The second point was an ace, so it must not inherit the first rally.
    expect(stats.far.aces).toBe(1);
    expect(stats.far.winners).toBe(0);
  });

  it("records only the near player's timing", () => {
    const stats = fold([
      serve("near"),
      hit("far", "weak"),
      hit("near", "perfect"),
      hit("near", "good"),
      { type: "whiff", by: "near", errorMs: 900 },
      { type: "whiff", by: "far", errorMs: 900 },
    ]);
    expect(stats.timing).toEqual({ perfect: 1, good: 1, weak: 0, miss: 1 });
    expect(timingAccuracy(stats)).toBeCloseTo(2 / 3, 6);
  });

  it("never loses a point: every point has exactly one winner", () => {
    const stats = fold([
      serve("near"),
      point("near", "double-bounce"),
      serve("far"),
      point("far", "out"),
      serve("near"),
      point("far", "net"),
    ]);
    expect(stats.near.pointsWon + stats.far.pointsWon).toBe(stats.totalPoints);
    expect(stats.totalPoints).toBe(3);
  });

  it("is a pure fold", () => {
    const events = [serve("near"), hit("far"), point("far", "out")];
    const before = createMatchStats();
    const after = foldEvents(before, events);
    expect(before).toEqual(createMatchStats());
    expect(after).not.toBe(before);
    expect(foldEvents(createMatchStats(), events)).toEqual(after);
  });
});

describe("match stats against real play", () => {
  it("accounts for every point of a simulated match", () => {
    const rally = createRally(createMatch("near"), createRng(21));
    const result = playPoints(rally, 10, { passive: ["far"] });
    const stats = foldEvents(createMatchStats(), result.events);

    const awarded = result.events.filter((e) => e.type === "point").length;
    expect(stats.totalPoints).toBe(awarded);
    expect(stats.near.pointsWon + stats.far.pointsWon).toBe(awarded);
    expect(stats.longestRally).toBeGreaterThan(0);
  });

  it("classifies every point exactly once", () => {
    const rally = createRally(createMatch("near"), createRng(4));
    const result = playPoints(rally, 8, { passive: ["far"] });
    const stats = foldEvents(createMatchStats(), result.events);

    const classified =
      stats.near.winners +
      stats.near.aces +
      stats.near.unforcedErrors +
      stats.near.doubleFaults +
      stats.far.winners +
      stats.far.aces +
      stats.far.unforcedErrors +
      stats.far.doubleFaults;

    expect(classified).toBe(stats.totalPoints);
  });
});
