import { describe, expect, it } from "vitest";
import type { SwingEvent } from "../engine/shotTypes";
import { createNetSession, type NetSession } from "./netSession";
import { createLoopback } from "./transport";

const swing = (over: Partial<SwingEvent> = {}): SwingEvent => ({
  t: 0,
  arc: "low-to-high",
  power: 0.65,
  lateralBias: 0,
  side: "forehand",
  ...over,
});

/** A connected pair, with `latencyMs` of delay in each direction. */
function pair(latencyMs = 0) {
  const link = createLoopback({ latencyMs });
  const host = createNetSession("host", link.a, { seed: 11 });
  const guest = createNetSession("guest", link.b, { seed: 11 });
  link.pump(latencyMs + 1);
  return { host, guest, link };
}

/**
 * Run both peers for `frames`, serving and returning on whichever side is due.
 *
 * Each peer acts only on its own behalf and only *once* per incoming ball, as a
 * human does — swinging on every frame the window is open would spam the wire
 * with swings the host is obliged to ignore.
 *
 * `offsetMs` mistimes a side. Two perfectly timed players rally indefinitely by
 * design, so without it no point would ever finish and nothing could be
 * asserted about scoring.
 */
function play(
  ctx: ReturnType<typeof pair>,
  frames: number,
  options: {
    hostPlays?: boolean;
    guestPlays?: boolean;
    offsetMs?: Partial<Record<"host" | "guest", number>>;
  } = {}
) {
  const { host, guest, link } = ctx;
  const hostPlays = options.hostPlays ?? true;
  const guestPlays = options.guestPlays ?? true;
  const dt = 16;
  const swungFor: Record<"host" | "guest", string | null> = {
    host: null,
    guest: null,
  };

  for (let i = 0; i < frames; i++) {
    host.beginFrame();
    guest.beginFrame();

    const act = (session: NetSession, who: "host" | "guest", enabled: boolean) => {
      if (!enabled) return;
      const s = session.state;
      const offset = options.offsetMs?.[who] ?? 0;

      if (s.phase === "awaiting-serve" && s.match.server === "near") {
        const key = `serve:${s.serveFaults}:${s.match.points.near}:${s.match.points.far}`;
        if (swungFor[who] === key) return;
        swungFor[who] = key;
        session.swing(swing({ t: s.timeMs, arc: "overhead", power: 0.6 }));
        return;
      }

      if (
        s.phase === "in-play" &&
        s.strike?.striker === "near" &&
        s.timeMs >= s.strike.idealTimeMs + offset
      ) {
        const key = `hit:${s.strike.idealTimeMs}`;
        if (swungFor[who] === key) return;
        swungFor[who] = key;
        session.swing(swing({ t: s.timeMs }));
      }
    };

    act(host, "host", hostPlays);
    act(guest, "guest", guestPlays);

    host.advance(dt);
    guest.advance(dt);
    link.pump(dt);
  }
}

describe("connection", () => {
  it("reaches playing on both ends", () => {
    const { host, guest } = pair();
    expect(host.status).toBe("playing");
    expect(guest.status).toBe("playing");
  });

  it("hangs up cleanly", () => {
    const ctx = pair();
    ctx.host.dispose();
    ctx.link.pump(1);
    expect(ctx.host.status).toBe("closed");
    expect(ctx.guest.status).toBe("closed");
  });
});

describe("authority", () => {
  it("ignores a guest swing when it is not their turn", () => {
    const ctx = pair();
    // Host serves first, so the guest has no business swinging.
    const before = ctx.host.state.hitCount;
    ctx.guest.swing(swing({ arc: "overhead", power: 1 }));
    ctx.link.pump(1);
    ctx.host.advance(16);
    expect(ctx.host.state.hitCount).toBe(before);
    expect(ctx.host.state.phase).toBe("awaiting-serve");
  });

  it("never lets the guest simulate locally", () => {
    const ctx = pair();
    const before = ctx.guest.state.hitCount;
    ctx.guest.swing(swing());
    // No pump: nothing has reached the host, so nothing may have changed.
    expect(ctx.guest.state.hitCount).toBe(before);
  });

  it("puts the ball in play when the host serves", () => {
    const ctx = pair();
    play(ctx, 200, { guestPlays: false });
    expect(ctx.host.state.hitCount).toBeGreaterThan(0);
  });
});

describe("mirroring across the wire", () => {
  it("shows each player themselves at the near end", () => {
    const ctx = pair();
    play(ctx, 400);

    // Whoever the host calls "far" is the guest's "near", by construction.
    expect(ctx.guest.state.striker).toBe(
      ctx.host.state.striker === "near" ? "far" : "near"
    );
  });

  it("puts the ball on opposite halves for the two players", () => {
    const ctx = pair();
    play(ctx, 300);
    if (ctx.host.state.phase !== "in-play") play(ctx, 200);

    expect(ctx.guest.state.ball.pos.z).toBeCloseTo(-ctx.host.state.ball.pos.z, 3);
    expect(ctx.guest.state.ball.pos.x).toBeCloseTo(-ctx.host.state.ball.pos.x, 3);
    expect(ctx.guest.state.ball.pos.y).toBeCloseTo(ctx.host.state.ball.pos.y, 3);
  });

  it("shows each player their own score first", () => {
    const ctx = pair();
    play(ctx, 3000, { offsetMs: { guest: 210 } });

    expect(ctx.host.state.match.points.near).toBe(ctx.guest.state.match.points.far);
    expect(ctx.host.state.match.points.far).toBe(ctx.guest.state.match.points.near);
    expect(ctx.host.state.match.games.near).toBe(ctx.guest.state.match.games.far);
  });
});

describe("a real exchange", () => {
  it("plays points with both peers acting", () => {
    const ctx = pair();
    play(ctx, 4000, { offsetMs: { guest: 210 } });

    expect(ctx.host.stats.totalPoints).toBeGreaterThan(0);
  });

  it("rallies indefinitely when neither player errs", () => {
    // Not a fault: two perfectly timed players is a rally that does not end,
    // and the same is true in the single-player engine.
    const ctx = pair();
    play(ctx, 2500);
    expect(ctx.host.state.hitCount).toBeGreaterThan(6);
    expect(ctx.host.stats.totalPoints).toBe(0);
  });

  it("sends one swing per ball, not one per frame", () => {
    // The host discards swings that are not due, so spam is harmless — but it
    // would still be paid for on the wire every frame of every rally.
    const link = createLoopback();
    const host = createNetSession("host", link.a, { seed: 5 });
    const guest = createNetSession("guest", link.b, { seed: 5 });
    link.pump(1);

    let sent = 0;
    const original = link.b.send.bind(link.b);
    link.b.send = (m) => {
      if (m.t === "swing") sent++;
      original(m);
    };

    play({ host, guest, link }, 1500, { offsetMs: { guest: 120 } });
    expect(sent).toBeGreaterThan(0);
    expect(sent).toBeLessThan(60);
  });

  it("keeps the guest's view in step with the host's score", () => {
    const ctx = pair();
    play(ctx, 4000, { offsetMs: { guest: 210 } });
    // The guest holds no authority, so its score can only come from the host.
    expect(ctx.guest.state.match.games.near + ctx.guest.state.match.games.far).toBe(
      ctx.host.state.match.games.near + ctx.host.state.match.games.far
    );
  });

  it("still works at a realistic round trip", () => {
    // 40 ms each way against a 700-900 ms ball flight: the whole reason the
    // sport was chosen over table tennis.
    const ctx = pair(40);
    play(ctx, 4000, { offsetMs: { guest: 210 } });

    expect(ctx.host.status).toBe("playing");
    expect(ctx.guest.status).toBe("playing");
    expect(ctx.guest.state.match.points.far).toBe(ctx.host.state.match.points.near);
  });

  it("delivers events to the guest for sound and the HUD", () => {
    const ctx = pair();
    let seen = 0;
    for (let i = 0; i < 600; i++) {
      ctx.host.beginFrame();
      ctx.guest.beginFrame();
      const s = ctx.host.state;
      if (s.phase === "awaiting-serve" && s.match.server === "near") {
        ctx.host.swing(swing({ t: s.timeMs, arc: "overhead", power: 0.6 }));
      }
      ctx.host.advance(16);
      ctx.guest.advance(16);
      ctx.link.pump(16);
      seen += ctx.guest.events.length;
    }
    expect(seen).toBeGreaterThan(0);
  });

  it("counts the same points on both sides", () => {
    const ctx = pair();
    play(ctx, 4000, { offsetMs: { guest: 210 } });
    expect(ctx.host.stats.totalPoints).toBeGreaterThan(0);
    expect(ctx.guest.stats.totalPoints).toBe(ctx.host.stats.totalPoints);
  });
});

describe("robustness", () => {
  it("survives a peer that vanishes mid-rally", () => {
    const ctx = pair();
    play(ctx, 500);
    ctx.link.a.close();

    // The host must keep running rather than throwing into the render loop.
    expect(() => play(ctx, 200)).not.toThrow();
    expect(ctx.host.status).toBe("closed");
  });

  it("refuses a peer speaking a different protocol version", () => {
    const link = createLoopback();
    const host = createNetSession("host", link.a, { seed: 3 });
    link.b.send({ t: "hello", version: 999, role: "guest" });
    link.pump(1);
    expect(host.status).toBe("closed");
  });
});
