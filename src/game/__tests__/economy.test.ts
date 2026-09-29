import { describe, expect, it } from 'vitest';
import { ECONOMY, MANPOWER, RECRUITMENT } from '@/game/balance';
import {
  applyIncome,
  countryIncome,
  grossIncome,
  investmentCost,
  manpowerCap,
  manpowerRegen,
  maxAffordableTroops,
  netIncome,
  recruitmentCost,
  troopUpkeep,
} from '@/game/economy';
import type { GameState } from '@/game/types';

function world(overrides: Partial<GameState> = {}): GameState {
  return {
    turn: 0,
    countries: {
      a: {
        id: 'a', name: 'A', population: 10_000_000, economyTier: 3,
        ownerId: 'me', troops: 10, development: 5, hasMoved: false,
      },
      b: {
        id: 'b', name: 'B', population: 40_000_000, economyTier: 2,
        ownerId: 'me', troops: 20, development: 3, hasMoved: false,
      },
      c: {
        id: 'c', name: 'C', population: 5_000_000, economyTier: 5,
        ownerId: 'them', troops: 5, development: 9, hasMoved: false,
      },
    },
    nations: {
      me: { id: 'me', name: 'Me', colour: '#fff', treasury: 100, manpower: 100_000, isPlayer: true, isMajor: true },
      them: { id: 'them', name: 'Them', colour: '#000', treasury: 50, manpower: 0, isPlayer: false, isMajor: false },
    },
    adjacency: { a: ['b'], b: ['a', 'c'], c: ['b'] },
    playerId: 'me',
    difficulty: 'standard',
    status: 'playing',
    log: [],
    nextLogId: 1,
    rngState: 1,
    stats: { battlesWon: 0, battlesLost: 0, defencesHeld: 0, countriesLost: 0, peakCountries: 1 },
    lastReport: null,
    history: [],
    ...overrides,
  };
}

describe('countryIncome', () => {
  it('rises with development', () => {
    const base = { population: 10_000_000, economyTier: 3 };
    expect(countryIncome({ ...base, development: 6 })).toBeGreaterThan(
      countryIncome({ ...base, development: 5 }),
    );
  });

  it('rises with economy tier', () => {
    const base = { population: 10_000_000, development: 5 };
    expect(countryIncome({ ...base, economyTier: 4 })).toBeGreaterThan(
      countryIncome({ ...base, economyTier: 3 }),
    );
  });

  it('rises with population but sub-linearly, so giants do not run away with it', () => {
    const base = { economyTier: 3, development: 5 };
    const small = countryIncome({ ...base, population: 10_000_000 });
    const huge = countryIncome({ ...base, population: 1_000_000_000 });
    expect(huge).toBeGreaterThan(small);
    expect(huge / small).toBeLessThan(100 / 1);
  });

  it('falls back to a sane factor for an out-of-range tier', () => {
    expect(countryIncome({ population: 1_000_000, economyTier: 99, development: 1 })).toBeGreaterThan(0);
  });
});

describe('national accounts', () => {
  it('sums gross income over owned countries only', () => {
    const state = world();
    const expected =
      countryIncome(state.countries['a']!) + countryIncome(state.countries['b']!);
    expect(grossIncome(state, 'me')).toBeCloseTo(expected);
  });

  it('charges upkeep per troop', () => {
    expect(troopUpkeep(world(), 'me')).toBeCloseTo(30 * ECONOMY.TROOP_UPKEEP);
  });

  it('nets income against upkeep', () => {
    const state = world();
    expect(netIncome(state, 'me')).toBeCloseTo(grossIncome(state, 'me') - troopUpkeep(state, 'me'));
  });

  it('can go negative when an army outgrows the economy', () => {
    const state = world();
    state.countries['a'] = { ...state.countries['a']!, troops: 100_000 };
    expect(netIncome(state, 'me')).toBeLessThan(0);
  });
});

describe('manpower', () => {
  it('regenerates a fixed fraction of owned population', () => {
    expect(manpowerRegen(world(), 'me')).toBeCloseTo(50_000_000 * MANPOWER.REGEN_RATE);
  });

  it('caps the pool at a year of regen', () => {
    const state = world();
    expect(manpowerCap(state, 'me')).toBeCloseTo(manpowerRegen(state, 'me') * MANPOWER.CAP_MONTHS);
  });

  it('recomputes regen from current holdings, so losing land cuts it immediately', () => {
    const state = world();
    const before = manpowerRegen(state, 'me');
    state.countries['b'] = { ...state.countries['b']!, ownerId: 'them' };
    expect(manpowerRegen(state, 'me')).toBeLessThan(before);
  });

  it('never exceeds the cap when income is applied', () => {
    const state = world();
    const brimming = {
      ...state,
      nations: { ...state.nations, me: { ...state.nations['me']!, manpower: 10_000_000 } },
    };
    const after = applyIncome(brimming, 'me', 1).state;
    expect(after.nations['me']!.manpower).toBeCloseTo(manpowerCap(state, 'me'));
  });

  it('leaves the banked stock alone when territory is lost', () => {
    const state = world();
    const banked = state.nations['me']!.manpower;
    state.countries['b'] = { ...state.countries['b']!, ownerId: 'them' };
    expect(state.nations['me']!.manpower).toBe(banked);
  });
});

describe('costs', () => {
  it('makes each development level dearer than the last', () => {
    expect(investmentCost(2)).toBeGreaterThan(investmentCost(1));
    expect(investmentCost(9)).toBeGreaterThan(investmentCost(8));
  });

  it('charges money and manpower per troop', () => {
    expect(recruitmentCost(10)).toEqual({
      money: 10 * RECRUITMENT.MONEY_PER_TROOP,
      manpower: 10 * MANPOWER.COST_PER_TROOP,
    });
  });

  it('caps recruitment by whichever of money or manpower runs out first', () => {
    const broke = world();
    broke.nations['me'] = { ...broke.nations['me']!, treasury: 8, manpower: 10_000_000 };
    expect(maxAffordableTroops(broke, 'me')).toBe(1);

    const drained = world();
    drained.nations['me'] = { ...drained.nations['me']!, treasury: 100_000, manpower: 0 };
    expect(maxAffordableTroops(drained, 'me')).toBe(0);
  });

  it('returns zero for a nation that does not exist', () => {
    expect(maxAffordableTroops(world(), 'nobody')).toBe(0);
  });
});

describe('applyIncome', () => {
  it('credits the treasury and regenerates manpower', () => {
    const state = world();
    const { state: after, net } = applyIncome(state, 'me', 1);
    expect(after.nations['me']!.treasury).toBeCloseTo(100 + net);
    expect(after.nations['me']!.manpower).toBeGreaterThan(100_000);
  });

  it('applies the AI income multiplier', () => {
    const state = world();
    const plain = applyIncome(state, 'me', 1).net;
    const boosted = applyIncome(state, 'me', 1.25).net;
    expect(boosted).toBeGreaterThan(plain);
  });

  it('bankrupts into desertion rather than a negative treasury', () => {
    const state = world();
    state.countries['a'] = { ...state.countries['a']!, troops: 100_000 };
    state.nations['me'] = { ...state.nations['me']!, treasury: 0 };
    const { state: after, deserted } = applyIncome(state, 'me', 1);
    expect(after.nations['me']!.treasury).toBe(0);
    expect(deserted).toBeGreaterThan(0);
    expect(after.countries['a']!.troops).toBeLessThan(100_000);
  });

  it('leaves other nations untouched', () => {
    const state = world();
    const after = applyIncome(state, 'me', 1).state;
    expect(after.nations['them']).toEqual(state.nations['them']);
  });
});
