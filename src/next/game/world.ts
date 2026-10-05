/**
 * The static world: parses public/province-facts.json and derives every
 * per-province and per-nation fact the rules read (§2.2). Built once per page
 * load and never saved; saves carry only `hash` to detect a different map.
 */
import { ECONOMY, GARRISON, MAP, TERRAIN, VICTORY } from './balance';
import { asNation, asProvince } from './ids';
import {
  GOODS,
  TERRAINS,
  type CityFact,
  type CountrySeed,
  type Edge,
  type Good,
  type MapStatic,
  type NationIx,
  type NationStatic,
  type ProvinceFact,
  type ProvinceFacts,
  type ProvinceIx,
  type ProvinceStatic,
  type Terrain,
} from './types';

// ------------------------------------------------------------------ parsing

type Json = Record<string, unknown>;

function fail(path: string, expected: string, value: unknown): never {
  // String() because JSON.stringify(undefined) is undefined; long values are cut.
  const shown = String(JSON.stringify(value)).slice(0, 60);
  throw new Error(`province facts: ${path} should be ${expected}, got ${shown}`);
}

function record(value: unknown, path: string): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(path, 'an object', value);
  return value as Json;
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, 'an array', value);
  return value as unknown[];
}

function text(value: unknown, path: string): string {
  if (typeof value !== 'string') fail(path, 'a string', value);
  return value;
}

function finite(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'a finite number', value);
  return value;
}

function flag(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail(path, 'a boolean', value);
  return value;
}

function member<T extends string>(value: unknown, options: readonly T[], path: string): T {
  if (typeof value !== 'string' || !(options as readonly string[]).includes(value)) fail(path, `one of ${options.join('/')}`, value);
  return value as T;
}

function numbers(value: unknown, length: number, path: string): number[] {
  const list = array(value, path);
  if (list.length !== length) fail(path, `${length} numbers`, value);
  return list.map((v, i) => finite(v, `${path}[${i}]`));
}

function parseCity(value: unknown, path: string): CityFact | null {
  if (value === null) return null;
  const c = record(value, path);
  return {
    name: text(c['name'], `${path}.name`),
    population: finite(c['population'], `${path}.population`),
    lon: finite(c['lon'], `${path}.lon`),
    lat: finite(c['lat'], `${path}.lat`),
  };
}

function parseProvince(value: unknown, path: string): ProvinceFact {
  const p = record(value, path);
  const neighbours = array(p['neighbours'], `${path}.neighbours`).map((n, i) => text(n, `${path}.neighbours[${i}]`));
  const [lon = 0, lat = 0] = numbers(p['anchor'], 2, `${path}.anchor`);
  const [x = 0, y = 0, z = 0] = numbers(p['xyz'], 3, `${path}.xyz`);
  const sea = array(p['sea'], `${path}.sea`);
  if (sea.length !== neighbours.length) fail(`${path}.sea`, `${neighbours.length} flags, parallel to neighbours`, sea.length);
  return {
    id: text(p['id'], `${path}.id`),
    name: text(p['name'], `${path}.name`),
    countryId: text(p['countryId'], `${path}.countryId`),
    population: finite(p['population'], `${path}.population`),
    areaKm2: finite(p['areaKm2'], `${path}.areaKm2`),
    city: parseCity(p['city'], `${path}.city`),
    capital: flag(p['capital'], `${path}.capital`),
    anchor: [lon, lat],
    xyz: [x, y, z],
    terrain: member<Terrain>(p['terrain'], TERRAINS, `${path}.terrain`),
    good: member<Good>(p['good'], GOODS, `${path}.good`),
    oilField: flag(p['oilField'], `${path}.oilField`),
    neighbours,
    edgeKm: numbers(p['edgeKm'], neighbours.length, `${path}.edgeKm`),
    sea: sea.map((s, i) => flag(s, `${path}.sea[${i}]`)),
  };
}

/** Validates the fetched JSON and returns a clean copy; throws a descriptive Error on a bad shape. */
export function parseFacts(json: unknown): ProvinceFacts {
  const root = record(json, 'root');
  if (root['format'] !== 2) fail('format', '2', root['format']);
  return {
    source: text(root['source'], 'source'),
    format: 2,
    version: text(root['version'], 'version'),
    provinces: array(root['provinces'], 'provinces').map((p, i) => parseProvince(p, `provinces[${i}]`)),
  };
}

// ------------------------------------------------------------ derived facts

/** Big land and dense population both yield goods (§2.2). */
export function goodsScale(population: number, areaKm2: number): number {
  const scale = Math.max(Math.sqrt(areaKm2 / MAP.GOODS_AREA_REF_KM2), Math.sqrt(population / MAP.GOODS_POP_REF));
  return Math.min(MAP.GOODS_SCALE_MAX, Math.max(MAP.GOODS_SCALE_MIN, scale));
}

function tierValue(table: Readonly<Record<number, number>>, tier: number, what: string): number {
  const value = table[tier];
  if (value === undefined) throw new Error(`country tier ${tier} has no ${what}`);
  return value;
}

function cityVp(city: CityFact | null): number {
  const pop = city?.population ?? 0;
  if (pop >= MAP.MAJOR_CITY) return MAP.VP_MAJOR_CITY;
  if (pop >= MAP.MEDIUM_CITY) return MAP.VP_MEDIUM_CITY;
  return 0;
}

function garrisonBase(fact: ProvinceFact): number {
  const militia = Math.min(GARRISON.BASE_HP + GARRISON.HP_PER_SQRT_MILLION * Math.sqrt(fact.population / 1e6), GARRISON.MAX_BASE_HP);
  const capital = fact.capital ? GARRISON.CAPITAL_MULT : 1;
  const city = (fact.city?.population ?? 0) >= MAP.MAJOR_CITY ? GARRISON.CITY_MULT : 1;
  return militia * capital * city;
}

/**
 * Builds the static map. Provinces keep file order as their dense index;
 * nations are indexed in ascending country id. Throws if the facts and seeds
 * disagree, or if an edge is not mirrored exactly.
 */
export function buildMap(facts: ProvinceFacts, seeds: readonly CountrySeed[]): MapStatic {
  const sortedSeeds = [...seeds].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const nationById = new Map<string, NationIx>();
  sortedSeeds.forEach((seed, i) => {
    if (nationById.has(seed.id)) throw new Error(`country ${seed.id} is seeded twice`);
    nationById.set(seed.id, asNation(i));
  });

  const provinceById = new Map<string, ProvinceIx>();
  const homeOf: ProvinceIx[][] = sortedSeeds.map(() => []);
  const popOf: number[] = sortedSeeds.map(() => 0);
  const nationOf: NationIx[] = [];
  facts.provinces.forEach((fact, i) => {
    if (provinceById.has(fact.id)) throw new Error(`province ${fact.id} appears twice`);
    const n = nationById.get(fact.countryId);
    if (n === undefined) throw new Error(`province ${fact.id} belongs to unseeded country ${fact.countryId}`);
    provinceById.set(fact.id, asProvince(i));
    nationOf.push(n);
    homeOf[n]?.push(asProvince(i));
    popOf[n] = (popOf[n] ?? 0) + fact.population;
  });

  const provinces: ProvinceStatic[] = facts.provinces.map((fact, i) => {
    const n = nationOf[i] ?? asNation(0);
    const seed = sortedSeeds[n];
    if (!seed) throw new Error(`no seed for nation ${n}`);
    const countryPop = popOf[n] ?? 0;
    // Each country keeps its √(seed population) total, split by province population share.
    const share = countryPop > 0 ? fact.population / countryPop : 1 / (homeOf[n]?.length ?? 1);
    const funds = tierValue(ECONOMY.TIER_FUNDS, seed.economyTier, 'Funds rate') * Math.sqrt(seed.population / 1e6) * share;
    const yieldFactor = fact.oilField ? ECONOMY.OIL_FIELD_YIELD : TERRAIN[fact.terrain].goodsYield;
    const goods =
      ECONOMY.GOODS_BASE[fact.good] *
      yieldFactor *
      goodsScale(fact.population, fact.areaKm2) *
      tierValue(ECONOMY.GOODS_TIER, seed.economyTier, 'goods multiplier');
    return {
      ix: asProvince(i),
      id: fact.id,
      name: fact.name,
      country: n,
      population: fact.population,
      areaKm2: fact.areaKm2,
      city: fact.city,
      isCapital: fact.capital,
      terrain: fact.terrain,
      good: fact.good,
      oilField: fact.oilField,
      fundsBase: funds,
      goodsBase: goods,
      recruitsBase: fact.population * ECONOMY.RECRUITS_PER_PERSON,
      garrisonBase: garrisonBase(fact),
      vp: MAP.VP_BASE + cityVp(fact.city) + (fact.capital ? MAP.VP_CAPITAL : 0),
      anchor: fact.anchor,
      xyz: fact.xyz,
    };
  });

  const edges: Edge[][] = facts.provinces.map((fact, i) => {
    const list = fact.neighbours.map((id, k): Edge => {
      const to = provinceById.get(id);
      if (to === undefined) throw new Error(`province ${fact.id} names unknown neighbour ${id}`);
      if (to === i) throw new Error(`province ${fact.id} neighbours itself`);
      return { to, km: fact.edgeKm[k] ?? 0, sea: fact.sea[k] ?? false };
    });
    return list.sort((a, b) => a.to - b.to);
  });
  edges.forEach((list, from) => {
    for (const e of list) {
      const back = edges[e.to]?.find((b) => b.to === from);
      if (!back || back.km !== e.km || back.sea !== e.sea) {
        throw new Error(`edge ${facts.provinces[from]?.id ?? from} -> ${facts.provinces[e.to]?.id ?? e.to} is not mirrored`);
      }
    }
  });

  const nations: NationStatic[] = sortedSeeds.map((seed, i) => {
    const n = asNation(i);
    const home = homeOf[i] ?? [];
    if (home.length === 0) throw new Error(`country ${seed.id} has no provinces`);
    const capitals = home.filter((p) => provinces[p]?.isCapital === true);
    const [capital] = capitals;
    if (capital === undefined || capitals.length !== 1) throw new Error(`country ${seed.id} has ${capitals.length} capitals`);
    const neighbours = new Set<NationIx>();
    for (const p of home) {
      for (const e of edges[p] ?? []) {
        const other = nationOf[e.to];
        if (other !== undefined && other !== n) neighbours.add(other);
      }
    }
    return {
      ix: n,
      id: seed.id,
      name: seed.name,
      tier: seed.economyTier,
      population: seed.population,
      capital,
      home,
      neighbours: [...neighbours].sort((a, b) => a - b),
    };
  });

  const totalVp = provinces.reduce((sum, p) => sum + p.vp, 0);
  return {
    provinces,
    edges,
    nations,
    provinceById,
    nationById,
    totalVp,
    goalVp: Math.ceil(VICTORY.VP_SHARE * totalVp),
    hash: facts.version,
  };
}

// ---------------------------------------------------------------- queries

/** Straight-line km through the globe between two unit vectors; never longer than the arc. */
export function chordKm(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return MAP.EARTH_RADIUS_KM * Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** The edge from one province to another, by binary search over the sorted list. */
export function edgeBetween(map: MapStatic, from: ProvinceIx, to: ProvinceIx): Edge | null {
  const list = map.edges[from];
  if (!list) return null;
  let lo = 0;
  let hi = list.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const edge = list[mid];
    if (!edge) return null;
    if (edge.to === to) return edge;
    if (edge.to < to) lo = mid + 1;
    else hi = mid - 1;
  }
  return null;
}

/** Country adjacency (land and sea) keyed by country id, for the colouring. */
export function countryGraph(map: MapStatic): Readonly<Record<string, readonly string[]>> {
  const graph: Record<string, readonly string[]> = {};
  for (const nation of map.nations) {
    graph[nation.id] = nation.neighbours.map((n) => map.nations[n]?.id ?? '').filter((id) => id !== '');
  }
  return graph;
}

/** Connected parts of the province graph; each ascending, ordered by their lowest index. */
export function connectedComponents(map: MapStatic): ProvinceIx[][] {
  const seen = new Uint8Array(map.provinces.length);
  const parts: ProvinceIx[][] = [];
  for (let start = 0; start < map.provinces.length; start += 1) {
    if (seen[start] === 1) continue;
    seen[start] = 1;
    const queue: ProvinceIx[] = [asProvince(start)];
    for (let head = 0; head < queue.length; head += 1) {
      for (const e of map.edges[queue[head] ?? 0] ?? []) {
        if (seen[e.to] === 1) continue;
        seen[e.to] = 1;
        queue.push(e.to);
      }
    }
    parts.push(queue.sort((a, b) => a - b));
  }
  return parts;
}
