import { describe, expect, it } from 'vitest';
import { COMBAT, EFFECTS, GARRISON, TERRAIN, UNITS } from '../../balance';
import { assessNation, lanchester, liveOperations, softShare, strength } from '../../ai/assess';
import { asArmy } from '../../ids';
import { unitsFromCounts } from '../../units';
import { tinySim } from '../helpers';

describe('strength', () => {
  it('is √(damage per hour × HP), with the defender bonuses and frontage', () => {
    const rifles = unitsFromCounts({ rifles: 10 });
    const attack = strength(rifles, 0, 'attacker', 1, 'plains', 0);
    expect(attack.hp).toBe(10 * UNITS.rifles.hp);
    expect(attack.damage).toBeCloseTo(10 * UNITS.rifles.attack.soft * COMBAT.DAMAGE_SCALE, 9);
    expect(attack.f).toBeCloseTo(Math.sqrt(attack.damage * attack.hp), 9);

    const held = strength(rifles, 80, 'defender', 1, 'mountains', 2);
    const raw = 10 * UNITS.rifles.defence.soft + (80 / GARRISON.HP_PER_UNIT) * GARRISON.DEFENCE.soft;
    expect(held.damage).toBeCloseTo(raw * COMBAT.DAMAGE_SCALE * TERRAIN.mountains.defence * (1 + 2 * EFFECTS.RAMPARTS_DAMAGE_PER_LEVEL), 9);
    expect(held.hp).toBeCloseTo(280 / (1 - 2 * EFFECTS.RAMPARTS_PROTECTION_PER_LEVEL), 9);

    // Beyond the frontage more units add HP but no damage.
    const crowd = strength(unitsFromCounts({ rifles: 60 }), 0, 'attacker', 1, 'mountains', 0);
    expect(crowd.damage).toBeCloseTo(TERRAIN.mountains.frontage * UNITS.rifles.attack.soft * COMBAT.DAMAGE_SCALE, 9);
    // Hard damage only counts against a hard enemy.
    expect(strength(unitsFromCounts({ hunters: 4 }), 0, 'attacker', 0, 'plains', 0).damage).toBeCloseTo(4 * UNITS.hunters.attack.hard * COMBAT.DAMAGE_SCALE, 9);
    expect(softShare(unitsFromCounts({ rifles: 1, tanks: 1 }), 0)).toBeCloseTo(20 / 56, 9);
  });
});

describe('lanchester', () => {
  it('follows the square law', () => {
    const a = strength(unitsFromCounts({ rifles: 20 }), 0, 'attacker', 1, 'plains', 0);
    const b = strength(unitsFromCounts({ rifles: 10 }), 0, 'attacker', 1, 'plains', 0);
    const fight = lanchester(a, b);
    expect(fight.aWins).toBe(true);
    expect(fight.keep).toBeCloseTo(Math.sqrt(1 - (b.f / a.f) * (b.f / a.f)), 9);
    expect(fight.hours).toBeGreaterThan(0);
    expect(fight.hours).toBeLessThan(COMBAT.PREDICT_MAX_HOURS);
    const back = lanchester(b, a);
    expect(back.aWins).toBe(false);
    expect(back.keep).toBe(0);
    // The loser lasts as long either way round.
    expect(back.hours).toBeCloseTo(fight.hours, 9);
    // Against nothing, everything is kept at once.
    expect(lanchester(a, { damage: 0, hp: 0, f: 0 })).toEqual({ aWins: true, keep: 1, hours: 0 });
  });

  it('times the fight with an accurate atanh (no log on the deterministic path)', () => {
    // Equal per-HP rates: x' = −y, y' = −x, so B is gone when tanh(t) = F_B / F_A.
    const a = { damage: 10, hp: 10, f: 10 };
    const b = { damage: 5, hp: 5, f: 5 };
    expect(lanchester(a, b).hours).toBeCloseTo(0.5493061443340548, 9); // atanh(1/2) = ln(3) / 2
  });
});

describe('assessNation', () => {
  it('orders the frontier capital first, then by threat over defence, and lists free armies', () => {
    const { sim, n, p, a } = tinySim({
      provinces: {
        cap: { owner: 'aa', capitalOf: 'aa' },
        quiet: { owner: 'aa' },
        hot: { owner: 'aa', garrison: 10 },
        e1: { owner: 'bb', capitalOf: 'bb' },
        e2: { owner: 'cc', capitalOf: 'cc' },
        me: { owner: 'me' },
      },
      edges: [
        ['cap', 'quiet'],
        ['cap', 'hot'],
        ['quiet', 'e1'],
        ['hot', 'e2'],
      ],
      armies: [
        { owner: 'cc', at: 'e2', units: { rifles: 8 } },
        { owner: 'aa', at: 'cap', units: { rifles: 3 } },
        { owner: 'aa', at: 'quiet', units: { rifles: 3 } },
      ],
    });
    const view = assessNation(sim, n('aa'));
    expect(view.frontier).toEqual([p('cap'), p('hot'), p('quiet')]);
    expect(view.available).toEqual([a(1), a(2)]);
    expect(view.operations).toBe(0);
    expect(view.field.ticks[p('cap')]).toBe(0);
  });

  it('drops operations whose target is taken or whose armies all went home', () => {
    const { sim, n, p, a } = tinySim({
      provinces: { cap: { owner: 'aa', capitalOf: 'aa' }, t: { owner: 'aa' }, u: { owner: 'bb', capitalOf: 'bb' }, me: { owner: 'me' } },
      edges: [
        ['cap', 't'],
        ['t', 'u'],
      ],
      armies: [{ owner: 'aa', at: 'cap', units: { rifles: 3 } }],
    });
    const nation = sim.state.nations[n('aa')]!;
    nation.ai.operations = [
      { target: p('t'), armies: [a(0)], launchedAt: 0 },
      { target: p('u'), armies: [a(0)], launchedAt: 0 },
      { target: p('u'), armies: [asArmy(99)], launchedAt: 0 },
    ];
    // The army is idle: every operation it belongs to is over.
    expect(liveOperations(sim, n('aa'))).toEqual([]);
    sim.state.armies[0]!.path = [p('t'), p('u')];
    sim.state.armies[0]!.departAt = 10;
    expect(liveOperations(sim, n('aa'))).toEqual([nation.ai.operations[1]]);
  });
});
