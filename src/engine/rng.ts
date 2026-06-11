/**
 * Small deterministic PRNG.
 *
 * The engine must never touch Math.random: shot scatter and bot error have to
 * replay identically from the same seed, both for tests and for the shot-event
 * netplay planned later.
 */

export type Rng = { seed: number };

export const createRng = (seed = 1): Rng => ({ seed: seed >>> 0 || 1 });

/** Uniform in [0, 1). Mutates the generator. */
export function next(rng: Rng): number {
  // xorshift32
  let x = rng.seed;
  x ^= x << 13;
  x >>>= 0;
  x ^= x >> 17;
  x ^= x << 5;
  x >>>= 0;
  rng.seed = x;
  return x / 0x100000000;
}

/** Uniform in [-1, 1). */
export const signed = (rng: Rng): number => next(rng) * 2 - 1;

/** Uniform in [min, max). */
export const range = (rng: Rng, min: number, max: number): number =>
  min + next(rng) * (max - min);

/**
 * Roughly normal, mean 0, sd 1, via the sum of four uniforms.
 *
 * Bounded rather than truly Gaussian, which suits shot scatter: real misses
 * cluster near the intended target and never land in the car park.
 */
export function gaussian(rng: Rng): number {
  const sum = next(rng) + next(rng) + next(rng) + next(rng);
  return (sum - 2) * Math.sqrt(3);
}
