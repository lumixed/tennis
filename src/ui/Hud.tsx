/**
 * Heads-up display.
 *
 * The timing meter is the important part: with the avatar auto-positioning, the
 * player's whole job is *when* to swing, so the approach of the strike window
 * has to be legible at a glance.
 */

import type { TimingGrade } from "../engine/shotTypes";
import { describeScore, type MatchState, type Side, type Stake } from "../engine/scoring";
import type { PointReason } from "../engine/rally";

export type HudSnapshot = {
  match: MatchState;
  /** Seconds until the ideal contact, or null when not on strike. */
  timeToStrike: number | null;
  charge: number;
  aim: number;
  lastGrade: TimingGrade | null;
  lastKind: string | null;
  /** Quality the last shot's footwork added or removed, or null if unknown. */
  lastFootwork: number | null;
  /** Live stance from the camera, -1..1, or null when not on camera. */
  stance: number | null;
  /** How the last point ended, while it is still worth showing. */
  lastPoint: { winner: Side; reason: PointReason } | null;
  /** Landmark visibility from the camera, or null when not on camera. */
  poseVisibility: number | null;
  /** Short label for the opponent's current level, when it is adapting. */
  difficultyLabel: string | null;
  /** What the near player has at stake on this point. */
  nearStake: Stake | null;
  /** What the opponent has at stake. */
  farStake: Stake | null;
  /** 1 or 2 while a serve is due, otherwise null. */
  serveNumber: 1 | 2 | null;
  /** A game or set just completed, while it is still worth announcing. */
  milestone: {
    kind: "game" | "set";
    winner: Side;
    detail: string;
  } | null;
  /** Set when rallying without score. */
  practice: { rally: number; best: number; returns: number } | null;
  rallyShots: number;
  /** Smoothed cost of one sim+render frame, ms. */
  renderMs: number;
  phase: string;
  awaitingServe: boolean;
};

/**
 * Why the point ended, from the near player's point of view.
 *
 * Losing without being told why is the fastest way to stop improving — a
 * recorded session went three minutes without the player scoring, and nothing
 * on screen ever said whether shots were going long, into the net, or simply
 * not being reached.
 */
const POINT_REASON: Record<PointReason, { won: string; lost: string }> = {
  out: { won: "Their shot was out", lost: "Your shot was out" },
  net: { won: "They found the net", lost: "Into the net" },
  "double-bounce": { won: "They could not reach it", lost: "You did not reach it" },
  "double-fault": { won: "Double fault", lost: "Double fault" },
};

const STAKE_LABEL: Record<Stake, string> = {
  "match-point": "Match point",
  "set-point": "Set point",
  "break-point": "Break point",
  "game-point": "Game point",
};

const GRADE_LABEL: Record<TimingGrade, string> = {
  perfect: "Perfect",
  good: "Good",
  weak: "Weak",
  miss: "Missed",
};

/** Window half-widths in seconds, mirroring TIMING in the engine config. */
const PERFECT_WINDOW = 0.07;
const GOOD_WINDOW = 0.165;

export function Hud({ snapshot }: { snapshot: HudSnapshot }) {
  const { match } = snapshot;
  const score = describeScore(match);

  if (snapshot.practice) {
    return <PracticeHud snapshot={snapshot} practice={snapshot.practice} />;
  }

  return (
    <div className="hud">
      <div className="hud-score">
        <ScoreRow
          label="You"
          accent="near"
          sets={match.sets.near}
          games={match.games.near}
          point={score.near}
          serving={match.server === "near"}
        />
        <ScoreRow
          label="Bot"
          accent="far"
          sets={match.sets.far}
          games={match.games.far}
          point={score.far}
          serving={match.server === "far"}
        />
        {score.caption && <div className="hud-caption">{score.caption}</div>}
        {snapshot.difficultyLabel && (
          <div className="hud-level" title="The opponent tracks your level">
            {snapshot.difficultyLabel}
          </div>
        )}
      </div>

      <div className="hud-centre">
        <StakeBanner near={snapshot.nearStake} far={snapshot.farStake} />
        {snapshot.rallyShots > 2 && (
          <div className="hud-rally">{snapshot.rallyShots} shot rally</div>
        )}
        {snapshot.lastGrade && (
          <div className={`hud-grade grade-${snapshot.lastGrade}`}>
            {GRADE_LABEL[snapshot.lastGrade]}
            {snapshot.lastKind && (
              <span className="hud-kind"> {snapshot.lastKind}</span>
            )}
          </div>
        )}
        <FootworkTag value={snapshot.lastFootwork} />
        <PointOutcome outcome={snapshot.lastPoint} />
        <Milestone milestone={snapshot.milestone} />
      </div>

      <div className="hud-bottom">
        <TimingMeter timeToStrike={snapshot.timeToStrike} />
        <div className="hud-meters">
          <Meter label="Power" value={snapshot.charge} />
          <AimMeter label="Aim" value={snapshot.aim} />
          {snapshot.stance !== null && (
            <AimMeter label="Stance" value={snapshot.stance} />
          )}
        </div>
        {snapshot.serveNumber === 2 && (
          <div className="second-serve">Second serve</div>
        )}
        {snapshot.awaitingServe && (
          <div className="hud-prompt">Hold a swing key to serve</div>
        )}
      </div>
    </div>
  );
}

function ScoreRow({
  label,
  accent,
  sets,
  games,
  point,
  serving,
}: {
  label: string;
  accent: "near" | "far";
  sets: number;
  games: number;
  point: string;
  serving: boolean;
}) {
  return (
    <div className={`score-row score-${accent}`}>
      <span className="score-serving">{serving ? "●" : ""}</span>
      <span className="score-name">{label}</span>
      <span className="score-sets">{sets}</span>
      <span className="score-games">{games}</span>
      <span className="score-point">{point}</span>
    </div>
  );
}

/**
 * Marks the approaching contact moment.
 *
 * The needle sweeps right as the ball arrives; the bands show how much error
 * each grade tolerates, so mistiming is diagnosable rather than mysterious.
 */
function TimingMeter({ timeToStrike }: { timeToStrike: number | null }) {
  if (timeToStrike === null) {
    return <div className="timing timing-idle" />;
  }

  // Show a fixed window around the contact so the sweep rate reads consistently.
  const span = 1.2;
  const clamped = Math.max(-span, Math.min(span, timeToStrike));
  const position = ((span - clamped) / (span * 2)) * 100;

  const goodWidth = (GOOD_WINDOW / span) * 50;
  const perfectWidth = (PERFECT_WINDOW / span) * 50;

  return (
    <div className="timing">
      <div
        className="timing-band timing-good"
        style={{ left: `${50 - goodWidth}%`, width: `${goodWidth * 2}%` }}
      />
      <div
        className="timing-band timing-perfect"
        style={{ left: `${50 - perfectWidth}%`, width: `${perfectWidth * 2}%` }}
      />
      <div className="timing-needle" style={{ left: `${position}%` }} />
    </div>
  );
}

function Meter({ label, value }: { label: string; value: number }) {
  return (
    <div className="meter">
      <span className="meter-label">{label}</span>
      <div className="meter-track">
        <div className="meter-fill" style={{ width: `${value * 100}%` }} />
      </div>
    </div>
  );
}

/**
 * What this point is worth.
 *
 * Only one side can be a point from the game, so there is never a contest for
 * this space — and a match where nothing is ever announced has no shape at all.
 */
function StakeBanner({ near, far }: { near: Stake | null; far: Stake | null }) {
  const stake = near ?? far;
  if (!stake) return null;
  const mine = near !== null;

  return (
    <div className={mine ? "stake stake-mine" : "stake stake-theirs"}>
      {STAKE_LABEL[stake]}
      {!mine && <span className="stake-who"> against you</span>}
    </div>
  );
}

/**
 * The practice view.
 *
 * No score at all — the scoreboard is the thing practice exists to remove. What
 * is left is the only number that matters while grooving a swing: how long you
 * kept the ball alive.
 */
function PracticeHud({
  snapshot,
  practice,
}: {
  snapshot: HudSnapshot;
  practice: NonNullable<HudSnapshot["practice"]>;
}) {
  return (
    <div className="hud">
      <div className="hud-score practice-panel">
        <div className="practice-row">
          <span>Rally</span>
          <strong>{Math.max(0, practice.rally - 1)}</strong>
        </div>
        <div className="practice-row">
          <span>Best</span>
          <strong>{Math.max(0, practice.best - 1)}</strong>
        </div>
        <div className="practice-row">
          <span>Returns</span>
          <strong>{practice.returns}</strong>
        </div>
        <div className="hud-caption">Practice</div>
      </div>

      <div className="hud-centre">
        {snapshot.lastGrade && (
          <div className={`hud-grade grade-${snapshot.lastGrade}`}>
            {GRADE_LABEL[snapshot.lastGrade]}
            {snapshot.lastKind && (
              <span className="hud-kind"> {snapshot.lastKind}</span>
            )}
          </div>
        )}
        <FootworkTag value={snapshot.lastFootwork} />
      </div>

      <div className="hud-bottom">
        <TimingMeter timeToStrike={snapshot.timeToStrike} />
        <div className="hud-meters">
          <Meter label="Power" value={snapshot.charge} />
          <AimMeter label="Aim" value={snapshot.aim} />
          {snapshot.stance !== null && (
            <AimMeter label="Stance" value={snapshot.stance} />
          )}
        </div>
        {snapshot.awaitingServe && (
          <div className="hud-prompt">Hold a swing key to serve</div>
        )}
      </div>
    </div>
  );
}

function Milestone({
  milestone,
}: {
  milestone: HudSnapshot["milestone"];
}) {
  if (!milestone) return null;
  const mine = milestone.winner === "near";

  return (
    <div
      className={`milestone milestone-${milestone.kind} ${
        mine ? "milestone-mine" : "milestone-theirs"
      }`}
    >
      <span className="milestone-kind">
        {milestone.kind === "set" ? "Set" : "Game"}
      </span>
      <span className="milestone-who">{mine ? "you" : "bot"}</span>
      <span className="milestone-detail">{milestone.detail}</span>
    </div>
  );
}

function PointOutcome({
  outcome,
}: {
  outcome: HudSnapshot["lastPoint"];
}) {
  if (!outcome) return null;
  const won = outcome.winner === "near";
  const text = POINT_REASON[outcome.reason][won ? "won" : "lost"];

  return (
    <div className={won ? "point-end point-won" : "point-end point-lost"}>
      <span className="point-end-verdict">{won ? "Point" : "Point lost"}</span>
      <span className="point-end-reason">{text}</span>
    </div>
  );
}

/**
 * Feedback for the footwork mechanic.
 *
 * Footwork silently changes how well a shot comes off, and a mechanic you
 * cannot observe is one you cannot learn — so when it mattered, say so.
 */
function FootworkTag({ value }: { value: number | null }) {
  // Below this the ball was near enough that footwork was not being asked for.
  if (value === null || Math.abs(value) < 0.02) return null;

  const good = value > 0;
  return (
    <div className={good ? "footwork footwork-good" : "footwork footwork-bad"}>
      {good ? "Good footwork" : "Flat-footed"}
    </div>
  );
}

function AimMeter({ label, value }: { label: string; value: number }) {
  return (
    <div className="meter">
      <span className="meter-label">{label}</span>
      <div className="meter-track meter-aim">
        <div
          className="meter-aim-dot"
          style={{ left: `${((value + 1) / 2) * 100}%` }}
        />
      </div>
    </div>
  );
}
