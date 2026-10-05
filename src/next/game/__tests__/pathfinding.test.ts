import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MOVEMENT } from '../balance';
import { createCache } from '../cache';
import { asNation, asProvince } from '../ids';
import { defaultTradePolicy, emptyStats, noBuildings, noShortage, zeroGoods, zeroStocks } from '../keys';
import { findPath, heuristicTicks, HOSTILE_PENALTY_TICKS, pathFromField, travelField, type PathOptions } from '../pathfinding';
import { localRng } from '../rng';
import { legTicks } from '../travel';
import type { CountrySeed, GameState, MapStatic, NationIx, ProvinceFact, ProvinceIx, Sim } from '../types';
import { buildMap, chordKm, edgeBetween, parseFacts } from '../world';
import { tinySim } from './helpers';

// ------------------------------------------------------------------ worlds

/** A playable state over any map: every province held by its original nation. */
function worldSim(map: MapStatic): Sim {
  const state: GameState = {
    format: 5,
    seed: 'paths',
    tick: 0,
    rng: 1,
    difficulty: 'standard',
    player: asNation(0),
    status: 'playing',
    endedAt: null,
    sandbox: false,
    provinces: map.provinces.map((p) => ({
      owner: p.country,
      garrison: 0,
      stability: 100,
      heldSince: 0,
      integrated: false,
      buildings: noBuildings(),
      construction: null,
      queue: [],
      keepTraining: false,
      rally: null,
      battleSince: null,
      graceUntil: 0,
    })),
    nations: map.nations.map((n, i) => ({
      ix: n.ix,
      alive: true,
      isPlayer: i === 0,
      tier: 'major',
      colour: '#888888',
      stocks: zeroStocks(),
      capital: n.capital,
      shortage: noShortage(),
      trade: defaultTradePolicy(i === 0),
      armySerial: 0,
      ai: { nextThink: 0, alertAt: null, provoked: false, operations: [] },
      eliminatedAt: null,
    })),
    armies: [],
    nextArmyId: 1,
    market: { pressure: zeroGoods(), history: [] },
    feed: [],
    nextFeedId: 1,
    stats: emptyStats(),
    history: [],
    surrenders: [],
  };
  return { map, state, cache: createCache(map, state, false) };
}

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const readJson = (path: string): unknown => JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
const realMap = buildMap(parseFacts(readJson('public/province-facts.json')), readJson('src/data/countries.seed.json') as CountrySeed[]);

/**
 * A random world on the sphere: provinces at random unit vectors, each linked
 * to its nearest neighbours by land and a few by long sea crossings (some past
 * the sea cap), with edge km never below the chord, like real great circles.
 */
function randomMap(seed: number, count: number): MapStatic {
  const rand = localRng(seed);
  const xyz: [number, number, number][] = [];
  while (xyz.length < count) {
    const v: [number, number, number] = [rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1];
    const len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
    if (len < 0.1 || len > 1) continue;
    xyz.push([v[0] / len, v[1] / len, v[2] / len]);
  }
  const ids = xyz.map((_, i) => `r${String(i).padStart(3, '0')}`);
  const countries = ['aa', 'bb', 'cc'];
  const links = new Map<string, { km: number; sea: boolean }>();
  const key = (i: number, j: number): string => (i < j ? `${i}-${j}` : `${j}-${i}`);
  const link = (i: number, j: number, sea: boolean): void => {
    if (i === j || links.has(key(i, j))) return;
    const chord = chordKm(xyz[i]!, xyz[j]!);
    links.set(key(i, j), { km: Math.ceil(chord * (1 + rand() * 0.4) * 10) / 10, sea });
  };
  for (let i = 0; i < count; i += 1) {
    const nearest = xyz
      .map((v, j) => ({ j, d: chordKm(xyz[i]!, v) }))
      .filter(({ j }) => j !== i)
      .sort((x, y) => x.d - y.d || x.j - y.j)
      .slice(0, 3);
    for (const { j } of nearest) link(i, j, false);
  }
  for (let k = 0; k < count / 6; k += 1) link(Math.floor(rand() * count), Math.floor(rand() * count), true);
  const country = (i: number): string => countries[i % countries.length]!;
  const facts: ProvinceFact[] = ids.map((id, i) => {
    const neighbours: { id: string; km: number; sea: boolean }[] = [];
    for (let j = 0; j < count; j += 1) {
      const l = links.get(key(i, j));
      if (l !== undefined) neighbours.push({ id: ids[j]!, ...l });
    }
    neighbours.sort((x, y) => (x.id < y.id ? -1 : 1));
    return {
      id,
      name: id,
      countryId: country(i),
      population: 1_000_000,
      areaKm2: 10_000,
      city: null,
      capital: i < countries.length,
      anchor: [0, 0],
      xyz: xyz[i]!,
      terrain: (['plains', 'hills', 'mountains', 'desert', 'urban'] as const)[i % 5]!,
      good: 'food',
      oilField: false,
      neighbours: neighbours.map((x) => x.id),
      edgeKm: neighbours.map((x) => x.km),
      sea: neighbours.map((x) => x.sea),
    };
  });
  return buildMap(
    { source: 'random', format: 2, version: `random-${seed}`, provinces: facts },
    countries.map((id) => ({ id, name: id, population: 1_000_000, economyTier: 3 })),
  );
}

// ------------------------------------------------------------------ reference

/** A textbook binary heap of [cost, node], for the reference searches. */
class RefHeap {
  private items: [number, number][] = [];
  get size(): number {
    return this.items.length;
  }
  push(item: [number, number]): void {
    const a = this.items;
    a.push(item);
    for (let i = a.length - 1; i > 0; ) {
      const up = (i - 1) >> 1;
      if (a[up]![0] <= a[i]![0]) break;
      [a[up], a[i]] = [a[i]!, a[up]!];
      i = up;
    }
  }
  pop(): [number, number] {
    const a = this.items;
    const top = a[0]!;
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      for (let i = 0; ; ) {
        const l = 2 * i + 1;
        let m = i;
        if (l < a.length && a[l]![0] < a[m]![0]) m = l;
        if (l + 1 < a.length && a[l + 1]![0] < a[m]![0]) m = l + 1;
        if (m === i) break;
        [a[m], a[i]] = [a[i]!, a[m]!];
        i = m;
      }
    }
    return top;
  }
}

/** Plain Dijkstra with the same rules as findPath; returns the route cost (penalties included). */
function reference(sim: Sim, from: ProvinceIx, to: ProvinceIx, o: PathOptions): number | null {
  const count = sim.map.provinces.length;
  const passable = (p: ProvinceIx): boolean =>
    o.mode === 'attack' || (sim.state.provinces[p]!.owner === o.nation && (o.mode === 'own' || sim.cache.contested[p] !== 1));
  if (o.mode === 'retreat' && !passable(to)) return null;
  if (from === to) return 0;
  const dist = new Float64Array(count).fill(Number.POSITIVE_INFINITY);
  const done = new Uint8Array(count);
  dist[from] = 0;
  const queue = new RefHeap();
  queue.push([0, from]);
  while (queue.size > 0) {
    const [d, u] = queue.pop();
    if (done[u] === 1) continue;
    done[u] = 1;
    if (u === to) return d;
    if (u !== from && !passable(asProvince(u))) continue;
    for (const e of sim.map.edges[u]!) {
      if (e.to !== to && !passable(e.to)) continue;
      const penalty = o.mode === 'attack' && e.to !== to && sim.state.provinces[e.to]!.owner !== o.nation ? HOSTILE_PENALTY_TICKS : 0;
      const next = d + legTicks(sim, asProvince(u), e.to, e.km, e.sea, o.speedKmh) + penalty;
      if (next < dist[e.to]! && next <= o.maxTicks) {
        dist[e.to] = next;
        queue.push([next, e.to]);
      }
    }
  }
  return null;
}

/** Exact real ticks from every province to `to`, over any land (for the heuristic bound). */
function exactTo(sim: Sim, to: ProvinceIx, speed: number): Float64Array {
  const count = sim.map.provinces.length;
  const dist = new Float64Array(count).fill(Number.POSITIVE_INFINITY);
  dist[to] = 0;
  const done = new Uint8Array(count);
  for (;;) {
    let v = -1;
    for (let i = 0; i < count; i += 1) if (done[i] === 0 && dist[i]! < Number.POSITIVE_INFINITY && (v < 0 || dist[i]! < dist[v]!)) v = i;
    if (v < 0) return dist;
    done[v] = 1;
    for (const e of sim.map.edges[v]!) {
      const next = dist[v]! + legTicks(sim, e.to, asProvince(v), e.km, e.sea, speed);
      if (next < dist[e.to]!) dist[e.to] = next;
    }
  }
}

const costOf = (r: { ticks: number; hostile: number }): number => r.ticks + r.hostile * HOSTILE_PENALTY_TICKS;
const INF = Number.POSITIVE_INFINITY;
const options = (nation: NationIx, mode: PathOptions['mode'], speedKmh = 20): PathOptions => ({ nation, speedKmh, mode, maxTicks: INF });

/** The real ticks of walking `nodes` from `from`. */
function walk(sim: Sim, from: ProvinceIx, nodes: readonly ProvinceIx[], speed: number): number {
  let total = 0;
  let at = from;
  for (const p of nodes) {
    const e = edgeBetween(sim.map, at, p);
    expect(e, 'route follows edges').not.toBeNull();
    total += legTicks(sim, at, p, e!.km, e!.sea, speed);
    at = p;
  }
  return total;
}

// ------------------------------------------------------------------ tests

describe('A*', () => {
  it('equals Dijkstra on 200 seeded random pairs of the real map', () => {
    const sim = worldSim(realMap);
    const rand = localRng(20260930);
    const count = realMap.provinces.length;
    for (let i = 0; i < 200; i += 1) {
      const from = asProvince(Math.floor(rand() * count));
      const to = asProvince(Math.floor(rand() * count));
      const nation = sim.state.provinces[from]!.owner;
      const speed = [16, 20, 30, 36][i % 4]!;
      const o = options(nation, 'attack', speed);
      const path = findPath(sim, from, to, o);
      const want = reference(sim, from, to, o);
      expect(path === null, `${from}->${to}`).toBe(want === null);
      if (path === null) continue;
      expect(costOf(path), `${from}->${to}`).toBe(want);
      expect(walk(sim, from, path.nodes, speed)).toBe(path.ticks);
      expect(path.nodes[path.nodes.length - 1] ?? from).toBe(to);
    }
  });

  it('equals Dijkstra on random graphs, in every mode', () => {
    for (let seed = 1; seed <= 12; seed += 1) {
      const sim = worldSim(randomMap(seed, 70));
      const rand = localRng(seed * 7919);
      const count = sim.map.provinces.length;
      for (let i = 0; i < 40; i += 1) {
        const from = asProvince(Math.floor(rand() * count));
        const to = asProvince(Math.floor(rand() * count));
        const mode = (['attack', 'own', 'retreat'] as const)[i % 3]!;
        const o = options(sim.state.provinces[from]!.owner, mode, i % 2 === 0 ? 20 : 36);
        const path = findPath(sim, from, to, o);
        const want = reference(sim, from, to, o);
        expect(path === null ? null : costOf(path), `seed ${seed}: ${from}->${to} ${mode}`).toBe(want);
      }
    }
  });

  it('the heuristic never overestimates, capped sea crossings included', () => {
    const worlds = [worldSim(realMap), worldSim(randomMap(99, 90))];
    const hawaii = realMap.provinceById.get('840-44');
    for (const sim of worlds) {
      const count = sim.map.provinces.length;
      const rand = localRng(count);
      const targets = [asProvince(Math.floor(rand() * count)), asProvince(Math.floor(rand() * count))];
      if (sim.map === realMap && hawaii !== undefined) targets.push(hawaii);
      for (const to of targets) {
        for (const speed of [16, 36]) {
          const exact = exactTo(sim, to, speed);
          for (let v = 0; v < count; v += 1) {
            if (exact[v] === INF) continue;
            expect(heuristicTicks(sim, asProvince(v), to, speed), `${v}->${to}`).toBeLessThanOrEqual(exact[v]! + 1e-9);
          }
        }
      }
    }
  });

  it('the plain chord bound alone would overestimate across the longest capped crossing', () => {
    const sim = worldSim(realMap);
    const a = realMap.provinceById.get('840-3')!;
    const b = realMap.provinceById.get('840-44')!;
    const edge = edgeBetween(realMap, a, b)!;
    expect(edge.sea).toBe(true);
    const chordTicks = (chordKm(realMap.provinces[a]!.xyz, realMap.provinces[b]!.xyz) * 4) / MOVEMENT.SEA_KMH;
    const leg = legTicks(sim, a, b, edge.km, true, 20);
    expect(chordTicks).toBeGreaterThan(leg);
    expect(heuristicTicks(sim, a, b, 20)).toBeLessThanOrEqual(leg);
  });

  it('own mode never enters hostile land on the way', () => {
    const sim = worldSim(realMap);
    const rand = localRng(4242);
    const russia = realMap.nationById.get('643')!;
    const land = realMap.nations[russia]!.home;
    for (let i = 0; i < 60; i += 1) {
      const from = land[Math.floor(rand() * land.length)]!;
      const to = asProvince(Math.floor(rand() * realMap.provinces.length));
      const path = findPath(sim, from, to, options(russia, 'own'));
      if (path === null) continue;
      for (const p of path.nodes.slice(0, -1)) expect(sim.state.provinces[p]!.owner).toBe(russia);
      expect(path.hostile).toBe(0);
    }
  });

  it('charges 96 ticks per hostile province crossed before the target', () => {
    // a to t: through hostile h (2 legs of 20 ticks, plus 96 for crossing h) or around through own o1, o2 (3 legs).
    const build = (aroundKm: number) =>
      tinySim({
        provinces: { a: { owner: 'me' }, h: { owner: 'foe' }, o1: { owner: 'me' }, o2: { owner: 'me' }, t: { owner: 'foe' } },
        edges: [
          ['a', 'h', 100],
          ['h', 't', 100],
          ['a', 'o1', aroundKm],
          ['o1', 'o2', aroundKm],
          ['o2', 't', aroundKm],
        ],
      });
    const cheap = build(200);
    const around = findPath(cheap.sim, cheap.p('a'), cheap.p('t'), options(cheap.n('me'), 'attack'))!;
    expect(around.nodes).toEqual([cheap.p('o1'), cheap.p('o2'), cheap.p('t')]);
    expect(around.ticks).toBe(3 * 40);
    expect(around.hostile).toBe(0);
    const dear = build(300);
    const through = findPath(dear.sim, dear.p('a'), dear.p('t'), options(dear.n('me'), 'attack'))!;
    expect(through.nodes).toEqual([dear.p('h'), dear.p('t')]);
    expect(through.ticks).toBe(40);
    expect(through.hostile).toBe(1);
    expect(HOSTILE_PENALTY_TICKS).toBe(96);
  });

  it('gives null when unreachable, when the retreat target is unsafe, or past maxTicks', () => {
    const { sim, p, n } = tinySim({
      provinces: { a: { owner: 'me' }, b: { owner: 'me' }, c: { owner: 'foe' }, island: { owner: 'me' } },
      edges: [
        ['a', 'b'],
        ['b', 'c'],
      ],
    });
    expect(findPath(sim, p('a'), p('island'), options(n('me'), 'attack'))).toBeNull();
    expect(findPath(sim, p('a'), p('c'), options(n('me'), 'retreat'))).toBeNull();
    expect(findPath(sim, p('a'), p('b'), options(n('me'), 'retreat'))).not.toBeNull();
    expect(findPath(sim, p('a'), p('c'), { ...options(n('me'), 'attack'), maxTicks: 39 })).toBeNull();
    expect(findPath(sim, p('a'), p('c'), { ...options(n('me'), 'attack'), maxTicks: 40 })?.ticks).toBe(40);
    expect(findPath(sim, p('a'), p('a'), options(n('me'), 'own'))).toEqual({ nodes: [], ticks: 0, hostile: 0 });
  });

  it('breaks ties toward the lower province index, every time', () => {
    const { sim, p, n } = tinySim({
      provinces: { s: { owner: 'me' }, x: { owner: 'me' }, y: { owner: 'me' }, t: { owner: 'me' } },
      edges: [
        ['s', 'y'],
        ['s', 'x'],
        ['y', 't'],
        ['x', 't'],
      ],
    });
    const first = findPath(sim, p('s'), p('t'), options(n('me'), 'own'))!;
    expect(first.nodes).toEqual([p('x'), p('t')]);
    for (let i = 0; i < 5; i += 1) expect(findPath(sim, p('s'), p('t'), options(n('me'), 'own'))).toEqual(first);
  });

  it('counts its searches', () => {
    const { sim, p, n } = tinySim({ provinces: { a: { owner: 'me' }, b: { owner: 'me' } }, edges: [['a', 'b']] });
    findPath(sim, p('a'), p('b'), options(n('me'), 'own'));
    travelField(sim, [p('a')], options(n('me'), 'own'));
    expect(sim.cache.counters).toMatchObject({ paths: 1, fields: 1 });
  });
});

describe('travelField', () => {
  it('equals repeated A* to the nearest source, and its routes walk to a source', () => {
    const sim = worldSim(realMap);
    const france = realMap.nationById.get('250')!;
    const germany = realMap.nationById.get('276')!;
    const sources = [realMap.nations[france]!.capital, realMap.nations[germany]!.capital];
    for (const mode of ['own', 'retreat'] as const) {
      const o = options(france, mode, 20);
      const field = travelField(sim, sources, o);
      for (let v = 0; v < realMap.provinces.length; v += 1) {
        const p = asProvince(v);
        const best = sources.reduce<number | null>((min, s) => {
          const path = findPath(sim, p, s, o);
          return path === null ? min : min === null ? path.ticks : Math.min(min, path.ticks);
        }, null);
        expect(field.ticks[v], `${mode} ${realMap.provinces[v]!.id}`).toBe(best ?? -1);
        if (best === null) continue;
        const route = pathFromField(field, p);
        if (sources.includes(p)) {
          expect(route).toEqual([]);
          continue;
        }
        expect(sources).toContain(route[route.length - 1]);
        expect(walk(sim, p, route, 20)).toBe(best);
      }
    }
  });

  it('caps the search at maxTicks and marks the rest unreachable', () => {
    const { sim, p, n } = tinySim({
      provinces: { a: { owner: 'me' }, b: { owner: 'me' }, c: { owner: 'me' } },
      edges: [
        ['a', 'b'],
        ['b', 'c'],
      ],
    });
    const field = travelField(sim, [p('a')], { ...options(n('me'), 'own'), maxTicks: 25 });
    expect([...field.ticks]).toEqual([0, 20, -1]);
    expect([...field.next]).toEqual([-1, p('a'), -1]);
    expect(pathFromField(field, p('c'))).toEqual([]);
    expect(pathFromField(field, p('b'))).toEqual([p('a')]);
  });
});
