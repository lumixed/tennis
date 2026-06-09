# Tennis

Webcam-controlled 3D tennis. Stand in front of a camera, swing, and play a bot.

```bash
npm install && npm run dev
```

Then open http://localhost:5450.

## Playing

Pick a starting opponent and a control scheme, then **Play** for a match,
**Practice** to rally without a scoreboard, or **Play a friend** for
head-to-head.

The opponent tracks your level as you go, so the starting choice is only where
it begins. Practice deliberately does not adapt — a target that keeps shifting
is the opposite of what you want while grooving a swing.

**The avatar runs to the ball on its own.** Your job is *when* to swing and
*how* — that is the entire game, and it is a deliberate design choice rather
than a shortcut. See [DESIGN.md](DESIGN.md) for why.

### Camera

| Gesture | Shot |
| --- | --- |
| swing upwards | topspin |
| swing downwards | slice |
| swing level | flat drive |
| reach above your shoulders | overhead / smash |
| lean left or right | aim |
| swing faster | more power |
| step across to a wide ball | better shot |

Stand back far enough that your hips *and* shoulders are in frame — the detector
measures speed in torso-lengths, so it needs to see your torso, and it reads
footwork from your hips moving.

Leaning aims the ball; actually *stepping* toward a ball that pulls you wide
makes the shot come off better, and standing rooted makes it worse. Footwork
never decides whether you connect — only how well.

Press **T** in game for the tuning panel.

### Keyboard

| Key | Shot |
| --- | --- |
| `J` / `Space` | topspin |
| `K` | flat drive |
| `L` | slice |
| `I` | overhead |
| `A` / `D` | aim |
| hold, then release | charge power |
| `M` | mute |

Keyboard mode is not a fallback — it is how the game gets tuned. It drives the
engine through exactly the same `SwingEvent` interface the camera does.

## Tuning the camera

Press **T**, then hit **Calibrate to me** and swing five times. It measures your
actual swing speeds and sets the thresholds from them — a gentle swinger and a
violent one both end up with a game that fits. Do this first; it beats any
constant shipped in the source, which is necessarily tuned to one body at one
distance.

The rest of the panel is there when calibration is not enough: the skeleton, a
live wrist-speed trace drawn against the actual thresholds, a slider for each
one, and performance readouts — all adjustable mid-rally.

If a swing is not registering, watch the trace:

- the peak never reaches the **Min peak** line → lower it, or swing harder
- the trace never crosses **Arm at** → lower it
- `vis` reads red → you are out of frame or too dark
- shots feel late → raise **Latency comp**
- one swing registers as two → raise **Refractory**
- `stance` sits near 0 even when you step → you are not moving far enough for
  the frame, or the neutral centre has drifted onto you; stand still a moment
  and try again

If the game stutters, look at the performance row:

- **delegate** reads `CPU` → the GPU delegate failed to load; inference is
  several times slower and this alone will cause stutter
- **infer ms** above ~22 → pose inference is eating the frame. It runs on the
  main thread, so this is felt directly
- **worst** much higher than **infer ms** → occasional long frames, which read
  as hitches rather than general slowness
- **draw ms** above ~12 → the scene itself is the bottleneck, not the camera

## Playing someone else

**Play a friend** connects two browsers directly, with no server and no
accounts. One player hosts and gets an invite code; the other pastes it and
sends back a reply code. Send them however you already talk — the codes are the
entire handshake.

The host runs the only simulation and the guest renders what it is told, so the
two can never disagree about the score. Both players see themselves at the near
end: the guest's whole world is mirrored on arrival.

That design is only viable because of the sport. A swing takes a round trip to
be acknowledged, which would be fatal in table tennis — but the ball is in the
air for 700–900 ms here, against an RTT of tens.

There is no TURN server, so two players both behind symmetric NAT will fail to
connect. Everything else should work.

## Layout

```
src/
  engine/   pure, deterministic simulation — no DOM, no THREE, fully tested
  vision/   MediaPipe -> SwingEvent; the detector itself is pure and tested
  scene/    THREE.js rendering; reads engine state, owns no logic
  input/    keyboard adapter
  game/     session, hit-stop and slow motion
  net/      head-to-head over WebRTC; protocol and sync are pure and tested
  audio/    synthesised sound, no asset files
  ui/       HUD and the tuning overlay
```

The engine is pure and deterministic: same seed, same match. It never learns
whether a swing came from a camera, a keyboard or the bot.

During a match you get break/set/match point called out, games and sets
announced, and a reason for every point you lose. At the end you get winners,
unforced errors, aces, double faults, longest rally and how many of your swings
were on time — plus one thing to work on.

```bash
npm test         # 251 tests
npm run typecheck
npm run build
```

## Status

M0–M12 complete: physics, rally engine, bot, renderer, pose input, game feel,
footwork, readability, adaptive calibration, an adaptive opponent, match
presentation, practice mode and head-to-head multiplayer.

The camera path has been played and verified on a real webcam: pose runs at
~30 fps on the GPU delegate with ~15 ms inference, and a recorded session went
from being shut out to winning games.

Shot power is learned from your own swings as you play, so the game fits
whoever is in front of the camera without anyone touching a slider. The
opponent tracks your level between points rather than sitting on a preset.
Explicit calibration (**T**) is still there when you want to set it directly.

Multiplayer has been tested over a real WebRTC data channel — connection,
mirroring and a full match with scores agreeing on both ends — but only ever
looped back within one browser. It has never run between two machines on a real
network, so latency, NAT traversal and disconnects are unproven in the field.
