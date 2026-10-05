import { describe, expect, it } from 'vitest';
import { ECONOMY, MOVEMENT } from '../balance';
import { armyStatus } from '../armies';
import { armyById, rebuildArmyIndex, setOwner } from '../cache';
import { hoursToTicks } from '../clock';
import { battleInputAt } from '../combat';
import {
  etaTicks,
  onOilShortageChanged,
  orderMove,
  orderRally,
  planOrder,
  retreatArmies,
  retreatTarget,
  stopArmies,
} from '../movement';
import { createArmy } from '../armies';
import { asProvince } from '../ids';
import { totalHp, unitsFromCounts } from '../units';
import { assertInvariants, tinySim } from './helpers';
import { step, steps, stepUntil } from './steps';

const ok = (result: { ok: boolean }): void => expect(result).toMatchObject({ ok: true });

/** home - m1 (hills) - m2 (mountains) - t (foe), plus side roads into t from w and e. */
function march() {
  return tinySim({
    provinces: {
      home: { owner: 'me', capitalOf: 'me' },
      m1: { owner: 'me', terrain: 'hills' },
      m2: { owner: 'me', terrain: 'mountains' },
      w: { owner: 'me' },
      e: { owner: 'me' },
      t: { owner: 'foe', garrison: 200 },
      f0: { owner: 'foe', capitalOf: 'foe' },
    },
    edges: [
      ['home', 'm1', 150],
      ['m1', 'm2', 120],
      ['m2', 't', 90],
      ['home', 'w', 60],
      ['w', 't', 300],
      ['home', 'e', 250],
      ['e', 't', 40],
      ['t', 'f0'],
    ],
    armies: [
      { owner: 'me', at: 'home', units: { rifles: 6 } },
      { owner: 'me', at: 'w', units: { tanks: 2 } },
      { owner: 'me', at: 'e', units: { rifles: 2, guns: 2 } },
      { owner: 'me', at: 'm1', units: { rifles: 3 } },
    ],
    player: 'me',
  });
}

describe('orders and marching', () => {
  it('arrives exactly when the ETA says', () => {
    const { sim, a, p, n } = march();
    ok(orderMove(sim, n('me'), [a(0)], p('m2'), false, false));
    const army = armyById(sim, a(0))!;
    const eta = etaTicks(sim, army)!;
    expect(eta).toBeGreaterThan(1);
    steps(sim, eta - 1);
    expect(army.leg).not.toBeNull();
    step(sim);
    expect(army.leg).toBeNull();
    expect(army.at).toBe(p('m2'));
    expect(armyStatus(sim, army)).toBe('idle');
    expect(etaTicks(sim, army)).toBeNull();
    assertInvariants(sim);
  });

  it('three armies from three provinces, arriving together, enter the target in the same tick', () => {
    const { sim, a, p, n } = march();
    const ids = [a(1), a(2), a(3)];
    const plans = planOrder(sim, n('me'), ids, p('t'), true);
    if (typeof plans === 'string') throw new Error(plans);
    const etas = plans.map((plan) => plan.departAt - sim.state.tick + plan.path.ticks);
    expect(new Set(etas).size).toBe(1);
    expect(plans.filter((plan) => plan.departAt > sim.state.tick).length).toBeGreaterThanOrEqual(2);
    ok(orderMove(sim, n('me'), ids, p('t'), true, false));
    expect(armyStatus(sim, armyById(sim, a(3))!)).toMatch(/waiting|moving/);
    steps(sim, etas[0]!);
    const armies = ids.map((id) => armyById(sim, id)!);
    for (const army of armies) {
      expect(army.at).toBe(p('t'));
      expect(army.battle?.joinedAt).toBe(sim.state.tick - 1);
    }
    expect(new Set(armies.map((army) => army.battle!.direction)).size).toBe(3);
    expect(battleInputAt(sim, p('t'))!.attackers[0]!.directions).toBe(3);
    assertInvariants(sim);
  });

  it('without arrive-together, each army leaves at once', () => {
    const { sim, a, p, n } = march();
    const plans = planOrder(sim, n('me'), [a(1), a(2)], p('t'), false);
    if (typeof plans === 'string') throw new Error(plans);
    for (const plan of plans) expect(plan.departAt).toBe(sim.state.tick);
  });

  it('co-located idle armies march as one', () => {
    const { sim, a, p, n } = march();
    const extra = createArmy(sim, n('me'), p('home'), unitsFromCounts({ guns: 1 }), 'manual');
    const plans = planOrder(sim, n('me'), [a(0), extra.id], p('m2'), true);
    if (typeof plans === 'string') throw new Error(plans);
    expect(plans).toHaveLength(2);
    expect(plans[0]!.path).toEqual(plans[1]!.path);
    // One group: nothing to wait for.
    expect(plans[0]!.departAt).toBe(sim.state.tick);
    const result = orderMove(sim, n('me'), [a(0), extra.id], p('m2'), true, false);
    expect(result).toEqual({ ok: true, armies: [a(0)] });
    const merged = armyById(sim, a(0))!;
    expect(merged.units.guns.count).toBe(1);
    expect(armyById(sim, extra.id)).toBeUndefined();
    expect(merged.path).toEqual(plans[0]!.path.nodes);
    assertInvariants(sim);
  });

  it('a waypoint appends a route from the end of the current one', () => {
    const { sim, a, p, n } = march();
    ok(orderMove(sim, n('me'), [a(0)], p('m1'), false, false));
    ok(orderMove(sim, n('me'), [a(0)], p('w'), false, true));
    expect(armyById(sim, a(0))!.path).toEqual([p('m1'), p('home'), p('w')]);
  });

  it('refuses frozen armies, foreign armies and unknown provinces', () => {
    const { sim, a, p, n } = march();
    const army = armyById(sim, a(0))!;
    army.departAt = sim.state.tick + 10;
    expect(orderMove(sim, n('me'), [a(0)], p('m1'), false, false)).toMatchObject({ ok: false });
    expect(orderMove(sim, n('foe'), [a(1)], p('m1'), false, false)).toEqual({ ok: false, reason: 'Not your army' });
    expect(planOrder(sim, n('me'), [a(1)], asProvince(99), false)).toBe('No such province');
  });

  it('an own-land order with no own route falls back to an attack route', () => {
    const { sim, p, n, a } = tinySim({
      provinces: { home: { owner: 'me' }, gap: { owner: 'foe', garrison: 0 }, exclave: { owner: 'me' } },
      edges: [
        ['home', 'gap'],
        ['gap', 'exclave'],
      ],
      armies: [{ owner: 'me', at: 'home', units: { rifles: 2 } }],
      player: 'me',
    });
    const plans = planOrder(sim, n('me'), [a(0)], p('exclave'), false);
    if (typeof plans === 'string') throw new Error(plans);
    expect(plans[0]!.path.nodes).toEqual([p('gap'), p('exclave')]);
    expect(plans[0]!.path.hostile).toBe(1);
    ok(orderMove(sim, n('me'), [a(0)], p('exclave'), false, false));
    expect(armyById(sim, a(0))!.intent).toBe('attack');
  });

  it('Stop turns back under half a leg and finishes the leg past it', () => {
    const { sim, a, p, n } = march();
    ok(orderMove(sim, n('me'), [a(0)], p('m2'), false, false));
    const army = armyById(sim, a(0))!;
    steps(sim, 3);
    const leg = army.leg!;
    expect(leg.done * 2).toBeLessThan(leg.ticks);
    const done = leg.done;
    ok(stopArmies(sim, n('me'), [a(0)]));
    expect(army.path).toEqual([]);
    expect(army.leg).toMatchObject({ from: p('m1'), to: p('home'), done: leg.ticks - done });
    expect(army.at).toBe(p('m1'));
    assertInvariants(sim);
    steps(sim, done);
    expect(army.at).toBe(p('home'));
    expect(army.leg).toBeNull();

    ok(orderMove(sim, n('me'), [a(0)], p('m2'), false, false));
    const ticks = etaTicks(sim, army)!;
    stepUntil(sim, () => army.leg !== null && army.leg.done * 2 >= army.leg.ticks, ticks);
    ok(stopArmies(sim, n('me'), [a(0)]));
    stepUntil(sim, () => army.leg === null, ticks);
    expect(army.at).toBe(p('m1'));
    expect(army.path).toEqual([]);
  });

  it('Stop releases a waiting army at once', () => {
    const { sim, a, p, n } = march();
    ok(orderMove(sim, n('me'), [a(1), a(2)], p('t'), true, false));
    const waiting = [a(1), a(2)].map((id) => armyById(sim, id)!).find((army) => armyStatus(sim, army) === 'waiting')!;
    ok(stopArmies(sim, n('me'), [waiting.id]));
    expect(armyStatus(sim, waiting)).toBe('idle');
  });

  it('leaving a battle costs 10% of current HP', () => {
    const { sim, a, p, n } = march();
    const army = armyById(sim, a(3))!;
    army.at = p('t');
    army.battle = { joinedAt: 0, startHp: 60, direction: p('m2') };
    rebuildArmyIndex(sim);
    expect(sim.cache.battles).toEqual([p('t')]);
    const before = totalHp(army.units);
    ok(orderMove(sim, n('me'), [a(3)], p('m2'), false, false));
    expect(totalHp(army.units)).toBeCloseTo(before * (1 - MOVEMENT.DISENGAGE_HP_LOSS), 9);
    expect(army.battle).toBeNull();
    step(sim);
    expect(army.leg?.to).toBe(p('m2'));
  });

  it('a sea crossing into hostile land sets the landing penalty', () => {
    const { sim, a, p, n } = tinySim({
      provinces: { port: { owner: 'me' }, shore: { owner: 'foe', garrison: 50 }, f: { owner: 'foe' } },
      edges: [
        ['port', 'shore', 100, 'sea'],
        ['shore', 'f'],
      ],
      armies: [{ owner: 'me', at: 'port', units: { rifles: 8 } }],
      player: 'me',
    });
    ok(orderMove(sim, n('me'), [a(0)], p('shore'), false, false));
    const army = armyById(sim, a(0))!;
    const eta = etaTicks(sim, army)!;
    expect(eta).toBe(((100 + MOVEMENT.SEA_EMBARK_KM) / MOVEMENT.SEA_KMH) * 4);
    steps(sim, eta);
    expect(army.at).toBe(p('shore'));
    expect(army.landingUntil).toBe(sim.state.tick - 1 + hoursToTicks(MOVEMENT.LANDING_HOURS));
    expect(battleInputAt(sim, p('shore'))!.attackers[0]!.landed.rifles).toBeGreaterThan(0);
  });

  it('re-routes when the next province turns hostile, and stops when no route is left', () => {
    const { sim, a, p, n } = tinySim({
      provinces: { a: { owner: 'me' }, b: { owner: 'me' }, c: { owner: 'me' }, d: { owner: 'me' }, z: { owner: 'foe' } },
      edges: [
        ['a', 'b', 50],
        ['b', 'd', 50],
        ['a', 'c', 100],
        ['c', 'd', 100],
        ['c', 'z'],
      ],
      armies: [{ owner: 'me', at: 'a', units: { rifles: 1 } }],
      player: 'me',
    });
    ok(orderMove(sim, n('me'), [a(0)], p('d'), false, false));
    const army = armyById(sim, a(0))!;
    expect(army.path).toEqual([p('b'), p('d')]);
    setOwner(sim, p('b'), n('foe'));
    step(sim);
    expect(army.leg?.to).toBe(p('c'));
    stepUntil(sim, () => army.leg === null, 100);
    expect(army.at).toBe(p('c'));
    // Now every own route out of c is cut: the way back to b runs only through foe land.
    setOwner(sim, p('d'), n('foe'));
    setOwner(sim, p('a'), n('foe'));
    army.path = [p('a'), p('b')];
    step(sim);
    expect(army.path).toEqual([]);
    expect(army.leg).toBeNull();
    expect(sim.state.feed[0]).toMatchObject({ kind: 'routeBlocked', army: army.id });
  });

  it('walks into an undefended province; the next arrival attacks the new owner', () => {
    const { sim, a, p, n } = tinySim({
      provinces: { me1: { owner: 'me' }, x1: { owner: 'xx' }, t: { owner: 'foe', garrison: 0 }, f: { owner: 'foe' } },
      edges: [
        ['me1', 't'],
        ['x1', 't'],
        ['t', 'f'],
      ],
      armies: [
        { owner: 'me', at: 'me1', units: { rifles: 2 } },
        { owner: 'xx', at: 'x1', units: { rifles: 2 } },
      ],
      player: 'me',
    });
    ok(orderMove(sim, n('me'), [a(0)], p('t'), false, false));
    ok(orderMove(sim, n('xx'), [a(1)], p('t'), false, false));
    steps(sim, etaTicks(sim, armyById(sim, a(0))!)!);
    expect(sim.state.provinces[p('t')]!.owner).toBe(n('me'));
    expect(sim.state.stats.provincesCaptured).toBe(1);
    const theirs = armyById(sim, a(1))!;
    expect(theirs.battle).not.toBeNull();
    expect(armyById(sim, a(0))!.battle).not.toBeNull();
    expect(sim.cache.battles).toEqual([p('t')]);
    assertInvariants(sim);
  });

  it('an attacker with a path continues once the province is taken', () => {
    const { sim, a, p, n } = tinySim({
      provinces: { me1: { owner: 'me' }, t: { owner: 'foe', garrison: 1 }, beyond: { owner: 'foe', garrison: 0 }, f: { owner: 'foe' } },
      edges: [
        ['me1', 't'],
        ['t', 'beyond'],
        ['beyond', 'f'],
      ],
      armies: [{ owner: 'me', at: 'me1', units: { rifles: 6 } }],
      player: 'me',
    });
    ok(orderMove(sim, n('me'), [a(0)], p('beyond'), false, false));
    const army = armyById(sim, a(0))!;
    stepUntil(sim, () => army.battle !== null, 200);
    expect(army.at).toBe(p('t'));
    expect(army.path).toEqual([p('beyond')]);
    stepUntil(sim, () => army.leg !== null, 50);
    expect(sim.state.provinces[p('t')]!.owner).toBe(n('me'));
    expect(army.leg?.to).toBe(p('beyond'));
    stepUntil(sim, () => army.leg === null, 200);
    expect(sim.state.provinces[p('beyond')]!.owner).toBe(n('me'));
  });

  it('retreats to where it came from, or to the best-defended safe neighbour', () => {
    const { sim, a, p, n } = march();
    const army = armyById(sim, a(3))!;
    army.at = p('t');
    army.cameFrom = p('m2');
    army.battle = { joinedAt: 0, startHp: 60, direction: p('m2') };
    rebuildArmyIndex(sim);
    expect(retreatTarget(sim, army)).toBe(p('m2'));
    army.cameFrom = null;
    // w holds 2 Tanks (72 HP), e 2 Rifles + 2 Guns (68 HP): same garrison, so w wins.
    expect(retreatTarget(sim, army)).toBe(p('w'));
    const before = totalHp(army.units);
    ok(retreatArmies(sim, n('me'), [a(3)], null));
    expect(army.intent).toBe('retreat');
    expect(army.path).toEqual([p('w')]);
    expect(totalHp(army.units)).toBeCloseTo(before * 0.9, 9);
    const idle = armyById(sim, a(0))!;
    ok(retreatArmies(sim, n('me'), [a(0)], p('m2')));
    expect(idle.path).toEqual([p('m1'), p('m2')]);
    expect(totalHp(idle.units)).toBe(120);
    expect(retreatArmies(sim, n('me'), [a(0)], p('home'))).toMatchObject({ ok: false });
  });

  it('re-times moving Oil users when the Oil shortage flag flips', () => {
    const { sim, a, p, n } = march();
    ok(orderMove(sim, n('me'), [a(1)], p('home'), false, false));
    step(sim);
    const leg = armyById(sim, a(1))!.leg!;
    const { ticks, done } = leg;
    onOilShortageChanged(sim, n('me'), 1, ECONOMY.OIL_SHORT_SPEED);
    expect(leg.ticks).toBe(done + Math.ceil((ticks - done) * 2));
    onOilShortageChanged(sim, n('me'), ECONOMY.OIL_SHORT_SPEED, 1);
    expect(leg.ticks).toBe(done + Math.ceil(((ticks - done) * 2) / 2));
    const rifles = armyById(sim, a(0))!;
    ok(orderMove(sim, n('me'), [a(0)], p('m1'), false, false));
    step(sim);
    const riflesTicks = rifles.leg!.ticks;
    onOilShortageChanged(sim, n('me'), 1, ECONOMY.OIL_SHORT_SPEED);
    expect(rifles.leg!.ticks).toBe(riflesTicks);
  });

  it('a rally army marches over own land and merges into the idle army there', () => {
    const { sim, a, p, n } = march();
    const recruit = createArmy(sim, n('me'), p('home'), unitsFromCounts({ rifles: 1 }), 'manual');
    orderRally(sim, recruit, p('m1'));
    expect(recruit.intent).toBe('rally');
    expect(recruit.path).toEqual([p('m1')]);
    steps(sim, etaTicks(sim, recruit)!);
    expect(recruit.alive).toBe(false);
    expect(armyById(sim, a(3))!.units.rifles.count).toBe(4);
    assertInvariants(sim);
  });

  it('counts the wait of an arrive-together army in its ETA', () => {
    const { sim, a, p, n } = march();
    ok(orderMove(sim, n('me'), [a(1), a(2)], p('t'), true, false));
    const etas = [a(1), a(2)].map((id) => etaTicks(sim, armyById(sim, id)!));
    expect(etas[0]).toBe(etas[1]);
  });
});
