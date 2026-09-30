import { describe, expect, it } from 'vitest';
import { assault, attack } from '@/game/actions';
import { adviseAttack, executePlan, planAssault, planAttack } from '@/game/ai';
import { ADVISOR } from '@/game/balance';
import { captureProbability } from '@/game/combat';
import { previewAssault, previewAttack, supportOptions } from '@/game/orders';
import { combinedThreat } from '@/game/threat';
import { tinyWorld } from './helpers';

/**
 * The Ukraine case, in miniature: three of our countries border a weak target,
 * but each is pinned by a big army of its own, so none can spare enough alone.
 */
function pinnedFront() {
  return tinyWorld(
    {
      a: { owner: 'me', troops: 90 },
      b: { owner: 'me', troops: 90 },
      c: { owner: 'me', troops: 90 },
      prey: { owner: 'x', troops: 40 },
      wolfA: { owner: 'w', troops: 95 },
      wolfB: { owner: 'w', troops: 95 },
      wolfC: { owner: 'w', troops: 95 },
    },
    [
      ['a', 'prey'], ['b', 'prey'], ['c', 'prey'],
      ['a', 'wolfA'], ['b', 'wolfB'], ['c', 'wolfC'],
    ],
  );
}

describe('assault', () => {
  it('resolves one battle with the combined force and spends every contributor’s action', () => {
    const state = tinyWorld(
      { a: { owner: 'me', troops: 60 }, b: { owner: 'me', troops: 60 }, prey: { owner: 'x', troops: 30 } },
      [['a', 'prey'], ['b', 'prey']],
    );
    const after = assault(state, 'me', 'prey', [{ fromId: 'a', troops: 50 }, { fromId: 'b', troops: 50 }]).state;
    expect(after.countries['a']).toMatchObject({ troops: 10, hasMoved: true });
    expect(after.countries['b']).toMatchObject({ troops: 10, hasMoved: true });
    expect(after.countries['prey']?.ownerId).toBe('me');
    expect(after.log[0]?.text).toMatch(/100 troops from 2 countries/);
  });

  it('matches a single-country attack exactly when there is one contributor', () => {
    const state = tinyWorld(
      { a: { owner: 'me', troops: 60 }, prey: { owner: 'x', troops: 30 } },
      [['a', 'prey']],
    );
    expect(assault(state, 'me', 'prey', [{ fromId: 'a', troops: 50 }]).state).toEqual(
      attack(state, 'me', 'a', 'prey', 50).state,
    );
  });

  it('uses the troop-weighted development of the contributors', () => {
    const state = tinyWorld(
      {
        rich: { owner: 'me', troops: 100, development: 10 },
        poor: { owner: 'me', troops: 100, development: 1 },
        prey: { owner: 'x', troops: 60 },
      },
      [['rich', 'prey'], ['poor', 'prey']],
    );
    const preview = previewAssault(state, 'prey', [{ fromId: 'rich', troops: 30 }, { fromId: 'poor', troops: 90 }])!;
    const expected = captureProbability({ attackerTroops: 120, attackerDev: (30 * 10 + 90 * 1) / 120, defenderTroops: 60, defenderDev: 5 });
    expect(preview.winChance).toBeCloseTo(expected, 12);
  });

  it('rejects contributors that are not adjacent, not ours, listed twice, or already acted', () => {
    const state = tinyWorld(
      {
        a: { owner: 'me', troops: 60 },
        far: { owner: 'me', troops: 60 },
        theirs: { owner: 'y', troops: 60 },
        prey: { owner: 'x', troops: 30 },
      },
      [['a', 'prey'], ['theirs', 'prey']],
    );
    expect(assault(state, 'me', 'prey', [{ fromId: 'a', troops: 5 }, { fromId: 'far', troops: 5 }]).error).toBeDefined();
    expect(assault(state, 'me', 'prey', [{ fromId: 'a', troops: 5 }, { fromId: 'theirs', troops: 5 }]).error).toBeDefined();
    expect(assault(state, 'me', 'prey', [{ fromId: 'a', troops: 5 }, { fromId: 'a', troops: 5 }]).error).toBeDefined();
    const moved = { ...state, countries: { ...state.countries, a: { ...state.countries['a']!, hasMoved: true } } };
    expect(assault(moved, 'me', 'prey', [{ fromId: 'a', troops: 5 }]).error).toBeDefined();
  });
});

describe('planAssault', () => {
  it('finds the combined attack where no single country can safely go', () => {
    const state = pinnedFront();
    expect(planAttack(state, 'me', ADVISOR.WIN_CHANCE, ADVISOR.RISK_TOLERANCE)).toBeNull();
    const plan = planAssault(state, 'me', ADVISOR.WIN_CHANCE, ADVISOR.RISK_TOLERANCE)!;
    expect(plan.targetId).toBe('prey');
    expect(plan.support.length).toBeGreaterThanOrEqual(1);

    const parts = [{ fromId: plan.fromId, troops: plan.troops }, ...plan.support];
    const preview = previewAssault(state, 'prey', parts)!;
    expect(preview.winChance).toBeGreaterThanOrEqual(ADVISOR.WIN_CHANCE);
    for (const part of parts) {
      const from = state.countries[part.fromId]!;
      expect(combinedThreat(state, part.fromId, from.troops - part.troops, 'prey')).toBeLessThanOrEqual(ADVISOR.RISK_TOLERANCE);
    }
  });

  it('is what the advisor falls back on, and executing it takes the country', () => {
    const state = pinnedFront();
    const plan = adviseAttack(state)!;
    expect(plan.support.length).toBeGreaterThan(0);
    expect(executePlan(state, 'me', plan).countries['prey']?.ownerId).toBe('me');
  });

  it('needs at least two contributors', () => {
    const state = tinyWorld(
      { a: { owner: 'me', troops: 30 }, prey: { owner: 'x', troops: 100 } },
      [['a', 'prey']],
    );
    expect(planAssault(state, 'me', 0.8, 0.2)).toBeNull();
  });
});

describe('supportOptions', () => {
  it('lists the other bordering countries that can join, most spare first', () => {
    const state = tinyWorld(
      {
        lead: { owner: 'me', troops: 50 },
        big: { owner: 'me', troops: 200 },
        small: { owner: 'me', troops: 20 },
        away: { owner: 'me', troops: 500 },
        prey: { owner: 'x', troops: 30 },
      },
      [['lead', 'prey'], ['big', 'prey'], ['small', 'prey']],
    );
    const options = supportOptions(state, 'prey', 'lead');
    expect(options.map((o) => o.fromId)).toEqual(['big', 'small']);
    expect(options[0]!.spare).toBeGreaterThan(options[1]!.spare);
  });

  it('previewAttack is the one-source case of previewAssault', () => {
    const state = pinnedFront();
    expect(previewAttack(state, 'a', 'prey', 50)).toEqual(previewAssault(state, 'prey', [{ fromId: 'a', troops: 50 }]));
  });
});
