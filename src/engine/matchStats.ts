/**
 * What happened over a match.
 *
 * Folded from the same `RallyEvent` stream everything else reads, so the
 * numbers cannot drift from what actually occurred on court.
 *
 * A match that ends with a single line of text teaches nothing. Knowing you hit
 * four winners and eleven unforced errors tells you what to do differently;
 * "Bot wins" does not.
 */

import type { RallyEvent } from "./rally";
import type { Side } from "./scoring";
import type { TimingGrade } from "./shotTypes";

export type SideStats = {
  pointsWon: number;
  /** Points won because the opponent could not reach the ball. */
  winners: number;
  /** Points lost by putting the ball out or into the net. */
  unforcedErrors: number;
  doubleFaults: number;
  /** Serves that were never returned. */
  aces: number;
  /** Serves that missed the box, including those that became double faults. */
  faults: number;
};

export type MatchStats = {
  near: SideStats;
  far: SideStats;
  totalPoints: number;
  longestRally: number;
  /** Shots in the rally currently in progress, serve included. */
  currentRally: number;
  /** How the near player's swings have been timed. */
  timing: Record<TimingGrade, number>;
};

const emptySide = (): SideStats => ({
  pointsWon: 0,
  winners: 0,
  unforcedErrors: 0,
  doubleFaults: 0,
  aces: 0,
  faults: 0,
});

export function createMatchStats(): MatchStats {
  return {
    near: emptySide(),
    far: emptySide(),
    totalPoints: 0,
    longestRally: 0,
    currentRally: 0,
    timing: { perfect: 0, good: 0, weak: 0, miss: 0 },
  };
}

const other = (side: Side): Side => (side === "near" ? "far" : "near");

/**
 * Fold one event in.
 *
 * Rally length is counted here from serve and hit events rather than read off
 * the rally state, so the stats depend only on the event stream and can be
 * replayed from a log.
 */
export function foldEvent(stats: MatchStats, event: RallyEvent): MatchStats {
  const next: MatchStats = {
    ...stats,
    near: { ...stats.near },
    far: { ...stats.far },
    timing: { ...stats.timing },
  };

  switch (event.type) {
    case "serve":
      next.currentRally = 1;
      break;

    case "hit":
      next.currentRally += 1;
      if (event.by === "near") next.timing[event.grade] += 1;
      break;

    case "whiff":
      if (event.by === "near") next.timing.miss += 1;
      break;

    case "fault":
      next[event.by].faults += 1;
      break;

    case "point": {
      const winner = event.winner;
      const loser = other(winner);
      next[winner].pointsWon += 1;
      next.totalPoints += 1;
      next.longestRally = Math.max(next.longestRally, next.currentRally);

      switch (event.reason) {
        case "double-fault":
          next[loser].doubleFaults += 1;
          break;
        case "out":
        case "net":
          next[loser].unforcedErrors += 1;
          break;
        case "double-bounce":
          // Unreturned serve is an ace; anything longer is a winner.
          if (next.currentRally <= 1) next[winner].aces += 1;
          else next[winner].winners += 1;
          break;
      }

      next.currentRally = 0;
      break;
    }
  }

  return next;
}

export function foldEvents(
  stats: MatchStats,
  events: readonly RallyEvent[]
): MatchStats {
  return events.reduce(foldEvent, stats);
}

/** Share of the near player's swings that landed in the good window or better. */
export function timingAccuracy(stats: MatchStats): number | null {
  const { perfect, good, weak, miss } = stats.timing;
  const total = perfect + good + weak + miss;
  if (total === 0) return null;
  return (perfect + good) / total;
}
