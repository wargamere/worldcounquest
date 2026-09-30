import { describe, expect, it } from 'vitest';
import { CAPITAL, MOVEMENT, PROVINCE, REVOLT, TIME } from '../balance';
import { armyStatus, sweepDeadArmies } from '../armies';
import { armyById, rebuildArmyIndex } from '../cache';
import { hoursToTicks } from '../clock';
import { capitulatesOnCapture, captureProvince, relocatePlayerCapital, revertProvince, tryWalkIn } from '../capture';
import { garrisonCap, statusOf } from '../province';
import { assertInvariants, tinySim, type TinyArmy } from './helpers';

/** me (player) next to foe, whose capital fc borders my land; x is a bystander. */
function empire(extra: TinyArmy[] = []) {
  return tinySim({
    provinces: {
      home: { owner: 'me', capitalOf: 'me', population: 3_000_000 },
      lyon: { owner: 'me', population: 2_000_000 },
      fc: { owner: 'foe', capitalOf: 'foe', buildings: { ramparts: 1, works: 1, training: 2 } },
      f1: { owner: 'foe', buildings: { works: 2 } },
      f2: { owner: 'foe' },
      x: { owner: 'xx', capitalOf: 'xx' },
    },
    edges: [
      ['home', 'lyon'],
      ['home', 'fc'],
      ['fc', 'f1'],
      ['f1', 'f2'],
      ['f2', 'x'],
      ['lyon', 'x'],
    ],
    armies: [
      { owner: 'foe', at: 'f1', units: { rifles: 5, tanks: 1 } },
      { owner: 'foe', at: 'f2', units: { rifles: 2 } },
      { owner: 'foe', at: 'lyon', units: { rifles: 3 } },
      { owner: 'me', at: 'home', units: { rifles: 4 } },
      ...extra,
    ],
    player: 'me',
    stocks: { foe: { funds: 1000, recruits: 5000, food: 200, steel: 80, oil: 40 }, me: { funds: 100 } },
  });
}

describe('captureProvince', () => {
  it('resets the province: stability 25, garrison 0, Works and Ramparts −1, queue gone', () => {
    const { sim, p, n } = empire();
    const f1 = sim.state.provinces[p('f1')]!;
    f1.queue.push({ unit: 'rifles', hoursLeft: 3, hoursTotal: 6, paid: {}, started: true });
    captureProvince(sim, p('f1'), n('me'));
    expect(f1.owner).toBe(n('me'));
    expect(f1.stability).toBe(PROVINCE.STABILITY_ON_CAPTURE);
    expect(f1.garrison).toBe(0);
    expect(f1.buildings.works).toBe(1);
    expect(f1.queue).toEqual([]);
    expect(statusOf(sim, p('f1'))).toBe('occupied');
    expect(sim.state.nations[n('foe')]!.ai.provoked).toBe(true);
    expect(sim.state.stats.provincesCaptured).toBe(1);
    expect(sim.cache.events.ownershipChanged).toEqual([p('f1')]);
  });

  it('liberation makes a province Home again at stability 60', () => {
    const { sim, p, n } = empire();
    captureProvince(sim, p('lyon'), n('foe'));
    expect(statusOf(sim, p('lyon'))).toBe('occupied');
    expect(sim.state.stats.provincesLost).toBe(1);
    captureProvince(sim, p('lyon'), n('me'));
    expect(statusOf(sim, p('lyon'))).toBe('home');
    expect(sim.state.provinces[p('lyon')]!.stability).toBe(PROVINCE.STABILITY_ON_LIBERATION);
  });

  it('only an AI nation’s own, current, original capital capitulates it', () => {
    const { sim, p, n } = empire();
    expect(capitulatesOnCapture(sim, p('fc'))).toBe(true);
    expect(capitulatesOnCapture(sim, p('f1'))).toBe(false);
    expect(capitulatesOnCapture(sim, p('home'))).toBe(false);
    sim.state.nations[n('foe')]!.capital = null;
    expect(capitulatesOnCapture(sim, p('fc'))).toBe(false);
  });

  it('a walk-in needs an empty garrison and no owner army', () => {
    const { sim, p, n, a } = empire();
    const mine = armyById(sim, a(3))!;
    mine.at = p('f2');
    rebuildArmyIndex(sim);
    expect(tryWalkIn(sim, mine)).toBe(false);
    armyById(sim, a(1))!.at = p('f1');
    rebuildArmyIndex(sim);
    expect(tryWalkIn(sim, mine)).toBe(false);
    sim.state.provinces[p('f2')]!.garrison = 0.4;
    expect(tryWalkIn(sim, mine)).toBe(true);
    expect(sim.state.provinces[p('f2')]!.owner).toBe(n('me'));
  });
});

describe('capitulation', () => {
  it('hands over land, half the armies at home (frozen), half the stocks, and ends the loser', () => {
    const { sim, p, n, a } = empire();
    const foe = n('foe');
    const me = n('me');
    // One foe army is on the road, another abroad in my land.
    const onLeg = armyById(sim, a(1))!;
    onLeg.leg = { from: p('f2'), to: p('x'), ticks: 10, done: 2, sea: false };
    rebuildArmyIndex(sim);
    const garrisonF1 = sim.state.provinces[p('f1')]!.garrison;
    sim.state.provinces[p('f2')]!.queue.push({ unit: 'rifles', hoursLeft: 3, hoursTotal: 6, paid: {}, started: true });
    const myFunds = sim.state.nations[me]!.stocks.funds;
    captureProvince(sim, p('fc'), me);

    for (const key of ['fc', 'f1', 'f2']) expect(sim.state.provinces[p(key)]!.owner).toBe(me);
    const f1 = sim.state.provinces[p('f1')]!;
    expect(f1.garrison).toBeCloseTo(garrisonF1 * CAPITAL.GARRISON_KEPT, 9);
    expect(f1.stability).toBe(PROVINCE.STABILITY_ON_SURRENDER);
    expect(f1.graceUntil).toBe(sim.state.tick + REVOLT.SURRENDER_GRACE_DAYS * TIME.TICKS_PER_DAY);
    expect(f1.buildings.works).toBe(2);
    expect(sim.state.provinces[p('f2')]!.queue).toEqual([]);
    // The captured capital itself was taken, not handed over: capture damage applies there.
    expect(sim.state.provinces[p('fc')]!.buildings.ramparts).toBe(0);

    const joined = armyById(sim, a(0))!;
    expect(joined.owner).toBe(me);
    expect(joined.units.rifles).toEqual({ count: 3, hp: 50 });
    expect(joined.units.tanks).toEqual({ count: 1, hp: 18 });
    expect(joined.stance).toBe('manual');
    expect(joined.departAt).toBe(sim.state.tick + hoursToTicks(MOVEMENT.SURRENDER_FREEZE_HOURS));
    expect(armyStatus(sim, joined)).toBe('frozen');
    expect(onLeg.alive).toBe(false);
    expect(armyById(sim, a(2))).toBeUndefined();

    const loser = sim.state.nations[foe]!;
    expect(loser.alive).toBe(false);
    expect(loser.eliminatedAt).toBe(sim.state.tick);
    expect(sim.state.nations[me]!.stocks).toMatchObject({ funds: myFunds + 500, food: 100, steel: 40, oil: 20, recruits: 0 });
    expect(sim.state.surrenders).toEqual([{ loser: foe, winner: me, tick: 0, provinces: 3, vp: sim.map.provinces[p('fc')]!.vp + 2, units: 4 }]);
    expect(sim.state.feed.some((e) => e.kind === 'capitulation')).toBe(true);
    sweepDeadArmies(sim);
    assertInvariants(sim);
  });

  it('a surrendered province mid-battle keeps fighting with the winner as defender', () => {
    // An xx army attacks f2, which the foe's army there defends.
    const { sim, p, n } = empire([{ owner: 'xx', at: 'f2', units: { rifles: 6 } }]);
    expect(sim.cache.battles).toContain(p('f2'));
    captureProvince(sim, p('fc'), n('me'));
    expect(sim.state.provinces[p('f2')]!.owner).toBe(n('me'));
    expect(sim.state.provinces[p('f2')]!.battleSince).toBe(0);
    expect(sim.cache.battles).toContain(p('f2'));
  });
});

describe('elimination and the player', () => {
  it('a nation left with no provinces is eliminated and its armies disband', () => {
    const { sim, p, n, a } = tinySim({
      provinces: {
        home: { owner: 'me', capitalOf: 'me' },
        // rump's capital is held by xx, so it has no seat and cannot capitulate.
        rc: { owner: 'xx', capitalOf: 'rump' },
        r1: { owner: 'rump', country: 'rump' },
        x: { owner: 'xx', capitalOf: 'xx' },
      },
      edges: [
        ['home', 'r1'],
        ['r1', 'rc'],
        ['rc', 'x'],
      ],
      armies: [{ owner: 'rump', at: 'x', units: { rifles: 2 } }],
      player: 'me',
    });
    expect(sim.state.nations[n('rump')]!.capital).toBeNull();
    captureProvince(sim, p('r1'), n('me'));
    expect(sim.state.nations[n('rump')]!.alive).toBe(false);
    expect(armyById(sim, a(0))!.alive).toBe(false);
    expect(sim.state.feed.some((e) => e.kind === 'eliminated')).toBe(true);
  });

  it('a one-province nation capitulates when its capital falls', () => {
    const { sim, p, n } = tinySim({
      provinces: { home: { owner: 'me', capitalOf: 'me' }, solo: { owner: 'solo', capitalOf: 'solo' } },
      edges: [['home', 'solo']],
      player: 'me',
    });
    captureProvince(sim, p('solo'), n('me'));
    expect(sim.state.nations[n('solo')]!.alive).toBe(false);
    expect(sim.state.surrenders).toHaveLength(1);
  });

  it('the player never capitulates: the capital moves to the most populous uncontested home province', () => {
    const { sim, p, n } = tinySim({
      provinces: {
        paris: { owner: 'me', capitalOf: 'me', population: 5_000_000 },
        lille: { owner: 'me', population: 3_000_000 },
        lyon: { owner: 'me', population: 2_000_000 },
        conquest: { owner: 'me', country: 'foe', population: 9_000_000 },
        berlin: { owner: 'foe', capitalOf: 'foe' },
      },
      edges: [
        ['paris', 'lille'],
        ['paris', 'lyon'],
        ['paris', 'berlin'],
        ['lille', 'conquest'],
        ['conquest', 'berlin'],
      ],
      armies: [{ owner: 'foe', at: 'lille', units: { rifles: 3 } }],
      player: 'me',
    });
    expect(sim.cache.battles).toEqual([p('lille')]);
    captureProvince(sim, p('paris'), n('foe'));
    const me = sim.state.nations[n('me')]!;
    expect(me.alive).toBe(true);
    expect(me.capital).toBe(p('lyon'));
    expect(sim.state.provinces[p('lyon')]!.stability).toBe(100 + PROVINCE.STABILITY_RELOCATION);
    expect(sim.state.provinces[p('lille')]!.stability).toBe(100 + PROVINCE.STABILITY_RELOCATION);
    expect(sim.state.provinces[p('conquest')]!.stability).toBe(100);
    expect(sim.state.provinces[p('conquest')]!.owner).toBe(n('me'));
    expect(sim.state.stats.capitalMoves).toBe(1);
    expect(sim.state.feed.some((e) => e.kind === 'capitalMoved' && e.province === p('lyon'))).toBe(true);
    expect(sim.state.surrenders).toEqual([]);
    // With no home province left, the most populous one held.
    captureProvince(sim, p('lyon'), n('foe'));
    captureProvince(sim, p('lille'), n('foe'));
    expect(me.capital).toBe(p('conquest'));
    relocatePlayerCapital(sim);
    expect(me.capital).toBe(p('conquest'));
  });
});

describe('revertProvince', () => {
  it('returns an occupied province to its living original nation, half garrisoned', () => {
    const { sim, p, n } = tinySim({
      provinces: {
        home: { owner: 'me', capitalOf: 'me' },
        taken: { owner: 'me', country: 'foe', stability: 10 },
        fc: { owner: 'foe', capitalOf: 'foe' },
      },
      edges: [
        ['home', 'taken'],
        ['taken', 'fc'],
      ],
      player: 'me',
    });
    sim.state.provinces[p('taken')]!.queue.push({ unit: 'rifles', hoursLeft: 3, hoursTotal: 6, paid: {}, started: true });
    revertProvince(sim, p('taken'));
    const province = sim.state.provinces[p('taken')]!;
    expect(province.owner).toBe(n('foe'));
    expect(statusOf(sim, p('taken'))).toBe('home');
    expect(province.stability).toBe(REVOLT.STABILITY_AFTER);
    expect(province.garrison).toBeCloseTo(REVOLT.GARRISON_SHARE * garrisonCap(sim, p('taken')), 9);
    expect(province.queue).toEqual([]);
    expect(sim.state.stats.revoltsSuffered).toBe(1);
    expect(sim.state.feed[0]!.kind).toBe('revolt');
    // Nothing happens to a province already home, or whose nation is gone.
    revertProvince(sim, p('taken'));
    expect(sim.state.stats.revoltsSuffered).toBe(1);
  });
});
