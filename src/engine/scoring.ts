/**
 * Tennis scoring: points, games, tiebreaks, sets, match.
 *
 * Pure reducer over an immutable state, so the UI can render any historical
 * state and tests can drive whole matches point by point.
 */

export type Side = "near" | "far";

export const otherSide = (side: Side): Side => (side === "near" ? "far" : "near");

export type MatchConfig = {
  /** Sets needed to take the match. 2 gives best-of-three. */
  setsToWin: number;
  /** Games needed to take a set, subject to a two-game margin. */
  gamesPerSet: number;
  /** Game count at which a tiebreak replaces normal play. */
  tiebreakAt: number;
  /** Points needed to take a tiebreak, subject to a two-point margin. */
  tiebreakTarget: number;
};

export const DEFAULT_MATCH_CONFIG: MatchConfig = {
  setsToWin: 2,
  gamesPerSet: 6,
  tiebreakAt: 6,
  tiebreakTarget: 7,
};

export type SetSummary = { near: number; far: number };

export type MatchState = {
  config: MatchConfig;
  points: Record<Side, number>;
  games: Record<Side, number>;
  sets: Record<Side, number>;
  /** Completed sets, oldest first, for the scoreboard. */
  history: SetSummary[];
  inTiebreak: boolean;
  server: Side;
  /** Points played in the current tiebreak, used for serve rotation. */
  tiebreakPointsPlayed: number;
  /**
   * Who served the tiebreak's first point. The next set opens with that player
   * receiving, so this has to survive the tiebreak to set up the following game.
   */
  tiebreakFirstServer: Side | null;
  winner: Side | null;
};

export function createMatch(
  firstServer: Side = "near",
  config: MatchConfig = DEFAULT_MATCH_CONFIG
): MatchState {
  return {
    config,
    points: { near: 0, far: 0 },
    games: { near: 0, far: 0 },
    sets: { near: 0, far: 0 },
    history: [],
    inTiebreak: false,
    server: firstServer,
    tiebreakPointsPlayed: 0,
    tiebreakFirstServer: null,
    winner: null,
  };
}

const wonBy = (a: number, b: number, target: number, margin = 2): boolean =>
  a >= target && a - b >= margin;

/**
 * Award one point and cascade through game, set and match completion.
 *
 * Awarding a point to an already-finished match is a no-op rather than an error,
 * so a late-arriving swing after match point cannot corrupt the score.
 */
export function awardPoint(state: MatchState, to: Side): MatchState {
  if (state.winner) return state;

  const { config } = state;
  const opponent = otherSide(to);
  const points = { ...state.points, [to]: state.points[to] + 1 };

  let next: MatchState = { ...state, points };

  if (state.inTiebreak) {
    next.tiebreakPointsPlayed = state.tiebreakPointsPlayed + 1;
    // Serve passes after the first point, then every two points.
    next.server =
      (next.tiebreakPointsPlayed - 1) % 2 === 0
        ? otherSide(state.server)
        : state.server;

    if (wonBy(points[to], points[opponent], config.tiebreakTarget)) {
      return completeGame(next, to, /* takesSet */ true);
    }
    return next;
  }

  if (wonBy(points[to], points[opponent], 4)) {
    const games = state.games[to] + 1;
    const takesSet = wonBy(games, state.games[opponent], config.gamesPerSet);
    return completeGame(next, to, takesSet);
  }

  return next;
}

function completeGame(
  state: MatchState,
  to: Side,
  takesSet: boolean
): MatchState {
  const opponent = otherSide(to);
  const games = { ...state.games, [to]: state.games[to] + 1 };

  let next: MatchState = {
    ...state,
    points: { near: 0, far: 0 },
    games,
    inTiebreak: false,
    tiebreakPointsPlayed: 0,
    tiebreakFirstServer: null,
    // A tiebreak that has just ended hands the next serve to whoever received
    // its opening point. A normal game simply alternates.
    server: state.inTiebreak
      ? otherSide(state.tiebreakFirstServer ?? state.server)
      : otherSide(state.server),
  };

  if (!takesSet) {
    // Entering a tiebreak leaves the game count alone; only the mode changes.
    if (
      games[to] === state.config.tiebreakAt &&
      games[opponent] === state.config.tiebreakAt
    ) {
      next.inTiebreak = true;
      next.tiebreakFirstServer = next.server;
    }
    return next;
  }

  const sets = { ...state.sets, [to]: state.sets[to] + 1 };
  next = {
    ...next,
    sets,
    games: { near: 0, far: 0 },
    history: [...state.history, { near: games.near, far: games.far }],
  };

  if (sets[to] >= state.config.setsToWin) {
    next.winner = to;
  }

  return next;
}

const POINT_NAMES = ["0", "15", "30", "40"] as const;

export type ScoreDisplay = {
  /** Point score for each side, or a caption like "Deuce" covering both. */
  near: string;
  far: string;
  caption: string | null;
};

/** Human-readable current point score. */
export function describeScore(state: MatchState): ScoreDisplay {
  const { points, inTiebreak } = state;

  if (state.winner) {
    return { near: "", far: "", caption: `Game, set and match` };
  }

  if (inTiebreak) {
    return {
      near: String(points.near),
      far: String(points.far),
      caption: "Tiebreak",
    };
  }

  if (points.near >= 3 && points.far >= 3) {
    if (points.near === points.far) {
      return { near: "40", far: "40", caption: "Deuce" };
    }
    const leader: Side = points.near > points.far ? "near" : "far";
    return {
      near: leader === "near" ? "Ad" : "",
      far: leader === "far" ? "Ad" : "",
      caption: leader === state.server ? "Advantage server" : "Advantage receiver",
    };
  }

  return {
    near: POINT_NAMES[Math.min(points.near, 3)]!,
    far: POINT_NAMES[Math.min(points.far, 3)]!,
    caption: null,
  };
}

/** True when the given side is one point from taking the match. */
export function isMatchPoint(state: MatchState, side: Side): boolean {
  if (state.winner) return false;
  const after = awardPoint(state, side);
  return after.winner === side;
}

/** True when the given side is one point from taking the current game. */
export function isGamePoint(state: MatchState, side: Side): boolean {
  if (state.winner) return false;
  const after = awardPoint(state, side);
  return after.games[side] > state.games[side] || after.sets[side] > state.sets[side];
}

/** True when the given side is one point from taking the current set. */
export function isSetPoint(state: MatchState, side: Side): boolean {
  if (state.winner) return false;
  const after = awardPoint(state, side);
  return after.sets[side] > state.sets[side];
}

/**
 * The most significant thing at stake on this point, from `side`'s view.
 *
 * Ordered by weight so the caller can show one label rather than three: match
 * point subsumes set point, which subsumes game point. A game point against the
 * server is a break point, which is the one every tennis crowd reacts to.
 */
export type Stake = "match-point" | "set-point" | "break-point" | "game-point";

export function stakeFor(state: MatchState, side: Side): Stake | null {
  if (state.winner) return null;
  if (isMatchPoint(state, side)) return "match-point";
  if (isSetPoint(state, side)) return "set-point";
  if (!isGamePoint(state, side)) return null;
  return state.server === side ? "game-point" : "break-point";
}
