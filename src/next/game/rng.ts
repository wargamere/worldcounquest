/**
 * Seeded PRNG (mulberry32). Deterministic so combat and AI can be unit tested,
 * and so a saved game resumes the same way it would have run.
 *
 * Every draw returns the next state alongside the value; nothing is mutated.
 */
export interface Roll {
  value: number;
  state: number;
}

/** Uniform in [0, 1). */
export function nextRandom(state: number): Roll {
  let t = (state + 0x6d2b79f5) | 0;
  let r = Math.imul(t ^ (t >>> 15), 1 | t);
  r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
  const value = ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  t = t | 0;
  return { value, state: t };
}

/** Uniform in [min, max). */
export function nextInRange(state: number, min: number, max: number): Roll {
  const roll = nextRandom(state);
  return { value: min + roll.value * (max - min), state: roll.state };
}

/** Turns an arbitrary string into a seed, so a game can be seeded by name. */
export function seedFromString(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
