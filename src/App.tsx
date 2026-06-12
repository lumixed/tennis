import { useCallback, useEffect, useRef, useState } from "react";
import { DIFFICULTIES } from "./engine/bot";
import type { TimingGrade } from "./engine/shotTypes";
import { createSession, type Controller, type Session } from "./game/session";
import { createKeyboardInput } from "./input/keyboard";
import { createGameScene } from "./scene/gameScene";
import { Hud, type HudSnapshot } from "./ui/Hud";

type Setup = {
  difficulty: keyof typeof DIFFICULTIES;
  nearControl: Controller;
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

        <div className="start-keys">
          <Key label="J / Space" action="Topspin" />
          <Key label="K" action="Flat drive" />
          <Key label="L" action="Slice" />
          <Key label="I" action="Overhead" />
          <Key label="A / D" action="Aim" />
          <Key label="hold" action="Charge power" />
        </div>

        <div className="start-actions">
          <button
            className="primary"
            onClick={() => onStart({ difficulty, nearControl: "human" })}
          >
            Play
          </button>
          <button
            className="secondary"
            onClick={() => onStart({ difficulty, nearControl: "bot" })}
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
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sessionRef = useRef<Session | null>(null);
  const [snapshot, setSnapshot] = useState<HudSnapshot | null>(null);

  const handleExit = useCallback(() => onExit(), [onExit]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const scene = createGameScene(canvas);
    const input = createKeyboardInput();
    const session = createSession({
      near: setup.nearControl,
      far: "bot",
      nearDifficulty: DIFFICULTIES[setup.difficulty]!,
      farDifficulty: DIFFICULTIES[setup.difficulty]!,
    });
    sessionRef.current = session;

    const resize = () => {
      const { clientWidth, clientHeight } = canvas.parentElement ?? canvas;
      scene.resize(clientWidth, clientHeight);
    };
    resize();
    window.addEventListener("resize", resize);

    let lastGrade: TimingGrade | null = null;
    let lastKind: string | null = null;
    let gradeShownAt = 0;
    let hudAccumulator = 0;
    let last = performance.now();
    let frame = 0;

    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);

      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;

      input.update(now, dt);

      if (setup.nearControl === "human") {
        for (const swing of input.drain()) {
          // Stamp against engine time; the keyboard has no sensor lag to undo.
          session.swing({ ...swing, t: session.state.timeMs });
        }
      }

      session.advance(dt * 1000);

      for (const event of session.events) {
        if (event.type === "hit" && event.by === "near") {
          lastGrade = event.grade;
          lastKind = event.kind;
          gradeShownAt = now;
        } else if (event.type === "whiff" && event.by === "near") {
          lastGrade = "miss";
          lastKind = null;
          gradeShownAt = now;
        }
      }

      scene.render(session, dt);

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
          phase: state.phase,
          awaitingServe:
            state.phase === "awaiting-serve" &&
            state.match.server === "near" &&
            setup.nearControl === "human",
        });
      }
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
          const steps = Math.round((seconds * 1000) / stepMs);
          for (let i = 0; i < steps; i++) {
            session.advance(stepMs);
            scene.render(session, stepMs / 1000);
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
      input.dispose();
      scene.dispose();
      sessionRef.current = null;
    };
  }, [setup]);

  return (
    <div className="court">
      <canvas ref={canvasRef} />
      {snapshot && <Hud snapshot={snapshot} />}
      <button className="exit" onClick={handleExit}>
        ← Menu
      </button>
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
