/**
 * Synthesised audio. No asset files.
 *
 * Every sound is built from oscillators and noise at runtime, which keeps the
 * bundle free of binaries and lets pitch and brightness track the actual shot
 * rather than replaying one canned sample.
 *
 * Browsers block audio until a user gesture, so the context starts suspended and
 * `resume` must be called from a click or keypress.
 */

export type Sound = {
  resume: () => void;
  hit: (power: number, kind: "topspin" | "flat" | "slice" | "smash" | "serve") => void;
  bounce: (speed: number) => void;
  net: () => void;
  point: (won: boolean) => void;
  setMuted: (muted: boolean) => void;
  readonly muted: boolean;
  dispose: () => void;
};

/** Shared noise buffer; regenerating it per hit would be wasteful. */
function makeNoise(context: AudioContext): AudioBuffer {
  const length = Math.floor(context.sampleRate * 0.4);
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

export function createSound(): Sound {
  const AudioCtor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;

  if (!AudioCtor) {
    const noop = () => {};
    return {
      resume: noop,
      hit: noop,
      bounce: noop,
      net: noop,
      point: noop,
      setMuted: noop,
      muted: true,
      dispose: noop,
    };
  }

  const context = new AudioCtor();
  const master = context.createGain();
  master.gain.value = 0.55;
  master.connect(context.destination);

  const noiseBuffer = makeNoise(context);
  let muted = false;

  const now = () => context.currentTime;

  /** A filtered noise burst — the body of every impact sound. */
  function burst(options: {
    at: number;
    duration: number;
    frequency: number;
    q: number;
    gain: number;
    type?: BiquadFilterType;
  }) {
    const source = context.createBufferSource();
    source.buffer = noiseBuffer;

    const filter = context.createBiquadFilter();
    filter.type = options.type ?? "bandpass";
    filter.frequency.value = options.frequency;
    filter.Q.value = options.q;

    const envelope = context.createGain();
    envelope.gain.setValueAtTime(0, options.at);
    envelope.gain.linearRampToValueAtTime(options.gain, options.at + 0.002);
    envelope.gain.exponentialRampToValueAtTime(
      0.0001,
      options.at + options.duration
    );

    source.connect(filter).connect(envelope).connect(master);
    source.start(options.at);
    source.stop(options.at + options.duration + 0.02);
  }

  /** A short pitched tone, used for the thock and for point stings. */
  function tone(options: {
    at: number;
    frequency: number;
    duration: number;
    gain: number;
    type?: OscillatorType;
    slideTo?: number;
  }) {
    const oscillator = context.createOscillator();
    oscillator.type = options.type ?? "sine";
    oscillator.frequency.setValueAtTime(options.frequency, options.at);
    if (options.slideTo !== undefined) {
      oscillator.frequency.exponentialRampToValueAtTime(
        options.slideTo,
        options.at + options.duration
      );
    }

    const envelope = context.createGain();
    envelope.gain.setValueAtTime(0, options.at);
    envelope.gain.linearRampToValueAtTime(options.gain, options.at + 0.004);
    envelope.gain.exponentialRampToValueAtTime(0.0001, options.at + options.duration);

    oscillator.connect(envelope).connect(master);
    oscillator.start(options.at);
    oscillator.stop(options.at + options.duration + 0.02);
  }

  const sound: Sound = {
    get muted() {
      return muted;
    },

    resume() {
      if (context.state === "suspended") void context.resume();
    },

    hit(power, kind) {
      if (muted) return;
      const t = now();
      const strength = Math.max(0.1, Math.min(1, power));

      // Harder shots are brighter and louder; slice is duller by design.
      const brightness =
        kind === "slice" ? 0.55 : kind === "smash" || kind === "serve" ? 1.15 : 1;
      burst({
        at: t,
        duration: 0.055 + strength * 0.03,
        frequency: (900 + strength * 1500) * brightness,
        q: 1.1,
        gain: 0.28 + strength * 0.34,
      });
      tone({
        at: t,
        frequency: (150 + strength * 90) * brightness,
        slideTo: 70,
        duration: 0.09,
        gain: 0.16 + strength * 0.2,
        type: "triangle",
      });
    },

    bounce(speed) {
      if (muted) return;
      const strength = Math.max(0.08, Math.min(1, speed / 18));
      burst({
        at: now(),
        duration: 0.05,
        frequency: 420 + strength * 500,
        q: 0.8,
        gain: 0.1 + strength * 0.2,
      });
    },

    net() {
      if (muted) return;
      burst({
        at: now(),
        duration: 0.14,
        frequency: 240,
        q: 0.6,
        gain: 0.3,
        type: "lowpass",
      });
    },

    point(won) {
      if (muted) return;
      const t = now();
      // A rising pair when you take it, a falling pair when you do not.
      const [a, b] = won ? [523.25, 783.99] : [392, 261.63];
      tone({ at: t, frequency: a, duration: 0.16, gain: 0.16, type: "sine" });
      tone({ at: t + 0.11, frequency: b, duration: 0.28, gain: 0.14, type: "sine" });
    },

    setMuted(next) {
      muted = next;
      master.gain.setTargetAtTime(next ? 0 : 0.55, now(), 0.02);
    },

    dispose() {
      void context.close();
    },
  };

  return sound;
}
