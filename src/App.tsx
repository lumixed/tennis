import { useCallback, useEffect, useRef, useState } from "react";
import { DIFFICULTIES } from "./engine/bot";
import type { TimingGrade } from "./engine/shotTypes";
import { createSound } from "./audio/sound";
import { createSession, type Controller, type Session } from "./game/session";
import { createTimeControl } from "./game/timeControl";
import { createKeyboardInput } from "./input/keyboard";
import { createGameScene } from "./scene/gameScene";
import { Hud, type HudSnapshot } from "./ui/Hud";
import { TuningOverlay } from "./ui/TuningOverlay";
import { createPoseInput, type PoseInput } from "./vision/poseInput";

export type InputMode = "keyboard" | "camera";

type Setup = {
  difficulty: keyof typeof DIFFICULTIES;
  nearControl: Controller;
  inputMode: InputMode;
};

export function App() {
  const [setup, setSetup] = useState<Setup | null>(null);

  return setup ? (
    <Court setup={setup} onExit={() => setSetup(null)} />
  ) : (
    <StartScreen onStart={setSetup} />
  );
}

function StartScreen({ onStart }: { onStart: (setup: Setup) => void }) {
  const [difficulty, setDifficulty] =
    useState<keyof typeof DIFFICULTIES>("club");
  const [inputMode, setInputMode] = useState<InputMode>("keyboard");

  return (
    <div className="start">
      <div className="start-inner">
        <h1>Tennis</h1>
        <p className="start-tag">
          The avatar runs to the ball. You choose <em>when</em> and <em>how</em>{" "}
          to swing.
        </p>

        <div className="start-section">
          <span className="start-label">Opponent</span>
          <div className="start-options">
            {(Object.keys(DIFFICULTIES) as Array<keyof typeof DIFFICULTIES>).map(
              (key) => (
                <button
                  key={key}
                  className={difficulty === key ? "chip chip-on" : "chip"}
                  onClick={() => setDifficulty(key)}
                >
                  {DIFFICULTIES[key]!.name}
                </button>
              )
            )}
          </div>
        </div>

        <div className="start-section">
          <span className="start-label">Controls</span>
          <div className="start-options">
            <button
              className={inputMode === "keyboard" ? "chip chip-on" : "chip"}
              onClick={() => setInputMode("keyboard")}
            >
              Keyboard
            </button>
            <button
              className={inputMode === "camera" ? "chip chip-on" : "chip"}
              onClick={() => setInputMode("camera")}
            >
              Camera
            </button>
          </div>
        </div>

        {inputMode === "keyboard" ? (
          <div className="start-keys">
            <Key label="J / Space" action="Topspin" />
            <Key label="K" action="Flat drive" />
            <Key label="L" action="Slice" />
            <Key label="I" action="Overhead" />
            <Key label="A / D" action="Aim" />
            <Key label="hold" action="Charge power" />
          </div>
        ) : (
          <div className="start-keys start-camera">
            <Key label="swing up" action="Topspin" />
            <Key label="swing down" action="Slice" />
            <Key label="swing level" action="Flat drive" />
            <Key label="reach high" action="Overhead" />
            <Key label="lean" action="Aim" />
            <Key label="swing fast" action="More power" />
            <p className="start-note">
              Stand back so your hips and shoulders are in frame. Press{" "}
              <kbd>T</kbd> in game to tune detection.
            </p>
          </div>
        )}

        <div className="start-actions">
          <button
            className="primary"
            onClick={() => onStart({ difficulty, nearControl: "human", inputMode })}
          >
            Play
          </button>
          <button
            className="secondary"
            onClick={() =>
              onStart({ difficulty, nearControl: "bot", inputMode: "keyboard" })
            }
          >
            Watch bots
          </button>
        </div>
      </div>
    </div>
  );
}

function Key({ label, action }: { label: string; action: string }) {
  return (
    <div className="key">
      <kbd>{label}</kbd>
      <span>{action}</span>
    </div>
  );
}

function Court({ setup, onExit }: { setup: Setup; onExit: () => void }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<Session | null>(null);
  const [snapshot, setSnapshot] = useState<HudSnapshot | null>(null);
  const [pose, setPose] = useState<PoseInput | null>(null);
  const [poseError, setPoseError] = useState<string | null>(null);
  const [showTuning, setShowTuning] = useState(false);
  const [muted, setMuted] = useState(false);
  const soundRef = useRef<ReturnType<typeof createSound> | null>(null);

  const toggleMute = useCallback(() => {
    setMuted((wasMuted) => {
      soundRef.current?.setMuted(!wasMuted);
      return !wasMuted;
    });
  }, []);

  const handleExit = useCallback(() => onExit(), [onExit]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;

    const scene = createGameScene(stage);
    const input = createKeyboardInput();
    const sound = createSound();
    soundRef.current = sound;
    const time = createTimeControl();

    // Browsers hold audio until a gesture; any key or click releases it.
    const unlockAudio = () => sound.resume();
    window.addEventListener("keydown", unlockAudio);
    window.addEventListener("pointerdown", unlockAudio);

    let poseInput: PoseInput | null = null;
    if (setup.inputMode === "camera" && setup.nearControl === "human") {
      poseInput = createPoseInput();
      setPose(poseInput);
      void poseInput.start().then(() => {
        if (poseInput?.status === "error") setPoseError(poseInput.error);
      });
    }

    const onTuningKey = (event: KeyboardEvent) => {
      if (event.code === "KeyT") setShowTuning((visible) => !visible);
      if (event.code === "KeyM") toggleMute();
    };
    window.addEventListener("keydown", onTuningKey);

    const session = createSession({
      near: setup.nearControl,
      far: "bot",
      nearDifficulty: DIFFICULTIES[setup.difficulty]!,
      farDifficulty: DIFFICULTIES[setup.difficulty]!,
    });
    sessionRef.current = session;

    const resize = () => {
      scene.resize(stage.clientWidth, stage.clientHeight);
    };
    resize();
    window.addEventListener("resize", resize);

    let lastGrade: TimingGrade | null = null;
    let lastKind: string | null = null;
    let gradeShownAt = 0;
    let hudAccumulator = 0;
    let last = performance.now();
    let frame = 0;
    // Smoothed cost of one sim+render frame, surfaced in the tuning panel.
    let frameCostMs = 0;

    /** One frame of work, shared by the rAF loop and the dev pump. */
    const frameStep = (now: number, dt: number) => {
      const frameStartedAt = performance.now();
      input.update(now, dt);

      if (setup.nearControl === "human") {
        for (const swing of input.drain()) {
          // Stamp against engine time; the keyboard has no sensor lag to undo.
          session.swing({ ...swing, t: session.state.timeMs });
        }

        if (poseInput) {
          // Pose swings carry performance.now() timestamps, already latency
          // compensated. Rebase them onto the engine clock, which runs slower
          // whenever a frame is dropped and dt gets clamped.
          const epoch = now - session.state.timeMs;
          for (const swing of poseInput.update()) {
            session.swing({ ...swing, t: swing.t - epoch });
          }
        }
      }

      // Hit-stop and slow motion scale the simulation, never the wall clock,
      // so the engine stays deterministic and simply gets a smaller delta.
      time.update(dt * 1000);
      session.advance(dt * 1000 * time.scale);

      for (const event of session.events) {
        switch (event.type) {
          case "hit": {
            const power = event.grade === "perfect" ? 1 : event.grade === "good" ? 0.7 : 0.4;
            sound.hit(
              power,
              event.kind === "topspin" || event.kind === "lob"
                ? "topspin"
                : event.kind === "drive"
                  ? "flat"
                  : event.kind
            );
            if (event.by === "near") {
              time.impact(power);
              lastGrade = event.grade;
              lastKind = event.kind;
              gradeShownAt = now;
            }
            break;
          }
          case "whiff":
            if (event.by === "near") {
              lastGrade = "miss";
              lastKind = null;
              gradeShownAt = now;
            }
            break;
          case "serve":
            sound.hit(0.85, "serve");
            break;
          case "bounce":
            sound.bounce(Math.abs(session.state.ball.vel.y) + 6);
            break;
          case "net":
            sound.net();
            break;
          case "point":
            sound.point(event.winner === "near");
            // Linger on the shot that ended a real rally, not on a double fault.
            if (session.state.hitCount >= 4) time.slowMotion(650);
            break;
        }
      }

      scene.render(session, dt);

      const cost = performance.now() - frameStartedAt;
      frameCostMs = frameCostMs === 0 ? cost : frameCostMs * 0.9 + cost * 0.1;

      // The HUD does not need 60 Hz; refreshing it less often keeps React out
      // of the frame budget.
      hudAccumulator += dt;
      if (hudAccumulator >= 0.08) {
        hudAccumulator = 0;
        const state = session.state;
        const onStrike = state.strike?.striker === "near";

        setSnapshot({
          match: state.match,
          timeToStrike:
            onStrike && state.strike
              ? (state.strike.idealTimeMs - state.timeMs) / 1000
              : null,
          charge: input.charge,
          aim: input.aim,
          lastGrade: now - gradeShownAt < 1100 ? lastGrade : null,
          lastKind: now - gradeShownAt < 1100 ? lastKind : null,
          rallyShots: state.hitCount,
          renderMs: frameCostMs,
          phase: state.phase,
          awaitingServe:
            state.phase === "awaiting-serve" &&
            state.match.server === "near" &&
            setup.nearControl === "human",
        });
      }
    };

    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      frameStep(now, dt);
    };

    frame = requestAnimationFrame(tick);

    // Dev-only manual pump. Browsers suspend requestAnimationFrame while the
    // document is hidden, so an automated pane cannot observe the game running;
    // this drives frames directly. Also handy for reproducing a specific rally
    // state while tuning.
    if (import.meta.env.DEV) {
      (window as unknown as Record<string, unknown>).__tennis = {
        session,
        pump(seconds: number, stepMs = 16) {
          // Runs the same frameStep the rAF loop does, so input handling is
          // exercised too rather than only physics and rendering.
          const steps = Math.round((seconds * 1000) / stepMs);
          for (let i = 0; i < steps; i++) {
            last += stepMs;
            frameStep(last, stepMs / 1000);
          }
          const state = session.state;
          return {
            phase: state.phase,
            hits: state.hitCount,
            points: state.match.points,
            games: state.match.games,
            ball: state.ball.pos,
            striker: state.strike?.striker ?? null,
          };
        },
      };
    }

    return () => {
      cancelAnimationFrame(frame);
      if (import.meta.env.DEV) {
        delete (window as unknown as Record<string, unknown>).__tennis;
      }
      window.removeEventListener("resize", resize);
      window.removeEventListener("keydown", onTuningKey);
      window.removeEventListener("keydown", unlockAudio);
      window.removeEventListener("pointerdown", unlockAudio);
      sound.dispose();
      soundRef.current = null;
      input.dispose();
      poseInput?.stop();
      setPose(null);
      scene.dispose();
      sessionRef.current = null;
    };
  }, [setup, toggleMute]);

  return (
    <div className="court">
      <div className="stage" ref={stageRef} />
      {snapshot && <Hud snapshot={snapshot} />}
      <button className="exit" onClick={handleExit}>
        ← Menu
      </button>
      <button className="mute" onClick={toggleMute} title="Mute (M)">
        {muted ? "🔇" : "🔊"}
      </button>

      {pose && showTuning && (
        <TuningOverlay
          pose={pose}
          renderMs={snapshot?.renderMs ?? 0}
          onClose={() => setShowTuning(false)}
        />
      )}

      {pose && !showTuning && pose.status === "running" && (
        <button className="tuning-open" onClick={() => setShowTuning(true)}>
          Tune detection (T)
        </button>
      )}

      {poseError && (
        <div className="pose-error">
          <strong>Camera unavailable</strong>
          <p>{poseError}</p>
          <p className="pose-error-hint">
            Keyboard controls still work: J topspin, K flat, L slice, I overhead.
          </p>
        </div>
      )}
      {snapshot?.match.winner && (
        <div className="result">
          <h2>{snapshot.match.winner === "near" ? "You win" : "Bot wins"}</h2>
          <button className="primary" onClick={handleExit}>
            Back to menu
          </button>
        </div>
      )}
    </div>
  );
}
