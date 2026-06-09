/**
 * Camera -> pose -> SwingEvent.
 *
 * The runtime counterpart to the keyboard adapter: it produces exactly the same
 * events, so the engine cannot tell which one is driving it.
 *
 * Inference is driven by `requestVideoFrameCallback`, which fires once per
 * decoded camera frame, rather than from the render loop. Running it per render
 * frame does roughly twice the work on a 60 Hz display fed by a 30 fps camera —
 * and `video.currentTime` cannot be used to detect duplicates, because for a
 * live stream it is a continuously advancing clock rather than a frame counter.
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

/** What the pipeline is costing, for the tuning overlay. */
export type PoseStats = {
  /** Smoothed inference time per frame, ms. */
  inferenceMs: number;
  /** Worst inference seen, ms. A single long frame is what reads as a stutter. */
  worstInferenceMs: number;
  /** Camera frames actually processed per second. */
  poseFps: number;
  /** Frames skipped because inference was still running. */
  dropped: number;
  /** Which MediaPipe delegate loaded. CPU is several times slower than GPU. */
  delegate: "GPU" | "CPU" | "unknown";
  /** Times the watchdog had to revive a stalled frame loop. */
  restarts: number;
};

/** How long without a camera frame counts as a stalled loop. */
const WATCHDOG_STALL_MS = 1500;

export type PoseInput = {
  readonly status: PoseStatus;
  readonly error: string | null;
  readonly video: HTMLVideoElement;
  readonly landmarks: NormalizedLandmark[] | null;
  readonly debug: DetectorDebug | null;
  readonly stats: PoseStats;
  start: () => Promise<void>;
  /** Drain swings detected since the last call. Does no inference. */
  update: () => SwingEvent[];
  /** Reset the detector, e.g. when starting calibration. */
  reset: () => void;
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

type VideoWithRVFC = HTMLVideoElement & {
  requestVideoFrameCallback?: (
    callback: (now: number, metadata: { captureTime?: number }) => void
  ) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

export function createPoseInput(): PoseInput {
  const video = document.createElement("video") as VideoWithRVFC;
  video.playsInline = true;
  video.muted = true;
  video.autoplay = true;

  let status: PoseStatus = "idle";
  let error: string | null = null;
  let stream: MediaStream | null = null;
  let landmarker: PoseLandmarker | null = null;
  let landmarks: NormalizedLandmark[] | null = null;
  let detector: DetectorState = createDetectorState();

  const queue: SwingEvent[] = [];
  const stats: PoseStats = {
    inferenceMs: 0,
    worstInferenceMs: 0,
    poseFps: 0,
    dropped: 0,
    delegate: "unknown",
    restarts: 0,
  };

  let running = false;
  let busy = false;
  let frameHandle: number | null = null;
  let fallbackTimer: number | null = null;
  let lastFrameAt = 0;
  /** MediaPipe rejects a non-increasing timestamp. */
  let lastStamp = -1;

  /**
   * Bumped by every `stop()`, captured by every `start()`.
   *
   * `start()` awaits the camera and the model, and a stop can land in that gap —
   * React StrictMode mounts each effect twice, so it reliably does. Without this
   * check the resumed `start()` sets running and launches its frame loop anyway,
   * leaving an orphaned instance driving inference forever. That matters because
   * the landmarker is cached and therefore *shared*: two live instances feed one
   * PoseLandmarker interleaved timestamps, and VIDEO mode requires them to
   * increase monotonically, so the pose output goes stale.
   */
  let generation = 0;

  const runInference = (captureMs: number) => {
    if (!landmarker || !running || busy) {
      if (busy) stats.dropped++;
      return;
    }
    if (video.readyState < 2) return;

    // Strictly increasing timestamps, whatever the clock reports.
    const stamp = captureMs > lastStamp ? captureMs : lastStamp + 1;
    lastStamp = stamp;

    busy = true;
    const started = performance.now();
    try {
      const result = landmarker.detectForVideo(video, stamp);
      const elapsed = performance.now() - started;
      stats.inferenceMs =
        stats.inferenceMs === 0
          ? elapsed
          : stats.inferenceMs * 0.9 + elapsed * 0.1;
      stats.worstInferenceMs = Math.max(stats.worstInferenceMs, elapsed);

      if (lastFrameAt > 0) {
        const delta = started - lastFrameAt;
        if (delta > 0) {
          const instant = 1000 / delta;
          stats.poseFps =
            stats.poseFps === 0 ? instant : stats.poseFps * 0.9 + instant * 0.1;
        }
      }
      lastFrameAt = started;

      const found = result.landmarks?.[0];
      if (!found || found.length === 0) {
        landmarks = null;
        return;
      }
      landmarks = found;

      const sample = buildSample(found, started);
      if (!sample) return;

      const pushed = pushSample(detector, sample, swingConfig);
      detector = pushed.state;
      if (pushed.swing) queue.push(toSwingEvent(pushed.swing, swingConfig));
    } catch (cause) {
      console.warn("[vision] inference failed:", cause);
    } finally {
      busy = false;
    }
  };

  /**
   * Identifies the current frame loop.
   *
   * The watchdog can re-arm a loop it believes is dead; if the original callback
   * then fires after all, this stops the two from running in parallel.
   */
  let loopToken = 0;

  const scheduleNextFrame = () => {
    if (!running) return;
    loopToken++;
    const mine = loopToken;

    if (typeof video.requestVideoFrameCallback === "function") {
      frameHandle = video.requestVideoFrameCallback((now, metadata) => {
        if (mine !== loopToken || !running) return;
        // captureTime, where available, is closer to when light hit the sensor.
        runInference(metadata?.captureTime ?? now);
        scheduleNextFrame();
      });
      return;
    }

    // Safari before 15.4 and a few others lack rVFC; fall back to a timer at
    // roughly camera rate rather than tying inference to the render loop.
    fallbackTimer = window.setTimeout(() => {
      if (mine !== loopToken || !running) return;
      runInference(performance.now());
      scheduleNextFrame();
    }, 1000 / 30);
  };

  /**
   * Restart the frame loop if it stops delivering.
   *
   * A self-driving loop that quietly dies shows up as a skeleton frozen
   * mid-pose with no error anywhere — the hardest kind of failure to diagnose
   * from the outside. Hidden documents are exempt, because a suspended callback
   * there is correct behaviour rather than a stall.
   */
  const watchdog = window.setInterval(() => {
    if (!running || document.hidden) return;
    const idleFor = performance.now() - lastFrameAt;
    if (lastFrameAt > 0 && idleFor > WATCHDOG_STALL_MS) {
      console.warn(
        `[vision] no camera frame for ${Math.round(idleFor)}ms, restarting the loop`
      );
      stats.restarts++;
      scheduleNextFrame();
    }
  }, WATCHDOG_STALL_MS);

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
    get stats() {
      return stats;
    },

    async start() {
      if (status === "starting" || status === "running") return;
      status = "starting";
      error = null;

      const mine = generation;
      /** True once a stop has superseded this start attempt. */
      const superseded = () => generation !== mine;

      try {
        const opened = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 640 },
            height: { ideal: 480 },
            frameRate: { ideal: 30, max: 30 },
          },
          audio: false,
        });

        // Stopped while the permission prompt was up: release the camera we
        // just took rather than leaving its light on with nobody reading it.
        if (superseded()) {
          opened.getTracks().forEach((track) => track.stop());
          return;
        }

        stream = opened;
        video.srcObject = stream;
        await video.play();
        if (superseded()) return;

        const loaded = await loadLandmarker();
        if (superseded()) return;

        landmarker = loaded.landmarker;
        stats.delegate = loaded.delegate;

        detector = createDetectorState();
        status = "running";
        running = true;
        // Primed so the watchdog also covers a loop that never delivers its
        // first frame, not only one that stops partway through.
        lastFrameAt = performance.now();
        scheduleNextFrame();
      } catch (cause) {
        if (superseded()) return;
        status = "error";
        error =
          cause instanceof Error
            ? cause.message
            : "Could not start the camera.";
        input.stop();
      }
    },

    update() {
      if (queue.length === 0) return [];
      return queue.splice(0, queue.length);
    },

    reset() {
      detector = createDetectorState();
      queue.length = 0;
      stats.worstInferenceMs = 0;
      stats.dropped = 0;
    },

    stop() {
      generation++;
      running = false;
      loopToken++;
      window.clearInterval(watchdog);
      if (frameHandle !== null && video.cancelVideoFrameCallback) {
        video.cancelVideoFrameCallback(frameHandle);
      }
      if (fallbackTimer !== null) window.clearTimeout(fallbackTimer);
      frameHandle = null;
      fallbackTimer = null;

      stream?.getTracks().forEach((track) => track.stop());
      stream = null;
      video.srcObject = null;
      landmarks = null;
      queue.length = 0;
      lastStamp = -1;
      if (status !== "error") status = "idle";
    },
  };

  return input;
}
