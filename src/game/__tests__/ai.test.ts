import { describe, expect, it } from 'vitest';
import { adviseMove, distanceToFront, planAttack, safeGarrison, takeMajorTurn } from '@/game/ai';
import { captureProbability } from '@/game/combat';
import { combinedThreat } from '@/game/threat';
import { tinyWorld } from './helpers';

const SETTINGS = { winChance: 0.75, riskTolerance: 0.15, attacksPerTurn: 3, investThreshold: 1e9 };

describe('planAttack', () => {
  it('takes a free win when home stays safe', () => {
    const state = tinyWorld(
      { home: { owner: 'ai', troops: 100 }, prey: { owner: 'x', troops: 10 } },
      [['home', 'prey']],
    );
    const plan = planAttack(state, 'ai', 0.75, 0.15);
    expect(plan?.targetId).toBe('prey');
  });

  it('never strips home below a safe garrison', () => {
    // A big hostile army also borders home. The AI may still attack, but only
    // with troops it can spare against that army.
    const state = tinyWorld(
      {
        home: { owner: 'ai', troops: 120 },
        prey: { owner: 'x', troops: 10 },
        wolf: { owner: 'w', troops: 90 },
      },
      [['home', 'prey'], ['home', 'wolf']],
    );
    const plan = planAttack(state, 'ai', 0.75, 0.15);
    const left = 120 - (plan?.troops ?? 0);
    expect(left).toBeGreaterThanOrEqual(safeGarrison(state, 'home', 0.15, 'prey'));
    expect(combinedThreat(state, 'home', left, 'prey')).toBeLessThanOrEqual(0.15);
  });

  it('declines when any safe force would be too small to win', () => {
    const state = tinyWorld(
      {
        home: { owner: 'ai', troops: 60 },
        prey: { owner: 'x', troops: 30 },
        wolf: { owner: 'w', troops: 70 },
      },
      [['home', 'prey'], ['home', 'wolf']],
    );
    expect(planAttack(state, 'ai', 0.75, 0.15)).toBeNull();
  });

  it('sizes a big army to hold what it takes, instead of refusing the attack', () => {
    // Regression guard: the US once sat 1,637 troops next to Panama and never
    // attacked, because a capped 48-troop force could not have held it.
    const state = tinyWorld(
      {
        stack: { owner: 'ai', troops: 1600 },
        prey: { owner: 'x', troops: 20 },
        rival: { owner: 'r', troops: 200 },
      },
      [['stack', 'prey'], ['prey', 'rival']],
    );
    const plan = planAttack(state, 'ai', 0.75, 0.15);
    expect(plan?.targetId).toBe('prey');
    expect(plan!.troops).toBeGreaterThan(48);
  });

  it('skips captures that could not be held with everything it can spare', () => {
    const state = tinyWorld(
      {
        home: { owner: 'ai', troops: 30 },
        prey: { owner: 'x', troops: 5 },
        giant: { owner: 'g', troops: 5000 },
      },
      [['home', 'prey'], ['prey', 'giant']],
    );
    expect(planAttack(state, 'ai', 0.75, 0.15)).toBeNull();
  });

  it('ignores countries that already acted this turn', () => {
    const state = tinyWorld(
      { home: { owner: 'ai', troops: 100 }, prey: { owner: 'x', troops: 10 } },
      [['home', 'prey']],
    );
    state.countries['home'] = { ...state.countries['home']!, hasMoved: true };
    expect(planAttack(state, 'ai', 0.75, 0.15)).toBeNull();
  });

  it('prefers the better deal: more income per troop needed', () => {
    const state = tinyWorld(
      {
        home: { owner: 'ai', troops: 400 },
        poor: { owner: 'x', troops: 10, tier: 1, population: 1_000_000 },
        rich: { owner: 'y', troops: 10, tier: 5, population: 50_000_000 },
      },
      [['home', 'poor'], ['home', 'rich']],
    );
    expect(planAttack(state, 'ai', 0.75, 0.15)?.targetId).toBe('rich');
  });
});

describe('takeMajorTurn', () => {
  it('attacks before reinforcing, so a drained source can still attack', () => {
    // Regression guard: reinforcing first marked the homeland as having acted,
    // so no nation could ever attack from a country it had just drained.
    const state = tinyWorld(
      {
        home: { owner: 'ai', troops: 200 },
        outpost: { owner: 'ai', troops: 1 },
        prey: { owner: 'x', troops: 10 },
        wolf: { owner: 'w', troops: 60 },
      },
      [['home', 'outpost'], ['home', 'prey'], ['outpost', 'wolf']],
    );
    const after = takeMajorTurn(state, 'ai', SETTINGS);
    expect(after.countries['prey']?.ownerId).toBe('ai');
  });

  it('commits only attacks that clear its win chance', () => {
    const state = tinyWorld(
      { home: { owner: 'ai', troops: 100 }, prey: { owner: 'x', troops: 10 } },
      [['home', 'prey']],
    );
    const plan = planAttack(state, 'ai', 0.75, 0.15)!;
    const chance = captureProbability({ attackerTroops: plan.troops, attackerDev: 5, defenderTroops: 10, defenderDev: 5 });
    expect(chance).toBeGreaterThanOrEqual(0.75);
  });
});

describe('safeGarrison', () => {
  it('is a small floor with no hostile neighbours', () => {
    const state = tinyWorld({ home: { owner: 'ai', troops: 100 } }, []);
    expect(safeGarrison(state, 'home', 0.15)).toBeLessThanOrEqual(4);
  });

  it('grows with the army next door', () => {
    const small = tinyWorld(
      { home: { owner: 'ai', troops: 500 }, n: { owner: 'x', troops: 20 } },
      [['home', 'n']],
    );
    const big = tinyWorld(
      { home: { owner: 'ai', troops: 500 }, n: { owner: 'x', troops: 200 } },
      [['home', 'n']],
    );
    expect(safeGarrison(big, 'home', 0.15)).toBeGreaterThan(safeGarrison(small, 'home', 0.15));
  });
});

describe('adviseMove', () => {
  it('shores up a country likely to fall', () => {
    const state = tinyWorld(
      {
        rear: { owner: 'me', troops: 300 },
        front: { owner: 'me', troops: 3 },
        enemy: { owner: 'x', troops: 120 },
      },
      [['rear', 'front'], ['front', 'enemy']],
    );
    expect(adviseMove(state)).toMatchObject({ fromId: 'rear', toId: 'front', reason: 'threatened' });
  });

  it('walks idle interior troops one step toward the front', () => {
    // deep – middle – edge – enemy (weak): nothing is threatened, but deep is idle.
    const state = tinyWorld(
      {
        deep: { owner: 'me', troops: 200 },
        middle: { owner: 'me', troops: 5 },
        edge: { owner: 'me', troops: 500 },
        enemy: { owner: 'x', troops: 2 },
      },
      [['deep', 'middle'], ['middle', 'edge'], ['edge', 'enemy']],
    );
    const plan = adviseMove(state);
    expect(plan).toMatchObject({ fromId: 'deep', toId: 'middle', reason: 'forward' });
    expect(distanceToFront(state, 'me').get('deep')).toBe(2);
  });

  it('suggests nothing when every garrison is where it should be', () => {
    const state = tinyWorld(
      { edge: { owner: 'me', troops: 50 }, enemy: { owner: 'x', troops: 2 } },
      [['edge', 'enemy']],
    );
    expect(adviseMove(state)).toBeNull();
  });
});
