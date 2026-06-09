/**
 * A two-way message channel between peers.
 *
 * Abstracted so the game logic never touches WebRTC: the loopback below carries
 * a full match between two sessions inside one process, which is what makes
 * head-to-head play testable without a second machine, a second person, or a
 * network.
 */

import { decode, encode, type NetMessage } from "./protocol";

export type Transport = {
  readonly open: boolean;
  send: (message: NetMessage) => void;
  /** Replaces any previous handler. */
  onMessage: (handler: (message: NetMessage) => void) => void;
  onClose: (handler: () => void) => void;
  close: () => void;
};

/**
 * A pair of transports wired to each other.
 *
 * `latencyMs` delays delivery so tests can prove the game still behaves at a
 * realistic round trip rather than only at zero.
 */
export function createLoopback(options: { latencyMs?: number } = {}): {
  a: Transport;
  b: Transport;
  /** Deliver anything whose delay has elapsed. Advances the loopback clock. */
  pump: (elapsedMs?: number) => void;
  inFlight: () => number;
} {
  const latency = options.latencyMs ?? 0;
  let clock = 0;
  const queue: Array<{ at: number; to: "a" | "b"; raw: string }> = [];

  const handlers: Record<"a" | "b", ((m: NetMessage) => void) | null> = {
    a: null,
    b: null,
  };
  const closers: Record<"a" | "b", (() => void) | null> = { a: null, b: null };
  let closed = false;

  const makeSide = (self: "a" | "b", peer: "a" | "b"): Transport => ({
    get open() {
      return !closed;
    },
    send(message) {
      if (closed) return;
      // Serialised even in-process, so the tests exercise the real wire format
      // and cannot accidentally pass a live object reference between peers.
      queue.push({ at: clock + latency, to: peer, raw: encode(message) });
    },
    onMessage(handler) {
      handlers[self] = handler;
    },
    onClose(handler) {
      closers[self] = handler;
    },
    close() {
      if (closed) return;
      closed = true;
      closers.a?.();
      closers.b?.();
    },
  });

  return {
    a: makeSide("a", "b"),
    b: makeSide("b", "a"),
    inFlight: () => queue.length,
    pump(elapsedMs = 0) {
      clock += elapsedMs;
      for (let i = 0; i < queue.length; ) {
        const item = queue[i]!;
        if (item.at > clock) {
          i++;
          continue;
        }
        queue.splice(i, 1);
        const message = decode(item.raw);
        if (message) handlers[item.to]?.(message);
      }
    },
  };
}
