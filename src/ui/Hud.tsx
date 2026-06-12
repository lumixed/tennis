/**
 * Heads-up display.
 *
 * The timing meter is the important part: with the avatar auto-positioning, the
 * player's whole job is *when* to swing, so the approach of the strike window
 * has to be legible at a glance.
 */

import type { TimingGrade } from "../engine/shotTypes";
import { describeScore, type MatchState } from "../engine/scoring";

export type HudSnapshot = {
  match: MatchState;
  /** Seconds until the ideal contact, or null when not on strike. */
  timeToStrike: number | null;
  charge: number;
  aim: number;
  lastGrade: TimingGrade | null;
  lastKind: string | null;
  rallyShots: number;
  phase: string;
  awaitingServe: boolean;
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
      </div>

      <div className="hud-centre">
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
      </div>

      <div className="hud-bottom">
        <TimingMeter timeToStrike={snapshot.timeToStrike} />
        <div className="hud-meters">
          <Meter label="Power" value={snapshot.charge} />
          <AimMeter value={snapshot.aim} />
        </div>
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

function AimMeter({ value }: { value: number }) {
  return (
    <div className="meter">
      <span className="meter-label">Aim</span>
      <div className="meter-track meter-aim">
        <div
          className="meter-aim-dot"
          style={{ left: `${((value + 1) / 2) * 100}%` }}
        />
      </div>
    </div>
  );
}
