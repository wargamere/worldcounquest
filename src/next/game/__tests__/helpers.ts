/**
 * Shared test helpers (spec §12.1): hand-built tiny worlds, new games on the
 * committed map, the state invariants every engine test can assert, a state
 * hash and deep freezing.
 *
 * tinySim builds MapStatic and GameState directly, in the shapes world.ts and
 * init.ts produce, so rule tests do not depend on the committed map data.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { AI, COMBAT, ECONOMY, GARRISON, MAP, PROVINCE, EFFECTS, TERRAIN, UNITS, VICTORY } from '../balance';
import { createCache } from '../cache';
import { hoursToTicks } from '../clock';
import { createGame } from '../init';
import { advance, createSim } from '../sim';
import { assignColours } from '../colours';
import { asArmy, asNation, asProvince } from '../ids';
import { defaultTradePolicy, emptyStats, noBuildings, noShortage, zeroGoods, zeroStocks, zeroUnits } from '../keys';
import { seedFromString } from '../rng';
import { UNIT_TYPES } from '../types';
import { buildMap, goodsScale, parseFacts } from '../world';
import type {
  Army,
  ArmyId,
  BuildingLevels,
  CountrySeed,
  Difficulty,
  Edge,
  GameState,
  Good,
  MapStatic,
  Nation,
  NationIx,
  NationStatic,
  Province,
  ProvinceIx,
  ProvinceStatic,
  Sim,
  Stance,
  Stocks,
  Terrain,
  TickEvents,
  UnitCounts,
} from '../types';

export interface TinyProvince {
  owner: string;
  terrain?: Terrain;
  good?: Good;
  population?: number;
  areaKm2?: number;
  /** Makes this province the original capital of that nation (and, by default, part of it). */
  capitalOf?: string;
  /** The original nation; defaults to capitalOf, then owner. */
  country?: string;
  buildings?: Partial<BuildingLevels>;
  garrison?: number;
  stability?: number;
}
export interface TinyArmy {
  owner: string;
  at: string;
  units: UnitCounts;
  stance?: Stance;
  retreatAt?: number;
}
export type TinyEdge = [string, string] | [string, string, number] | [string, string, number, 'sea'];
export interface TinySpec {
  provinces: Record<string, TinyProvince>;
  edges: TinyEdge[];
  armies?: TinyArmy[];
  player?: string;
  difficulty?: Difficulty;
  seed?: string;
  stocks?: Record<string, Partial<Stocks>>;
}
export interface TinySim {
  sim: Sim;
  p: (key: string) => ProvinceIx;
  n: (id: string) => NationIx;
  a: (index: number) => ArmyId;
}

/** Defaults: 1 M people on 40,000 km² (goods scale 1), economy tier 3, 100 km edges (Rifles: 5 h a leg). */
const TINY_POPULATION = 1_000_000;
const TINY_AREA_KM2 = 40_000;
const TINY_TIER = 3;
const TINY_EDGE_KM = 100;
const TINY_NAME = 'tiny';

function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${suffix}`;
}

function defaultGood(terrain: Terrain): Good {
  if (terrain === 'desert' || terrain === 'arctic') return 'oil';
  if (terrain === 'mountains' || terrain === 'urban') return 'steel';
  return 'food';
}

function buildTinyMap(spec: TinySpec, keys: readonly string[]): MapStatic {
  const countryOf = (t: TinyProvince): string => t.country ?? t.capitalOf ?? t.owner;
  const ids = new Set<string>();
  for (const key of keys) {
    const t = spec.provinces[key]!;
    ids.add(t.owner);
    ids.add(countryOf(t));
  }
  const nationIds = [...ids].sort();
  const nationById = new Map(nationIds.map((id, i) => [id, asNation(i)]));
  const provinceById = new Map(keys.map((key, i) => [key, asProvince(i)]));
  const home: ProvinceIx[][] = nationIds.map(() => []);
  const population: number[] = nationIds.map(() => 0);
  keys.forEach((key, i) => {
    const t = spec.provinces[key]!;
    const n = nationById.get(countryOf(t))!;
    home[n]!.push(asProvince(i));
    population[n]! += t.population ?? TINY_POPULATION;
  });
  const capitalOf = nationIds.map((id, n) => {
    const authored = keys.findIndex((key) => spec.provinces[key]!.capitalOf === id);
    return authored >= 0 ? asProvince(authored) : home[n]![0]!;
  });

  const provinces: ProvinceStatic[] = keys.map((key, i) => {
    const t = spec.provinces[key]!;
    const n = nationById.get(countryOf(t))!;
    const terrain = t.terrain ?? 'plains';
    const good = t.good ?? defaultGood(terrain);
    const pop = t.population ?? TINY_POPULATION;
    const area = t.areaKm2 ?? TINY_AREA_KM2;
    const isCapital = capitalOf[n] === i;
    const countryPop = population[n]!;
    const militia = Math.min(GARRISON.BASE_HP + GARRISON.HP_PER_SQRT_MILLION * Math.sqrt(pop / 1e6), GARRISON.MAX_BASE_HP);
    return {
      ix: asProvince(i),
      id: key,
      name: key.toUpperCase(),
      country: n,
      population: pop,
      areaKm2: area,
      city: null,
      isCapital,
      terrain,
      good,
      oilField: false,
      fundsBase: ECONOMY.TIER_FUNDS[TINY_TIER]! * Math.sqrt(countryPop / 1e6) * (pop / countryPop),
      goodsBase: ECONOMY.GOODS_BASE[good] * TERRAIN[terrain].goodsYield * goodsScale(pop, area) * ECONOMY.GOODS_TIER[TINY_TIER]!,
      recruitsBase: pop * ECONOMY.RECRUITS_PER_PERSON,
      garrisonBase: militia * (isCapital ? GARRISON.CAPITAL_MULT : 1),
      vp: MAP.VP_BASE + (isCapital ? MAP.VP_CAPITAL : 0),
      anchor: [0, 0],
      // One shared point: the A* heuristic is then 0, which is always admissible.
      xyz: [1, 0, 0],
    };
  });

  const edges: Edge[][] = keys.map(() => []);
  for (const [a, b, km, sea] of spec.edges) {
    const from = provinceById.get(a);
    const to = provinceById.get(b);
    if (from === undefined || to === undefined) throw new Error(`tinySim: edge ${a}-${b} names an unknown province`);
    if (from === to) throw new Error(`tinySim: ${a} cannot neighbour itself`);
    if (edges[from]!.some((e) => e.to === to)) throw new Error(`tinySim: edge ${a}-${b} is listed twice`);
    const length = km ?? TINY_EDGE_KM;
    edges[from]!.push({ to, km: length, sea: sea === 'sea' });
    edges[to]!.push({ to: from, km: length, sea: sea === 'sea' });
  }
  for (const list of edges) list.sort((x, y) => x.to - y.to);

  const nations: NationStatic[] = nationIds.map((id, i) => {
    const neighbours = new Set<NationIx>();
    for (const p of home[i]!) for (const e of edges[p]!) if (provinces[e.to]!.country !== i) neighbours.add(provinces[e.to]!.country);
    return {
      ix: asNation(i),
      id,
      name: id.toUpperCase(),
      tier: TINY_TIER,
      population: population[i]!,
      capital: capitalOf[i]!,
      home: home[i]!,
      neighbours: [...neighbours].sort((x, y) => x - y),
    };
  });
  const totalVp = provinces.reduce((sum, p) => sum + p.vp, 0);
  const shape = keys.map((key) => `${key}:${spec.provinces[key]!.owner}`).join(',');
  return {
    provinces,
    edges,
    nations,
    provinceById,
    nationById,
    totalVp,
    goalVp: Math.ceil(VICTORY.VP_SHARE * totalVp),
    hash: `${TINY_NAME}-${seedFromString(shape).toString(16)}`,
  };
}

/**
 * A hand-built world for rule tests. Province keys are ids (their order is the
 * ProvinceIx order); every owner or country becomes a nation. Nations start
 * with no stocks unless `stocks` says otherwise, garrisons start full, and
 * armies standing in a hostile, defended province start in its battle.
 */
export function tinySim(spec: TinySpec): TinySim {
  const keys = Object.keys(spec.provinces);
  if (keys.length === 0) throw new Error('tinySim: no provinces');
  const map = buildTinyMap(spec, keys);
  const nationIx = (id: string): NationIx => {
    const n = map.nationById.get(id);
    if (n === undefined) throw new Error(`tinySim: unknown nation ${id}`);
    return n;
  };
  const provinceIx = (key: string): ProvinceIx => {
    const p = map.provinceById.get(key);
    if (p === undefined) throw new Error(`tinySim: unknown province ${key}`);
    return p;
  };
  const playerId = spec.player ?? (map.nationById.has('me') ? 'me' : map.nations[0]!.id);
  const player = nationIx(playerId);

  const provinces: Province[] = keys.map((key, i) => {
    const t = spec.provinces[key]!;
    const owner = nationIx(t.owner);
    const buildings = { ...noBuildings(), ...t.buildings };
    const status = owner === map.provinces[i]!.country ? 'home' : 'occupied';
    const cap = map.provinces[i]!.garrisonBase * PROVINCE.GARRISON[status] * (1 + EFFECTS.RAMPARTS_GARRISON_PER_LEVEL * buildings.ramparts);
    return {
      owner,
      garrison: t.garrison ?? cap,
      stability: t.stability ?? 100,
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
  });

  const serial = map.nations.map(() => 0);
  const armies: Army[] = (spec.armies ?? []).map((t, i) => {
    const owner = nationIx(t.owner);
    const units = zeroUnits();
    for (const type of UNIT_TYPES) {
      const count = t.units[type] ?? 0;
      units[type] = { count, hp: count * UNITS[type].hp };
    }
    serial[owner]! += 1;
    const isPlayer = owner === player;
    const stance = t.stance ?? (isPlayer ? 'manual' : 'delegate');
    const at = provinceIx(t.at);
    return {
      id: asArmy(i + 1),
      owner,
      name: `${ordinal(serial[owner]!)} Army`,
      units,
      at,
      leg: null,
      path: [],
      departAt: 0,
      intent: 'move',
      stance,
      post: stance === 'defend' ? at : null,
      retreatAt: t.retreatAt ?? (isPlayer ? COMBAT.PLAYER_RETREAT_AT : COMBAT.AI_RETREAT_AT),
      battle: null,
      cameFrom: null,
      landingUntil: 0,
      // Long enough ago that the AI's anti-oscillation rule does not hold anything back.
      orderedAt: -hoursToTicks(AI.REASSIGN_AFTER_HOURS),
      alive: true,
    };
  });

  const adjacency: Record<string, string[]> = {};
  for (const nation of map.nations) adjacency[nation.id] = nation.neighbours.map((m) => map.nations[m]!.id);
  const colours = assignColours(
    map.nations.map((nation) => nation.id),
    adjacency,
    playerId,
  );
  const nations: Nation[] = map.nations.map((ns, i) => {
    const alive = provinces.some((p) => p.owner === i);
    const isPlayer = i === player;
    const capital = provinces[ns.capital]!.owner === i ? ns.capital : null;
    return {
      ix: asNation(i),
      alive,
      isPlayer,
      tier: 'major',
      colour: colours[ns.id]!,
      stocks: { ...zeroStocks(), ...spec.stocks?.[ns.id] },
      capital,
      shortage: noShortage(),
      trade: defaultTradePolicy(isPlayer),
      armySerial: serial[i]!,
      ai: { nextThink: 0, alertAt: null, provoked: false, operations: [] },
      eliminatedAt: alive ? null : 0,
    };
  });

  const seed = spec.seed ?? TINY_NAME;
  const state: GameState = {
    format: 5,
    seed,
    tick: 0,
    rng: seedFromString(seed),
    difficulty: spec.difficulty ?? 'standard',
    player,
    status: 'playing',
    endedAt: null,
    sandbox: false,
    provinces,
    nations,
    armies,
    nextArmyId: armies.length + 1,
    market: { pressure: zeroGoods(), history: [] },
    feed: [],
    nextFeedId: 1,
    stats: emptyStats(),
    history: [],
    surrenders: [],
  };

  // Armies placed inside a defended hostile province are already fighting there.
  const probe = createCache(map, state, false);
  for (const p of probe.battles) {
    state.provinces[p]!.battleSince = 0;
    for (const army of probe.armiesAt[p]!) {
      let hp = 0;
      for (const type of UNIT_TYPES) hp += army.units[type].hp;
      army.battle = { joinedAt: 0, startHp: hp, direction: null };
    }
  }
  const sim: Sim = { map, state, cache: createCache(map, state, true) };
  return {
    sim,
    p: provinceIx,
    n: nationIx,
    a: (index: number): ArmyId => {
      const army = armies[index];
      if (army === undefined) throw new Error(`tinySim: no army #${index}`);
      return army.id;
    },
  };
}

// ------------------------------------------------------------------ real world

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
let realMap: MapStatic | null = null;

/** The committed map, built once per test file. */
export function realMapStatic(): MapStatic {
  if (realMap === null) {
    const read = (path: string): unknown => JSON.parse(readFileSync(`${ROOT}${path}`, 'utf8'));
    realMap = buildMap(parseFacts(read('public/province-facts.json')), read('src/data/countries.seed.json') as CountrySeed[]);
  }
  return realMap;
}

/** A new game on the committed map (France, Standard, seed "test" unless told otherwise), recording commands. */
export function realSim(options: { player?: string; difficulty?: Difficulty; seed?: string } = {}): Sim {
  const map = realMapStatic();
  const state = createGame(map, {
    playerCountryId: options.player ?? '250',
    difficulty: options.difficulty ?? 'standard',
    seed: options.seed ?? 'test',
  });
  return createSim(map, state, { recordCommands: true });
}

/** Runs whole game hours through the real tick and returns what they reported. */
export function runHours(sim: Sim, hours: number): TickEvents {
  return advance(sim, hoursToTicks(hours));
}

// ------------------------------------------------------------------ invariants

function ids(armies: readonly Army[]): number[] {
  return armies.map((a) => a.id);
}

/**
 * Fails with `what` unless `ok`. The invariants run every game hour on the real
 * map, so a passing check must cost no more than the comparison itself.
 */
function ensure(ok: boolean, what: string): void {
  if (!ok) expect.fail(what);
}

/** Deep equality, compared as JSON first; Vitest's diff only runs on a mismatch. */
function same(actual: unknown, wanted: unknown, what: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) expect(actual, what).toEqual(wanted);
}

function sane(value: number, what: string): void {
  ensure(Number.isFinite(value) && value >= 0, `${what} is ${value}`);
}

/** The §12.1 invariants; call between ticks. */
export function assertInvariants(sim: Sim): void {
  const { map, state, cache } = sim;
  const fresh = createCache(map, state, false);

  // The cache matches the state.
  same([...cache.armyById.keys()].sort((x, y) => x - y), [...fresh.armyById.keys()], 'armyById');
  same(cache.armiesAt.map(ids), fresh.armiesAt.map(ids), 'armiesAt');
  same(cache.armiesOf.map(ids), fresh.armiesOf.map(ids), 'armiesOf');
  same(cache.inbound.map(ids), fresh.inbound.map(ids), 'inbound');
  same(cache.nationProvinces, fresh.nationProvinces, 'nationProvinces');
  same(cache.vp, fresh.vp, 'vp');
  same(cache.battles, fresh.battles, 'battles');
  same([...cache.contested], [...fresh.contested], 'contested');

  // Nothing negative, nothing NaN; every owner is alive.
  state.provinces.forEach((p, i) => {
    const id = map.provinces[i]!.id;
    sane(p.garrison, `garrison of ${id}`);
    sane(p.stability, `stability of ${id}`);
    ensure(p.stability <= 100, `stability of ${id} is ${p.stability}`);
    ensure(state.nations[p.owner]?.alive === true, `owner of ${id} is not alive`);
  });
  for (const nation of state.nations) {
    for (const [key, amount] of Object.entries(nation.stocks)) sane(amount, `${key} of nation ${nation.ix}`);
  }
  for (const amount of Object.values(state.market.pressure)) ensure(Number.isFinite(amount), `market pressure is ${amount}`);

  // Armies: sorted, alive, on a province or a real edge, never both moving and fighting.
  let lastId = 0;
  for (const army of state.armies) {
    const label = `${army.name} (#${army.id})`;
    ensure(army.id > lastId, `${label} is out of id order`);
    lastId = army.id;
    ensure(army.id < state.nextArmyId, `${label} is not below nextArmyId`);
    ensure(army.alive, `${label} is dead between ticks`);
    ensure(state.nations[army.owner]?.alive === true, `${label} has a dead owner`);
    ensure(army.at >= 0 && army.at < map.provinces.length, `${label} stands nowhere`);
    for (const type of UNIT_TYPES) {
      const stack = army.units[type];
      sane(stack.hp, `${label} ${type} hp`);
      sane(stack.count, `${label} ${type} count`);
      ensure(Number.isInteger(stack.count), `${label} ${type} count is not whole`);
      ensure(stack.hp <= stack.count * UNITS[type].hp + 1e-6, `${label} ${type} hp exceeds its count`);
    }
    for (const p of army.path) ensure(p >= 0 && p < map.provinces.length, `${label} path leaves the map`);
    if (army.leg !== null) {
      const { from, to, ticks, done } = army.leg;
      ensure(from === army.at, `${label} leg does not start where it stands`);
      ensure(map.edges[from]?.some((e) => e.to === to) === true, `${label} leg is not an edge`);
      ensure(ticks >= 1, `${label} leg ticks ${ticks}`);
      ensure(done >= 0 && done <= ticks, `${label} leg progress ${done}/${ticks}`);
      ensure(army.battle === null, `${label} is moving and fighting`);
    }
  }

  // Every contested province has both sides present.
  for (const p of cache.battles) {
    const province = state.provinces[p]!;
    const here = cache.armiesAt[p]!;
    ensure(here.some((a) => a.owner !== province.owner), `no attacker in ${map.provinces[p]!.id}`);
    const ownerSide = here.some((a) => a.owner === province.owner) || province.garrison >= GARRISON.EMPTY_BELOW;
    ensure(ownerSide, `no defender in ${map.provinces[p]!.id}`);
  }
}

/** A short digest of the whole GameState, for determinism checks. */
export function stateHash(sim: Sim): string {
  const text = JSON.stringify(sim.state);
  return `${text.length.toString(16)}-${seedFromString(text).toString(16)}`;
}

/** Freezes a value and everything reachable from it (typed arrays excepted: they cannot be frozen). */
export function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value) || ArrayBuffer.isView(value)) return value;
  if (value instanceof Map) {
    for (const [k, v] of value) {
      deepFreeze(k);
      deepFreeze(v);
    }
  } else if (value instanceof Set) {
    for (const v of value) deepFreeze(v);
  }
  Object.freeze(value);
  for (const key of Reflect.ownKeys(value)) deepFreeze((value as Record<PropertyKey, unknown>)[key]);
  return value;
}
