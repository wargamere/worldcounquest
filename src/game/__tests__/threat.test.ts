import { describe, expect, it } from 'vitest';
import { combinedThreat, strikeForce, strongestThreat } from '@/game/threat';
import { tinyWorld } from './helpers';

describe('strongestThreat', () => {
  it('names the most dangerous enemy neighbour', () => {
    const state = tinyWorld(
      { home: { owner: 'me', troops: 30 }, weak: { owner: 'a', troops: 5 }, strong: { owner: 'b', troops: 80 } },
      [['home', 'weak'], ['home', 'strong']],
    );
    expect(strongestThreat(state, 'home')?.fromId).toBe('strong');
  });

  it('ignores friendly neighbours', () => {
    const state = tinyWorld(
      { home: { owner: 'me', troops: 1 }, mine: { owner: 'me', troops: 500 } },
      [['home', 'mine']],
    );
    expect(strongestThreat(state, 'home')).toBeNull();
  });

  it('falls as the hypothetical garrison grows', () => {
    const state = tinyWorld(
      { home: { owner: 'me', troops: 10 }, enemy: { owner: 'a', troops: 60 } },
      [['home', 'enemy']],
    );
    expect(strongestThreat(state, 'home', 100)!.chance).toBeLessThan(strongestThreat(state, 'home', 10)!.chance);
  });
});

describe('combinedThreat', () => {
  it('is at least the strongest single threat, and grows with more borders', () => {
    // Regression guard: counting only the strongest neighbour let China, with
    // fourteen borders, be dogpiled in year one.
    const one = tinyWorld(
      { home: { owner: 'me', troops: 40 }, a: { owner: 'a', troops: 80 } },
      [['home', 'a']],
    );
    const three = tinyWorld(
      {
        home: { owner: 'me', troops: 40 },
        a: { owner: 'a', troops: 80 },
        b: { owner: 'b', troops: 80 },
        c: { owner: 'c', troops: 80 },
      },
      [['home', 'a'], ['home', 'b'], ['home', 'c']],
    );
    const single = combinedThreat(one, 'home');
    expect(single).toBeGreaterThan(0);
    expect(single).toBeCloseTo(strongestThreat(one, 'home')!.chance, 9);
    expect(combinedThreat(three, 'home')).toBeCloseTo(1 - (1 - single) ** 3, 9);
  });

  it('can leave one neighbour out of the reckoning', () => {
    const state = tinyWorld(
      { home: { owner: 'me', troops: 10 }, a: { owner: 'a', troops: 200 } },
      [['home', 'a']],
    );
    expect(combinedThreat(state, 'home', undefined, 'a')).toBe(0);
  });
});

describe('strikeForce', () => {
  it('counts what an enemy can recruit before attacking, not only what stands there', () => {
    // Regression guard: France judged 23 troops safe against Italy's 25, and
    // Italy recruited first and attacked with 37.
    const poor = tinyWorld({ e: { owner: 'a', troops: 50 } }, []);
    const rich = tinyWorld({ e: { owner: 'a', troops: 50 } }, []);
    rich.nations['a'] = { ...rich.nations['a']!, treasury: 100_000, manpower: 100_000_000 };
    expect(strikeForce(rich, 'e')).toBeGreaterThan(strikeForce(poor, 'e'));
  });
});
