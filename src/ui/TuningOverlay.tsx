/**
 * Live swing-detection tuning.
 *
 * Every threshold in `swingConfig` is a guess until it has met a real body in
 * real lighting. This panel exists so that meeting happens in ten minutes in
 * front of the camera rather than never: skeleton, live speed trace against the
 * actual thresholds, and a slider for each one, all adjustable mid-rally.
 */

import { useEffect, useRef, useState } from "react";
import { LANDMARK } from "../vision/landmarker";
import {
  resetSwingConfig,
  swingConfig,
  type SwingConfig,
} from "../vision/swingConfig";
import type { PoseInput } from "../vision/poseInput";

type SliderSpec = {
  key: keyof SwingConfig;
  label: string;
  min: number;
  max: number;
  step: number;
  hint?: string;
};

const SLIDERS: SliderSpec[] = [
  {
    key: "enterSpeed",
    label: "Arm at",
    min: 0.5,
    max: 8,
    step: 0.1,
    hint: "torso-lengths/s to start a swing",
  },
  { key: "exitSpeed", label: "Release at", min: 0.2, max: 5, step: 0.1 },
  { key: "minPeakSpeed", label: "Min peak", min: 1, max: 12, step: 0.1 },
  { key: "refractoryMs", label: "Refractory", min: 100, max: 1200, step: 10 },
  { key: "positionTauMs", label: "Position smooth", min: 5, max: 200, step: 1 },
  { key: "speedTauMs", label: "Speed smooth", min: 5, max: 200, step: 1 },
  { key: "minVisibility", label: "Min visibility", min: 0, max: 1, step: 0.01 },
  {
    key: "arcVerticalRatio",
    label: "Arc threshold",
    min: 0,
    max: 1,
    step: 0.01,
    hint: "how vertical before it counts as lift/chop",
  },
  { key: "overheadHeight", label: "Overhead at", min: -0.3, max: 0.8, step: 0.01 },
  { key: "leanGain", label: "Lean gain", min: 0, max: 6, step: 0.1 },
  {
    key: "latencyCompensationMs",
    label: "Latency comp",
    min: 0,
    max: 300,
    step: 5,
    hint: "ms subtracted from each swing's timestamp",
  },
];

/** Skeleton bones, by MediaPipe landmark index. */
const BONES: Array<[number, number]> = [
  [LANDMARK.leftShoulder, LANDMARK.rightShoulder],
  [LANDMARK.leftShoulder, LANDMARK.leftHip],
  [LANDMARK.rightShoulder, LANDMARK.rightHip],
  [LANDMARK.leftHip, LANDMARK.rightHip],
  [LANDMARK.leftShoulder, 13],
  [13, LANDMARK.leftWrist],
  [LANDMARK.rightShoulder, 14],
  [14, LANDMARK.rightWrist],
];

export function TuningOverlay({
  pose,
  onClose,
}: {
  pose: PoseInput;
  onClose: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const traceRef = useRef<HTMLCanvasElement>(null);
  const [, forceRender] = useState(0);

  useEffect(() => {
    let frame = 0;
    let tick = 0;

    const draw = () => {
      frame = requestAnimationFrame(draw);
      drawSkeleton(canvasRef.current, pose);
      drawTrace(traceRef.current, pose);

      // Refresh the numeric readouts a few times a second, not every frame.
      if (++tick % 6 === 0) forceRender((n) => n + 1);
    };

    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [pose]);

  const debug = pose.debug;

  return (
    <div className="tuning">
      <div className="tuning-head">
        <strong>Swing tuning</strong>
        <button onClick={onClose}>close</button>
      </div>

      <canvas ref={canvasRef} className="tuning-cam" width={240} height={180} />
      <canvas ref={traceRef} className="tuning-trace" width={240} height={72} />

      <div className="tuning-readouts">
        <Readout label="fps" value={pose.fps.toFixed(0)} />
        <Readout label="speed" value={(debug?.speed ?? 0).toFixed(2)} />
        <Readout
          label="vis"
          value={(debug?.visibility ?? 0).toFixed(2)}
          warn={(debug?.visibility ?? 0) < swingConfig.minVisibility}
        />
        <Readout label="lean" value={(debug?.lean ?? 0).toFixed(2)} />
        <Readout label="stance" value={(debug?.stance ?? 0).toFixed(2)} />
        <Readout label="armed" value={debug?.armed ? "yes" : "no"} />
      </div>

      <div className="tuning-sliders">
        {SLIDERS.map((spec) => (
          <Slider key={String(spec.key)} spec={spec} onChange={() => forceRender((n) => n + 1)} />
        ))}
      </div>

      <button
        className="tuning-reset"
        onClick={() => {
          resetSwingConfig();
          forceRender((n) => n + 1);
        }}
      >
        Reset to defaults
      </button>
    </div>
  );
}

function Readout({
  label,
  value,
  warn,
}: {
  label: string;
  value: string;
  warn?: boolean;
}) {
  return (
    <div className={warn ? "readout readout-warn" : "readout"}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Slider({
  spec,
  onChange,
}: {
  spec: SliderSpec;
  onChange: () => void;
}) {
  const value = swingConfig[spec.key];

  return (
    <label className="tuning-slider" title={spec.hint}>
      <span className="tuning-slider-label">{spec.label}</span>
      <input
        type="range"
        min={spec.min}
        max={spec.max}
        step={spec.step}
        value={value}
        onChange={(event) => {
          // Mutated in place so the running detector picks it up immediately.
          swingConfig[spec.key] = Number(event.target.value);
          onChange();
        }}
      />
      <span className="tuning-slider-value">
        {typeof value === "number" && value >= 10
          ? value.toFixed(0)
          : Number(value).toFixed(2)}
      </span>
    </label>
  );
}

function drawSkeleton(canvas: HTMLCanvasElement | null, pose: PoseInput) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);

  const video = pose.video;
  if (video.readyState >= 2) {
    // Mirrored, so the player sees themselves the way a mirror shows them.
    ctx.save();
    ctx.translate(width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, width, height);
    ctx.restore();
  } else {
    ctx.fillStyle = "#0d1620";
    ctx.fillRect(0, 0, width, height);
  }

  const landmarks = pose.landmarks;
  if (!landmarks) {
    ctx.fillStyle = "rgba(255,107,74,0.9)";
    ctx.font = "11px ui-sans-serif, system-ui";
    ctx.fillText("no pose", 8, height - 8);
    return;
  }

  // Landmarks are in unmirrored space; mirror x to match the drawn image.
  const px = (index: number) => (1 - (landmarks[index]?.x ?? 0)) * width;
  const py = (index: number) => (landmarks[index]?.y ?? 0) * height;

  ctx.strokeStyle = "rgba(200,255,61,0.85)";
  ctx.lineWidth = 2;
  for (const [a, b] of BONES) {
    if (!landmarks[a] || !landmarks[b]) continue;
    ctx.beginPath();
    ctx.moveTo(px(a), py(a));
    ctx.lineTo(px(b), py(b));
    ctx.stroke();
  }

  const armed = pose.debug?.armed ?? false;
  for (const index of [LANDMARK.leftWrist, LANDMARK.rightWrist]) {
    if (!landmarks[index]) continue;
    ctx.beginPath();
    ctx.fillStyle = armed ? "#ff6b4a" : "#c8ff3d";
    ctx.arc(px(index), py(index), armed ? 6 : 4, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawTrace(canvas: HTMLCanvasElement | null, pose: PoseInput) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#0d1620";
  ctx.fillRect(0, 0, width, height);

  const trace = pose.debug?.trace ?? [];
  const ceiling = Math.max(
    swingConfig.minPeakSpeed * 1.6,
    ...trace,
    swingConfig.enterSpeed * 1.4
  );
  const y = (speed: number) => height - (speed / ceiling) * height;

  // Threshold lines, so a swing that failed to register is diagnosable.
  const lines: Array<[number, string]> = [
    [swingConfig.enterSpeed, "rgba(127,216,255,0.75)"],
    [swingConfig.exitSpeed, "rgba(140,160,180,0.5)"],
    [swingConfig.minPeakSpeed, "rgba(200,255,61,0.8)"],
  ];
  ctx.lineWidth = 1;
  for (const [level, colour] of lines) {
    ctx.strokeStyle = colour;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(0, y(level));
    ctx.lineTo(width, y(level));
    ctx.stroke();
  }
  ctx.setLineDash([]);

  if (trace.length < 2) return;

  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  trace.forEach((speed, index) => {
    const x = (index / (trace.length - 1)) * width;
    if (index === 0) ctx.moveTo(x, y(speed));
    else ctx.lineTo(x, y(speed));
  });
  ctx.stroke();
}
