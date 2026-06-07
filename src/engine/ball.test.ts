import { describe, expect, it } from "vitest";
import { aeroAcceleration, stepBall, type BallState } from "./ball";
import { BALL, GRAVITY, PHYSICS_DT } from "./constants";
import { vec, type Vec3 } from "./vec3";

/** Launch a ball from the near baseline towards +z. */
function launch(opts: {
  speed: number;
  angleDeg: number;
  spin?: Vec3;
  height?: number;
}): BallState {
  const rad = (opts.angleDeg * Math.PI) / 180;
  return {
    pos: vec(0, opts.height ?? 1.0, -11.885),
    vel: vec(0, opts.speed * Math.sin(rad), opts.speed * Math.cos(rad)),
    spin: opts.spin ?? vec(),
  };
}

type Flight = {
  /** State immediately before the first bounce. */
  beforeBounce: BallState;
  /** State immediately after the first bounce. */
  afterBounce: BallState;
  /** Where the first bounce landed. */
  landing: Vec3;
  /** Highest point the ball reached after the first bounce. */
  bounceApex: number;
  /** Peak height during the initial flight. */
  flightApex: number;
};

/** Run until the ball has bounced once and then reached the top of its hop. */
function flightOf(initial: BallState, maxSeconds = 12): Flight {
  let state = initial;
  let beforeBounce = initial;
  let afterBounce: BallState | null = null;
  let landing: Vec3 = vec();
  let bounceApex = 0;
  let flightApex = initial.pos.y;

  const steps = Math.ceil(maxSeconds / PHYSICS_DT);
  for (let i = 0; i < steps; i++) {
    const prev = state;
    const { state: next, bounces } = stepBall(state, PHYSICS_DT);
    state = next;

    if (!afterBounce) {
      flightApex = Math.max(flightApex, next.pos.y);
      if (bounces.length > 0) {
        beforeBounce = prev;
        afterBounce = next;
        landing = bounces[0]!.at;
      }
    } else {
      bounceApex = Math.max(bounceApex, next.pos.y);
      // Stop once the ball is coming back down from the hop.
      if (next.vel.y < 0 && next.pos.y < bounceApex) break;
    }
  }

  if (!afterBounce) throw new Error("ball never bounced");
  return { beforeBounce, afterBounce, landing, bounceApex, flightApex };
}

describe("aeroAcceleration", () => {
  it("is pure gravity for a stationary ball", () => {
    const acc = aeroAcceleration({ pos: vec(), vel: vec(), spin: vec() });
    expect(acc.x).toBe(0);
    expect(acc.y).toBeCloseTo(-GRAVITY, 6);
    expect(acc.z).toBe(0);
  });

  it("opposes motion with drag", () => {
    const acc = aeroAcceleration({ pos: vec(), vel: vec(0, 0, 25), spin: vec() });
    expect(acc.z).toBeLessThan(0);
    // At 25 m/s drag on a tennis ball is on the order of 1g.
    expect(Math.abs(acc.z)).toBeGreaterThan(5);
    expect(Math.abs(acc.z)).toBeLessThan(25);
  });

  it("pushes down under topspin and up under backspin", () => {
    const base = { pos: vec(), vel: vec(0, 0, 25) };
    const topspin = aeroAcceleration({ ...base, spin: vec(300, 0, 0) });
    const backspin = aeroAcceleration({ ...base, spin: vec(-300, 0, 0) });
    const flat = aeroAcceleration({ ...base, spin: vec() });

    expect(topspin.y).toBeLessThan(flat.y);
    expect(backspin.y).toBeGreaterThan(flat.y);
  });

  it("ignores spin aligned with the direction of travel", () => {
    const gyroscopic = aeroAcceleration({
      pos: vec(),
      vel: vec(0, 0, 25),
      spin: vec(0, 0, 400),
    });
    const flat = aeroAcceleration({ pos: vec(), vel: vec(0, 0, 25), spin: vec() });

    expect(gyroscopic.y).toBeCloseTo(flat.y, 6);
    expect(gyroscopic.x).toBeCloseTo(0, 6);
  });

  it("curves sideways under sidespin", () => {
    const acc = aeroAcceleration({
      pos: vec(),
      vel: vec(0, 0, 25),
      spin: vec(0, 300, 0),
    });
    expect(acc.x).toBeGreaterThan(1);
  });
});

describe("flight", () => {
  it("is deterministic", () => {
    const a = flightOf(launch({ speed: 25, angleDeg: 12, spin: vec(250, 0, 0) }));
    const b = flightOf(launch({ speed: 25, angleDeg: 12, spin: vec(250, 0, 0) }));
    expect(a.landing).toEqual(b.landing);
    expect(a.afterBounce.vel).toEqual(b.afterBounce.vel);
  });

  it("falls short of the drag-free prediction", () => {
    const speed = 25;
    const angle = 12;
    const start = launch({ speed, angleDeg: angle });
    const { landing } = flightOf(start);

    // Vacuum range for the same launch, solved from the projectile equations.
    const rad = (angle * Math.PI) / 180;
    const vy = speed * Math.sin(rad);
    const vz = speed * Math.cos(rad);
    const h = start.pos.y - BALL.radius;
    const tVacuum = (vy + Math.sqrt(vy * vy + 2 * GRAVITY * h)) / GRAVITY;
    const vacuumRange = start.pos.z + vz * tVacuum;

    expect(landing.z).toBeLessThan(vacuumRange);
    // Drag should cost distance, but not absurdly much over ~20 m.
    expect(vacuumRange - landing.z).toBeGreaterThan(0.5);
    expect(vacuumRange - landing.z).toBeLessThan(8);
  });

  it("shortens the ball with topspin and lengthens it with backspin", () => {
    const flat = flightOf(launch({ speed: 25, angleDeg: 12 }));
    const top = flightOf(launch({ speed: 25, angleDeg: 12, spin: vec(300, 0, 0) }));
    const back = flightOf(launch({ speed: 25, angleDeg: 12, spin: vec(-300, 0, 0) }));

    expect(top.landing.z).toBeLessThan(flat.landing.z);
    expect(back.landing.z).toBeGreaterThan(flat.landing.z);
    // The effect has to be big enough to shape tactics, not a rounding error.
    expect(flat.landing.z - top.landing.z).toBeGreaterThan(1.0);
  });

  it("lets topspin be hit harder and still land in", () => {
    // The signature topspin benefit: more pace for the same landing spot.
    const flat = flightOf(launch({ speed: 25, angleDeg: 12 }));
    const top = flightOf(launch({ speed: 30, angleDeg: 12, spin: vec(400, 0, 0) }));

    expect(top.landing.z).toBeLessThanOrEqual(flat.landing.z);
    expect(top.beforeBounce.vel.z).toBeGreaterThan(flat.beforeBounce.vel.z);
  });

  it("bends laterally under sidespin", () => {
    const straight = flightOf(launch({ speed: 25, angleDeg: 12 }));
    const sliced = flightOf(
      launch({ speed: 25, angleDeg: 12, spin: vec(0, 300, 0) })
    );

    expect(Math.abs(straight.landing.x)).toBeLessThan(0.01);
    expect(sliced.landing.x).toBeGreaterThan(0.3);
  });

  it("never gains energy while airborne", () => {
    let state = launch({ speed: 28, angleDeg: 14, spin: vec(200, 0, 0) });
    const energy = (s: BallState) =>
      0.5 * (s.vel.x ** 2 + s.vel.y ** 2 + s.vel.z ** 2) + GRAVITY * s.pos.y;

    let previous = energy(state);
    for (let i = 0; i < 200; i++) {
      const { state: next, bounces } = stepBall(state, PHYSICS_DT);
      if (bounces.length > 0) break;
      state = next;
      const current = energy(state);
      expect(current).toBeLessThanOrEqual(previous + 1e-9);
      previous = current;
    }
  });
});

describe("bounce", () => {
  it("rebounds a vertical drop to roughly the ITF-specified height", () => {
    // ITF: dropped from 100 in, a ball must rebound 53-58 in. Drag costs us a
    // little, so the band here is slightly lower than the bare spec range.
    const drop: BallState = { pos: vec(0, 2.54, 0), vel: vec(), spin: vec() };
    const { bounceApex } = flightOf(drop);

    expect(bounceApex).toBeGreaterThan(1.15);
    expect(bounceApex).toBeLessThan(1.45);
  });

  it("kicks forward off topspin and holds back off backspin", () => {
    const top = flightOf(launch({ speed: 25, angleDeg: 12, spin: vec(400, 0, 0) }));
    const back = flightOf(launch({ speed: 25, angleDeg: 12, spin: vec(-400, 0, 0) }));

    // Compare how much of the incoming pace each keeps through the bounce.
    const topRetention = top.afterBounce.vel.z / top.beforeBounce.vel.z;
    const backRetention = back.afterBounce.vel.z / back.beforeBounce.vel.z;

    expect(topRetention).toBeGreaterThan(backRetention);
  });

  it("makes backspin skid lower than topspin bounces up", () => {
    // Spin must be the ONLY variable here. Comparing two full flights would not
    // isolate the bounce: a backspin ball floats longer and arrives steeper, and
    // that flight difference swamps what the bounce itself does.
    const arriving = (spin: Vec3): BallState => ({
      pos: vec(0, BALL.radius + 0.02, 0),
      vel: vec(0, -8, 18),
      spin,
    });

    const top = flightOf(arriving(vec(400, 0, 0)));
    const back = flightOf(arriving(vec(-400, 0, 0)));
    const flat = flightOf(arriving(vec()));

    expect(top.bounceApex).toBeGreaterThan(flat.bounceApex);
    expect(back.bounceApex).toBeLessThan(flat.bounceApex);
  });

  it("leaves rebound speed untouched by pure sidespin", () => {
    // Only spin about the axis perpendicular to travel should change how hard
    // the ball comes off the court. Note this is asserted on rebound velocity,
    // not on the apex that follows: sidespin diverts pace sideways in flight,
    // which weakens the topspin downforce and does move the apex a little.
    const arriving = (spin: Vec3): BallState => ({
      pos: vec(0, BALL.radius + 0.02, 0),
      vel: vec(0, -8, 18),
      spin,
    });

    const side = flightOf(arriving(vec(0, 400, 0))).afterBounce;
    const flat = flightOf(arriving(vec())).afterBounce;

    // Sampled a step after contact, so a little aero divergence is expected.
    // For scale, topspin shifts this figure by ~0.9 m/s.
    expect(side.vel.y).toBeCloseTo(flat.vel.y, 2);
  });

  it("drives spin towards the rolling condition", () => {
    // Friction always pushes the contact patch towards zero slip. A ball sliding
    // forwards therefore gains topspin, whatever spin it arrived with — a flat
    // ball starts rolling, and a sliced ball has its backspin scrubbed off.
    const arriving = (spin: Vec3): BallState => ({
      pos: vec(0, BALL.radius + 0.02, 0),
      vel: vec(0, -8, 18),
      spin,
    });

    const flat = flightOf(arriving(vec())).afterBounce;
    expect(flat.spin.x).toBeGreaterThan(0);

    const sliced = flightOf(arriving(vec(-400, 0, 0))).afterBounce;
    expect(sliced.spin.x).toBeGreaterThan(-400);

    // Rolling is omega = v/r. Friction should stop exactly there and not spin
    // the ball up past it. Tolerance is loose because the sample is taken a full
    // step after contact, by which point drag has trimmed v slightly.
    const rolling = flat.vel.z / BALL.radius;
    expect(flat.spin.x).toBeLessThanOrEqual(rolling * 1.01);
    expect(flat.spin.x).toBeGreaterThan(rolling * 0.9);
  });

  it("retains more pace through the bounce with topspin than with slice", () => {
    const arriving = (spin: Vec3): BallState => ({
      pos: vec(0, BALL.radius + 0.02, 0),
      vel: vec(0, -8, 18),
      spin,
    });

    const top = flightOf(arriving(vec(400, 0, 0))).afterBounce;
    const flat = flightOf(arriving(vec())).afterBounce;
    const back = flightOf(arriving(vec(-400, 0, 0))).afterBounce;

    expect(top.vel.z).toBeGreaterThan(flat.vel.z);
    expect(back.vel.z).toBeLessThan(flat.vel.z);
  });

  it("loses vertical speed on every bounce", () => {
    const { beforeBounce, afterBounce } = flightOf(
      launch({ speed: 20, angleDeg: 20 })
    );
    expect(Math.abs(afterBounce.vel.y)).toBeLessThan(Math.abs(beforeBounce.vel.y));
  });

  it("resolves the bounce at court level, not below it", () => {
    let state: BallState = { pos: vec(0, 0.5, 0), vel: vec(0, -30, 5), spin: vec() };
    for (let i = 0; i < 240; i++) {
      const { state: next, bounces } = stepBall(state, PHYSICS_DT);
      state = next;
      if (bounces.length > 0) {
        expect(bounces[0]!.at.y).toBeCloseTo(BALL.radius, 6);
        expect(state.pos.y).toBeGreaterThanOrEqual(BALL.radius - 1e-6);
        return;
      }
    }
    throw new Error("expected a bounce");
  });
});
