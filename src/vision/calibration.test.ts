import { describe, expect, it } from "vitest";
import {
  analyseCalibration,
  applyCalibration,
  findPeaks,
  type CalibrationResult,
} from "./calibration";
import { DEFAULT_SWING_CONFIG, type SwingConfig } from "./swingConfig";

/**
 * A speed trace: `count` bell-shaped swings of the given peak, separated by
 * near-idle stretches, plus a little noise throughout.
 */
function trace(options: {
  count: number;
  peak: number;
  jitter?: number;
  swingSamples?: number;
  gapSamples?: number;
  noise?: number;
}): number[] {
  const {
    count,
    peak,
    jitter = 0,
    swingSamples = 12,
    gapSamples = 25,
    noise = 0.05,
  } = options;

  const speeds: number[] = [];
  // Deterministic pseudo-noise; tests must not depend on Math.random.
  let seed = 7;
  const wobble = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return ((seed / 0x7fffffff) * 2 - 1) * noise;
  };

  for (let s = 0; s < count; s++) {
    for (let i = 0; i < gapSamples; i++) speeds.push(Math.abs(wobble()));
    const amplitude = peak + (s % 2 === 0 ? jitter : -jitter);
    for (let i = 0; i < swingSamples; i++) {
      const phase = (i / (swingSamples - 1)) * Math.PI;
      speeds.push(Math.max(0, Math.sin(phase) * amplitude + wobble()));
    }
  }
  for (let i = 0; i < gapSamples; i++) speeds.push(Math.abs(wobble()));
  return speeds;
}

const ok = (r: ReturnType<typeof analyseCalibration>): CalibrationResult => {
  if ("problem" in r) throw new Error(`expected success, got ${r.problem}`);
  return r;
};

describe("findPeaks", () => {
  it("finds one peak per swing", () => {
    expect(findPeaks(trace({ count: 5, peak: 6 }))).toHaveLength(5);
  });

  it("ignores idle noise", () => {
    const idle = trace({ count: 0, peak: 0, gapSamples: 120 });
    expect(findPeaks(idle)).toHaveLength(0);
  });

  it("does not split one swing into two", () => {
    // A bumpy profile: a dip partway up the same gesture.
    const bumpy = [0, 0.1, 2, 4, 3.6, 5.5, 6, 4, 1, 0.2, 0];
    expect(findPeaks(bumpy, 8)).toHaveLength(1);
  });

  it("returns peaks largest first", () => {
    const peaks = findPeaks([0, 3, 0, 0, 0, 0, 0, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0, 5, 0]);
    expect(peaks).toEqual([...peaks].sort((a, b) => b - a));
  });
});

describe("analyseCalibration", () => {
  it("derives thresholds below the player's peak", () => {
    const result = ok(analyseCalibration(trace({ count: 5, peak: 6 }), 5));

    expect(result.medianPeak).toBeGreaterThan(5);
    expect(result.medianPeak).toBeLessThan(7);

    const { enterSpeed, exitSpeed, minPeakSpeed } = result.suggestion;
    // Arming must happen well before the peak, or the swing is recognised only
    // after it has already finished.
    expect(enterSpeed).toBeLessThan(result.medianPeak * 0.6);
    expect(exitSpeed).toBeLessThan(enterSpeed);
    expect(minPeakSpeed).toBeLessThan(result.medianPeak);
    expect(minPeakSpeed).toBeGreaterThan(enterSpeed);
  });

  it("scales to a gentle swinger", () => {
    const gentle = ok(analyseCalibration(trace({ count: 5, peak: 2.5 }), 5));
    // The shipped default of 3.0 would have ignored this player entirely.
    expect(gentle.suggestion.minPeakSpeed).toBeLessThan(
      DEFAULT_SWING_CONFIG.minPeakSpeed
    );
    expect(gentle.suggestion.enterSpeed).toBeLessThan(
      DEFAULT_SWING_CONFIG.enterSpeed
    );
  });

  it("scales to a violent swinger", () => {
    const violent = ok(analyseCalibration(trace({ count: 5, peak: 16 }), 5));
    // Defaults would have pinned this player at full power on every shot.
    expect(violent.suggestion.enterSpeed).toBeGreaterThan(
      DEFAULT_SWING_CONFIG.enterSpeed
    );
    expect(violent.suggestion.powerRange[1]).toBeGreaterThan(
      DEFAULT_SWING_CONFIG.powerSpeedMax
    );
  });

  it("puts a typical swing in the middle of the power range", () => {
    const result = ok(analyseCalibration(trace({ count: 5, peak: 7 }), 5));
    const [lo, hi] = result.suggestion.powerRange;
    const typical = (result.medianPeak - lo) / (hi - lo);

    // A normal rally swing should feel like a normal shot, with headroom above.
    expect(typical).toBeGreaterThan(0.3);
    expect(typical).toBeLessThan(0.85);
  });

  it("lets the hardest swing reach full power", () => {
    const result = ok(analyseCalibration(trace({ count: 5, peak: 8 }), 5));
    const [lo, hi] = result.suggestion.powerRange;
    expect((result.maxPeak - lo) / (hi - lo)).toBeGreaterThan(0.8);
  });

  it("tolerates swings of uneven strength", () => {
    const result = ok(
      analyseCalibration(trace({ count: 6, peak: 6, jitter: 1.5 }), 5)
    );
    expect(result.suggestion.minPeakSpeed).toBeGreaterThan(0);
  });

  it("reports no signal when the player never moved", () => {
    const result = analyseCalibration(new Array(200).fill(0.02), 5);
    expect(result).toEqual({ problem: "no-signal" });
  });

  it("reports too few swings rather than guessing", () => {
    const result = analyseCalibration(trace({ count: 1, peak: 6 }), 5);
    expect(result).toEqual({ problem: "too-few-swings" });
  });

  it("rejects a trace dominated by one huge outlier", () => {
    // e.g. the player walked into frame partway through.
    const mixed = [
      ...trace({ count: 4, peak: 1.2 }),
      ...trace({ count: 1, peak: 40 }),
    ];
    const result = analyseCalibration(mixed, 5);
    expect(result).toEqual({ problem: "inconsistent" });
  });

  it("is deterministic", () => {
    const samples = trace({ count: 5, peak: 6 });
    expect(analyseCalibration(samples, 5)).toEqual(
      analyseCalibration(samples, 5)
    );
  });
});

describe("applyCalibration", () => {
  it("writes every derived threshold into the config", () => {
    const config: SwingConfig = { ...DEFAULT_SWING_CONFIG };
    const result = ok(analyseCalibration(trace({ count: 5, peak: 6 }), 5));
    applyCalibration(config, result.suggestion);

    expect(config.enterSpeed).toBe(result.suggestion.enterSpeed);
    expect(config.exitSpeed).toBe(result.suggestion.exitSpeed);
    expect(config.minPeakSpeed).toBe(result.suggestion.minPeakSpeed);
    expect(config.powerSpeedMin).toBe(result.suggestion.powerRange[0]);
    expect(config.powerSpeedMax).toBe(result.suggestion.powerRange[1]);
  });

  it("leaves unrelated settings alone", () => {
    const config: SwingConfig = { ...DEFAULT_SWING_CONFIG };
    const result = ok(analyseCalibration(trace({ count: 5, peak: 6 }), 5));
    applyCalibration(config, result.suggestion);

    expect(config.latencyCompensationMs).toBe(
      DEFAULT_SWING_CONFIG.latencyCompensationMs
    );
    expect(config.leanGain).toBe(DEFAULT_SWING_CONFIG.leanGain);
    expect(config.overheadHeight).toBe(DEFAULT_SWING_CONFIG.overheadHeight);
  });
});
