/**
 * How the match went.
 *
 * "Bot wins" tells a player nothing they can act on. Four winners against
 * eleven unforced errors tells them exactly what to do differently, and the
 * timing breakdown says whether the problem is the swing or the shot selection.
 */

import { timingAccuracy, type MatchStats } from "../engine/matchStats";
import type { MatchState, Side } from "../engine/scoring";

export function MatchSummary({
  match,
  stats,
  onPlayAgain,
  onExit,
}: {
  match: MatchState;
  stats: MatchStats;
  onPlayAgain: () => void;
  onExit: () => void;
}) {
  const won = match.winner === "near";
  const accuracy = timingAccuracy(stats);

  return (
    <div className="summary">
      <div className="summary-card">
        <h2 className={won ? "summary-win" : "summary-loss"}>
          {won ? "You win" : "Bot wins"}
        </h2>

        <div className="summary-sets">
          {match.history.length === 0 ? (
            <span className="summary-nosets">Match ended early</span>
          ) : (
            match.history.map((set, index) => (
              <span key={index} className="summary-set">
                {set.near}–{set.far}
              </span>
            ))
          )}
        </div>

        <table className="summary-table">
          <thead>
            <tr>
              <th />
              <th>You</th>
              <th>Bot</th>
            </tr>
          </thead>
          <tbody>
            <Row label="Points won" near={stats.near.pointsWon} far={stats.far.pointsWon} />
            <Row label="Winners" near={stats.near.winners} far={stats.far.winners} />
            <Row label="Aces" near={stats.near.aces} far={stats.far.aces} />
            <Row
              label="Unforced errors"
              near={stats.near.unforcedErrors}
              far={stats.far.unforcedErrors}
              lowerIsBetter
            />
            <Row
              label="Double faults"
              near={stats.near.doubleFaults}
              far={stats.far.doubleFaults}
              lowerIsBetter
            />
          </tbody>
        </table>

        <div className="summary-extras">
          <Extra label="Longest rally" value={`${stats.longestRally} shots`} />
          {accuracy !== null && (
            <Extra
              label="Swings on time"
              value={`${Math.round(accuracy * 100)}%`}
            />
          )}
          <Extra
            label="Perfect"
            value={String(stats.timing.perfect)}
          />
          <Extra label="Missed" value={String(stats.timing.miss)} />
        </div>

        <Advice stats={stats} accuracy={accuracy} />

        <div className="summary-actions">
          <button className="primary" onClick={onPlayAgain}>
            Play again
          </button>
          <button className="secondary" onClick={onExit}>
            Menu
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * One thing to work on.
 *
 * Deliberately a single sentence about the largest problem: a list of five
 * weaknesses is a list nobody acts on.
 */
function Advice({
  stats,
  accuracy,
}: {
  stats: MatchStats;
  accuracy: number | null;
}) {
  const errors = stats.near.unforcedErrors;
  const winners = stats.near.winners + stats.near.aces;

  let text: string;
  if (accuracy === null) {
    // No graded swings at all. This is the player who most needs telling, and
    // gating the advice on having swung would have left them with nothing.
    text =
      "You never made contact during a rally. Watch the bar under the court and swing as the needle reaches the bright band.";
  } else if (stats.timing.miss > stats.timing.perfect + stats.timing.good) {
    text =
      "Most swings missed the ball entirely — watch the timing bar and swing as the needle reaches the bright band.";
  } else if (accuracy < 0.5) {
    text =
      "Your timing was off more often than on. The bar under the court shows when contact is due.";
  } else if (errors > winners * 2 && errors > 4) {
    text =
      "Plenty of contact, but a lot of it went out. Try swinging a little softer and lifting more.";
  } else if (stats.near.doubleFaults > 2) {
    text = "Double faults cost you. Take some pace off the second serve.";
  } else if (winners > errors) {
    text = "Strong hitting — you made more than you missed.";
  } else {
    text = "Solid match. Winners and errors were close to even.";
  }

  return <p className="summary-advice">{text}</p>;
}

function Row({
  label,
  near,
  far,
  lowerIsBetter,
}: {
  label: string;
  near: number;
  far: number;
  lowerIsBetter?: boolean;
}) {
  const nearBetter = lowerIsBetter ? near < far : near > far;
  const farBetter = lowerIsBetter ? far < near : far > near;

  return (
    <tr>
      <th scope="row">{label}</th>
      <td className={nearBetter ? "summary-lead" : undefined}>{near}</td>
      <td className={farBetter ? "summary-lead" : undefined}>{far}</td>
    </tr>
  );
}

function Extra({ label, value }: { label: string; value: string }) {
  return (
    <div className="summary-extra">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

/** Which side the summary is written from. */
export const SUMMARY_SIDE: Side = "near";
