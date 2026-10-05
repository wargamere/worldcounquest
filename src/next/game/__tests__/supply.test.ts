import { describe, expect, it } from 'vitest';
import { createCache, setOwner } from '../cache';
import { asArmy, asProvince } from '../ids';
import { defaultTradePolicy, emptyStats, noBuildings, noShortage, zeroGoods, zeroStocks, zeroUnits } from '../keys';
import { computeSupply, computeVision, isArmyVisible, isConnected, isSupplied, refreshSupply, refreshVision } from '../supply';
import type { Army, GameState, Leg, NationIx, ProvinceFact, ProvinceIx, Sim } from '../types';
import { buildMap } from '../world';

/**
 * A line-and-branch world built from facts, so the tests exercise the real
 * buildMap and cache. Each province's original country is its key's prefix
 * (`a1` belongs to country `a`); `owner` may differ, to model conquests.
 */
interface Spot {
  owner: string;
  capital?: boolean;
  training?: number;
  areaKm2?: number;
}
interface Troop {
  owner: string;
  at: string;
  to?: string;
}

function world(spec: { provinces: Record<string, Spot>; edges: [string, string][]; player: string; armies?: Troop[] }) {
  const keys = Object.keys(spec.provinces);
  const country = (key: string): string => key.replace(/\d+$/, '');
  const countries = [...new Set(keys.map(country))].sort();
  const linked = (key: string): string[] =>
    spec.edges.flatMap(([a, b]) => (a === key ? [b] : b === key ? [a] : [])).sort();
  const facts: ProvinceFact[] = keys.map((key) => {
    const own = keys.filter((k) => country(k) === country(key));
    const capital = own.find((k) => spec.provinces[k]?.capital === true) ?? own[0];
    const neighbours = linked(key);
    return {
      id: key,
      name: key,
      countryId: country(key),
      population: 1_000_000,
      areaKm2: spec.provinces[key]?.areaKm2 ?? 10_000,
      city: null,
      capital: key === capital,
      anchor: [0, 0],
      xyz: [1, 0, 0],
      terrain: 'plains',
      good: 'food',
      oilField: false,
      neighbours,
      edgeKm: neighbours.map(() => 100),
      sea: neighbours.map(() => false),
    };
  });
  const map = buildMap(
    { source: 'test', format: 2, version: 'test', provinces: facts },
    countries.map((id) => ({ id, name: id, population: 1_000_000 * keys.filter((k) => country(k) === id).length, economyTier: 3 })),
  );
  const n = (id: string): NationIx => {
    const ix = map.nationById.get(id);
    if (ix === undefined) throw new Error(`no nation ${id}`);
    return ix;
  };
  const p = (key: string): ProvinceIx => {
    const ix = map.provinceById.get(key);
    if (ix === undefined) throw new Error(`no province ${key}`);
    return ix;
  };
  const armies: Army[] = (spec.armies ?? []).map((t, i) => {
    const leg: Leg | null = t.to === undefined ? null : { from: p(t.at), to: p(t.to), ticks: 4, done: 1, sea: false };
    const units = zeroUnits();
    units.rifles = { count: 1, hp: 100 };
    return {
      id: asArmy(i + 1),
      owner: n(t.owner),
      name: `Army ${i + 1}`,
      units,
      at: p(t.at),
      leg,
      path: [],
      departAt: 0,
      intent: 'move',
      stance: 'manual',
      post: null,
      retreatAt: 0,
      battle: null,
      cameFrom: null,
      landingUntil: 0,
      orderedAt: 0,
      alive: true,
    };
  });
  const state: GameState = {
    format: 5,
    seed: 'supply',
    tick: 0,
    rng: 1,
    difficulty: 'standard',
    player: n(spec.player),
    status: 'playing',
    endedAt: null,
    sandbox: false,
    provinces: map.provinces.map((s) => {
      const buildings = noBuildings();
      buildings.training = spec.provinces[s.id]?.training ?? 0;
      return {
        owner: n(spec.provinces[s.id]?.owner ?? ''),
        garrison: 0,
        stability: 100,
        heldSince: 0,
        integrated: false,
        buildings,
        construction: null,
        queue: [],
        keepTraining: false,
        rally: null,
        battleSince: null,
        graceUntil: 0,
      };
    }),
    nations: map.nations.map((s) => ({
      ix: s.ix,
      alive: true,
      isPlayer: s.id === spec.player,
      tier: 'minor',
      colour: '#888888',
      stocks: zeroStocks(),
      capital: s.capital,
      shortage: noShortage(),
      trade: defaultTradePolicy(s.id === spec.player),
      armySerial: 0,
      ai: { nextThink: 0, alertAt: null, provoked: false, operations: [] },
      eliminatedAt: null,
    })),
    armies,
    nextArmyId: armies.length + 1,
    market: { pressure: zeroGoods(), history: [] },
    feed: [],
    nextFeedId: 1,
    stats: emptyStats(),
    history: [],
    surrenders: [],
  };
  const sim: Sim = { map, state, cache: createCache(map, state, false) };
  return { sim, p, n };
}

/** 1 flags as sorted province keys, so failures read as names. */
const flagged = (sim: Sim, flags: Uint8Array): string[] =>
  sim.map.provinces.filter((s) => flags[s.ix] === 1).map((s) => s.id).sort();

describe('supply', () => {
  // a1 (capital) - a2 - b1 - b2 - b3 - a3, with a4 hanging off b1.
  const line = () =>
    world({
      provinces: {
        a1: { owner: 'a', capital: true },
        a2: { owner: 'a' },
        a3: { owner: 'a' },
        a4: { owner: 'a' },
        b1: { owner: 'b', capital: true },
        b2: { owner: 'b' },
        b3: { owner: 'b' },
      },
      edges: [
        ['a1', 'a2'],
        ['a2', 'b1'],
        ['b1', 'b2'],
        ['b2', 'b3'],
        ['b3', 'a3'],
        ['b1', 'a4'],
      ],
      player: 'a',
      armies: [
        { owner: 'a', at: 'a3' },
        { owner: 'a', at: 'b2' },
        { owner: 'a', at: 'b3' },
      ],
    });

  it('leaves a pocket cut off from the capital unconnected', () => {
    const { sim, n, p } = line();
    const supply = computeSupply(sim.map, sim.state, n('a'));
    expect(flagged(sim, supply.connected)).toEqual(['a1', 'a2']);
    expect(isConnected(sim, n('a'), p('a3'))).toBe(false);
    expect(isConnected(sim, n('a'), p('a4'))).toBe(false);
    expect(isConnected(sim, n('a'), p('a2'))).toBe(true);
  });

  it('supplies exactly 2 hops beyond connected land, of any ownership', () => {
    const { sim, n } = line();
    const supply = computeSupply(sim.map, sim.state, n('a'));
    // b1 and a4 via b1 are within 2 hops of a2; b2 is 2 hops; b3 and a3 are 3 and 4.
    expect(flagged(sim, supply.supplied)).toEqual(['a1', 'a2', 'a4', 'b1', 'b2']);
    const [inPocket, halo, beyond] = sim.state.armies;
    if (!inPocket || !halo || !beyond) throw new Error('armies missing');
    expect(isSupplied(sim, inPocket)).toBe(false);
    expect(isSupplied(sim, halo)).toBe(true);
    expect(isSupplied(sim, beyond)).toBe(false);
  });

  it('roots a nation without a capital at its first Training Ground, else its largest province', () => {
    const spec = {
      provinces: {
        a1: { owner: 'a', capital: true },
        a2: { owner: 'a', areaKm2: 90_000 },
        a3: { owner: 'a', training: 1 },
        b1: { owner: 'b' },
      },
      edges: [
        ['a1', 'b1'],
        ['a2', 'b1'],
        ['b1', 'a3'],
      ] as [string, string][],
      player: 'a',
    };
    const trained = world(spec);
    const nation = trained.sim.state.nations[trained.n('a')];
    if (!nation) throw new Error('no nation');
    nation.capital = null;
    expect(flagged(trained.sim, computeSupply(trained.sim.map, trained.sim.state, nation.ix).connected)).toEqual(['a3']);

    const untrained = world({ ...spec, provinces: { ...spec.provinces, a3: { owner: 'a' } } });
    const bare = untrained.sim.state.nations[untrained.n('a')];
    if (!bare) throw new Error('no nation');
    bare.capital = null;
    expect(flagged(untrained.sim, computeSupply(untrained.sim.map, untrained.sim.state, bare.ix).connected)).toEqual(['a2']);

    // A capital the nation no longer owns falls back the same way.
    const lost = world(spec);
    setOwner(lost.sim, lost.p('a1'), lost.n('b'));
    expect(flagged(lost.sim, computeSupply(lost.sim.map, lost.sim.state, lost.n('a')).connected)).toEqual(['a3']);
  });

  it('recomputes only dirty nations, and drops dead ones', () => {
    const { sim, n, p } = world({
      provinces: {
        a1: { owner: 'a' },
        a2: { owner: 'a' },
        b1: { owner: 'b' },
        c1: { owner: 'c' },
      },
      edges: [
        ['a1', 'a2'],
        ['a2', 'b1'],
        ['b1', 'c1'],
      ],
      player: 'a',
    });
    refreshSupply(sim);
    const [a, b, c] = [n('a'), n('b'), n('c')].map((ix) => sim.cache.supply[ix]);
    expect(a && b && c).toBeTruthy();
    expect(sim.cache.supplyDirty).toEqual([false, false, false]);

    refreshSupply(sim);
    expect(sim.cache.supply[n('a')]).toBe(a);

    setOwner(sim, p('a2'), n('b'));
    expect(sim.cache.supplyDirty).toEqual([true, true, false]);
    // A dirty map is read fresh without being stored, as a loaded game would read it.
    expect(isConnected(sim, n('b'), p('a2'))).toBe(true);
    expect(sim.cache.supply[n('b')]).toBe(b);
    refreshSupply(sim);
    expect(sim.cache.supply[n('a')]).not.toBe(a);
    expect(sim.cache.supply[n('b')]).not.toBe(b);
    expect(sim.cache.supply[n('c')]).toBe(c);
    expect(isConnected(sim, n('b'), p('a2'))).toBe(true);

    const dead = sim.state.nations[n('c')];
    if (!dead) throw new Error('no nation');
    dead.alive = false;
    sim.cache.supplyDirty[n('c')] = true;
    refreshSupply(sim);
    expect(sim.cache.supply[n('c')]).toBeNull();
  });

  it('reads an uncomputed map without storing it', () => {
    const { sim, n, p } = line();
    expect(isConnected(sim, n('a'), p('a2'))).toBe(true);
    expect(sim.cache.supply[n('a')]).toBeNull();
    expect(sim.cache.supplyDirty[n('a')]).toBe(true);
  });
});

describe('vision', () => {
  // p1 - x1 - x2 - x3 - x4 - x5 - x6, the player owning p1 with an army at x6.
  const fog = () =>
    world({
      provinces: {
        p1: { owner: 'p' },
        x1: { owner: 'x' },
        x2: { owner: 'x' },
        x3: { owner: 'x' },
        x4: { owner: 'x' },
        x5: { owner: 'x' },
        x6: { owner: 'x' },
      },
      edges: [
        ['p1', 'x1'],
        ['x1', 'x2'],
        ['x2', 'x3'],
        ['x3', 'x4'],
        ['x4', 'x5'],
        ['x5', 'x6'],
      ],
      player: 'p',
      armies: [
        { owner: 'p', at: 'x6' },
        { owner: 'x', at: 'x3' },
        { owner: 'x', at: 'x3', to: 'x2' },
        { owner: 'x', at: 'x5' },
      ],
    });

  it('sees 2 hops from own land and own armies', () => {
    const { sim, n } = fog();
    expect(flagged(sim, computeVision(sim, n('p')))).toEqual(['p1', 'x1', 'x2', 'x4', 'x5', 'x6']);
  });

  it('counts both ends of an own army’s leg', () => {
    const { sim, n } = world({
      provinces: { p1: { owner: 'p' }, x1: { owner: 'x' }, x2: { owner: 'x' }, x3: { owner: 'x' }, x4: { owner: 'x' } },
      edges: [
        ['p1', 'x1'],
        ['x1', 'x2'],
        ['x2', 'x3'],
        ['x3', 'x4'],
      ],
      player: 'p',
      armies: [{ owner: 'p', at: 'x1', to: 'x2' }],
    });
    expect(flagged(sim, computeVision(sim, n('p')))).toEqual(['p1', 'x1', 'x2', 'x3', 'x4']);
  });

  it('hides hostile armies outside vision, shows those on a leg touching it', () => {
    const { sim } = fog();
    refreshVision(sim);
    expect(flagged(sim, sim.cache.vision)).toEqual(['p1', 'x1', 'x2', 'x4', 'x5', 'x6']);
    const [own, hidden, leaving, near] = sim.state.armies;
    if (!own || !hidden || !leaving || !near) throw new Error('armies missing');
    expect(isArmyVisible(sim, own)).toBe(true);
    expect(isArmyVisible(sim, hidden)).toBe(false);
    expect(isArmyVisible(sim, leaving)).toBe(true);
    expect(isArmyVisible(sim, near)).toBe(true);
  });

  it('always shows a battle against the player’s armies', () => {
    const { sim, p } = fog();
    refreshVision(sim);
    const [own, hidden] = sim.state.armies;
    if (!own || !hidden) throw new Error('armies missing');
    // Stale vision (it refreshes hourly) must not hide a fight the player is in.
    sim.cache.vision.fill(0);
    own.at = p('x3');
    hidden.battle = { joinedAt: 0, startHp: 100, direction: asProvince(0) };
    sim.cache.armiesAt[p('x6')] = [];
    sim.cache.armiesAt[p('x3')] = [own, hidden];
    expect(isArmyVisible(sim, hidden)).toBe(true);
    hidden.battle = null;
    expect(isArmyVisible(sim, hidden)).toBe(false);
  });
});
