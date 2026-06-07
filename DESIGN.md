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
  peakSpeed: number;    // normalised units/s — maps to shot power
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

### Multiplayer (later)

Because input is discrete `SwingEvent`s rather than continuous pose, networked play syncs **shot events** — a resolved ball state vector plus spin plus timestamp — a few bytes per stroke. No continuous state streaming, no rollback netcode. The auto-positioning decision is what buys this.

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

## Tuning overlay

Swing thresholds cannot be tuned from synthetic tests — they depend on real bodies, real lighting, and real camera placement. So the pose milestone ships **with** a live overlay: skeleton wireframe, wrist velocity trace, hit-zone volume, and a slider for every threshold, adjustable while playing. Tuning is a ten-minute session in front of the camera, not a deferred TODO.

## Milestones

- **M0** scaffold + this document
- **M1** ball physics with Magnus
- **M2** pure rally engine, scoring, keyboard input
- **M3** Three.js court, avatars, cameras
- **M4** bot opponent
- **M5** pose adapter + tuning overlay
- **M6** game feel, sound, match presentation

Later: footwork layer, shot-event multiplayer.
