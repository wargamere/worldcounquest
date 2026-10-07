import { describe, expect, it } from 'vitest';
import { armyStatus, createArmy } from '../armies';
import { armyById, rebuildArmyIndex, setOwner } from '../cache';
import { applyCommand } from '../commands';
import { orderRally } from '../movement';
import { advance } from '../sim';
import { totalHp, unitsFromCounts } from '../units';
import { tinySim } from './helpers';
import { step, stepUntil } from './steps';

/** Bugs found in review of orders and marching; each test failed before its fix. */
describe('order regressions', () => {
  it('an army ordered out of a battle to arrive together keeps fighting until it leaves, then leaves on time', () => {
    const { sim, a, p, n } = tinySim({
      provinces: {
        home: { owner: 'me', capitalOf: 'me' },
        b: { owner: 'me', garrison: 0 },
        t: { owner: 'foe', garrison: 10 },
        f0: { owner: 'foe', capitalOf: 'foe' },
      },
      edges: [
        ['b', 't', 100],
        ['home', 't', 180],
        ['home', 'b', 100],
        ['t', 'f0'],
        ['b', 'f0', 300],
      ],
      armies: [
        { owner: 'me', at: 'b', units: { rifles: 10 }, retreatAt: 0 },
        { owner: 'me', at: 'home', units: { rifles: 5 } },
        { owner: 'foe', at: 'b', units: { rifles: 10 }, retreatAt: 0 },
      ],
    });
    const x = armyById(sim, a(0))!;
    expect(x.battle).not.toBeNull();
    const before = totalHp(x.units);
    expect(applyCommand(sim, { kind: 'move', nation: n('me'), armies: [a(0), a(1)], to: p('t'), together: true, append: false }, 'player').ok).toBe(true);
    // No disengage cost yet: it waits in the battle.
    expect(totalHp(x.units)).toBe(before);
    expect(x.battle).not.toBeNull();
    const departAt = x.departAt;
    expect(departAt).toBeGreaterThan(sim.state.tick);
    stepUntil(sim, () => x.leg !== null || !x.alive, 200);
    expect(x.alive).toBe(true);
    expect(sim.state.tick - 1).toBe(departAt);
    expect(x.battle).toBeNull();
  });

  it('an army already at the target of an arrive-together order is not frozen', () => {
    const { sim, a, p, n } = tinySim({
      provinces: {
        home: { owner: 'me', capitalOf: 'me' },
        gather: { owner: 'me' },
        far: { owner: 'me' },
        side: { owner: 'me' },
        f0: { owner: 'foe', capitalOf: 'foe' },
      },
      edges: [
        ['home', 'gather', 100],
        ['far', 'gather', 600],
        ['gather', 'side', 100],
        ['far', 'f0', 100],
      ],
      armies: [
        { owner: 'me', at: 'gather', units: { rifles: 4 } },
        { owner: 'me', at: 'far', units: { rifles: 4 } },
      ],
    });
    expect(applyCommand(sim, { kind: 'move', nation: n('me'), armies: [a(0), a(1)], to: p('gather'), together: true, append: false }, 'player').ok).toBe(true);
    expect(armyStatus(sim, armyById(sim, a(0))!)).toBe('idle');
    expect(applyCommand(sim, { kind: 'move', nation: n('me'), armies: [a(0)], to: p('side'), together: false, append: false }, 'player').ok).toBe(true);
  });

  it('a cut-off rally point keeps new units together at home and says so', () => {
    const { sim, p, n } = tinySim({
      provinces: {
        home: { owner: 'me', capitalOf: 'me', buildings: { training: 1 } },
        gap: { owner: 'foe', garrison: 500 },
        ex: { owner: 'me' },
        f0: { owner: 'foe', capitalOf: 'foe' },
      },
      edges: [
        ['home', 'gap'],
        ['gap', 'ex'],
        ['gap', 'f0'],
      ],
      stocks: { me: { funds: 100000, recruits: 100000, food: 100000 }, foe: { funds: 100000, food: 100000 } },
    });
    expect(applyCommand(sim, { kind: 'rally', nation: n('me'), province: p('home'), to: p('ex') }, 'player').ok).toBe(true);
    expect(applyCommand(sim, { kind: 'train', nation: n('me'), province: p('home'), unit: 'rifles', count: 5 }, 'player').ok).toBe(true);
    advance(sim, 4 * 40);
    const mine = sim.state.armies.filter((army) => army.alive && army.owner === n('me'));
    expect(mine).toHaveLength(1);
    expect(mine[0]!.units.rifles.count).toBe(5);
    expect(sim.state.provinces[p('home')]!.rally).toBeNull();
    expect(sim.state.feed.some((e) => e.kind === 'routeBlocked' && e.text.includes('cut off'))).toBe(true);
  });

  it('a recruit whose rally point falls on the way stops instead of attacking it', () => {
    const { sim, p, n } = tinySim({
      provinces: {
        home: { owner: 'me', capitalOf: 'me' },
        m: { owner: 'me' },
        r: { owner: 'me' },
        f0: { owner: 'foe', capitalOf: 'foe' },
      },
      edges: [
        ['home', 'm', 100],
        ['m', 'r', 100],
        ['r', 'f0', 100],
      ],
    });
    const recruit = createArmy(sim, n('me'), p('home'), unitsFromCounts({ rifles: 1 }), 'manual');
    orderRally(sim, recruit, p('r'));
    step(sim);
    setOwner(sim, p('r'), n('foe'));
    sim.state.provinces[p('r')]!.garrison = 40;
    rebuildArmyIndex(sim);
    stepUntil(sim, () => recruit.leg === null && recruit.path.length === 0, 200);
    expect(recruit.at).toBe(p('m'));
    expect(recruit.battle).toBeNull();
    expect(sim.state.stats.attacksLost).toBe(0);
  });
});
