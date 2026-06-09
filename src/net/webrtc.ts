/**
 * A WebRTC data channel between two browsers.
 *
 * Signalling is done by copying a code between the players rather than by a
 * server. That is a deliberate trade: a signalling server is a thing to deploy,
 * keep running and pay for, and this game needs neither matchmaking nor
 * discovery — two people who already know each other want one connection.
 *
 * The codes are the SDP offer and answer, compressed and base64'd. They are
 * long, which is the cost of having no infrastructure at all.
 */

import type { NetMessage } from "./protocol";
import { decode, encode } from "./protocol";
import type { Transport } from "./transport";

/** Public STUN only. No TURN, so symmetric-NAT pairs will fail to connect. */
const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

const CHANNEL = "tennis";

export type SignalCode = string;

function toCode(description: RTCSessionDescriptionInit): SignalCode {
  const packed = JSON.stringify({ t: description.type, s: description.sdp });
  // Base64 of UTF-8, so the code survives being pasted through chat apps.
  return btoa(unescape(encodeURIComponent(packed)));
}

export function fromCode(code: SignalCode): RTCSessionDescriptionInit | null {
  try {
    const packed = JSON.parse(decodeURIComponent(escape(atob(code.trim()))));
    if (!packed || typeof packed.s !== "string") return null;
    if (packed.t !== "offer" && packed.t !== "answer") return null;
    return { type: packed.t, sdp: packed.s };
  } catch {
    return null;
  }
}

function wrap(channel: RTCDataChannel, peer: RTCPeerConnection): Transport {
  let handler: ((message: NetMessage) => void) | null = null;
  let closeHandler: (() => void) | null = null;
  let closed = false;

  channel.onmessage = (event) => {
    const message = decode(String(event.data));
    if (message) handler?.(message);
  };

  const onClosed = () => {
    if (closed) return;
    closed = true;
    closeHandler?.();
  };
  channel.onclose = onClosed;
  channel.onerror = onClosed;
  peer.onconnectionstatechange = () => {
    if (
      peer.connectionState === "failed" ||
      peer.connectionState === "disconnected" ||
      peer.connectionState === "closed"
    ) {
      onClosed();
    }
  };

  return {
    get open() {
      return !closed && channel.readyState === "open";
    },
    send(message) {
      // Dropping while not open is correct: the host re-broadcasts state
      // continuously, so a missed frame costs nothing and a throw would take
      // down the render loop.
      if (closed || channel.readyState !== "open") return;
      try {
        channel.send(encode(message));
      } catch {
        onClosed();
      }
    },
    onMessage(next) {
      handler = next;
    },
    onClose(next) {
      closeHandler = next;
    },
    close() {
      onClosed();
      try {
        channel.close();
        peer.close();
      } catch {
        // Already gone.
      }
    },
  };
}

/**
 * Wait for enough ICE candidates to be worth sending.
 *
 * The alternative is trickle ICE, which needs a live signalling channel to send
 * candidates over — exactly what copy-paste does not have. So the code can only
 * be produced once the description is reasonably complete.
 *
 * "Reasonably" is doing work there. Waiting for gathering to *finish* took over
 * four seconds in testing, which is a long time to stare at a button before you
 * can even send an invite. A local candidate plus one server-reflexive is
 * enough to connect in almost every case, so this settles shortly after the
 * reflexive candidate arrives and only falls back to the long cap if none does.
 */
function waitForIce(
  peer: RTCPeerConnection,
  options: { graceMs?: number; capMs?: number } = {}
): Promise<void> {
  const graceMs = options.graceMs ?? 350;
  const capMs = options.capMs ?? 4000;
  if (peer.iceGatheringState === "complete") return Promise.resolve();

  return new Promise((resolve) => {
    let settled = false;
    let grace: ReturnType<typeof setTimeout> | undefined;

    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(cap);
      clearTimeout(grace);
      peer.removeEventListener("icegatheringstatechange", onState);
      peer.removeEventListener("icecandidate", onCandidate);
      resolve();
    };

    const onState = () => {
      if (peer.iceGatheringState === "complete") done();
    };

    const onCandidate = (event: RTCPeerConnectionIceEvent) => {
      // A null candidate means gathering finished.
      if (!event.candidate) return done();
      if (event.candidate.type === "srflx" || event.candidate.type === "relay") {
        clearTimeout(grace);
        grace = setTimeout(done, graceMs);
      }
    };

    const cap = setTimeout(done, capMs);
    peer.addEventListener("icegatheringstatechange", onState);
    peer.addEventListener("icecandidate", onCandidate);
  });
}

export type HostHandle = {
  /** Give this to the other player. */
  offer: SignalCode;
  /** Paste their reply here to finish connecting. */
  accept: (answer: SignalCode) => Promise<Transport>;
  cancel: () => void;
};

/** Start a game and produce an invite code. */
export async function hostGame(): Promise<HostHandle> {
  const peer = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const channel = peer.createDataChannel(CHANNEL, {
    // Swings must not be reordered or dropped; state snapshots are frequent
    // enough that reliability costs nothing in practice.
    ordered: true,
  });

  await peer.setLocalDescription(await peer.createOffer());
  await waitForIce(peer);

  return {
    offer: toCode(peer.localDescription!),
    cancel: () => peer.close(),
    async accept(answerCode) {
      const answer = fromCode(answerCode);
      if (!answer || answer.type !== "answer") {
        throw new Error("That does not look like a reply code.");
      }
      await peer.setRemoteDescription(answer);
      await waitForChannel(channel);
      return wrap(channel, peer);
    },
  };
}

/** Join a game from an invite code, producing a reply code. */
export async function joinGame(offerCode: SignalCode): Promise<{
  answer: SignalCode;
  connected: Promise<Transport>;
  cancel: () => void;
}> {
  const offer = fromCode(offerCode);
  if (!offer || offer.type !== "offer") {
    throw new Error("That does not look like an invite code.");
  }

  const peer = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const channelReady = new Promise<RTCDataChannel>((resolve) => {
    peer.ondatachannel = (event) => resolve(event.channel);
  });

  await peer.setRemoteDescription(offer);
  await peer.setLocalDescription(await peer.createAnswer());
  await waitForIce(peer);

  return {
    answer: toCode(peer.localDescription!),
    cancel: () => peer.close(),
    connected: channelReady.then(async (channel) => {
      await waitForChannel(channel);
      return wrap(channel, peer);
    }),
  };
}

function waitForChannel(channel: RTCDataChannel, timeoutMs = 20000): Promise<void> {
  if (channel.readyState === "open") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Could not connect. Check both codes and try again.")),
      timeoutMs
    );
    channel.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}
