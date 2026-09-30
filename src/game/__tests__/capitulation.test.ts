import { describe, expect, it } from 'vitest';
import { attack } from '@/game/actions';
import { followAdvice, planAttack, safeGarrison } from '@/game/ai';
import { CAPITAL } from '@/game/balance';
import { captureIncome, capitulatesOnCapture, isCapital } from '@/game/capitulation';
import { countryIncome } from '@/game/economy';
import { endTurn } from '@/game/turn';
import { tinyWorld } from './helpers';

/**
 * Empire "e" holds its capital (the country sharing its id) and two provinces.
 * We border the capital with an overwhelming army.
 */
function empire() {
  return tinyWorld(
    {
      me: { owner: 'me', troops: 1000 },
      e: { owner: 'e', troops: 10 },
      e1: { owner: 'e', troops: 41 },
      e2: { owner: 'e', troops: 20 },
    },
    [['me', 'e'], ['e', 'e1'], ['e', 'e2']],
  );
}

describe('capitals', () => {
  it('is the country a nation started from, while it still holds it', () => {
    const state = empire();
    expect(isCapital(state, 'e')).toBe(true);
    expect(isCapital(state, 'e1')).toBe(false);
    const lost = { ...state, countries: { ...state.countries, e: { ...state.countries['e']!, ownerId: 'me' } } };
    expect(isCapital(lost, 'e')).toBe(false);
  });

  it('only brings down a nation that has something left to surrender', () => {
    const state = tinyWorld({ me: { owner: 'me', troops: 50 }, lone: { owner: 'lone', troops: 5 } }, [['me', 'lone']]);
    expect(capitulatesOnCapture(state, 'lone')).toBe(false);
    expect(capitulatesOnCapture(empire(), 'e')).toBe(true);
  });

  it('never brings down the player', () => {
    const state = tinyWorld(
      { me: { owner: 'me', troops: 5 }, mine: { owner: 'me', troops: 5 }, foe: { owner: 'foe', troops: 900 } },
      [['me', 'foe'], ['me', 'mine']],
    );
    expect(capitulatesOnCapture(state, 'me')).toBe(false);
    const after = attack(state, 'foe', 'foe', 'me', 800).state;
    expect(after.countries['me']?.ownerId).toBe('foe');
    expect(after.countries['mine']?.ownerId).toBe('me');
  });

  it('is worth the whole nation’s income', () => {
    const state = empire();
    const total = ['e', 'e1', 'e2'].reduce((sum, id) => sum + countryIncome(state.countries[id]!), 0);
    expect(captureIncome(state, 'e')).toBeCloseTo(total);
    expect(captureIncome(state, 'e1')).toBeCloseTo(countryIncome(state.countries['e1']!));
  });
});

describe('capitulation', () => {
  it('hands every province to whoever takes the capital, garrisons halved', () => {
    const after = attack(empire(), 'me', 'me', 'e', 500).state;
    expect(after.countries['e']?.ownerId).toBe('me');
    expect(after.countries['e1']).toMatchObject({ ownerId: 'me', troops: Math.floor(41 * CAPITAL.TROOPS_KEPT), hasMoved: true });
    expect(after.countries['e2']).toMatchObject({ ownerId: 'me', troops: Math.floor(20 * CAPITAL.TROOPS_KEPT), hasMoved: true });
    expect(after.nations['e']).toMatchObject({ treasury: 0, manpower: 0 });
    expect(after.log[0]?.surrender).toEqual({ loserId: 'e', winnerId: 'me', countries: 2, troops: 20 + 10 });
    expect(after.log[1]?.combat?.captured).toBe(true);
    expect(after.stats.peakCountries).toBe(4);
  });

  it('does not happen when the attack on the capital fails', () => {
    const state = empire();
    const after = attack({ ...state, countries: { ...state.countries, e: { ...state.countries['e']!, troops: 900 } } }, 'me', 'me', 'e', 10).state;
    expect(after.countries['e']?.ownerId).toBe('e');
    expect(after.countries['e1']?.ownerId).toBe('e');
    expect(after.log.some((entry) => entry.surrender)).toBe(false);
  });

  it('shows up in the turn report when a large nation falls', () => {
    const big = tinyWorld(
      {
        me: { owner: 'me', troops: 20 },
        w: { owner: 'w', troops: 900 },
        e: { owner: 'e', troops: 5 },
        e1: { owner: 'e', troops: 5 },
        e2: { owner: 'e', troops: 5 },
        e3: { owner: 'e', troops: 5 },
      },
      [['w', 'e'], ['e', 'e1'], ['e', 'e2'], ['e', 'e3'], ['me', 'e3']],
    );
    const after = endTurn(big);
    expect(after.countries['e3']?.ownerId).toBe('w');
    expect(after.lastReport?.surrenders).toEqual([{ loserId: 'e', winnerId: 'w', countries: 3, troops: 6 }]);
  });
});

describe('the AI and capitals', () => {
  it('goes for a capital over an equally held province', () => {
    const state = tinyWorld(
      {
        me: { owner: 'me', troops: 400 },
        e: { owner: 'e', troops: 30 },
        e1: { owner: 'e', troops: 30 },
        e2: { owner: 'e', troops: 30 },
      },
      [['me', 'e'], ['me', 'e1'], ['e', 'e2']],
    );
    expect(planAttack(state, 'me', 0.75, 0.15)?.targetId).toBe('e');
  });

  it('holds its capital to a tighter risk than a province', () => {
    const state = tinyWorld(
      {
        e: { owner: 'e', troops: 200 },
        e1: { owner: 'e', troops: 200 },
        wolfA: { owner: 'w', troops: 120 },
        wolfB: { owner: 'w', troops: 120 },
      },
      [['e', 'e1'], ['e', 'wolfA'], ['e1', 'wolfB']],
    );
    expect(safeGarrison(state, 'e', 0.15)).toBeGreaterThan(safeGarrison(state, 'e1', 0.15));
  });
});

describe('followAdvice', () => {
  it('carries out every safe attack and stops when nothing is left to suggest', () => {
    const state = tinyWorld(
      {
        a: { owner: 'me', troops: 300 },
        b: { owner: 'me', troops: 300 },
        x: { owner: 'x', troops: 5 },
        y: { owner: 'y', troops: 5 },
      },
      [['a', 'x'], ['b', 'y'], ['a', 'b']],
    );
    const taken = followAdvice(state);
    expect(taken.attacks).toBe(2);
    expect(taken.captured.sort()).toEqual(['x', 'y']);
    expect(taken.state.countries['x']?.ownerId).toBe('me');
    expect(taken.state.countries['y']?.ownerId).toBe('me');
    expect(followAdvice(taken.state)).toMatchObject({ attacks: 0, moves: 0 });
  });

  it('never touches the treasury: recruiting and investing stay with the player', () => {
    const base = tinyWorld({ a: { owner: 'me', troops: 300 }, x: { owner: 'x', troops: 5 } }, [['a', 'x']]);
    const state = { ...base, nations: { ...base.nations, me: { ...base.nations['me']!, treasury: 5000, manpower: 1e7 } } };
    expect(followAdvice(state).state.nations['me']).toEqual(state.nations['me']);
  });
});
