import { describe, expect, it } from "vitest";
import { DIFFICULTIES } from "../engine/bot";
import type { SwingEvent } from "../engine/shotTypes";
import { createSession, type Session } from "./session";

const swing = (over: Partial<SwingEvent> = {}): SwingEvent => ({
  t: 0,
  arc: "overhead",
  power: 0.6,
  lateralBias: 0,
  side: "forehand",
  ...over,
});

function humanVsBot(): Session {
  return createSession({
    near: "human",
    far: "bot",
    nearDifficulty: DIFFICULTIES.club!,
    farDifficulty: DIFFICULTIES.club!,
    seed: 31,
  });
}

/** Mirror what the render loop does for one frame. */
function frame(session: Session, submit?: () => void, dtMs = 16) {
  session.beginFrame();
  submit?.();
  session.advance(dtMs);
  return session.events;
}

/**
 * Serve, then decline to play the return, until `count` points are lost.
 *
 * The human serves first, so a test that simply never swings never starts the
 * match at all — nothing happens and nothing adapts.
 */
function concedePoints(session: Session, count: number) {
  let conceded = 0;
  for (let i = 0; i < 20000 && conceded < count; i++) {
    const events = frame(session, () => {
      if (session.state.phase === "awaiting-serve") {
        session.swing(swing({ t: session.state.timeMs }));
      }
    });
    conceded += events.filter((e) => e.type === "point").length;
  }
  return conceded;
}

describe("adaptive opponent", () => {
  it("starts adapting against a human and reports its level", () => {
    const session = humanVsBot();
    expect(session.difficultyLevel).not.toBeNull();
    expect(session.difficultyLabel).not.toBeNull();
  });

  it("does not adapt in a bot-versus-bot match", () => {
    // Balance measurement needs a fixed opponent, not a moving target.
    const session = createSession({
      near: "bot",
      far: "bot",
      nearDifficulty: DIFFICULTIES.club!,
      farDifficulty: DIFFICULTIES.club!,
    });
    expect(session.difficultyLevel).toBeNull();
  });

  it("eases off after losing a run of points", () => {
    const session = humanVsBot();
    const before = session.difficultyLevel!;

    concedePoints(session, 12);

    expect(session.state.match.games.far + session.state.match.points.far)
      .toBeGreaterThan(0);
    expect(session.difficultyLevel!).toBeLessThan(before);
  });

  it("keeps the far side's precision in step with its level", () => {
    const session = humanVsBot();
    const startingPrecision = session.state.precision.far;

    concedePoints(session, 12);

    // The level fell, so shot-making skill must have fallen with it.
    expect(session.state.precision.far).toBeLessThan(startingPrecision);
  });
});

describe("session event buffer", () => {
  it("keeps events from the player's own swing", () => {
    // Regression: `advance` used to clear the buffer, and the player's swings
    // are submitted before it runs — so every event from their own shot was
    // discarded. No sound, no hit-stop, no timing feedback; only the bot's
    // shots ever registered, which is why bot-vs-bot always looked correct.
    const session = humanVsBot();

    const events = frame(session, () =>
      session.swing(swing({ t: session.state.timeMs }))
    );

    expect(events.some((e) => e.type === "serve")).toBe(true);
  });

  it("clears the buffer between frames", () => {
    const session = humanVsBot();

    frame(session, () => session.swing(swing({ t: session.state.timeMs })));
    const second = frame(session);

    expect(second.some((e) => e.type === "serve")).toBe(false);
  });

  it("carries a rally hit and its footwork through to the consumer", () => {
    const session = humanVsBot();
    frame(session, () => session.swing(swing({ t: session.state.timeMs })));

    // Advance to the far bot's reply and on to our own strike window.
    let ours: ReturnType<typeof frame> = [];
    for (let i = 0; i < 900; i++) {
      const strike = session.state.strike;
      const due =
        strike?.striker === "near" && session.state.timeMs >= strike.idealTimeMs;

      const events = frame(session, () => {
        if (due) {
          session.swing(
            swing({
              t: session.state.timeMs,
              arc: "low-to-high",
              stance: 1,
            })
          );
        }
      });

      const hit = events.find((e) => e.type === "hit" && e.by === "near");
      if (hit) {
        ours = events;
        break;
      }
    }

    const hit = ours.find((e) => e.type === "hit");
    expect(hit).toBeDefined();
    if (hit?.type !== "hit") throw new Error("expected a hit event");
    expect(hit.by).toBe("near");
    expect(typeof hit.footwork).toBe("number");
  });

  it("still reports the bot's events", () => {
    const session = createSession({
      near: "bot",
      far: "bot",
      nearDifficulty: DIFFICULTIES.club!,
      farDifficulty: DIFFICULTIES.club!,
      seed: 7,
    });

    let sawServe = false;
    for (let i = 0; i < 400 && !sawServe; i++) {
      sawServe = frame(session).some((e) => e.type === "serve");
    }
    expect(sawServe).toBe(true);
  });
});
