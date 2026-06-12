import { describe, expect, it } from "vitest";
import {
  awardPoint,
  createMatch,
  stakeFor,
  describeScore,
  isMatchPoint,
  otherSide,
  type MatchState,
  type Side,
} from "./scoring";

/** Award a run of points to one side. */
function points(state: MatchState, to: Side, count: number): MatchState {
  let next = state;
  for (let i = 0; i < count; i++) next = awardPoint(next, to);
  return next;
}

/** Win a whole game from love. */
const game = (state: MatchState, to: Side): MatchState => points(state, to, 4);

/** Win `count` consecutive games. */
function games(state: MatchState, to: Side, count: number): MatchState {
  let next = state;
  for (let i = 0; i < count; i++) next = game(next, to);
  return next;
}

describe("point scoring", () => {
  it("counts 0, 15, 30, 40", () => {
    let state = createMatch();
    expect(describeScore(state).near).toBe("0");
    state = awardPoint(state, "near");
    expect(describeScore(state).near).toBe("15");
    state = awardPoint(state, "near");
    expect(describeScore(state).near).toBe("30");
    state = awardPoint(state, "near");
    expect(describeScore(state).near).toBe("40");
  });

  it("takes a game from 40-0", () => {
    const state = game(createMatch(), "near");
    expect(state.games.near).toBe(1);
    expect(state.points).toEqual({ near: 0, far: 0 });
  });

  it("calls deuce at 40-40", () => {
    let state = createMatch();
    state = points(state, "near", 3);
    state = points(state, "far", 3);
    expect(describeScore(state).caption).toBe("Deuce");
    expect(state.games.near).toBe(0);
  });

  it("requires a two-point margin from deuce", () => {
    let state = createMatch();
    state = points(state, "near", 3);
    state = points(state, "far", 3);

    state = awardPoint(state, "near");
    expect(state.games.near).toBe(0);
    expect(describeScore(state).caption).toBe("Advantage server");

    // Back to deuce.
    state = awardPoint(state, "far");
    expect(describeScore(state).caption).toBe("Deuce");

    state = awardPoint(state, "far");
    state = awardPoint(state, "far");
    expect(state.games.far).toBe(1);
  });

  it("labels advantage from the server's perspective", () => {
    let state = createMatch("near");
    state = points(state, "near", 3);
    state = points(state, "far", 4);
    expect(describeScore(state).caption).toBe("Advantage receiver");
  });
});

describe("games and sets", () => {
  it("alternates the server every game", () => {
    let state = createMatch("near");
    expect(state.server).toBe("near");
    state = game(state, "near");
    expect(state.server).toBe("far");
    state = game(state, "far");
    expect(state.server).toBe("near");
  });

  it("takes a set 6-0", () => {
    const state = games(createMatch(), "near", 6);
    expect(state.sets.near).toBe(1);
    expect(state.games).toEqual({ near: 0, far: 0 });
    expect(state.history).toEqual([{ near: 6, far: 0 }]);
  });

  it("requires a two-game margin at 5-5", () => {
    let state = createMatch();
    for (let i = 0; i < 5; i++) {
      state = game(state, "near");
      state = game(state, "far");
    }
    expect(state.games).toEqual({ near: 5, far: 5 });

    state = game(state, "near");
    expect(state.sets.near).toBe(0);
    expect(state.games).toEqual({ near: 6, far: 5 });

    state = game(state, "near");
    expect(state.sets.near).toBe(1);
    expect(state.history).toEqual([{ near: 7, far: 5 }]);
  });
});

describe("tiebreak", () => {
  /** Drive a set to 6-6 so the tiebreak begins. */
  function toTiebreak(firstServer: Side = "near"): MatchState {
    let state = createMatch(firstServer);
    for (let i = 0; i < 6; i++) {
      state = game(state, "near");
      state = game(state, "far");
    }
    return state;
  }

  it("begins at 6-6", () => {
    const state = toTiebreak();
    expect(state.inTiebreak).toBe(true);
    expect(state.games).toEqual({ near: 6, far: 6 });
    expect(describeScore(state).caption).toBe("Tiebreak");
  });

  it("counts plainly rather than in fifteens", () => {
    let state = toTiebreak();
    state = points(state, "near", 3);
    expect(describeScore(state).near).toBe("3");
  });

  it("rotates serve after one point and then every two", () => {
    let state = toTiebreak();
    const opener = state.server;

    state = awardPoint(state, "near");
    expect(state.server).toBe(otherSide(opener));
    state = awardPoint(state, "near");
    expect(state.server).toBe(otherSide(opener));
    state = awardPoint(state, "near");
    expect(state.server).toBe(opener);
    state = awardPoint(state, "near");
    expect(state.server).toBe(opener);
  });

  it("takes the set 7-6 when won", () => {
    let state = toTiebreak();
    state = points(state, "near", 7);
    expect(state.sets.near).toBe(1);
    expect(state.inTiebreak).toBe(false);
    expect(state.history).toEqual([{ near: 7, far: 6 }]);
  });

  it("requires a two-point margin", () => {
    let state = toTiebreak();
    state = points(state, "near", 6);
    state = points(state, "far", 6);
    state = awardPoint(state, "near");
    expect(state.sets.near).toBe(0);
    expect(state.points).toEqual({ near: 7, far: 6 });

    state = awardPoint(state, "near");
    expect(state.sets.near).toBe(1);
  });

  it("hands the next set's first serve to the tiebreak's receiver", () => {
    let state = toTiebreak("near");
    const opener = state.server;
    state = points(state, "near", 7);
    expect(state.server).toBe(otherSide(opener));
  });
});

describe("match", () => {
  it("ends after the required sets", () => {
    let state = createMatch();
    state = games(state, "near", 6);
    expect(state.winner).toBeNull();
    state = games(state, "near", 6);
    expect(state.winner).toBe("near");
  });

  it("ignores points awarded after the match is decided", () => {
    let state = createMatch();
    state = games(state, "near", 12);
    expect(state.winner).toBe("near");

    const after = awardPoint(state, "far");
    expect(after).toBe(state);
  });

  it("detects match point", () => {
    let state = createMatch();
    state = games(state, "near", 6);
    state = games(state, "near", 5);
    state = points(state, "near", 3);

    expect(isMatchPoint(state, "near")).toBe(true);
    expect(isMatchPoint(state, "far")).toBe(false);
  });
});

describe("what is at stake", () => {
  it("sees nothing at stake early in a game", () => {
    const state = createMatch("near");
    expect(stakeFor(state, "near")).toBeNull();
    expect(stakeFor(state, "far")).toBeNull();
  });

  it("calls it a game point for the server", () => {
    let state = createMatch("near");
    state = points(state, "near", 3);
    expect(stakeFor(state, "near")).toBe("game-point");
  });

  it("calls it a break point for the receiver", () => {
    // The same situation, seen from the other side, is the one a crowd reacts to.
    let state = createMatch("near");
    state = points(state, "far", 3);
    expect(stakeFor(state, "far")).toBe("break-point");
    expect(stakeFor(state, "near")).toBeNull();
  });

  it("prefers set point over game point", () => {
    let state = createMatch("near");
    state = games(state, "near", 5);
    state = points(state, "near", 3);
    expect(stakeFor(state, "near")).toBe("set-point");
  });

  it("prefers match point over set point", () => {
    let state = createMatch("near");
    state = games(state, "near", 6);
    state = games(state, "near", 5);
    state = points(state, "near", 3);
    expect(stakeFor(state, "near")).toBe("match-point");
  });

  it("sees nothing at stake at deuce", () => {
    let state = createMatch("near");
    state = points(state, "near", 3);
    state = points(state, "far", 3);
    expect(stakeFor(state, "near")).toBeNull();
    expect(stakeFor(state, "far")).toBeNull();
  });

  it("sees a game point at advantage", () => {
    let state = createMatch("near");
    state = points(state, "near", 3);
    state = points(state, "far", 3);
    state = awardPoint(state, "near");
    expect(stakeFor(state, "near")).toBe("game-point");
  });

  it("sees set point inside a tiebreak", () => {
    let state = createMatch("near");
    for (let i = 0; i < 6; i++) {
      state = game(state, "near");
      state = game(state, "far");
    }
    expect(state.inTiebreak).toBe(true);
    state = points(state, "near", 6);
    expect(stakeFor(state, "near")).toBe("set-point");
  });

  it("goes quiet once the match is decided", () => {
    let state = createMatch("near");
    state = games(state, "near", 12);
    expect(state.winner).toBe("near");
    expect(stakeFor(state, "near")).toBeNull();
    expect(stakeFor(state, "far")).toBeNull();
  });

  it("never claims a stake that awarding the point would not deliver", () => {
    // Cross-check against the real reducer for every position in a long match.
    let seed = 99;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };

    let state = createMatch("near");
    for (let i = 0; i < 4000 && !state.winner; i++) {
      for (const side of ["near", "far"] as const) {
        const stake = stakeFor(state, side);
        const after = awardPoint(state, side);
        const tookGame =
          after.games[side] > state.games[side] || after.sets[side] > state.sets[side];

        if (stake === "match-point") expect(after.winner).toBe(side);
        if (stake === "set-point") expect(after.sets[side]).toBeGreaterThan(state.sets[side]);
        if (stake === "game-point" || stake === "break-point") expect(tookGame).toBe(true);
        if (stake === null && !state.winner) expect(after.winner).not.toBe(side);
      }
      state = awardPoint(state, rand() < 0.5 ? "near" : "far");
    }
  });
});

describe("match invariants", () => {
  it("always terminates with a legal scoreline", () => {
    // Deterministic pseudo-random point sequences: a match must always finish,
    // and must never finish in an impossible state.
    let seed = 12345;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };

    for (let trial = 0; trial < 300; trial++) {
      const bias = 0.3 + rand() * 0.4;
      let state = createMatch(rand() < 0.5 ? "near" : "far");

      let guard = 0;
      while (!state.winner && guard++ < 20000) {
        state = awardPoint(state, rand() < bias ? "near" : "far");
      }

      expect(state.winner).not.toBeNull();
      const winner = state.winner!;
      expect(state.sets[winner]).toBe(2);
      expect(state.sets[otherSide(winner)]).toBeLessThanOrEqual(1);
      expect(state.history.length).toBe(
        state.sets.near + state.sets.far
      );

      for (const set of state.history) {
        const high = Math.max(set.near, set.far);
        const low = Math.min(set.near, set.far);
        expect(high).toBeGreaterThanOrEqual(6);
        // 7-6 via tiebreak, 7-5, or any 6-x.
        expect(high === 7 || (high === 6 && high - low >= 2)).toBe(true);
      }
    }
  });
});
