import { describe, expect, it } from 'vitest';
import { hashNumbers, localRng, nextInRange, nextRandom, roll, seedFromString } from '../rng';
import { tinySim } from './helpers';

describe('rng', () => {
  it('roll draws from and advances the game stream', () => {
    const { sim } = tinySim({ provinces: { a: { owner: 'me' } }, edges: [] });
    const start = sim.state.rng;
    const expected = nextInRange(start, 0.85, 1.15);
    expect(roll(sim, 0.85, 1.15)).toBe(expected.value);
    expect(sim.state.rng).toBe(expected.state);
    expect(roll(sim, 0.85, 1.15)).toBe(nextInRange(expected.state, 0.85, 1.15).value);
  });

  it('localRng replays the mulberry32 stream without touching any state', () => {
    const seed = seedFromString('forecast');
    const draw = localRng(seed);
    let state = seed;
    for (let i = 0; i < 100; i += 1) {
      const r = nextRandom(state);
      state = r.state;
      const v = draw();
      expect(v).toBe(r.value);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('hashNumbers ignores sub-1/1024 noise but not real changes or order', () => {
    const base = hashNumbers([120.5, 3, 0.85]);
    expect(hashNumbers([120.5 + 1e-6, 3, 0.85])).toBe(base);
    expect(hashNumbers([121, 3, 0.85])).not.toBe(base);
    expect(hashNumbers([3, 120.5, 0.85])).not.toBe(base);
    expect(hashNumbers([-2.5, 1e7])).toBe(hashNumbers([-2.5, 1e7]));
    expect(hashNumbers([])).toBe(2166136261);
    expect(Number.isInteger(base) && base >= 0 && base < 4294967296).toBe(true);
  });
});
