/**
 * Head-to-head play over a transport.
 *
 * The host runs the only simulation and broadcasts it. The guest renders what
 * it is told and sends its swings back. Both see themselves at the bottom of
 * the screen, which is what all the mirroring is for.
 *
 * Presenting the same surface as the single-player `Session` means the render
 * loop, the scene and the HUD do not know or care which one they are driving.
 */

import { stepBall } from "../engine/ball";
import { PHYSICS_DT } from "../engine/constants";
import {
  createMatchStats,
  foldEvent,
  type MatchStats,
} from "../engine/matchStats";
import {
  applySwing,
  createRally,
  nextPoint,
  readyForNextPoint,
  step,
  type RallyEvent,
  type RallyState,
} from "../engine/rally";
import { createRng } from "../engine/rng";
import { createMatch, stakeFor, type Side, type Stake } from "../engine/scoring";
import type { SwingEvent } from "../engine/shotTypes";
import {
  mirrorEvent,
  mirrorSnapshot,
  PROTOCOL_VERSION,
  type NetEvent,
  type NetSnapshot,
} from "./protocol";
import type { Transport } from "./transport";

export type NetRole = "host" | "guest";

export type NetStatus = "connecting" | "playing" | "closed";

export type NetSession = {
  readonly role: NetRole;
  readonly status: NetStatus;
  /** Always in the local player's frame: they are always "near". */
  state: RallyState;
  events: RallyEvent[];
  readonly stats: MatchStats;
  readonly nearStake: Stake | null;
  readonly farStake: Stake | null;
  /** Round-trip estimate in ms, or null before the first exchange. */
  readonly pingMs: number | null;
  /**
   * Present so a net session is a drop-in for the single-player one and the
   * render loop needs no branches. Difficulty is meaningless against a human,
   * and the practice counters belong to a mode that cannot be networked.
   */
  readonly difficultyLevel: null;
  readonly difficultyLabel: null;
  readonly rallyLength: number;
  readonly bestRally: number;
  readonly totalReturns: number;
  beginFrame: () => void;
  advance: (dtMs: number) => void;
  swing: (event: SwingEvent) => void;
  dispose: () => void;
};

/** How often the host broadcasts the world. */
const SNAPSHOT_HZ = 30;

/**
 * Whether it is this side's turn to act.
 *
 * The host must not let a guest's swing serve on its behalf: `applySwing` keys
 * off whoever is on strike, so an ungated remote swing during the host's own
 * serve would be applied as the host's.
 */
function isDue(state: RallyState, side: Side): boolean {
  if (state.phase === "awaiting-serve") return state.match.server === side;
  if (state.phase !== "in-play") return false;
  return state.strike?.striker === side;
}

function toNetEvents(events: readonly RallyEvent[]): NetEvent[] {
  const out: NetEvent[] = [];
  for (const event of events) {
    switch (event.type) {
      case "bounce":
        out.push({ type: "bounce", at: event.at, side: event.side, inCourt: event.inCourt });
        break;
      case "hit":
        out.push({
          type: "hit",
          by: event.by,
          kind: event.kind,
          grade: event.grade,
          footwork: event.footwork,
        });
        break;
      case "whiff":
      case "net":
        out.push({ type: event.type, by: event.by });
        break;
      case "fault":
        out.push({ type: "fault", by: event.by, count: event.count });
        break;
      case "serve":
        out.push({ type: "serve", by: event.by });
        break;
      case "point":
        out.push({ type: "point", winner: event.winner, reason: event.reason });
        break;
      case "let":
        break;
    }
  }
  return out;
}

/** Widen a net event back into the shape the HUD and scene already consume. */
function toRallyEvents(events: readonly NetEvent[]): RallyEvent[] {
  return events.map((event) => {
    switch (event.type) {
      case "hit":
        return {
          type: "hit",
          by: event.by,
          kind: event.kind,
          grade: event.grade,
          contact: { x: 0, y: 0, z: 0 },
          errorMs: 0,
          footwork: event.footwork,
        } as RallyEvent;
      case "serve":
        return { type: "serve", by: event.by, box: "deuce" } as RallyEvent;
      case "whiff":
        return { type: "whiff", by: event.by, errorMs: 0 } as RallyEvent;
      default:
        return event as RallyEvent;
    }
  });
}

export function createNetSession(
  role: NetRole,
  transport: Transport,
  options: { seed?: number } = {}
): NetSession {
  const rng = createRng(options.seed ?? 20260729);
  let status: NetStatus = "connecting";
  let stats: MatchStats = createMatchStats();
  let pingMs: number | null = null;
  let lastHelloAt: number | null = null;

  // Host time between snapshot broadcasts.
  let sinceSnapshot = 0;

  const session: NetSession = {
    role,
    get status() {
      return status;
    },
    state: createRally(createMatch("near"), rng),
    events: [],
    get stats() {
      return stats;
    },
    get nearStake() {
      return stakeFor(session.state.match, "near");
    },
    get farStake() {
      return stakeFor(session.state.match, "far");
    },
    get pingMs() {
      return pingMs;
    },
    difficultyLevel: null,
    difficultyLabel: null,
    get rallyLength() {
      return stats.currentRally;
    },
    get bestRally() {
      return stats.longestRally;
    },
    get totalReturns() {
      const { perfect, good, weak } = stats.timing;
      return perfect + good + weak;
    },

    beginFrame() {
      session.events = [];
    },

    advance(dtMs) {
      const dt = Math.min(dtMs, 100);

      if (role === "host") {
        const advanced = step(session.state, dt);
        session.state = advanced.state;
        session.events.push(...advanced.events);
        for (const e of advanced.events) stats = foldEvent(stats, e);

        if (
          session.state.phase === "point-over" &&
          readyForNextPoint(session.state) &&
          !session.state.match.winner
        ) {
          session.state = nextPoint(session.state);
        }

        sinceSnapshot += dt;
        if (sinceSnapshot >= 1000 / SNAPSHOT_HZ) {
          sinceSnapshot = 0;
          broadcastState();
        }
        if (session.events.length > 0) {
          transport.send({ t: "events", events: toNetEvents(session.events) });
        }
        return;
      }

      // Guest: no simulation, only smoothing. Carrying the ball forward with
      // the real physics between snapshots is what keeps it from juddering at
      // the snapshot rate, and it is corrected the moment the next one lands.
      if (session.state.phase === "in-play") {
        let remaining = dt / 1000;
        let ball = session.state.ball;
        while (remaining > 1e-6) {
          const slice = Math.min(PHYSICS_DT, remaining);
          ball = stepBall(ball, slice).state;
          remaining -= slice;
        }
        session.state = {
          ...session.state,
          ball,
          timeMs: session.state.timeMs + dt,
        };
      } else {
        session.state = { ...session.state, timeMs: session.state.timeMs + dt };
      }
    },

    swing(event) {
      if (role === "guest") {
        // The guest never simulates its own swing: the host decides what the
        // ball did, and a local guess would only have to be taken back.
        transport.send({ t: "swing", swing: event });
        return;
      }

      if (!isDue(session.state, "near")) return;
      const result = applySwing(session.state, event);
      session.state = result.state;
      session.events.push(...result.events);
      for (const e of result.events) stats = foldEvent(stats, e);
    },

    dispose() {
      if (transport.open) transport.send({ t: "bye", reason: "left" });
      transport.close();
      status = "closed";
    },
  };

  function broadcastState() {
    const s = session.state;
    const snapshot: NetSnapshot = {
      t: s.timeMs,
      phase: s.phase,
      ball: s.ball,
      striker: s.striker,
      lastHitter: s.lastHitter,
      serveFaults: s.serveFaults,
      strike: s.strike,
      match: s.match,
      outcome: s.outcome,
    };
    transport.send({ t: "state", snapshot });
  }

  transport.onMessage((message) => {
    switch (message.t) {
      case "hello":
        if (message.version !== PROTOCOL_VERSION) {
          transport.send({ t: "bye", reason: "version mismatch" });
          transport.close();
          status = "closed";
          return;
        }
        if (role === "host") {
          transport.send({ t: "hello", version: PROTOCOL_VERSION, role: "host" });
          broadcastState();
        }
        status = "playing";
        if (lastHelloAt !== null) pingMs = Date.now() - lastHelloAt;
        break;

      case "ready":
        status = "playing";
        break;

      case "swing":
        // Guests may only act when it is genuinely their turn.
        if (role !== "host") return;
        if (!isDue(session.state, "far")) return;
        {
          const result = applySwing(session.state, message.swing);
          session.state = result.state;
          session.events.push(...result.events);
          for (const e of result.events) stats = foldEvent(stats, e);
        }
        break;

      case "state": {
        if (role !== "guest") return;
        status = "playing";
        const mirrored = mirrorSnapshot(message.snapshot);
        session.state = {
          ...session.state,
          phase: mirrored.phase,
          ball: mirrored.ball,
          striker: mirrored.striker,
          lastHitter: mirrored.lastHitter,
          serveFaults: mirrored.serveFaults,
          strike: mirrored.strike,
          match: mirrored.match,
          outcome: mirrored.outcome,
          timeMs: mirrored.t,
        };
        break;
      }

      case "events": {
        if (role !== "guest") return;
        const mirrored = message.events.map(mirrorEvent);
        const widened = toRallyEvents(mirrored);
        session.events.push(...widened);
        for (const e of widened) stats = foldEvent(stats, e);
        break;
      }

      case "bye":
        status = "closed";
        break;
    }
  });

  transport.onClose(() => {
    status = "closed";
  });

  lastHelloAt = Date.now();
  transport.send({ t: "hello", version: PROTOCOL_VERSION, role });

  return session;
}
