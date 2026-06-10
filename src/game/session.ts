/**
 * The live game session.
 *
 * Owns the rally, the bots and the clock, and exposes a single `advance` for the
 * render loop to call. This is the only mutable layer above the engine; the
 * engine itself stays pure so it remains testable and replayable.
 */

import {
  createAdaptiveState,
  describeLevel,
  difficultyAt,
  observePoint,
  type AdaptiveState,
} from "../engine/adaptiveDifficulty";
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
import {
  createMatchStats,
  foldEvent,
  type MatchStats,
} from "../engine/matchStats";
import {
  createMatch,
  stakeFor,
  type MatchConfig,
  otherSide,
  type Side,
  type Stake,
} from "../engine/scoring";
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
  /**
   * Let the opponent track the player's level instead of sitting on a preset.
   *
   * On by default against a human: fixed presets leave gaps, and a match that
   * is a rout in either direction is not a match.
   */
  adaptive?: boolean;
  /**
   * Rally without keeping score.
   *
   * A match is a poor place to learn a control scheme: the recorded player
   * spent three minutes losing before finding the timing. Practice keeps the
   * rallies and drops the consequences.
   */
  practice?: boolean;
};

export type Session = {
  state: RallyState;
  /**
   * Events produced so far this frame, by swings and by `advance` alike.
   *
   * Cleared by `beginFrame`, never by `advance`: the player's own swings are
   * submitted before `advance` runs, so clearing there discarded every event
   * from their own shot — no sound, no hit-stop, no timing feedback, and only
   * the bot's shots ever registering.
   */
  events: RallyEvent[];
  /** Call once at the top of each frame, before submitting any input. */
  beginFrame: () => void;
  advance: (dtMs: number) => void;
  /** Feed a swing from a human input adapter. */
  swing: (event: SwingEvent) => void;
  /** True when the given side is waiting on a human to act. */
  awaitingHuman: (side: Side) => boolean;
  /** Everything that has happened, for the scoreboard and the summary. */
  readonly stats: MatchStats;
  /** What the near player has at stake on this point, if anything. */
  readonly nearStake: Stake | null;
  /** What the opponent has at stake, which is equally worth knowing. */
  readonly farStake: Stake | null;
  /** Shots in the rally in progress, and the best so far. Practice only. */
  readonly rallyLength: number;
  readonly bestRally: number;
  /** Total balls returned in practice, across all rallies. */
  readonly totalReturns: number;
  /** Opponent level, 0..1, or null when not adapting. */
  readonly difficultyLevel: number | null;
  /** Short label for that level. */
  readonly difficultyLabel: string | null;
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

  // Only the far side adapts, and only against a human: a bot-versus-bot match
  // is used for balance measurement, where a moving target would be useless.
  const practice = options.practice ?? false;
  // Practice deliberately does not adapt: a target that keeps shifting is the
  // opposite of what someone grooving a swing needs.
  const adapting =
    !practice &&
    (options.adaptive ?? true) &&
    options.near === "human" &&
    options.far === "bot";
  let adaptive: AdaptiveState | null = adapting ? createAdaptiveState() : null;
  let stats: MatchStats = createMatchStats();
  let bestRally = 0;

  let bots: Partial<Record<Side, BotState>> = {};
  if (options.near === "bot") {
    bots.near = createBot(options.nearDifficulty, "near", createRng(rng.seed ^ 0x9e3779b9));
  }
  if (options.far === "bot") {
    const startingDifficulty = adaptive
      ? difficultyAt(adaptive.level)
      : options.farDifficulty;
    if (adaptive) precision.far = startingDifficulty.precision;
    bots.far = createBot(startingDifficulty, "far", createRng(rng.seed ^ 0x85ebca6b));
  }

  const session: Session = {
    state: createRally(match, rng, precision),
    events: [],
    options,

    get stats() {
      return stats;
    },

    get rallyLength() {
      return stats.currentRally;
    },

    get bestRally() {
      return bestRally;
    },

    get totalReturns() {
      // Derived from the graded swings rather than counted separately: the
      // player's own hits arrive through `swing`, not `advance`, so counting
      // them here would have missed every one of them.
      const { perfect, good, weak } = stats.timing;
      return perfect + good + weak;
    },

    get nearStake() {
      return stakeFor(session.state.match, "near");
    },

    get farStake() {
      return stakeFor(session.state.match, "far");
    },

    get difficultyLevel() {
      return adaptive ? adaptive.level : null;
    },

    get difficultyLabel() {
      return adaptive ? describeLevel(adaptive.level) : null;
    },

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
      for (const e of result.events) stats = foldEvent(stats, e);
    },

    beginFrame() {
      session.events = [];
    },

    advance(dtMs) {
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
          for (const e of result.events) stats = foldEvent(stats, e);
        }
      }

      const advanced = step(session.state, dt);
      session.state = advanced.state;
      session.events.push(...advanced.events);
      for (const e of advanced.events) stats = foldEvent(stats, e);

      if (practice) {
        for (const event of advanced.events) {
          if (event.type !== "point") continue;
          bestRally = Math.max(bestRally, stats.longestRally);
          // Wipe the score so the rally is the only thing that carries over.
          session.state = {
            ...session.state,
            match: createMatch(otherSide(session.state.match.server), options.matchConfig),
          };
        }
      }

      if (adaptive) {
        for (const event of advanced.events) {
          if (event.type !== "point") continue;
          adaptive = observePoint(adaptive, event.winner === "far");

          // Retune between points, never during one: changing the opponent
          // mid-rally would rewrite a shot the player is already reacting to.
          const tuned = difficultyAt(adaptive.level);
          const bot = bots.far;
          if (bot) bots.far = { ...bot, difficulty: tuned };
          session.state = {
            ...session.state,
            precision: { ...session.state.precision, far: tuned.precision },
          };
        }
      }

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
