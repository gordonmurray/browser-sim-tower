/**
 * Seeded deterministic RNG (mulberry32). The state lives inside TowerState so
 * the whole simulation is reproducible from a save. Never use Math.random()
 * anywhere in src/core.
 */
export interface RngState {
  s: number;
}

export function createRng(seed: number): RngState {
  return { s: seed | 0 };
}

/** Uniform float in [0, 1). Mutates rng. */
export function rngNext(rng: RngState): number {
  rng.s = (rng.s + 0x6d2b79f5) | 0;
  let t = rng.s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Integer in [min, maxExclusive). */
export function rngInt(rng: RngState, min: number, maxExclusive: number): number {
  return min + Math.floor(rngNext(rng) * (maxExclusive - min));
}

/** True with probability p. */
export function rngChance(rng: RngState, p: number): boolean {
  return rngNext(rng) < p;
}
