/**
 * Swing detection from pose landmarks.
 *
 * Pure and synchronous: state in, state out, no camera, no MediaPipe, no clock.
 * That is what lets the gesture logic be tested against synthetic swings rather
 * than only ever "verified" by waving at a webcam.
 *
 * The detector reads *wrist speed through an arc*, never wrist position against
 * the ball. Landmark jitter is several centimetres, so treating the arm as a
 * collider would produce phantom hits and ghost misses; a velocity threshold
 * degrades gracefully instead.
 */

import {
  createFootworkState,
  updateFootwork,
  type FootworkState,
} from "./footwork";
import type { SwingConfig } from "./swingConfig";
import type { DetectedSwing, DetectorDebug, PoseSample, Point3 } from "./types";

type Hand = "left" | "right";

type ArmedSwing = {
  hand: Hand;
  startPos: Point3;
  startT: number;
  peakSpeed: number;
  peakT: number;
  peakPos: Point3;
  peakAboveShoulder: number;
  peakLean: number;
  peakStance: number;
};

export type DetectorState = {
  smoothedLeft: Point3 | null;
  smoothedRight: Point3 | null;
  speedLeft: number;
  speedRight: number;
  lastT: number | null;
  armed: ArmedSwing | null;
  /** Set after a swing fires; blocks re-arming until the arm settles. */
  cooling: boolean;
  lastSwingT: number;
  footwork: FootworkState;
  trace: number[];
  debug: DetectorDebug;
};

const ZERO: Point3 = { x: 0, y: 0, z: 0 };

const mid = (a: Point3, b: Point3): Point3 => ({
  x: (a.x + b.x) / 2,
  y: (a.y + b.y) / 2,
  z: (a.z + b.z) / 2,
});

const dist = (a: Point3, b: Point3): number =>
  Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/**
 * Frame-rate independent EMA factor for a given time constant.
 *
 * dt of 0 (the first frame) yields 0, leaving the existing value untouched.
 */
const timeAlpha = (dtMs: number, tauMs: number): number =>
  tauMs <= 0 ? 1 : 1 - Math.exp(-Math.max(0, dtMs) / tauMs);

const ema = (previous: Point3, next: Point3, alpha: number): Point3 => ({
  x: previous.x + (next.x - previous.x) * alpha,
  y: previous.y + (next.y - previous.y) * alpha,
  z: previous.z + (next.z - previous.z) * alpha,
});

export function createDetectorState(): DetectorState {
  return {
    smoothedLeft: null,
    smoothedRight: null,
    speedLeft: 0,
    speedRight: 0,
    lastT: null,
    armed: null,
    cooling: false,
    lastSwingT: -Infinity,
    footwork: createFootworkState(),
    trace: [],
    debug: {
      speed: 0,
      smoothedSpeed: 0,
      armed: false,
      torsoScale: 0,
      visibility: 0,
      hand: "right",
      lean: 0,
      stance: 0,
      stepSpeed: 0,
      trace: [],
    },
  };
}

/**
 * Feed one pose frame.
 *
 * Returns a swing on the frame the gesture's peak is *confirmed* — a frame or
 * two after the true peak, not at the end of the follow-through. Waiting for the
 * arm to stop would hand the engine a swing 150 ms stale, by which time the ball
 * has moved on. The returned timestamp is the peak's, so the grading stays
 * honest either way.
 */
export function pushSample(
  state: DetectorState,
  sample: PoseSample,
  config: SwingConfig
): { state: DetectorState; swing: DetectedSwing | null } {
  const next: DetectorState = { ...state };

  const shoulderMid = mid(sample.shoulderLeft, sample.shoulderRight);
  const hipMid = mid(sample.hipLeft, sample.hipRight);
  const torsoScale = dist(shoulderMid, hipMid);

  // A collapsed or barely-visible torso makes every derived figure meaningless.
  if (sample.visibility < config.minVisibility || torsoScale < 1e-4) {
    next.armed = null;
    next.cooling = false;
    next.lastT = sample.t;
    next.debug = {
      ...state.debug,
      speed: 0,
      smoothedSpeed: 0,
      armed: false,
      torsoScale,
      visibility: sample.visibility,
      trace: state.trace,
    };
    return { state: next, swing: null };
  }

  const dt = state.lastT === null ? 0 : (sample.t - state.lastT) / 1000;
  const dtMs = dt * 1000;

  // Time-based blend factors, so a 60 fps camera and a 30 fps camera measure the
  // same physical swing the same way.
  const alpha = timeAlpha(dtMs, config.positionTauMs);
  const beta = timeAlpha(dtMs, config.speedTauMs);

  const smoothedLeft = state.smoothedLeft
    ? ema(state.smoothedLeft, sample.wristLeft, alpha)
    : sample.wristLeft;
  const smoothedRight = state.smoothedRight
    ? ema(state.smoothedRight, sample.wristRight, alpha)
    : sample.wristRight;

  let rawLeft = 0;
  let rawRight = 0;
  if (dt > 1e-4 && state.smoothedLeft && state.smoothedRight) {
    // Speeds are in torso-lengths per second, so they survive the player moving
    // nearer to or further from the camera.
    rawLeft = dist(smoothedLeft, state.smoothedLeft) / torsoScale / dt;
    rawRight = dist(smoothedRight, state.smoothedRight) / torsoScale / dt;
  }

  const speedLeft = state.speedLeft + (rawLeft - state.speedLeft) * beta;
  const speedRight = state.speedRight + (rawRight - state.speedRight) * beta;

  next.smoothedLeft = smoothedLeft;
  next.smoothedRight = smoothedRight;
  next.speedLeft = speedLeft;
  next.speedRight = speedRight;
  next.lastT = sample.t;

  const hand: Hand = speedLeft > speedRight ? "left" : "right";
  const speed = Math.max(speedLeft, speedRight);
  const wrist = hand === "left" ? smoothedLeft : smoothedRight;

  const footwork = updateFootwork(state.footwork, hipMid.x, torsoScale, sample.t);
  next.footwork = footwork;

  const lean = (shoulderMid.x - hipMid.x) / torsoScale;
  const aboveShoulder = (wrist.y - shoulderMid.y) / torsoScale;

  const trace = [...state.trace, speed];
  if (trace.length > config.traceLength) {
    trace.splice(0, trace.length - config.traceLength);
  }
  next.trace = trace;

  let swing: DetectedSwing | null = null;
  let armed = state.armed;
  let cooling = state.cooling;

  if (cooling) {
    // Wait for the arm to actually settle before another swing can start,
    // otherwise one gesture's follow-through fires a second shot.
    if (speed < config.exitSpeed) cooling = false;
  } else if (!armed) {
    const rested = sample.t - state.lastSwingT >= config.refractoryMs;
    if (speed >= config.enterSpeed && rested) {
      armed = {
        hand,
        startPos: wrist,
        startT: sample.t,
        peakSpeed: speed,
        peakT: sample.t,
        peakPos: wrist,
        peakAboveShoulder: aboveShoulder,
        peakLean: lean,
        peakStance: footwork.stance,
      };
    }
  } else {
    if (speed > armed.peakSpeed) {
      armed = {
        ...armed,
        peakSpeed: speed,
        peakT: sample.t,
        peakPos: wrist,
        peakAboveShoulder: aboveShoulder,
        peakLean: lean,
        peakStance: footwork.stance,
      };
    } else if (
      armed.peakSpeed >= config.minPeakSpeed &&
      speed < armed.peakSpeed * 0.82
    ) {
      // Confirmed peak: fire now, dated to the peak frame.
      swing = {
        peakT: armed.peakT,
        hand: armed.hand,
        peakSpeed: armed.peakSpeed,
        travel: {
          x: (armed.peakPos.x - armed.startPos.x) / torsoScale,
          y: (armed.peakPos.y - armed.startPos.y) / torsoScale,
          z: (armed.peakPos.z - armed.startPos.z) / torsoScale,
        },
        wristAboveShoulder: armed.peakAboveShoulder,
        lean: armed.peakLean,
        stance: armed.peakStance,
      };
      next.lastSwingT = armed.peakT;
      armed = null;
      cooling = true;
    } else if (speed < config.exitSpeed) {
      // Fizzled out without ever getting quick enough to count.
      armed = null;
    }
  }

  next.armed = armed;
  next.cooling = cooling;
  next.debug = {
    speed,
    smoothedSpeed: speed,
    armed: armed !== null,
    torsoScale,
    visibility: sample.visibility,
    hand,
    lean,
    stance: footwork.stance,
    stepSpeed: footwork.speed,
    trace,
  };

  return { state: next, swing };
}

export { ZERO as ORIGIN };
