/**
 * Bot-versus-bot driver.
 *
 * Used to check that difficulty tiers actually differ in strength. Balance is a
 * statistical property, so it has to be measured over many points rather than
 * asserted from the constants.
 */

import { createBot, updateBot, type BotDifficulty, type BotState } from "../bot";
import { createRng, type Rng } from "../rng";
import {
  applySwing,
  createRally,
  nextPoint,
  readyForNextPoint,
  step,
  type RallyEvent,
  type RallyState,
} from "../rally";
import { createMatch, type MatchConfig, type Side } from "../scoring";

export type BotMatchResult = {
  state: RallyState;
  events: RallyEvent[];
  pointsPlayed: number;
  /** Points where the rally ran past the cap without resolving. */
  stalled: number;
  rallyLengths: number[];
};

export type BotMatchOptions = {
  seed?: number;
  frameMs?: number;
  /** Points to play, unless the match ends first. */
  maxPoints?: number;
  /** Simulated seconds a single point may run before it is abandoned. */
  maxPointSeconds?: number;
  matchConfig?: MatchConfig;
  firstServer?: Side;
};

export function playBotMatch(
  nearDifficulty: BotDifficulty,
  farDifficulty: BotDifficulty,
  options: BotMatchOptions = {}
): BotMatchResult {
  const frameMs = options.frameMs ?? 8;
  const maxPoints = options.maxPoints ?? 200;
  const maxFrames = Math.ceil(((options.maxPointSeconds ?? 45) * 1000) / frameMs);

  const rng: Rng = createRng(options.seed ?? 1);
  const match = createMatch(options.firstServer ?? "near", options.matchConfig);

  const precision = {
    near: nearDifficulty.precision,
    far: farDifficulty.precision,
  };

  let state = createRally(match, rng, precision);
  let near: BotState = createBot(nearDifficulty, "near", createRng(rng.seed ^ 0x9e3779b9));
  let far: BotState = createBot(farDifficulty, "far", createRng(rng.seed ^ 0x85ebca6b));

  const events: RallyEvent[] = [];
  const rallyLengths: number[] = [];
  let pointsPlayed = 0;
  let stalled = 0;

  for (let point = 0; point < maxPoints; point++) {
    let frames = 0;

    while (state.phase !== "point-over" && frames < maxFrames) {
      frames++;

      const nearUpdate = updateBot(near, state);
      near = nearUpdate.bot;
      if (nearUpdate.swing) {
        const result = applySwing(state, nearUpdate.swing);
        state = result.state;
        events.push(...result.events);
      }

      const farUpdate = updateBot(far, state);
      far = farUpdate.bot;
      if (farUpdate.swing) {
        const result = applySwing(state, farUpdate.swing);
        state = result.state;
        events.push(...result.events);
      }

      const advanced = step(state, frameMs);
      state = advanced.state;
      events.push(...advanced.events);
    }

    if (state.phase !== "point-over") {
      // Abandon the point but keep the match going. Bailing out entirely here
      // meant a single long rally threw away the whole sample, which made the
      // balance numbers look like the bots were barely playing.
      stalled++;
      state = createRally(state.match, rng, precision);
      continue;
    }

    rallyLengths.push(state.hitCount);
    pointsPlayed++;
    if (state.match.winner) break;

    let guard = 0;
    while (!readyForNextPoint(state) && guard++ < 500) {
      const advanced = step(state, 16);
      state = advanced.state;
      events.push(...advanced.events);
    }
    state = nextPoint(state);
  }

  return { state, events, pointsPlayed, stalled, rallyLengths };
}

/** Fraction of points won by the near side across several seeded matches. */
export function measureWinRate(
  nearDifficulty: BotDifficulty,
  farDifficulty: BotDifficulty,
  matches = 6,
  options: BotMatchOptions = {}
): { nearPoints: number; farPoints: number; rate: number; meanRally: number } {
  let nearPoints = 0;
  let farPoints = 0;
  const lengths: number[] = [];

  for (let i = 0; i < matches; i++) {
    const result = playBotMatch(nearDifficulty, farDifficulty, {
      ...options,
      seed: 1000 + i * 7919,
    });

    for (const event of result.events) {
      if (event.type === "point") {
        if (event.winner === "near") nearPoints++;
        else farPoints++;
      }
    }
    lengths.push(...result.rallyLengths);
  }

  const total = nearPoints + farPoints;
  return {
    nearPoints,
    farPoints,
    rate: total === 0 ? 0 : nearPoints / total,
    meanRally: lengths.length
      ? lengths.reduce((a, b) => a + b, 0) / lengths.length
      : 0,
  };
}
