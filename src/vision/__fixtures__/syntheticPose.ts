/**
 * Synthetic pose sequences.
 *
 * Lets the gesture logic be tested for real instead of being "verified" by
 * someone waving at a laptop. Coordinates are normalised frame units, y-up,
 * matching what the adapter hands the detector.
 */

import type { PoseSample, Point3 } from "../types";

const SHOULDER_Y = 0.62;
const HIP_Y = 0.37;
const SHOULDER_HALF = 0.09;
const HIP_HALF = 0.07;

/** Torso length in frame units, i.e. the unit every speed is measured in. */
export const TORSO_SCALE = SHOULDER_Y - HIP_Y;

const point = (x: number, y: number, z = 0): Point3 => ({ x, y, z });

/** Smoothstep, so the wrist accelerates and decelerates around a clear peak. */
const smoothstep = (u: number): number => u * u * (3 - 2 * u);

export type SwingShape = {
  from: Point3;
  to: Point3;
  durationMs: number;
};

/** Wrist paths roughly matching each gesture the game recognises. */
export const SHAPES: Record<string, SwingShape> = {
  topspin: { from: point(0.62, 0.24), to: point(0.4, 0.66), durationMs: 300 },
  slice: { from: point(0.6, 0.66), to: point(0.4, 0.3), durationMs: 320 },
  flat: { from: point(0.7, 0.46), to: point(0.3, 0.5), durationMs: 300 },
  overhead: { from: point(0.6, 0.55), to: point(0.45, 0.95), durationMs: 300 },
  /** Too slow and too short to count as a swing. */
  fidget: { from: point(0.55, 0.42), to: point(0.5, 0.46), durationMs: 900 },
};

export type SequenceOptions = {
  shape: SwingShape;
  hand?: "left" | "right";
  lean?: number;
  fps?: number;
  startT?: number;
  idleBeforeMs?: number;
  idleAfterMs?: number;
  visibility?: number;
};

function bodyAt(lean: number) {
  // Lean shifts the shoulders relative to the hips, which is what the detector
  // reads as aim.
  const shoulderX = 0.5 + lean * TORSO_SCALE;
  return {
    shoulderLeft: point(shoulderX - SHOULDER_HALF, SHOULDER_Y),
    shoulderRight: point(shoulderX + SHOULDER_HALF, SHOULDER_Y),
    hipLeft: point(0.5 - HIP_HALF, HIP_Y),
    hipRight: point(0.5 + HIP_HALF, HIP_Y),
  };
}

/** One swing, optionally padded with stillness either side. */
export function synthesiseSwing(options: SequenceOptions): PoseSample[] {
  const {
    shape,
    hand = "right",
    lean = 0,
    fps = 30,
    startT = 1000,
    idleBeforeMs = 400,
    idleAfterMs = 700,
    visibility = 0.95,
  } = options;

  const frameMs = 1000 / fps;
  const body = bodyAt(lean);
  const samples: PoseSample[] = [];

  const wristAt = (progress: number): Point3 =>
    point(
      shape.from.x + (shape.to.x - shape.from.x) * progress,
      shape.from.y + (shape.to.y - shape.from.y) * progress,
      0
    );

  const idleWrist = shape.from;
  const restWrist = shape.to;

  let t = startT;

  for (let elapsed = 0; elapsed < idleBeforeMs; elapsed += frameMs) {
    samples.push(frame(t, idleWrist, hand, body, visibility));
    t += frameMs;
  }

  for (let elapsed = 0; elapsed <= shape.durationMs; elapsed += frameMs) {
    const progress = smoothstep(Math.min(1, elapsed / shape.durationMs));
    samples.push(frame(t, wristAt(progress), hand, body, visibility));
    t += frameMs;
  }

  for (let elapsed = 0; elapsed < idleAfterMs; elapsed += frameMs) {
    samples.push(frame(t, restWrist, hand, body, visibility));
    t += frameMs;
  }

  return samples;
}

function frame(
  t: number,
  wrist: Point3,
  hand: "left" | "right",
  body: ReturnType<typeof bodyAt>,
  visibility: number
): PoseSample {
  // The idle hand rests by the hip so it never out-runs the swinging one.
  const idle = point(hand === "right" ? 0.36 : 0.64, 0.36);
  return {
    t,
    wristLeft: hand === "left" ? wrist : idle,
    wristRight: hand === "right" ? wrist : idle,
    ...body,
    visibility,
  };
}

/**
 * Several swings in a row, with the arm resetting between them.
 *
 * Concatenating independent sequences is not equivalent: the wrist would jump
 * from one shape's end to the next one's start, and that teleport reads as an
 * enormous instantaneous speed. The reset here is linear and slow so it stays
 * under the arming threshold, the way a player recovering between shots does.
 */
export function synthesiseRally(
  shapes: SwingShape[],
  options: Omit<SequenceOptions, "shape"> & { resetMs?: number } = {}
): PoseSample[] {
  const {
    hand = "right",
    lean = 0,
    fps = 30,
    startT = 1000,
    idleBeforeMs = 400,
    idleAfterMs = 500,
    visibility = 0.95,
    resetMs = 1300,
  } = options;

  const frameMs = 1000 / fps;
  const body = bodyAt(lean);
  const samples: PoseSample[] = [];
  let t = startT;

  const push = (wrist: Point3) => {
    samples.push(frame(t, wrist, hand, body, visibility));
    t += frameMs;
  };

  const lerp = (a: Point3, b: Point3, u: number): Point3 =>
    point(a.x + (b.x - a.x) * u, a.y + (b.y - a.y) * u, 0);

  shapes.forEach((shape, index) => {
    if (index === 0) {
      for (let e = 0; e < idleBeforeMs; e += frameMs) push(shape.from);
    } else {
      // Linear, not smoothstep: a smoothstep reset peaks at 1.5x its average
      // speed, which is enough to arm the detector on the recovery alone.
      const previous = shapes[index - 1]!;
      for (let e = 0; e < resetMs; e += frameMs) {
        push(lerp(previous.to, shape.from, e / resetMs));
      }
    }

    for (let e = 0; e <= shape.durationMs; e += frameMs) {
      push(lerp(shape.from, shape.to, smoothstep(Math.min(1, e / shape.durationMs))));
    }
  });

  const last = shapes[shapes.length - 1]!;
  for (let e = 0; e < idleAfterMs; e += frameMs) push(last.to);

  return samples;
}

/** A still body, for testing that nothing fires when nothing happens. */
export function synthesiseIdle(
  frames = 90,
  startT = 1000,
  fps = 30
): PoseSample[] {
  const body = bodyAt(0);
  const frameMs = 1000 / fps;
  const samples: PoseSample[] = [];
  for (let i = 0; i < frames; i++) {
    // A touch of jitter, because a real landmark stream is never perfectly still.
    const jitter = Math.sin(i * 1.7) * 0.0015;
    samples.push(
      frame(
        startT + i * frameMs,
        point(0.6 + jitter, 0.4 - jitter),
        "right",
        body,
        0.95
      )
    );
  }
  return samples;
}

/** Run a sequence through a detector, collecting everything it fires. */
export function runSequence(
  samples: PoseSample[],
  push: (sample: PoseSample) => unknown | null
): unknown[] {
  const swings: unknown[] = [];
  for (const sample of samples) {
    const swing = push(sample);
    if (swing) swings.push(swing);
  }
  return swings;
}
