/**
 * The live game session.
 *
 * Owns the rally, the bots and the clock, and exposes a single `advance` for the
 * render loop to call. This is the only mutable layer above the engine; the
 * engine itself stays pure so it remains testable and replayable.
 */

import {
  createBot,
  updateBot,
  type BotDifficulty,
  type BotState,
} from "../engine/bot";
import { createRng } from "../engine/rng";
import {
  applySwing,
  createRally,
  nextPoint,
  readyForNextPoint,
  step,
  type RallyEvent,
  type RallyState,
} from "../engine/rally";
import { createMatch, type MatchConfig, type Side } from "../engine/scoring";
import type { SwingEvent } from "../engine/shotTypes";

export type Controller = "human" | "bot";

export type SessionOptions = {
  near: Controller;
  far: Controller;
  nearDifficulty: BotDifficulty;
  farDifficulty: BotDifficulty;
  /** Skill for a human-controlled side; bots use their difficulty's value. */
  humanPrecision?: number;
  seed?: number;
  matchConfig?: MatchConfig;
  firstServer?: Side;
};

export type Session = {
  state: RallyState;
  /** Events produced by the most recent `advance`. */
  events: RallyEvent[];
  advance: (dtMs: number) => void;
  /** Feed a swing from a human input adapter. */
  swing: (event: SwingEvent) => void;
  /** True when the given side is waiting on a human to act. */
  awaitingHuman: (side: Side) => boolean;
  options: SessionOptions;
};

export function createSession(options: SessionOptions): Session {
  const rng = createRng(options.seed ?? 20260729);

  const precision: Record<Side, number> = {
    near:
      options.near === "bot"
        ? options.nearDifficulty.precision
        : (options.humanPrecision ?? 1),
    far:
      options.far === "bot"
        ? options.farDifficulty.precision
        : (options.humanPrecision ?? 1),
  };

  const match = createMatch(options.firstServer ?? "near", options.matchConfig);

  let bots: Partial<Record<Side, BotState>> = {};
  if (options.near === "bot") {
    bots.near = createBot(options.nearDifficulty, "near", createRng(rng.seed ^ 0x9e3779b9));
  }
  if (options.far === "bot") {
    bots.far = createBot(options.farDifficulty, "far", createRng(rng.seed ^ 0x85ebca6b));
  }

  const session: Session = {
    state: createRally(match, rng, precision),
    events: [],
    options,

    awaitingHuman(side) {
      const controller = side === "near" ? options.near : options.far;
      if (controller !== "human") return false;
      if (session.state.phase === "awaiting-serve") {
        return session.state.match.server === side;
      }
      return session.state.strike?.striker === side;
    },

    swing(event) {
      const result = applySwing(session.state, event);
      session.state = result.state;
      session.events.push(...result.events);
    },

    advance(dtMs) {
      session.events = [];

      // Cap the delta so a backgrounded tab does not fast-forward the match.
      const dt = Math.min(dtMs, 100);

      for (const side of ["near", "far"] as const) {
        const bot = bots[side];
        if (!bot) continue;
        const update = updateBot(bot, session.state);
        bots[side] = update.bot;
        if (update.swing) {
          const result = applySwing(session.state, update.swing);
          session.state = result.state;
          session.events.push(...result.events);
        }
      }

      const advanced = step(session.state, dt);
      session.state = advanced.state;
      session.events.push(...advanced.events);

      if (
        session.state.phase === "point-over" &&
        readyForNextPoint(session.state) &&
        !session.state.match.winner
      ) {
        session.state = nextPoint(session.state);
      }
    },
  };

  return session;
}
