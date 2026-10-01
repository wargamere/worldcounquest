/**
 * Seeded PRNG (mulberry32). Deterministic so combat and AI can be unit tested,
 * and so a saved game resumes the same way it would have run.
 *
 * Every draw returns the next state alongside the value; nothing is mutated,
 * except by `roll`, which advances the game's own stream in `state.rng`.
 */
import type { Sim } from './types';

export interface Roll {
  value: number;
  state: number;
}

/** The mulberry32 output for an already advanced state, uniform in [0, 1). */
function output(t: number): number {
  let r = Math.imul(t ^ (t >>> 15), 1 | t);
  r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
  return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
}

/** Uniform in [0, 1). */
export function nextRandom(state: number): Roll {
  const t = (state + 0x6d2b79f5) | 0;
  return { value: output(t), state: t };
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

/** Uniform in [min, max) from the game stream; advances `sim.state.rng`. */
export function roll(sim: Sim, min: number, max: number): number {
  const r = nextInRange(sim.state.rng, min, max);
  sim.state.rng = r.state;
  return r.value;
}

/**
 * FNV-1a over `Math.round(v × 1024)` of each value, byte by byte. Rounding first
 * means sub-1/1024 noise does not change the hash, so a seed derived from a
 * battle's inputs stays put while nothing meaningful changes.
 */
export function hashNumbers(values: readonly number[]): number {
  let h = 2166136261;
  for (const v of values) {
    const k = Number.isFinite(v) ? Math.round(v * 1024) | 0 : 0;
    h = Math.imul(h ^ (k & 0xff), 16777619);
    h = Math.imul(h ^ ((k >>> 8) & 0xff), 16777619);
    h = Math.imul(h ^ ((k >>> 16) & 0xff), 16777619);
    h = Math.imul(h ^ (k >>> 24), 16777619);
  }
  return h >>> 0;
}

/**
 * A private mulberry32 stream for forecasts: uniform in [0, 1), never touches
 * `state.rng`, and allocates nothing per draw.
 */
export function localRng(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    return output(state);
  };
}
