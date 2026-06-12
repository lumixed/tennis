/**
 * Keyboard input adapter.
 *
 * Produces exactly the `SwingEvent` the pose adapter will later produce, which
 * is the whole point: the game can be tuned and played long before any camera
 * work exists, and the vision layer has a working reference to match.
 *
 * Power is charged by holding and released on key-up, mirroring a real swing's
 * wind-up — and mirroring the gesture the pose adapter will detect.
 */

import type { SwingArc, SwingEvent } from "../engine/shotTypes";

const ARC_KEYS: Record<string, SwingArc> = {
  KeyJ: "low-to-high",
  Space: "low-to-high",
  KeyK: "flat",
  KeyL: "high-to-low",
  KeyI: "overhead",
};

const AIM_LEFT = new Set(["ArrowLeft", "KeyA"]);
const AIM_RIGHT = new Set(["ArrowRight", "KeyD"]);

/** Hold time, in ms, that charges a swing to full power. */
const FULL_CHARGE_MS = 620;
const MIN_POWER = 0.25;

export type KeyboardInput = {
  /** Current aim, -1..1. */
  aim: number;
  /** 0..1 charge of the swing being held, or 0 when idle. */
  charge: number;
  /** Called each frame to decay aim and update charge. */
  update: (nowMs: number, dt: number) => void;
  /** Swings released since the last drain. */
  drain: () => SwingEvent[];
  dispose: () => void;
};

export function createKeyboardInput(
  target: Window | HTMLElement = window
): KeyboardInput {
  let aim = 0;
  let aimLeft = false;
  let aimRight = false;
  let holding: { arc: SwingArc; since: number } | null = null;
  let charge = 0;
  const pending: SwingEvent[] = [];

  const onKeyDown = (event: Event) => {
    const e = event as KeyboardEvent;
    if (e.repeat) return;

    if (AIM_LEFT.has(e.code)) {
      aimLeft = true;
      return;
    }
    if (AIM_RIGHT.has(e.code)) {
      aimRight = true;
      return;
    }

    const arc = ARC_KEYS[e.code];
    if (arc) {
      e.preventDefault();
      // Ignore a second swing key while one is already charging.
      if (!holding) holding = { arc, since: performance.now() };
    }
  };

  const onKeyUp = (event: Event) => {
    const e = event as KeyboardEvent;

    if (AIM_LEFT.has(e.code)) {
      aimLeft = false;
      return;
    }
    if (AIM_RIGHT.has(e.code)) {
      aimRight = false;
      return;
    }

    const arc = ARC_KEYS[e.code];
    if (!arc || !holding || holding.arc !== arc) return;

    const held = performance.now() - holding.since;
    const power =
      MIN_POWER + (1 - MIN_POWER) * Math.min(1, held / FULL_CHARGE_MS);

    pending.push({
      // Stamped by the caller against engine time; see `drain` usage.
      t: 0,
      arc,
      power,
      lateralBias: aim,
      side: "forehand",
    });

    holding = null;
    charge = 0;
  };

  target.addEventListener("keydown", onKeyDown);
  target.addEventListener("keyup", onKeyUp);

  return {
    get aim() {
      return aim;
    },
    get charge() {
      return charge;
    },

    update(nowMs, dt) {
      const direction = (aimRight ? 1 : 0) - (aimLeft ? 1 : 0);
      if (direction !== 0) {
        aim = Math.max(-1, Math.min(1, aim + direction * dt * 2.4));
      } else {
        // Recentre when nothing is held, so aim does not drift between points.
        const decay = Math.exp(-4 * dt);
        aim *= decay;
        if (Math.abs(aim) < 0.01) aim = 0;
      }

      charge = holding
        ? Math.min(1, (nowMs - holding.since) / FULL_CHARGE_MS)
        : 0;
    },

    drain() {
      if (pending.length === 0) return [];
      return pending.splice(0, pending.length);
    },

    dispose() {
      target.removeEventListener("keydown", onKeyDown);
      target.removeEventListener("keyup", onKeyUp);
    },
  };
}
