import { describe, expect, it } from 'vitest';
import {
  armiesAt,
  armiesOf,
  armyById,
  createCache,
  inboundTo,
  indexArmy,
  isContested,
  markIncomeDirty,
  ownedProvinces,
  rebuildArmyIndex,
  setOwner,
  takeEvents,
} from '../cache';
import { asArmy } from '../ids';
import { assertInvariants, tinySim } from './helpers';

function world() {
  return tinySim({
    provinces: {
      a: { owner: 'me', capitalOf: 'me' },
      b: { owner: 'me' },
      c: { owner: 'ai', capitalOf: 'ai' },
      d: { owner: 'ai', garrison: 0 },
    },
    edges: [
      ['a', 'b'],
      ['b', 'c'],
      ['b', 'd'],
      ['c', 'd'],
    ],
    armies: [
      { owner: 'me', at: 'a', units: { rifles: 3 } },
      { owner: 'me', at: 'c', units: { rifles: 2 } },
      { owner: 'me', at: 'd', units: { rifles: 1 } },
      { owner: 'ai', at: 'c', units: { tanks: 1 } },
    ],
  });
}

describe('the sim cache', () => {
  it('indexes provinces, VP and armies from the state', () => {
    const { sim, p, n, a } = world();
    expect(ownedProvinces(sim, n('me'))).toEqual([p('a'), p('b')]);
    expect(ownedProvinces(sim, n('ai'))).toEqual([p('c'), p('d')]);
    expect(sim.cache.vp[n('me')]).toBe(5);
    expect(armiesAt(sim, p('c')).map((x) => x.id)).toEqual([a(1), a(3)]);
    expect(armiesOf(sim, n('me')).map((x) => x.id)).toEqual([a(0), a(1), a(2)]);
    expect(armyById(sim, a(3))?.owner).toBe(n('ai'));
    expect(armyById(sim, asArmy(99))).toBeUndefined();
    assertInvariants(sim);
  });

  it('contests a province only while both sides are present', () => {
    const { sim, p } = world();
    // c: attacker plus garrison and an owner army; d: attacker but an empty garrison and no defender.
    expect(isContested(sim, p('c'))).toBe(true);
    expect(isContested(sim, p('d'))).toBe(false);
    expect(isContested(sim, p('a'))).toBe(false);
    expect(sim.cache.battles).toEqual([p('c')]);
    sim.state.provinces[p('d')]!.garrison = 10;
    rebuildArmyIndex(sim);
    expect(sim.cache.battles).toEqual([p('c'), p('d')]);
  });

  it('counts an army on a leg as inbound, not standing', () => {
    const { sim, p, a } = world();
    const army = armyById(sim, a(0))!;
    army.leg = { from: p('a'), to: p('b'), ticks: 20, done: 3, sea: false };
    rebuildArmyIndex(sim);
    expect(armiesAt(sim, p('a'))).toEqual([]);
    expect(inboundTo(sim, p('b')).map((x) => x.id)).toEqual([a(0)]);
    assertInvariants(sim);
  });

  it('indexes a new army in id order', () => {
    const { sim, p, n } = world();
    const template = sim.state.armies[0]!;
    const fresh = { ...template, id: asArmy(sim.state.nextArmyId), units: { ...template.units }, path: [] };
    sim.state.nextArmyId += 1;
    sim.state.armies.push(fresh);
    const version = sim.cache.armyVersion;
    indexArmy(sim, fresh);
    indexArmy(sim, fresh);
    expect(armiesAt(sim, p('a')).map((x) => x.id)).toEqual([template.id, fresh.id]);
    expect(armiesOf(sim, n('me')).at(-1)).toBe(fresh);
    expect(sim.cache.armyVersion).toBeGreaterThan(version);
    assertInvariants(sim);
  });

  it('setOwner keeps lists, VP, versions and dirty flags in step', () => {
    const { sim, p, n } = world();
    sim.cache.incomeDirty.fill(false);
    sim.cache.supplyDirty.fill(false);
    const version = sim.cache.ownershipVersion;
    setOwner(sim, p('c'), n('me'));
    expect(sim.state.provinces[p('c')]!.owner).toBe(n('me'));
    expect(ownedProvinces(sim, n('me'))).toEqual([p('a'), p('b'), p('c')]);
    expect(ownedProvinces(sim, n('ai'))).toEqual([p('d')]);
    expect(sim.cache.vp[n('me')]).toBe(9);
    expect(sim.cache.vp[n('ai')]).toBe(1);
    expect(sim.cache.ownershipVersion).toBe(version + 1);
    expect(sim.cache.territoryVersion).toEqual([1, 1]);
    expect(sim.cache.supplyDirty).toEqual([true, true]);
    expect(sim.cache.incomeDirty).toEqual([true, true]);
    setOwner(sim, p('c'), n('me'));
    expect(sim.cache.ownershipVersion).toBe(version + 1);
    const fresh = createCache(sim.map, sim.state, false);
    expect(fresh.nationProvinces).toEqual(sim.cache.nationProvinces);
    expect(fresh.vp).toEqual(sim.cache.vp);
  });

  it('hands out events once', () => {
    const { sim, p, n } = world();
    setOwner(sim, p('d'), n('me'));
    markIncomeDirty(sim, n('ai'));
    const events = takeEvents(sim);
    expect(events.ownershipChanged).toEqual([p('d')]);
    expect(takeEvents(sim)).toEqual({ ticks: 0, feed: [], ownershipChanged: [], alerts: [], statusChanged: false });
  });

  it('records commands only when asked', () => {
    const { sim } = world();
    expect(sim.cache.commandLog).toEqual([]);
    expect(createCache(sim.map, sim.state, false).commandLog).toBeNull();
  });
});
