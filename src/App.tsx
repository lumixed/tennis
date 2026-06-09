import { useCallback, useEffect, useRef, useState } from "react";
import { DIFFICULTIES } from "./engine/bot";
import type { MatchStats } from "./engine/matchStats";
import type { SwingEvent, TimingGrade } from "./engine/shotTypes";
import { createSound } from "./audio/sound";
import { createSession, type Controller, type PlayableSession } from "./game/session";
import { createTimeControl } from "./game/timeControl";
import { createKeyboardInput } from "./input/keyboard";
import { createGameScene } from "./scene/gameScene";
import { Hud, type HudSnapshot } from "./ui/Hud";
import { Lobby } from "./ui/Lobby";
import { MatchSummary } from "./ui/MatchSummary";
import { TuningOverlay } from "./ui/TuningOverlay";
import { createPoseInput, type PoseInput } from "./vision/poseInput";
import { createNetSession, type NetRole } from "./net/netSession";
import type { Transport } from "./net/transport";

export type InputMode = "keyboard" | "camera";

type Setup = {
  difficulty: keyof typeof DIFFICULTIES;
  nearControl: Controller;
  inputMode: InputMode;
  practice?: boolean;
  /** Set when playing another person rather than the bot. */
  net?: { role: NetRole; transport: Transport };
};

export function App() {
  const [setup, setSetup] = useState<Setup | null>(null);
  const [inLobby, setInLobby] = useState(false);
  const [inputMode, setInputMode] = useState<InputMode>("keyboard");

  if (setup) {
    return (
      <Court
        setup={setup}
        onExit={() => {
          setup.net?.transport.close();
          setSetup(null);
        }}
      />
    );
  }

  if (inLobby) {
    return (
      <Lobby
        onCancel={() => setInLobby(false)}
        onConnected={(role, transport) => {
          setInLobby(false);
          setSetup({
            difficulty: "club",
            nearControl: "human",
            inputMode,
            net: { role, transport },
          });
        }}
      />
    );
  }

  return (
    <StartScreen
      onStart={setSetup}
      onPlayFriend={(mode) => {
        setInputMode(mode);
        setInLobby(true);
      }}
    />
  );
}

function StartScreen({
  onStart,
  onPlayFriend,
}: {
  onStart: (setup: Setup) => void;
  onPlayFriend: (inputMode: InputMode) => void;
}) {
  const [difficulty, setDifficulty] =
    useState<keyof typeof DIFFICULTIES>("club");
  const [inputMode, setInputMode] = useState<InputMode>("keyboard");

  // Swinging at a camera is harder than pressing a key, and a recorded session
  // on Club went three minutes without the player winning a game. Camera play
  // starts on Rookie; anyone who wants more can still pick it.
  const chooseInput = (mode: InputMode) => {
    setInputMode(mode);
    setDifficulty(mode === "camera" ? "rookie" : "club");
  };

  return (
    <div className="start">
      <div className="start-inner">
        <h1>Tennis</h1>
        <p className="start-tag">
          The avatar runs to the ball. You choose <em>when</em> and <em>how</em>{" "}
          to swing.
        </p>

        <div className="start-section">
          <span className="start-label">Starting opponent</span>
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
              onClick={() => chooseInput("keyboard")}
            >
              Keyboard
            </button>
            <button
              className={inputMode === "camera" ? "chip chip-on" : "chip"}
              onClick={() => chooseInput("camera")}
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

        <p className="start-adaptive">
          The opponent adjusts to your level as you play, so this is only where
          it begins.
        </p>

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
              onStart({ difficulty, nearControl: "human", inputMode, practice: true })
            }
          >
            Practice
          </button>
          <button className="secondary" onClick={() => onPlayFriend(inputMode)}>
            Play a friend
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
  const sessionRef = useRef<PlayableSession | null>(null);
  const [snapshot, setSnapshot] = useState<HudSnapshot | null>(null);
  const [pose, setPose] = useState<PoseInput | null>(null);
  const [poseError, setPoseError] = useState<string | null>(null);
  const [showTuning, setShowTuning] = useState(false);
  const [muted, setMuted] = useState(false);
  /** Bumped to rebuild the session for a rematch. */
  const [round, setRound] = useState(0);
  const [finalStats, setFinalStats] = useState<MatchStats | null>(null);
  const soundRef = useRef<ReturnType<typeof createSound> | null>(null);

  const toggleMute = useCallback(() => {
    setMuted((wasMuted) => {
      soundRef.current?.setMuted(!wasMuted);
      return !wasMuted;
    });
  }, []);

  const handleExit = useCallback(() => onExit(), [onExit]);

  /**
   * Nag about framing only when it is actually a problem.
   *
   * Visibility below the detector's floor means frames are being thrown away
   * entirely; a recorded session sat at 0.59 against a floor of 0.50, close
   * enough that swings were being dropped without any explanation on screen.
   */
  const framing = (() => {
    if (!snapshot) return null;
    if (snapshot.poseVisibility === null) return null;
    if (snapshot.poseVisibility >= 0.7) return null;
    return snapshot.poseVisibility < 0.45
      ? { title: "I can barely see you", hint: "Step back until your hips and shoulders are both in frame" }
      : { title: "Step back a little", hint: "Your hips need to be in frame for swings to register" };
  })();

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

    const session = setup.net
      ? createNetSession(setup.net.role, setup.net.transport)
      : createSession({
      near: setup.nearControl,
      far: "bot",
      nearDifficulty: DIFFICULTIES[setup.difficulty]!,
      farDifficulty: setup.practice
        ? DIFFICULTIES.rookie!
        : DIFFICULTIES[setup.difficulty]!,
      practice: setup.practice ?? false,
    });
    sessionRef.current = session;

    const resize = () => {
      const { clientWidth, clientHeight } = stage;
      // A zero-sized container yields a 0x0 buffer and a NaN camera aspect, and
      // nothing recovers it until the window happens to resize. That happens
      // whenever the stage has not laid out yet, or the page is hidden.
      if (clientWidth === 0 || clientHeight === 0) return;
      scene.resize(clientWidth, clientHeight);
    };
    resize();

    // Observing the element catches layout changes a window listener misses —
    // first layout, panel toggles, and the page becoming visible again.
    const observer = new ResizeObserver(resize);
    observer.observe(stage);
    window.addEventListener("resize", resize);

    let lastGrade: TimingGrade | null = null;
    let lastKind: string | null = null;
    let lastFootwork: number | null = null;
    let lastPoint: HudSnapshot["lastPoint"] = null;
    let pointShownAt = 0;
    let milestone: HudSnapshot["milestone"] = null;
    let milestoneShownAt = 0;
    /** Dev-only swings injected through the same door pose swings use. */
    const injected: SwingEvent[] = [];
    let gradeShownAt = 0;
    let hudAccumulator = 0;
    let last = performance.now();
    let frame = 0;
    // Smoothed cost of one sim+render frame, surfaced in the tuning panel.
    let frameCostMs = 0;

    /** One frame of work, shared by the rAF loop and the dev pump. */
    const frameStep = (now: number, dt: number) => {
      const frameStartedAt = performance.now();
      // Must precede any input: swings submitted below append to this buffer.
      session.beginFrame();
      input.update(now, dt);

      if (setup.nearControl === "human") {
        for (const swing of input.drain()) {
          // Stamp against engine time; the keyboard has no sensor lag to undo.
          session.swing({ ...swing, t: session.state.timeMs });
        }

        // Injected first, on the same path and in the same frame as a real
        // camera swing, so a dev harness exercises the true code path.
        for (const swing of injected.splice(0, injected.length)) {
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

      // Snapshot the score before the step, so a completed game or set can be
      // spotted by comparing across it.
      const matchBefore = session.state.match;

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
              lastFootwork = event.footwork;
              gradeShownAt = now;
            }
            break;
          }
          case "whiff":
            if (event.by === "near") {
              lastGrade = "miss";
              lastKind = null;
              lastFootwork = null;
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
            // Freeze the numbers the moment the match is decided; the session
            // keeps running and would otherwise keep folding events in.
            if (session.state.match.winner) setFinalStats(session.stats);
            lastPoint = { winner: event.winner, reason: event.reason };
            pointShownAt = now;

            // A game or set completing is the shape of a match; without it the
            // whole thing passes as an undifferentiated run of points.
            {
              const after = session.state.match;
              const side = event.winner;
              if (after.sets[side] > matchBefore.sets[side]) {
                const set = after.history[after.history.length - 1];
                milestone = {
                  kind: "set",
                  winner: side,
                  detail: set ? `${set.near}–${set.far}` : "",
                };
                milestoneShownAt = now;
                time.slowMotion(900, 0.4);
              } else if (after.games[side] > matchBefore.games[side]) {
                milestone = {
                  kind: "game",
                  winner: side,
                  detail: `${after.games.near}–${after.games.far}`,
                };
                milestoneShownAt = now;
              }
            }
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
          lastFootwork: now - gradeShownAt < 1100 ? lastFootwork : null,
          stance: poseInput?.debug?.stance ?? null,
          poseVisibility: poseInput?.debug?.visibility ?? null,
          difficultyLabel: session.difficultyLabel,
          practice: setup.practice
            ? {
                rally: session.rallyLength,
                best: session.bestRally,
                returns: session.totalReturns,
              }
            : null,
          opponentLabel: setup.net ? "Rival" : "Bot",
          nearStake: session.nearStake,
          farStake: session.farStake,
          serveNumber:
            state.phase === "awaiting-serve"
              ? ((state.serveFaults + 1) as 1 | 2)
              : null,
          lastPoint: now - pointShownAt < 2400 ? lastPoint : null,
          milestone: now - milestoneShownAt < 2600 ? milestone : null,
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
        injectSwing(event: SwingEvent) {
          injected.push(event);
        },
        scene: scene.debug,
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
      observer.disconnect();
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
  }, [setup, toggleMute, round]);

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

      {pose && !poseError && framing && (
        <div className="framing">
          <strong>{framing.title}</strong>
          <span>{framing.hint}</span>
        </div>
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
      {!setup.practice && snapshot?.match.winner && finalStats && (
        <MatchSummary
          match={snapshot.match}
          stats={finalStats}
          opponentLabel={setup.net ? "Rival" : "Bot"}
          onPlayAgain={() => {
            setFinalStats(null);
            setSnapshot(null);
            setRound((n) => n + 1);
          }}
          onExit={handleExit}
        />
      )}
    </div>
  );
}
