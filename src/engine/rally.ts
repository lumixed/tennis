/**
 * The rally state machine.
 *
 * Owns the ball, the strike windows, point adjudication and the handoff into
 * scoring. Consumes only `SwingEvent`s, so the human, the keyboard and the bot
 * all drive it through the same door.
 */

import { stepBall, type BallState } from "./ball";
import { BALL, COURT, PHYSICS_DT } from "./constants";
import { RALLY, SHOT_PROFILES, SOLVER } from "./config";
import { awardPoint, otherSide, type MatchState, type Side } from "./scoring";
import { createRng, gaussian, type Rng } from "./rng";
import { chooseShotKind, gradeTiming, resolveShot, solveLaunch } from "./shot";
import type { ShotKind, SwingEvent, TimingGrade } from "./shotTypes";
import {
  isInServiceBox,
  isInSinglesCourt,
  netHeightAt,
  predictFlight,
} from "./trajectory";
import { vec, type Vec3 } from "./vec3";

export type RallyPhase = "awaiting-serve" | "in-play" | "point-over";

export type PointReason = "out" | "net" | "double-bounce" | "double-fault";

export type PointOutcome = { winner: Side; reason: PointReason };

export type ServeBox = "deuce" | "ad";

/**
 * When and where the receiving player should make contact.
 *
 * Computed the instant the ball is struck, so the receiver has the full flight
 * as preparation time rather than being told at the last moment.
 */
export type StrikeWindow = {
  striker: Side;
  /** Engine time in ms of the ideal contact. */
  idealTimeMs: number;
  /** Predicted contact position at that moment. */
  contact: Vec3;
  /** Where the incoming ball is predicted to land. */
  landing: Vec3 | null;
};

export type RallyEvent =
  | { type: "bounce"; at: Vec3; side: Side; inCourt: boolean }
  | {
      type: "hit";
      by: Side;
      kind: ShotKind;
      grade: TimingGrade;
      contact: Vec3;
      errorMs: number;
    }
  | { type: "whiff"; by: Side; errorMs: number }
  | { type: "net"; by: Side }
  | { type: "fault"; by: Side; count: number }
  | { type: "let" }
  | { type: "serve"; by: Side; box: ServeBox }
  | { type: "point"; winner: Side; reason: PointReason };

export type RallyState = {
  phase: RallyPhase;
  /** Engine time in ms since the match began. */
  timeMs: number;
  ball: BallState;
  /** Whose turn it is to play the ball. */
  striker: Side;
  /** Who struck the ball most recently; null before the serve. */
  lastHitter: Side | null;
  bouncesSinceHit: number;
  serveFaults: number;
  outcome: PointOutcome | null;
  strike: StrikeWindow | null;
  match: MatchState;
  rng: Rng;
  /**
   * Shot-making skill per side, 1 being the human baseline. A property of the
   * player rather than of any individual swing, so it lives here instead of on
   * `SwingEvent` — the camera has no business reporting it.
   */
  precision: Record<Side, number>;
  hitCount: number;
  /** Leftover time carried between fixed physics steps. */
  accumulatorMs: number;
  /** Time the point was decided, for the settle delay before the next serve. */
  decidedAtMs: number | null;
};

/** Contact height the strike window aims for on a groundstroke. */
const IDEAL_CONTACT_HEIGHT = 0.95;

/** A serve passing within this margin of the cord counts as a let. */
const LET_MARGIN = 0.04;

export const serverContactPoint = (server: Side): Vec3 =>
  vec(
    server === "near" ? 0.9 : -0.9,
    2.45,
    server === "near" ? -COURT.halfLength - 0.15 : COURT.halfLength + 0.15
  );

/** Which box the next serve goes to. Games open on the deuce court. */
export function serveBoxFor(match: MatchState): ServeBox {
  const played = match.points.near + match.points.far;
  return played % 2 === 0 ? "deuce" : "ad";
}

export function createRally(
  match: MatchState,
  rng: Rng = createRng(1),
  precision: Record<Side, number> = { near: 1, far: 1 }
): RallyState {
  return {
    precision,
    phase: "awaiting-serve",
    timeMs: 0,
    ball: {
      pos: serverContactPoint(match.server),
      vel: vec(),
      spin: vec(),
    },
    striker: match.server,
    lastHitter: null,
    bouncesSinceHit: 0,
    serveFaults: 0,
    outcome: null,
    strike: null,
    match,
    rng,
    hitCount: 0,
    accumulatorMs: 0,
    decidedAtMs: null,
  };
}

/** Reset for the next point, keeping the match score and clock. */
export function nextPoint(state: RallyState): RallyState {
  return {
    ...createRally(state.match, state.rng, state.precision),
    timeMs: state.timeMs,
  };
}

const sideOfZ = (z: number): Side => (z < 0 ? "near" : "far");

/**
 * Work out when and where the receiver should make contact.
 *
 * The ideal moment is the descent back through a comfortable contact height
 * after the ball bounces. On a ball that never bounces that high the apex is
 * used instead, so a low skidding slice still yields a playable window.
 */
export function computeStrikeWindow(
  ball: BallState,
  nowMs: number,
  striker: Side
): StrikeWindow | null {
  const flight = predictFlight(ball, {
    dt: SOLVER.dt,
    maxTime: SOLVER.maxFlightSeconds,
  });

  if (!flight.landing || !flight.atLanding) return null;
  if (flight.netCrossing?.blocked) return null;
  if (sideOfZ(flight.landing.z) !== striker) return null;

  const dt = SOLVER.dt;
  let state = flight.atLanding;
  let elapsed = flight.timeToLand;
  let apex = state.pos.y;
  let apexTime = elapsed;
  let apexPos = state.pos;
  let rising = state.vel.y > 0;

  for (let i = 0; i < Math.ceil(3 / dt); i++) {
    const previous = state;
    const { state: next, bounces } = stepBall(state, dt);
    elapsed += dt;

    if (next.pos.y > apex) {
      apex = next.pos.y;
      apexTime = elapsed;
      apexPos = next.pos;
    }
    if (previous.vel.y > 0 && next.vel.y <= 0) rising = false;

    // Descending back through the ideal contact height is the sweet spot.
    if (
      !rising &&
      previous.pos.y >= IDEAL_CONTACT_HEIGHT &&
      next.pos.y < IDEAL_CONTACT_HEIGHT
    ) {
      return {
        striker,
        idealTimeMs: nowMs + elapsed * 1000,
        contact: next.pos,
        landing: flight.landing,
      };
    }

    state = next;

    // A second bounce means the ball was never going to come up to height.
    if (bounces.length > 0) break;
  }

  return {
    striker,
    idealTimeMs: nowMs + apexTime * 1000,
    contact: apexPos,
    landing: flight.landing,
  };
}

/**
 * Put the serve in play.
 *
 * Serves bypass the groundstroke target logic entirely: the rules dictate which
 * box the ball must reach, so the target is constructed from the box and the
 * solver is asked for it directly. Harder serves scatter more, which is what
 * makes a second serve worth taking pace off.
 */
export function serve(
  state: RallyState,
  swing: SwingEvent
): { state: RallyState; events: RallyEvent[] } {
  if (state.phase !== "awaiting-serve") return { state, events: [] };

  const server = state.match.server;
  const box = serveBoxFor(state.match);
  const contact = serverContactPoint(server);
  const power = Math.max(0, Math.min(1, swing.power));

  const towards = server === "near" ? 1 : -1;
  // The deuce box is to the receiver's right, which is -x on the far side.
  const boxSign = box === "deuce" ? -towards : towards;

  const profile = SHOT_PROFILES.serve;
  const speed = profile.speed[0] + (profile.speed[1] - profile.speed[0]) * power;
  const spinRate = profile.spin[0] + (profile.spin[1] - profile.spin[0]) * power;

  // Wider placement and less margin as the serve gets bigger, tightened by the
  // server's skill on the same axis groundstrokes use.
  const scatter = (0.35 + power * 0.75) / Math.max(0.2, state.precision[server]);
  const lateral =
    boxSign * (1.0 + power * 1.9 + swing.lateralBias * 0.8) +
    gaussian(state.rng) * scatter;
  const depth =
    towards * (4.3 + power * 1.5 + gaussian(state.rng) * scatter * 0.7);

  const solution = solveLaunch({
    from: contact,
    target: vec(lateral, BALL.radius, depth),
    speed,
    spinRate,
  });

  const next: RallyState = {
    ...state,
    phase: "in-play",
    ball: { pos: contact, vel: solution.vel, spin: solution.spin },
    striker: otherSide(server),
    lastHitter: server,
    bouncesSinceHit: 0,
    hitCount: state.hitCount + 1,
    strike: null,
  };

  next.strike = computeStrikeWindow(next.ball, state.timeMs, otherSide(server));

  return {
    state: next,
    events: [{ type: "serve", by: server, box }],
  };
}

/**
 * Attempt to play the ball.
 *
 * A swing outside every timing window whiffs: the ball carries on and the point
 * is lost to the double bounce, rather than being taken away on the spot. That
 * keeps a mistimed swing feeling like a miss the player can see, not a silent
 * rejection by the input layer.
 */
export function applySwing(
  state: RallyState,
  swing: SwingEvent
): { state: RallyState; events: RallyEvent[] } {
  if (state.phase === "awaiting-serve") return serve(state, swing);
  if (state.phase !== "in-play") return { state, events: [] };
  if (!state.strike || state.strike.striker !== state.striker) {
    return { state, events: [] };
  }

  const striker = state.striker;
  // Swing timestamps arrive already corrected; sensor lag is the input
  // adapter's business, not the engine's.
  const { grade, quality, errorMs } = gradeTiming(
    swing.t,
    state.strike.idealTimeMs
  );

  if (grade === "miss") {
    return {
      state,
      events: [{ type: "whiff", by: striker, errorMs }],
    };
  }

  const contact = state.ball.pos;
  const kind = chooseShotKind(swing, contact.y, {
    low: RALLY.lowContactHeight,
    smash: RALLY.smashContactHeight,
  });

  const shot = resolveShot({
    contact,
    hitter: striker,
    kind,
    swing,
    quality,
    rng: state.rng,
    precision: state.precision[striker],
  });

  const next: RallyState = {
    ...state,
    ball: { pos: contact, vel: shot.vel, spin: shot.spin },
    striker: otherSide(striker),
    lastHitter: striker,
    bouncesSinceHit: 0,
    hitCount: state.hitCount + 1,
    serveFaults: 0,
    strike: null,
  };

  next.strike = computeStrikeWindow(next.ball, state.timeMs, otherSide(striker));

  return {
    state: next,
    events: [{ type: "hit", by: striker, kind, grade, contact, errorMs }],
  };
}

function concludePoint(
  state: RallyState,
  winner: Side,
  reason: PointReason
): { state: RallyState; events: RallyEvent[] } {
  return {
    state: {
      ...state,
      phase: "point-over",
      outcome: { winner, reason },
      match: awardPoint(state.match, winner),
      decidedAtMs: state.timeMs,
      strike: null,
    },
    events: [{ type: "point", winner, reason }],
  };
}

/** Advance the rally by `dtMs` of wall time. */
export function step(
  state: RallyState,
  dtMs: number
): { state: RallyState; events: RallyEvent[] } {
  if (state.phase !== "in-play") {
    return { state: { ...state, timeMs: state.timeMs + dtMs }, events: [] };
  }

  const events: RallyEvent[] = [];
  let current = state;
  let budget = state.accumulatorMs + dtMs;
  const stepMs = PHYSICS_DT * 1000;

  while (budget >= stepMs) {
    budget -= stepMs;

    const before = current.ball;
    const { state: ball, bounces } = stepBall(before, PHYSICS_DT);
    const timeMs = current.timeMs + stepMs;
    current = { ...current, ball, timeMs };

    // Net plane crossing.
    if (Math.sign(before.pos.z) !== Math.sign(ball.pos.z)) {
      const span = ball.pos.z - before.pos.z;
      const frac = Math.abs(span) < 1e-9 ? 0 : -before.pos.z / span;
      const height = before.pos.y + (ball.pos.y - before.pos.y) * frac;
      const x = before.pos.x + (ball.pos.x - before.pos.x) * frac;
      const cord = netHeightAt(x);

      if (height < cord && current.lastHitter) {
        const loser = current.lastHitter;
        events.push({ type: "net", by: loser });
        const done = concludePoint(
          { ...current, accumulatorMs: budget },
          otherSide(loser),
          "net"
        );
        return { state: done.state, events: [...events, ...done.events] };
      }

      // A serve grazing the cord and landing in is a let.
      if (
        current.hitCount === 1 &&
        height - cord < LET_MARGIN &&
        current.lastHitter
      ) {
        const landing = predictFlight(ball, { dt: SOLVER.dt }).landing;
        const box = serveBoxFor(current.match);
        if (landing && isInServiceBox(landing, current.striker, box)) {
          events.push({ type: "let" });
          return {
            state: {
              ...createRally(current.match, current.rng, current.precision),
              timeMs: current.timeMs,
              serveFaults: current.serveFaults,
            },
            events,
          };
        }
      }
    }

    for (const bounce of bounces) {
      const side = sideOfZ(bounce.at.z);
      const isServe = current.hitCount === 1;
      const inCourt = isServe
        ? isInServiceBox(bounce.at, side, serveBoxFor(current.match))
        : isInSinglesCourt(bounce.at, side);

      current = { ...current, bouncesSinceHit: current.bouncesSinceHit + 1 };
      events.push({ type: "bounce", at: bounce.at, side, inCourt });

      const hitter = current.lastHitter;
      if (!hitter) continue;

      // The ball came down on the hitter's own side: it never crossed.
      if (side === hitter && current.bouncesSinceHit === 1) {
        const done = concludePoint(
          { ...current, accumulatorMs: budget },
          otherSide(hitter),
          "net"
        );
        return { state: done.state, events: [...events, ...done.events] };
      }

      if (current.bouncesSinceHit === 1 && !inCourt) {
        if (isServe) {
          const faults = current.serveFaults + 1;
          events.push({ type: "fault", by: hitter, count: faults });

          if (faults >= 2) {
            const done = concludePoint(
              { ...current, accumulatorMs: budget },
              otherSide(hitter),
              "double-fault"
            );
            return { state: done.state, events: [...events, ...done.events] };
          }

          return {
            state: {
              ...createRally(current.match, current.rng, current.precision),
              timeMs: current.timeMs,
              serveFaults: faults,
            },
            events,
          };
        }

        const done = concludePoint(
          { ...current, accumulatorMs: budget },
          otherSide(hitter),
          "out"
        );
        return { state: done.state, events: [...events, ...done.events] };
      }

      if (current.bouncesSinceHit >= 2) {
        const done = concludePoint(
          { ...current, accumulatorMs: budget },
          otherSide(current.striker),
          "double-bounce"
        );
        return { state: done.state, events: [...events, ...done.events] };
      }
    }
  }

  return { state: { ...current, accumulatorMs: budget }, events };
}

/** True once the settle delay after a decided point has elapsed. */
export function readyForNextPoint(state: RallyState): boolean {
  if (state.phase !== "point-over" || state.decidedAtMs === null) return false;
  return state.timeMs - state.decidedAtMs >= RALLY.pointSettleSeconds * 1000;
}
