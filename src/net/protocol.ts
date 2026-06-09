/**
 * What travels between two players.
 *
 * The host is authoritative: it runs the only real simulation, and the guest
 * renders what it is told. That is a deliberate choice over deterministic
 * lockstep — the engine *is* deterministic, but `advance` takes a variable
 * delta, so two peers with different frame timings would apply swings at
 * different points in the accumulator and drift apart silently. An authoritative
 * host cannot desync at all, and tennis has the latency budget to absorb the
 * round trip: the ball is in the air for 700-900 ms, against an RTT of tens.
 *
 * Everything here is pure and serialisable, so it can be tested without a
 * network and replayed from a log.
 */

import type { BallState } from "../engine/ball";
import type { PointReason, RallyPhase, StrikeWindow } from "../engine/rally";
import type { MatchState, Side } from "../engine/scoring";
import type { SwingEvent } from "../engine/shotTypes";
import type { Vec3 } from "../engine/vec3";

/** Bumped whenever the wire format changes incompatibly. */
export const PROTOCOL_VERSION = 1;

/**
 * The authoritative state a guest needs in order to draw the world.
 *
 * Deliberately not the whole `RallyState`: the RNG, the accumulator and the
 * physics bookkeeping are the host's business, and shipping them would invite
 * a guest to try simulating.
 */
export type NetSnapshot = {
  /** Host clock in ms, for ordering and staleness checks. */
  t: number;
  phase: RallyPhase;
  ball: BallState;
  striker: Side;
  lastHitter: Side | null;
  serveFaults: number;
  strike: StrikeWindow | null;
  match: MatchState;
  outcome: { winner: Side; reason: PointReason } | null;
};

export type NetMessage =
  | { t: "hello"; version: number; role: "host" | "guest" }
  | { t: "ready" }
  /** Guest to host: I swung. The host decides what it did. */
  | { t: "swing"; swing: SwingEvent }
  /** Host to guest: this is the world. */
  | { t: "state"; snapshot: NetSnapshot }
  /**
   * Host to guest: these things happened.
   *
   * Sent separately from state because sound, hit-stop and the HUD react to
   * discrete moments, and a guest sampling snapshots would miss any event that
   * began and ended between two of them.
   */
  | { t: "events"; events: NetEvent[] }
  | { t: "bye"; reason: string };

/**
 * The subset of rally events worth sending.
 *
 * Trimmed of anything the guest cannot use, so a burst of physics detail never
 * competes with the state stream for bandwidth.
 */
export type NetEvent =
  | { type: "bounce"; at: Vec3; side: Side; inCourt: boolean }
  | { type: "hit"; by: Side; kind: string; grade: string; footwork: number }
  | { type: "whiff"; by: Side }
  | { type: "net"; by: Side }
  | { type: "fault"; by: Side; count: number }
  | { type: "serve"; by: Side }
  | { type: "point"; winner: Side; reason: PointReason };

const flip = (v: Vec3): Vec3 => ({ x: -v.x, y: v.y, z: -v.z });

const otherSide = (side: Side): Side => (side === "near" ? "far" : "near");

const swapSides = <T>(record: Record<Side, T>): Record<Side, T> => ({
  near: record.far,
  far: record.near,
});

/**
 * Turn the host's world into the guest's.
 *
 * Both players must see themselves at the bottom of the screen, so the guest's
 * copy is rotated 180 degrees about the vertical axis and every side label is
 * swapped. Spin flips with it: angular velocity transforms as a vector under a
 * proper rotation, so x and z negate while y is unchanged.
 */
export function mirrorSnapshot(snapshot: NetSnapshot): NetSnapshot {
  return {
    t: snapshot.t,
    phase: snapshot.phase,
    ball: {
      pos: flip(snapshot.ball.pos),
      vel: flip(snapshot.ball.vel),
      spin: flip(snapshot.ball.spin),
    },
    striker: otherSide(snapshot.striker),
    lastHitter: snapshot.lastHitter ? otherSide(snapshot.lastHitter) : null,
    serveFaults: snapshot.serveFaults,
    strike: snapshot.strike
      ? {
          striker: otherSide(snapshot.strike.striker),
          idealTimeMs: snapshot.strike.idealTimeMs,
          contact: flip(snapshot.strike.contact),
          landing: snapshot.strike.landing ? flip(snapshot.strike.landing) : null,
          landingTimeMs: snapshot.strike.landingTimeMs,
        }
      : null,
    match: mirrorMatch(snapshot.match),
    outcome: snapshot.outcome
      ? { winner: otherSide(snapshot.outcome.winner), reason: snapshot.outcome.reason }
      : null,
  };
}

export function mirrorMatch(match: MatchState): MatchState {
  return {
    ...match,
    points: swapSides(match.points),
    games: swapSides(match.games),
    sets: swapSides(match.sets),
    history: match.history.map((set) => ({ near: set.far, far: set.near })),
    server: otherSide(match.server),
    tiebreakFirstServer: match.tiebreakFirstServer
      ? otherSide(match.tiebreakFirstServer)
      : null,
    winner: match.winner ? otherSide(match.winner) : null,
  };
}

export function mirrorEvent(event: NetEvent): NetEvent {
  switch (event.type) {
    case "bounce":
      return { ...event, at: flip(event.at), side: otherSide(event.side) };
    case "point":
      return { ...event, winner: otherSide(event.winner) };
    default:
      return { ...event, by: otherSide(event.by) };
  }
}

/**
 * A swing made on the guest's mirrored court, expressed in the host's frame.
 *
 * `lateralBias` and `stance` are already relative to the player who swung, so
 * they cross unchanged — the host applies them through `playerRightX` for
 * whichever side that player is on. Only the side label needs flipping, and
 * that is implied by which peer sent it.
 */
export function swingFromGuest(swing: SwingEvent): SwingEvent {
  return { ...swing };
}

export function encode(message: NetMessage): string {
  return JSON.stringify(message);
}

/**
 * Parse a message off the wire.
 *
 * Returns null rather than throwing on anything malformed: a peer sending
 * nonsense should not take the game down with it.
 */
export function decode(raw: string): NetMessage | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const message = parsed as NetMessage;
    switch (message.t) {
      case "hello":
      case "ready":
      case "swing":
      case "state":
      case "events":
      case "bye":
        return message;
      default:
        return null;
    }
  } catch {
    return null;
  }
}
