/**
 * A scripted swinger for headless tests.
 *
 * Stands in for both the camera and the bot so the rally engine can be driven
 * end to end without either. Swings are issued the way a real pose pipeline
 * would report them — timestamped late by the latency budget — so the tests
 * exercise the same compensation path that live play does.
 */

import { TIMING } from "../config";
import {
  applySwing,
  nextPoint,
  readyForNextPoint,
  step,
  type RallyEvent,
  type RallyState,
} from "../rally";
import type { Side } from "../scoring";
import type { SwingArc, SwingEvent } from "../shotTypes";

export type AutoPlayerOptions = {
  /** Milliseconds of timing error to add, per side. Positive is late. */
  offsetMs?: Partial<Record<Side, number>>;
  /** Swing arc each side uses. */
  arc?: Partial<Record<Side, SwingArc>>;
  power?: Partial<Record<Side, number>>;
  lateralBias?: Partial<Record<Side, number>>;
  /** Sides listed here never swing, so they lose the point. */
  passive?: Side[];
  /** Simulated wall-clock step, in ms. */
  frameMs?: number;
};

export type DriveResult = {
  state: RallyState;
  events: RallyEvent[];
  /** Frames actually simulated, for spotting runaway loops. */
  frames: number;
  /**
   * True when the budget ran out with the point still live. Two well-timed
   * players rally indefinitely — neither makes an error — so this is an
   * expected outcome, not necessarily a failure.
   */
  timedOut: boolean;
};

const swingFor = (
  side: Side,
  t: number,
  options: AutoPlayerOptions
): SwingEvent => ({
  t,
  arc: options.arc?.[side] ?? "low-to-high",
  power: options.power?.[side] ?? 0.65,
  lateralBias: options.lateralBias?.[side] ?? 0,
  side: "forehand",
});

/** Run one point to completion, or until `maxMs` of simulated time elapses. */
export function playPoint(
  initial: RallyState,
  options: AutoPlayerOptions = {},
  maxMs = 60_000
): DriveResult {
  const frameMs = options.frameMs ?? 8;
  const passive = new Set(options.passive ?? []);
  const events: RallyEvent[] = [];

  let state = initial;
  let frames = 0;
  const limit = Math.ceil(maxMs / frameMs);

  while (state.phase !== "point-over" && frames < limit) {
    frames++;

    if (state.phase === "awaiting-serve") {
      const server = state.match.server;
      if (passive.has(server)) break;
      const result = applySwing(
        state,
        swingFor(server, state.timeMs + TIMING.latencyCompensationMs, options)
      );
      state = result.state;
      events.push(...result.events);
      continue;
    }

    const strike = state.strike;
    if (
      strike &&
      !passive.has(strike.striker) &&
      state.timeMs >= strike.idealTimeMs + (options.offsetMs?.[strike.striker] ?? 0)
    ) {
      const result = applySwing(
        state,
        swingFor(
          strike.striker,
          state.timeMs + TIMING.latencyCompensationMs,
          options
        )
      );
      state = result.state;
      events.push(...result.events);
      // A whiff leaves the window in place; move on rather than swinging again.
      if (result.events.some((e) => e.type === "whiff")) {
        const advanced = step(state, frameMs);
        state = advanced.state;
        events.push(...advanced.events);
      }
      continue;
    }

    const advanced = step(state, frameMs);
    state = advanced.state;
    events.push(...advanced.events);
  }

  return { state, events, frames, timedOut: frames >= limit };
}

/**
 * Play a run of points.
 *
 * Stops early if a point cannot be resolved within its budget: continuing would
 * quietly let the settle loop finish the rally on the players' behalf, which
 * once made an unfinished point look like a completed one.
 */
export function playPoints(
  initial: RallyState,
  count: number,
  options: AutoPlayerOptions = {}
): DriveResult {
  let state = initial;
  const events: RallyEvent[] = [];
  let frames = 0;

  for (let i = 0; i < count; i++) {
    const result = playPoint(state, options);
    events.push(...result.events);
    frames += result.frames;
    state = result.state;

    if (result.timedOut) return { state, events, frames, timedOut: true };
    if (state.match.winner) break;

    // Settle, then serve the next point.
    let guard = 0;
    while (!readyForNextPoint(state) && guard++ < 500) {
      const advanced = step(state, 16);
      state = advanced.state;
      events.push(...advanced.events);
    }
    state = nextPoint(state);
  }

  return { state, events, frames, timedOut: false };
}
