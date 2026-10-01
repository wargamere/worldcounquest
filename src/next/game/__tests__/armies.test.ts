import { describe, expect, it } from 'vitest';
import { COMBAT, ECONOMY, MOVEMENT, SUPPLY } from '../balance';
import {
  armyName,
  armyStatus,
  createArmy,
  disbandArmy,
  hourlyArmies,
  isIdle,
  mergeArmies,
  removeArmy,
  setRetreatAt,
  setStance,
  spawnUnits,
  splitArmy,
  sweepDeadArmies,
  transferArmy,
} from '../armies';
import { armiesAt, armyById } from '../cache';
import { hoursToTicks } from '../clock';
import { refreshSupply } from '../supply';
import type { ArmyId } from '../types';
import { totalHp, unitsFromCounts } from '../units';
import { assertInvariants, tinySim } from './helpers';

function world() {
  return tinySim({
    provinces: {
      home: { owner: 'me', capitalOf: 'me' },
      mid: { owner: 'me' },
      far: { owner: 'foe', capitalOf: 'foe' },
    },
    edges: [
      ['home', 'mid'],
      ['mid', 'far'],
    ],
    armies: [
      { owner: 'me', at: 'home', units: { rifles: 5, guns: 2 } },
      { owner: 'me', at: 'home', units: { rifles: 3, tanks: 1 }, stance: 'delegate', retreatAt: 0.5 },
      { owner: 'me', at: 'mid', units: { rifles: 2 } },
      { owner: 'foe', at: 'far', units: { rifles: 4 } },
    ],
    player: 'me',
  });
}

const ok = (result: { ok: boolean }): void => expect(result).toMatchObject({ ok: true });
const hpSum = (ids: readonly ArmyId[], lookup: (id: ArmyId) => { units: Parameters<typeof totalHp>[0] } | undefined): number =>
  ids.reduce((s, id) => s + totalHp(lookup(id)!.units), 0);

describe('armies', () => {
  it('names armies with ordinals', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111, 112].map(armyName)).toEqual([
      '1st Army',
      '2nd Army',
      '3rd Army',
      '4th Army',
      '11th Army',
      '12th Army',
      '13th Army',
      '21st Army',
      '22nd Army',
      '23rd Army',
      '101st Army',
      '111th Army',
      '112th Army',
    ]);
  });

  it('creates armies with rising ids and names, sorted and indexed', () => {
    const { sim, p, n } = world();
    const first = createArmy(sim, n('me'), p('mid'), unitsFromCounts({ rifles: 1 }), 'manual');
    const second = createArmy(sim, n('me'), p('mid'), unitsFromCounts({ rifles: 1 }), 'defend');
    expect(second.id).toBe(first.id + 1);
    expect(first.name).toBe('4th Army');
    expect(second.name).toBe('5th Army');
    expect(second.post).toBe(p('mid'));
    expect(first.retreatAt).toBe(COMBAT.PLAYER_RETREAT_AT);
    expect(armiesAt(sim, p('mid')).map((a) => a.id)).toEqual([3, first.id, second.id]);
    assertInvariants(sim);
  });

  it('merges co-located armies into the lowest id, conserving HP exactly', () => {
    const { sim, a, n } = world();
    const lookup = (id: ArmyId) => armyById(sim, id);
    const before = hpSum([a(0), a(1)], lookup);
    const result = mergeArmies(sim, n('me'), [a(1), a(0)]);
    expect(result).toEqual({ ok: true, armies: [a(0)] });
    const merged = armyById(sim, a(0))!;
    expect(totalHp(merged.units)).toBe(before);
    expect(merged.units.rifles.count).toBe(8);
    expect(merged.stance).toBe('manual');
    expect(merged.retreatAt).toBe(0.5);
    expect(armyById(sim, a(1))).toBeUndefined();
    assertInvariants(sim);
  });

  it('refuses merges across provinces, on the move, in battle, or of one army', () => {
    const { sim, a, n } = world();
    expect(mergeArmies(sim, n('me'), [a(0), a(2)])).toMatchObject({ ok: false });
    expect(mergeArmies(sim, n('me'), [a(0)])).toMatchObject({ ok: false });
    expect(mergeArmies(sim, n('me'), [a(0), a(3)])).toEqual({ ok: false, reason: 'Not your army' });
    const moving = armyById(sim, a(1))!;
    moving.leg = { from: moving.at, to: moving.at, ticks: 4, done: 1, sea: false };
    expect(mergeArmies(sim, n('me'), [a(0), a(1)])).toMatchObject({ ok: false });
    moving.leg = null;
    moving.battle = { joinedAt: 0, startHp: 10, direction: null };
    expect(mergeArmies(sim, n('me'), [a(0), a(1)])).toMatchObject({ ok: false });
  });

  it('splits whole units with proportional HP, only while idle', () => {
    const { sim, a, n } = world();
    const army = armyById(sim, a(0))!;
    army.units.rifles.hp = 70;
    const before = totalHp(army.units);
    const result = splitArmy(sim, n('me'), a(0), { rifles: 3, guns: 1 });
    ok(result);
    if (!result.ok) return;
    const split = armyById(sim, result.armies[1]!)!;
    expect(split.units.rifles).toEqual({ count: 3, hp: 42 });
    expect(split.units.guns).toEqual({ count: 1, hp: 14 });
    expect(army.units.rifles).toEqual({ count: 2, hp: 28 });
    expect(totalHp(army.units) + totalHp(split.units)).toBe(before);
    expect(split.at).toBe(army.at);
    expect(splitArmy(sim, n('me'), a(0), { rifles: 2, guns: 1 })).toMatchObject({ ok: false });
    expect(splitArmy(sim, n('me'), a(0), {})).toMatchObject({ ok: false });
    expect(splitArmy(sim, n('me'), a(0), { rifles: 9 })).toMatchObject({ ok: false });
    army.path = [army.at];
    expect(splitArmy(sim, n('me'), a(0), { rifles: 1 })).toEqual({ ok: false, reason: 'Only an idle army can split' });
    assertInvariants(sim);
  });

  it('new units join the lowest-id idle army, or form a new one', () => {
    const { sim, a, n, p } = world();
    const joined = spawnUnits(sim, n('me'), p('home'), 'rifles', 2);
    expect(joined.id).toBe(a(0));
    expect(joined.units.rifles.count).toBe(7);
    armyById(sim, a(2))!.path = [p('home')];
    const fresh = spawnUnits(sim, n('me'), p('mid'), 'tanks', 1);
    expect(fresh.id).not.toBe(a(2));
    expect(fresh.name).toBe('4th Army');
    expect(fresh.units.tanks.count).toBe(1);
    assertInvariants(sim);
  });

  it('disbands', () => {
    const { sim, a, n } = world();
    expect(disbandArmy(sim, n('me'), a(2))).toEqual({ ok: true, armies: [] });
    expect(armyById(sim, a(2))).toBeUndefined();
    expect(sim.state.armies.map((x) => x.id)).toEqual([a(0), a(1), a(3)]);
    expect(disbandArmy(sim, n('me'), a(3))).toMatchObject({ ok: false });
    assertInvariants(sim);
  });

  it('reports idle, waiting, moving, fighting and frozen', () => {
    const { sim, a, p } = world();
    const army = armyById(sim, a(0))!;
    expect(armyStatus(sim, army)).toBe('idle');
    expect(isIdle(sim, army)).toBe(true);
    army.path = [p('mid')];
    expect(armyStatus(sim, army)).toBe('moving');
    army.departAt = sim.state.tick + 8;
    expect(armyStatus(sim, army)).toBe('waiting');
    army.path = [];
    expect(armyStatus(sim, army)).toBe('frozen');
    army.departAt = 0;
    army.leg = { from: army.at, to: p('mid'), ticks: 20, done: 3, sea: false };
    expect(armyStatus(sim, army)).toBe('moving');
    army.leg = null;
    army.battle = { joinedAt: 0, startHp: 100, direction: null };
    expect(armyStatus(sim, army)).toBe('fighting');
    expect(isIdle(sim, army)).toBe(false);
  });

  it('sets stances (Defend keeps a post) and retreat thresholds', () => {
    const { sim, a, n, p } = world();
    ok(setStance(sim, n('me'), [a(0), a(2)], 'defend'));
    expect(armyById(sim, a(2))!.post).toBe(p('mid'));
    ok(setStance(sim, n('me'), [a(2)], 'delegate'));
    expect(armyById(sim, a(2))!.post).toBeNull();
    ok(setRetreatAt(sim, n('me'), [a(0)], 0.5));
    expect(armyById(sim, a(0))!.retreatAt).toBe(0.5);
    expect(setRetreatAt(sim, n('me'), [a(0)], 1)).toMatchObject({ ok: false });
    expect(setRetreatAt(sim, n('me'), [a(0)], -0.1)).toMatchObject({ ok: false });
    expect(setStance(sim, n('me'), [a(3)], 'manual')).toMatchObject({ ok: false });
  });

  it('hands an army over at half strength, renamed and frozen', () => {
    const { sim, a, n } = world();
    const army = armyById(sim, a(0))!;
    army.path = [army.at];
    const handed = transferArmy(sim, army, n('foe'), 0.5)!;
    expect(handed.owner).toBe(n('foe'));
    expect(handed.name).toBe('2nd Army');
    expect(handed.units.rifles).toEqual({ count: 3, hp: 50 });
    expect(handed.units.guns).toEqual({ count: 1, hp: 14 });
    expect(handed.path).toEqual([]);
    expect(handed.departAt).toBe(sim.state.tick + hoursToTicks(MOVEMENT.SURRENDER_FREEZE_HOURS));
    expect(armyStatus(sim, handed)).toBe('frozen');
    const tiny = armyById(sim, a(2))!;
    tiny.units.rifles.hp = 0.9;
    expect(transferArmy(sim, tiny, n('foe'), 0.5)).toBeNull();
    expect(tiny.alive).toBe(false);
  });

  it('sweeps dead armies out of the state and the index', () => {
    const { sim, a } = world();
    removeArmy(sim, armyById(sim, a(1))!);
    expect(sim.state.armies).toHaveLength(4);
    sweepDeadArmies(sim);
    expect(sim.state.armies.map((x) => x.id)).toEqual([a(0), a(2), a(3)]);
    assertInvariants(sim);
  });
});

describe('hourlyArmies', () => {
  const damaged = () => {
    const tiny = world();
    refreshSupply(tiny.sim);
    for (const army of tiny.sim.state.armies) army.units.rifles.hp -= 10;
    return tiny;
  };

  it('heals 1.5%/h at home, capped at count × HP', () => {
    const { sim, a } = damaged();
    const army = armyById(sim, a(0))!;
    const before = army.units.rifles.hp;
    hourlyArmies(sim);
    expect(army.units.rifles.hp).toBeCloseTo(before + SUPPLY.HEAL_HOME_PER_HOUR * 100, 9);
    for (let i = 0; i < 50; i += 1) hourlyArmies(sim);
    expect(army.units.rifles.hp).toBe(100);
    expect(army.units.guns.hp).toBe(28);
  });

  it('heals 0.5%/h in the field when supplied, and not at all in battle', () => {
    const { sim, a, p } = damaged();
    const foe = armyById(sim, a(3))!;
    // The foe's own army stands at home; move one of mine into its land, within supply.
    const mine = armyById(sim, a(2))!;
    mine.at = p('far');
    mine.battle = { joinedAt: 0, startHp: 40, direction: p('mid') };
    const before = mine.units.rifles.hp;
    hourlyArmies(sim);
    expect(mine.units.rifles.hp).toBe(before);
    mine.battle = null;
    hourlyArmies(sim);
    expect(mine.units.rifles.hp).toBeCloseTo(before + SUPPLY.HEAL_FIELD_PER_HOUR * 40, 9);
    expect(foe.units.rifles.hp).toBeGreaterThan(70);
  });

  it('out of supply: no healing, 0.5% HP lost per hour', () => {
    const { sim, a, n } = damaged();
    const army = armyById(sim, a(0))!;
    sim.cache.supply[n('me')] = { connected: new Uint8Array(3), supplied: new Uint8Array(3) };
    const before = totalHp(army.units);
    hourlyArmies(sim);
    expect(totalHp(army.units)).toBeCloseTo(before * (1 - SUPPLY.ATTRITION_PER_HOUR), 9);
  });

  it('unpaid and hungry armies lose 3% a day each, and withered armies are removed', () => {
    const { sim, a, n } = damaged();
    const army = armyById(sim, a(0))!;
    sim.state.nations[n('me')]!.shortage.funds = true;
    sim.state.nations[n('me')]!.shortage.food = true;
    const before = totalHp(army.units);
    hourlyArmies(sim);
    const lost = (ECONOMY.UNPAID_ATTRITION_PER_DAY + ECONOMY.HUNGER_ATTRITION_PER_DAY) / 24;
    const expected = before * (1 - lost);
    // Healing then applies on top, to the pools' caps.
    expect(totalHp(army.units)).toBeGreaterThan(expected);
    const weak = armyById(sim, a(2))!;
    weak.units.rifles.hp = 0.5;
    hourlyArmies(sim);
    expect(weak.alive).toBe(false);
    expect(sim.state.feed.some((e) => e.kind === 'armyDestroyed' && e.army === weak.id)).toBe(true);
  });
});
