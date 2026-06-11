# Tennis — Design

Webcam-controlled 3D tennis. You stand in front of a camera, swing, and play a bot.

## The constraint everything else follows from

A webcam pose pipeline has roughly **80–120 ms** of end-to-end latency:

| stage | cost |
| --- | --- |
| camera frame interval @30fps | ~33 ms |
| MediaPipe pose inference | ~20–50 ms |
| smoothing filter lag | ~20–30 ms |

That latency is fixed. The only design lever is **how much time the ball spends in the air**, because that is the budget the player has to react and swing.

| sport | ball travel time | latency as % of budget |
| --- | --- | --- |
| table tennis | 110–250 ms | 40–90% — unplayable |
| **tennis** | **700–900 ms** | **~13% — comfortable** |
| badminton | 600–1500 ms | ~10% |

Tennis was chosen for this reason. Table tennis was the original idea and was rejected: the rally is over before the pipeline has reported where your arm is, and a 15 cm bat demands positional precision below the noise floor of MediaPipe's wrist landmark (several cm of jitter, plus no reliable depth from a single camera).

## The core mechanic

**The avatar auto-positions to the ball. The player controls the swing.**

A webcam sees a ~1×2 m box. A tennis court is 24 m long and 11 m wide. Mapping real lateral movement onto court position is hopeless, so we don't try. The avatar runs to the ball on its own; the player supplies timing and shot shape.

This is the Wii Sports Tennis model, and it is load-bearing for three separate reasons:

1. It fits the physical space a webcam actually covers.
2. It is robust to landmark jitter — we read swing *velocity across an arc*, not arm position.
3. It makes networked multiplayer tractable later (see below).

### What is NOT done

The arm is **not** a physics collider that the ball tests against. That design is intuitive and fails in practice: jitter produces phantom hits, latency produces ghost misses, and every whiff reads as the game's fault rather than the player's. A measurement failure must never render as a bad performance.

### What IS done

A swing is detected as **wrist velocity crossing a threshold while travelling through a gesture arc**. That yields a `SwingEvent`:

```ts
type SwingEvent = {
  t: number;            // ms, when the swing peaked
  arc: SwingArc;        // 'low-to-high' | 'high-to-low' | 'overhead' | 'flat'
  power: number;        // 0..1; the input adapter owns the calibration
  lateralBias: number;  // -1..1 from torso lean — biases placement
  side: 'forehand' | 'backhand';
};
```

The engine grades that event's timestamp against the window when the ball is in the hit zone. Timing quality determines power and accuracy; `arc` determines shot type:

| arc | shot | spin |
| --- | --- | --- |
| low-to-high | topspin drive | forward spin, dips into court |
| high-to-low | slice | backspin, floats and skids |
| overhead | smash | flat, high power |
| flat | flat drive | minimal spin |

## Architecture

```
src/
  engine/     pure, deterministic, no DOM, no THREE — fully unit tested
  vision/     MediaPipe -> SwingEvent adapter
  scene/      THREE.js renderer, reads engine state, owns no logic
  ui/         React HUD, scoreboard, tuning overlay
  store/      zustand glue
```

The **engine is pure and deterministic**. It receives abstract `SwingEvent`s and advances a fixed-timestep simulation. It knows nothing about cameras, canvases, or React. Consequences:

- Testable with synthetic swings; no camera needed in CI.
- Playable via keyboard before any vision code exists, so game feel can be tuned independently of pose tuning.
- Bot and player drive the *same* input interface, so the bot is not a special case.
- Swapping pose models later touches one directory.

### Multiplayer

Built as an **authoritative host** rather than the deterministic lockstep this
section originally imagined.

The engine *is* deterministic, but `advance` takes a variable delta: two peers
running at different frame rates would apply swings at different points in the
physics accumulator and drift apart with nothing to detect it. Lockstep would
have meant reworking the session onto a fixed logical tick. An authoritative
host cannot desync at all, and it costs only a round trip on the guest's own
swing — which the sport's 700-900 ms ball flight absorbs easily. That latency
budget is the same reason tennis was chosen over table tennis, being spent a
second time.

The guest carries the ball forward with the real physics between the host's
30 Hz snapshots, so motion stays smooth and is corrected the instant the next
snapshot lands.

Both players see themselves at the near end, so the guest's world arrives
mirrored: positions and velocities rotate 180 degrees about the vertical axis,
spin transforms with them, and every side label swaps. `mirrorSnapshot` is its
own inverse — the property that stops the two players slowly drifting into
different worlds, and it is asserted as such.

Signalling is copy-paste. There is no server to deploy or keep running, and the
game needs neither matchmaking nor discovery: two people who already know each
other want one connection. The cost is a long code and no TURN fallback, so two
players both behind symmetric NAT will not connect.

## Physics

Fixed timestep (240 Hz internal, decoupled from render). Forces on the ball:

- gravity
- quadratic air drag
- **Magnus force** from the spin vector

Magnus is not optional. Topspin diving into the court and slice floating long is most of what makes a tennis rally *read* as tennis. Without it every shot is a parabola and the game feels like Pong.

Bounce applies spin-dependent restitution and surface friction, and converts some spin into horizontal velocity (topspin kicks forward and up, backspin skids low).

## Bot

Same `SwingEvent` interface as the player. Difficulty is three knobs:

- **reaction delay** — ms before it commits to a shot
- **placement error radius** — metres of scatter on its target
- **aggression** — how often it goes for a winner vs a safe rally ball

## Coordinates

`+x` is one side of the court in world space, but the camera sits *behind* the
near player, so **world +x renders on screen left**. The near player defends -z
and therefore faces +z, putting their right hand at world -x; the far player is
the mirror image.

Anything expressed from a player's point of view — aim from a lean, stance from
a step, a keyboard "aim right" — must pass through `playerRightX(side)` to reach
world coordinates. This is not a pedantic distinction: skipping it made pressing
*right* visibly send the ball *left*, and made the footwork layer penalise the
near player precisely for stepping the correct way.

The rule of thumb is that a player-relative quantity and a world coordinate must
never be compared without a conversion between them.

## Footwork

The avatar still runs to the ball — that decision is load-bearing and is not
undone. Footwork adds *credit for covering the court yourself*: step across for
a ball pulling you wide and the shot comes off better, stand rooted and it comes
off worse.

It reads the hips actually translating across the frame, which is distinct from
the torso lean that drives aim — lean is a shoulder rotation you can do standing
still, a step is work. The neutral centre drifts slowly, so a player who sets up
off-centre does not collect a free bonus all match, but a genuine step still
registers.

Footwork changes how well a shot comes off, never whether it connects. A player
who covered the court should hit a better ball, not be the only one allowed to
hit at all. Stance is optional on `SwingEvent` and only the camera reports it,
so keyboard and bot play are completely unaffected.

## Reading the camera

The detector is pure — state in, state out, no camera, no MediaPipe, no clock —
so gesture logic is tested against synthetic swings rather than by waving at a
laptop and hoping. Three decisions carry most of the weight:

**Speeds are measured in torso-lengths per second, not pixels.** Normalising by
the shoulder-to-hip distance is what stops every threshold breaking when the
player stands closer to or further from the camera.

**The filters are time constants, not per-frame blend factors.** A fixed
per-frame EMA smooths twice as hard at 30 fps as at 60, and the identical
physical swing measured a peak of 7.8 on one and 8.9 on the other — shot power
would have depended on the player's webcam.

**Swings fire on the confirmed peak, not the end of the follow-through.**
Waiting for the arm to stop would hand the engine a swing ~150 ms stale, by
which time the ball has moved on. The event is dated to the peak frame either
way, so grading stays honest.

Latency compensation lives here and nowhere else. The engine grades swing
timestamps at face value, because the bot and the keyboard have no sensor lag to
undo — applying a camera's compensation to them would bias every one of their
swings early.

## Tuning overlay

Swing thresholds cannot be tuned from synthetic tests — they depend on real bodies, real lighting, and real camera placement. So the pose milestone ships **with** a live overlay: skeleton wireframe, wrist velocity trace, hit-zone volume, and a slider for every threshold, adjustable while playing. Tuning is a ten-minute session in front of the camera, not a deferred TODO.

## Milestones

- **M0** scaffold + this document
- **M1** ball physics with Magnus
- **M2** pure rally engine, shot solver, scoring
- **M3** bot opponent
- **M4** Three.js court, avatars, cameras, keyboard play
- **M5** pose adapter + tuning overlay
- **M6** game feel, sound, match presentation

Later: footwork layer, shot-event multiplayer.

The bot moved ahead of the renderer deliberately: it drives the same
`SwingEvent` interface as the player, so once it exists the first thing the
scene renders is a live rally rather than an empty court.

### Shot targeting

Magnus makes the trajectory non-analytic, so shots are solved *forwards*: pick a
target, take launch speed from the swing's power, then search elevation angles
against the real simulation for one that both clears the net and carries far
enough, preferring the flattest. Searching the same `stepBall` used in play
means a predicted shot and a played shot cannot drift apart.

A swing that no angle can rescue still returns its best attempt rather than an
error — a ball dumped into the net is a legitimate outcome of a bad swing, not a
case the caller should have to handle.
