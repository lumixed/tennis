/**
 * Camera -> pose -> SwingEvent.
 *
 * The runtime counterpart to the keyboard adapter: it produces exactly the same
 * events, so the engine cannot tell which one is driving it.
 */

import type { NormalizedLandmark, PoseLandmarker } from "@mediapipe/tasks-vision";
import type { SwingEvent } from "../engine/shotTypes";
import { LANDMARK, loadLandmarker } from "./landmarker";
import { swingConfig } from "./swingConfig";
import {
  createDetectorState,
  pushSample,
  type DetectorState,
} from "./swingDetector";
import { toSwingEvent } from "./toSwingEvent";
import type { DetectorDebug, PoseSample, Point3 } from "./types";

export type PoseStatus = "idle" | "starting" | "running" | "error";

export type PoseInput = {
  readonly status: PoseStatus;
  readonly error: string | null;
  readonly video: HTMLVideoElement;
  /** Most recent raw landmarks, for the overlay's skeleton. */
  readonly landmarks: NormalizedLandmark[] | null;
  readonly debug: DetectorDebug | null;
  /** Measured camera frame rate, for the overlay. */
  readonly fps: number;
  start: () => Promise<void>;
  /** Call once per animation frame; returns any swings detected. */
  update: (nowMs: number) => SwingEvent[];
  stop: () => void;
};

/**
 * Convert a landmark into detector space.
 *
 * Two conversions matter. MediaPipe reports y downwards, so it is flipped —
 * otherwise "low-to-high" would mean the opposite of what it says. And x is
 * mirrored, because the camera image is not: a player leaning to their own right
 * appears on the *left* of an unmirrored frame, and without the flip leaning
 * right would aim the ball left.
 */
const toPoint = (landmark: NormalizedLandmark): Point3 => ({
  x: 1 - landmark.x,
  y: 1 - landmark.y,
  z: landmark.z ?? 0,
});

const visibilityOf = (landmark: NormalizedLandmark): number =>
  landmark.visibility ?? 1;

export function buildSample(
  landmarks: NormalizedLandmark[],
  t: number
): PoseSample | null {
  const indices = [
    LANDMARK.leftWrist,
    LANDMARK.rightWrist,
    LANDMARK.leftShoulder,
    LANDMARK.rightShoulder,
    LANDMARK.leftHip,
    LANDMARK.rightHip,
  ];

  let visibility = 1;
  for (const index of indices) {
    const landmark = landmarks[index];
    if (!landmark) return null;
    visibility = Math.min(visibility, visibilityOf(landmark));
  }

  return {
    t,
    wristLeft: toPoint(landmarks[LANDMARK.leftWrist]!),
    wristRight: toPoint(landmarks[LANDMARK.rightWrist]!),
    shoulderLeft: toPoint(landmarks[LANDMARK.leftShoulder]!),
    shoulderRight: toPoint(landmarks[LANDMARK.rightShoulder]!),
    hipLeft: toPoint(landmarks[LANDMARK.leftHip]!),
    hipRight: toPoint(landmarks[LANDMARK.rightHip]!),
    visibility,
  };
}

export function createPoseInput(): PoseInput {
  const video = document.createElement("video");
  video.playsInline = true;
  video.muted = true;
  video.autoplay = true;

  let status: PoseStatus = "idle";
  let error: string | null = null;
  let stream: MediaStream | null = null;
  let landmarker: PoseLandmarker | null = null;
  let landmarks: NormalizedLandmark[] | null = null;
  let detector: DetectorState = createDetectorState();
  let lastVideoTime = -1;
  let fps = 0;
  let lastFrameAt = 0;

  const input: PoseInput = {
    get status() {
      return status;
    },
    get error() {
      return error;
    },
    get video() {
      return video;
    },
    get landmarks() {
      return landmarks;
    },
    get debug() {
      return status === "running" ? detector.debug : null;
    },
    get fps() {
      return fps;
    },

    async start() {
      if (status === "starting" || status === "running") return;
      status = "starting";
      error = null;

      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 640 },
            height: { ideal: 480 },
            frameRate: { ideal: 60 },
          },
          audio: false,
        });
        video.srcObject = stream;
        await video.play();

        landmarker = await loadLandmarker();
        detector = createDetectorState();
        status = "running";
      } catch (cause) {
        status = "error";
        error =
          cause instanceof Error
            ? cause.message
            : "Could not start the camera.";
        input.stop();
      }
    },

    update(nowMs) {
      if (status !== "running" || !landmarker) return [];
      if (video.readyState < 2) return [];

      // MediaPipe rejects a repeated timestamp, so only run on fresh frames.
      if (video.currentTime === lastVideoTime) return [];
      lastVideoTime = video.currentTime;

      if (lastFrameAt > 0) {
        const delta = nowMs - lastFrameAt;
        if (delta > 0) fps = fps === 0 ? 1000 / delta : fps * 0.9 + (1000 / delta) * 0.1;
      }
      lastFrameAt = nowMs;

      let result;
      try {
        result = landmarker.detectForVideo(video, nowMs);
      } catch (cause) {
        console.warn("[vision] inference failed:", cause);
        return [];
      }

      const found = result.landmarks?.[0];
      if (!found || found.length === 0) {
        landmarks = null;
        return [];
      }
      landmarks = found;

      const sample = buildSample(found, nowMs);
      if (!sample) return [];

      const pushed = pushSample(detector, sample, swingConfig);
      detector = pushed.state;

      return pushed.swing ? [toSwingEvent(pushed.swing, swingConfig)] : [];
    },

    stop() {
      stream?.getTracks().forEach((track) => track.stop());
      stream = null;
      video.srcObject = null;
      landmarks = null;
      lastVideoTime = -1;
      if (status !== "error") status = "idle";
    },
  };

  return input;
}
