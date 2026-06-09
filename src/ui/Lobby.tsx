/**
 * Connecting two players.
 *
 * The codes are long because there is no signalling server: the whole handshake
 * travels through whatever the players already use to talk to each other. That
 * is a worse first thirty seconds than a room code, in exchange for nothing to
 * deploy, nothing to keep running, and no account.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { hostGame, joinGame } from "../net/webrtc";
import type { Transport } from "../net/transport";
import type { NetRole } from "../net/netSession";

type Stage =
  | { at: "choose" }
  | { at: "hosting"; offer: string; busy: boolean }
  | { at: "joining" }
  | { at: "joined"; answer: string }
  | { at: "connecting" }
  | { at: "failed"; message: string };

export function Lobby({
  onConnected,
  onCancel,
}: {
  onConnected: (role: NetRole, transport: Transport) => void;
  onCancel: () => void;
}) {
  const [stage, setStage] = useState<Stage>({ at: "choose" });
  const [reply, setReply] = useState("");
  const [invite, setInvite] = useState("");
  const cancelRef = useRef<(() => void) | null>(null);

  // Any half-open peer connection must be torn down if the player walks away.
  useEffect(() => () => cancelRef.current?.(), []);

  const fail = useCallback((error: unknown) => {
    setStage({
      at: "failed",
      message: error instanceof Error ? error.message : "Something went wrong.",
    });
  }, []);

  const startHosting = useCallback(async () => {
    setStage({ at: "connecting" });
    try {
      const handle = await hostGame();
      cancelRef.current = handle.cancel;
      setStage({ at: "hosting", offer: handle.offer, busy: false });

      // Stashed so the reply box can finish the handshake.
      hostAccept.current = handle.accept;
    } catch (error) {
      fail(error);
    }
  }, [fail]);

  const hostAccept = useRef<((answer: string) => Promise<Transport>) | null>(null);

  const finishHosting = useCallback(async () => {
    if (!hostAccept.current) return;
    setStage((s) => (s.at === "hosting" ? { ...s, busy: true } : s));
    try {
      const transport = await hostAccept.current(reply);
      cancelRef.current = null;
      onConnected("host", transport);
    } catch (error) {
      fail(error);
    }
  }, [reply, onConnected, fail]);

  const startJoining = useCallback(async () => {
    setStage({ at: "connecting" });
    try {
      const handle = await joinGame(invite);
      cancelRef.current = handle.cancel;
      setStage({ at: "joined", answer: handle.answer });
      const transport = await handle.connected;
      cancelRef.current = null;
      onConnected("guest", transport);
    } catch (error) {
      fail(error);
    }
  }, [invite, onConnected, fail]);

  return (
    <div className="start">
      <div className="start-inner lobby">
        <h1>Play a friend</h1>

        {stage.at === "choose" && (
          <>
            <p className="start-tag">
              No server and no accounts — you swap a code, once.
            </p>
            <div className="start-actions">
              <button className="primary" onClick={startHosting}>
                Host a game
              </button>
              <button
                className="secondary"
                onClick={() => setStage({ at: "joining" })}
              >
                Join a game
              </button>
            </div>
          </>
        )}

        {stage.at === "connecting" && <p className="start-tag">Working…</p>}

        {stage.at === "hosting" && (
          <>
            <Step n={1} text="Send this invite code to the other player" />
            <CodeBox value={stage.offer} />
            <Step n={2} text="Paste their reply code here" />
            <textarea
              className="lobby-input"
              value={reply}
              placeholder="Their reply code"
              onChange={(e) => setReply(e.target.value)}
            />
            <button
              className="primary lobby-go"
              disabled={reply.trim().length === 0 || stage.busy}
              onClick={finishHosting}
            >
              {stage.busy ? "Connecting…" : "Start match"}
            </button>
          </>
        )}

        {stage.at === "joining" && (
          <>
            <Step n={1} text="Paste the invite code you were sent" />
            <textarea
              className="lobby-input"
              value={invite}
              placeholder="Invite code"
              onChange={(e) => setInvite(e.target.value)}
            />
            <button
              className="primary lobby-go"
              disabled={invite.trim().length === 0}
              onClick={startJoining}
            >
              Continue
            </button>
          </>
        )}

        {stage.at === "joined" && (
          <>
            <Step n={2} text="Send this reply code back, then wait" />
            <CodeBox value={stage.answer} />
            <p className="start-tag lobby-waiting">
              Waiting for them to start the match…
            </p>
          </>
        )}

        {stage.at === "failed" && (
          <>
            <p className="lobby-error">{stage.message}</p>
            <button className="secondary" onClick={() => setStage({ at: "choose" })}>
              Try again
            </button>
          </>
        )}

        <button className="lobby-back" onClick={onCancel}>
          ← Menu
        </button>
      </div>
    </div>
  );
}

function Step({ n, text }: { n: number; text: string }) {
  return (
    <div className="lobby-step">
      <span className="lobby-step-n">{n}</span>
      <span>{text}</span>
    </div>
  );
}

function CodeBox({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="lobby-code">
      <textarea readOnly value={value} onFocus={(e) => e.target.select()} />
      <button
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
          } catch {
            // Clipboard can be blocked; the box is selectable either way.
          }
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
