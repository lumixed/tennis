import { describe, expect, it } from "vitest";
import { DEFAULT_SWING_CONFIG, type SwingConfig } from "./swingConfig";
import { createDetectorState, pushSample } from "./swingDetector";
import { classifyArc, toSwingEvent } from "./toSwingEvent";
import type { DetectedSwing, PoseSample, Point3 } from "./types";
import {
  SHAPES,
  synthesiseIdle,
  synthesiseRally,
  synthesiseSwing,
} from "./__fixtures__/syntheticPose";

const config: SwingConfig = { ...DEFAULT_SWING_CONFIG };

/** Push a whole sequence, returning every swing detected. */
function detect(
  samples: PoseSample[],
  overrides: Partial<SwingConfig> = {}
): DetectedSwing[] {
  const settings = { ...config, ...overrides };
  let state = createDetectorState();
  const swings: DetectedSwing[] = [];
  for (const sample of samples) {
    const result = pushSample(state, sample, settings);
    state = result.state;
    if (result.swing) swings.push(result.swing);
  }
  return swings;
}

/** Move the whole body closer to or further from the camera. */
function scaleBody(samples: PoseSample[], factor: number): PoseSample[] {
  const about = (p: Point3): Point3 => ({
    x: 0.5 + (p.x - 0.5) * factor,
    y: 0.5 + (p.y - 0.5) * factor,
    z: p.z * factor,
  });
  return samples.map((s) => ({
    ...s,
    wristLeft: about(s.wristLeft),
    wristRight: about(s.wristRight),
    shoulderLeft: about(s.shoulderLeft),
    shoulderRight: about(s.shoulderRight),
    hipLeft: about(s.hipLeft),
    hipRight: about(s.hipRight),
  }));
}

describe("gesture classification", () => {
  it("reads a lifting swing as topspin", () => {
    const swings = detect(synthesiseSwing({ shape: SHAPES.topspin! }));
    expect(swings).toHaveLength(1);
    expect(classifyArc(swings[0]!, config)).toBe("low-to-high");
  });

  it("reads a chopping swing as slice", () => {
    const swings = detect(synthesiseSwing({ shape: SHAPES.slice! }));
    expect(swings).toHaveLength(1);
    expect(classifyArc(swings[0]!, config)).toBe("high-to-low");
  });

  it("reads a level swing as flat", () => {
    const swings = detect(synthesiseSwing({ shape: SHAPES.flat! }));
    expect(swings).toHaveLength(1);
    expect(classifyArc(swings[0]!, config)).toBe("flat");
  });

  it("reads a swing finishing above the shoulders as overhead", () => {
    const swings = detect(synthesiseSwing({ shape: SHAPES.overhead! }));
    expect(swings).toHaveLength(1);
    expect(swings[0]!.wristAboveShoulder).toBeGreaterThan(config.overheadHeight);
    expect(classifyArc(swings[0]!, config)).toBe("overhead");
  });
});

describe("rejection", () => {
  it("fires nothing when the player stands still", () => {
    expect(detect(synthesiseIdle())).toHaveLength(0);
  });

  it("ignores small slow movements", () => {
    expect(detect(synthesiseSwing({ shape: SHAPES.fidget! }))).toHaveLength(0);
  });

  it("ignores frames where the body is barely visible", () => {
    const swings = detect(
      synthesiseSwing({ shape: SHAPES.topspin!, visibility: 0.2 })
    );
    expect(swings).toHaveLength(0);
  });

  it("fires once per swing, not once per fast frame", () => {
    const swings = detect(synthesiseSwing({ shape: SHAPES.topspin! }));
    expect(swings).toHaveLength(1);
  });

  it("suppresses a second swing inside the refractory window", () => {
    // Reset far too quickly for the refractory gap to have elapsed.
    const swings = detect(
      synthesiseRally([SHAPES.topspin!, SHAPES.topspin!], { resetMs: 200 }),
      { refractoryMs: 1500 }
    );
    expect(swings).toHaveLength(1);
  });

  it("allows a second swing once the arm has settled", () => {
    const swings = detect(synthesiseRally([SHAPES.topspin!, SHAPES.slice!]));
    expect(swings).toHaveLength(2);
    expect(classifyArc(swings[0]!, config)).toBe("low-to-high");
    expect(classifyArc(swings[1]!, config)).toBe("high-to-low");
  });

  it("does not fire on the recovery between shots", () => {
    const swings = detect(
      synthesiseRally([SHAPES.topspin!, SHAPES.topspin!, SHAPES.topspin!])
    );
    // Three swings and two resets: exactly the swings should register.
    expect(swings).toHaveLength(3);
  });
});

describe("invariance", () => {
  it("measures the same swing the same way at 30 and 60 fps", () => {
    // Regression: a fixed per-frame EMA smoothed twice as hard at 30 fps, so
    // shot power depended on the player's webcam rather than their swing.
    const at30 = detect(synthesiseSwing({ shape: SHAPES.topspin!, fps: 30 }));
    const at60 = detect(synthesiseSwing({ shape: SHAPES.topspin!, fps: 60 }));

    expect(at30).toHaveLength(1);
    expect(at60).toHaveLength(1);

    const ratio = at60[0]!.peakSpeed / at30[0]!.peakSpeed;
    expect(ratio).toBeGreaterThan(0.9);
    expect(ratio).toBeLessThan(1.1);
  });

  it("measures the same swing at different distances from the camera", () => {
    const base = synthesiseSwing({ shape: SHAPES.topspin! });
    const near = detect(scaleBody(base, 1.35));
    const far = detect(scaleBody(base, 0.7));

    expect(near).toHaveLength(1);
    expect(far).toHaveLength(1);
    // Speeds are in torso-lengths, so stepping back must not weaken the shot.
    expect(near[0]!.peakSpeed).toBeCloseTo(far[0]!.peakSpeed, 4);
    expect(classifyArc(near[0]!, config)).toBe(classifyArc(far[0]!, config));
  });

  it("detects either hand", () => {
    const right = detect(synthesiseSwing({ shape: SHAPES.topspin!, hand: "right" }));
    const left = detect(synthesiseSwing({ shape: SHAPES.topspin!, hand: "left" }));

    expect(right).toHaveLength(1);
    expect(left).toHaveLength(1);
    expect(right[0]!.hand).toBe("right");
    expect(left[0]!.hand).toBe("left");
  });
});

describe("swing event mapping", () => {
  it("undoes pipeline latency on the timestamp", () => {
    const swings = detect(synthesiseSwing({ shape: SHAPES.topspin! }));
    const event = toSwingEvent(swings[0]!, config);

    expect(event.t).toBe(swings[0]!.peakT - config.latencyCompensationMs);
  });

  it("turns lean into aim", () => {
    const right = detect(synthesiseSwing({ shape: SHAPES.topspin!, lean: 0.25 }));
    const left = detect(synthesiseSwing({ shape: SHAPES.topspin!, lean: -0.25 }));

    const aimRight = toSwingEvent(right[0]!, config).lateralBias;
    const aimLeft = toSwingEvent(left[0]!, config).lateralBias;

    expect(aimRight).toBeGreaterThan(0.2);
    expect(aimLeft).toBeLessThan(-0.2);
    expect(aimRight).toBeCloseTo(-aimLeft, 6);
  });

  it("keeps aim inside the engine's range", () => {
    const extreme = detect(synthesiseSwing({ shape: SHAPES.topspin!, lean: 0.6 }));
    const event = toSwingEvent(extreme[0]!, config);
    expect(event.lateralBias).toBeLessThanOrEqual(1);
    expect(event.lateralBias).toBeGreaterThanOrEqual(-1);
  });

  it("gives a faster swing more power", () => {
    const slow = detect(
      synthesiseSwing({
        shape: { ...SHAPES.topspin!, durationMs: 520 },
      })
    );
    const fast = detect(
      synthesiseSwing({
        shape: { ...SHAPES.topspin!, durationMs: 220 },
      })
    );

    expect(slow).toHaveLength(1);
    expect(fast).toHaveLength(1);
    expect(toSwingEvent(fast[0]!, config).power).toBeGreaterThan(
      toSwingEvent(slow[0]!, config).power
    );
  });

  it("produces power inside 0..1", () => {
    const wild = detect(
      synthesiseSwing({ shape: { ...SHAPES.topspin!, durationMs: 90 } })
    );
    for (const swing of wild) {
      const event = toSwingEvent(swing, config);
      expect(event.power).toBeGreaterThanOrEqual(0);
      expect(event.power).toBeLessThanOrEqual(1);
    }
  });
});

describe("debug output", () => {
  it("tracks speed and arming for the tuning overlay", () => {
    let state = createDetectorState();
    let sawArmed = false;
    let peak = 0;

    for (const sample of synthesiseSwing({ shape: SHAPES.topspin! })) {
      const result = pushSample(state, sample, config);
      state = result.state;
      if (state.debug.armed) sawArmed = true;
      peak = Math.max(peak, state.debug.speed);
    }

    expect(sawArmed).toBe(true);
    expect(peak).toBeGreaterThan(config.minPeakSpeed);
    expect(state.debug.trace.length).toBeGreaterThan(10);
    expect(state.debug.torsoScale).toBeGreaterThan(0);
  });
});
