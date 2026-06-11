/**
 * MediaPipe pose landmarker setup.
 *
 * Isolated here so the rest of the vision layer — and all of the gesture logic —
 * stays free of the library. Swapping models later touches this file only.
 */

import { FilesetResolver, PoseLandmarker } from "@mediapipe/tasks-vision";

export const MODEL = {
  wasmBase:
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.20/wasm",
  /**
   * The lite model, deliberately. Every millisecond of inference is a
   * millisecond of the latency budget the whole design is built around, and the
   * heavier models buy accuracy this game does not need — swings are read from
   * gross wrist motion, not fingertip precision.
   */
  assetPath:
    "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
} as const;

/** MediaPipe landmark indices used by the swing detector. */
export const LANDMARK = {
  leftShoulder: 11,
  rightShoulder: 12,
  leftWrist: 15,
  rightWrist: 16,
  leftHip: 23,
  rightHip: 24,
} as const;

export type LoadedLandmarker = {
  landmarker: PoseLandmarker;
  /**
   * Which delegate actually loaded.
   *
   * Reported rather than swallowed: CPU inference is several times slower than
   * GPU, easily enough to turn a smooth game into a stuttering one, and a silent
   * fallback makes that look like a mysterious performance problem.
   */
  delegate: "GPU" | "CPU";
};

let cached: Promise<LoadedLandmarker> | null = null;

async function build(delegate: "GPU" | "CPU"): Promise<LoadedLandmarker> {
  const vision = await FilesetResolver.forVisionTasks(MODEL.wasmBase);
  const landmarker = await PoseLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: MODEL.assetPath, delegate },
    runningMode: "VIDEO",
    numPoses: 1,
  });
  return { landmarker, delegate };
}

/**
 * Load the landmarker, falling back to CPU when the GPU delegate is unavailable.
 *
 * The fallback matters: a machine without a usable WebGL delegate should play
 * slowly rather than not at all.
 */
export function loadLandmarker(): Promise<LoadedLandmarker> {
  if (!cached) {
    cached = build("GPU").catch((error) => {
      console.warn("[vision] GPU delegate failed, retrying on CPU:", error);
      return build("CPU");
    });
    // A failed load must not be cached, or a retry can never succeed.
    cached.catch(() => {
      cached = null;
    });
  }
  return cached;
}
