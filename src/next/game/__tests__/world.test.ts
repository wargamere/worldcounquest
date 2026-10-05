import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ECONOMY, GARRISON, MAP } from '../balance';
import { asProvince } from '../ids';
import type { CountrySeed, GoodOverride, ProvinceFact, ProvinceFacts, Terrain, TerrainOverride } from '../types';
import { buildMap, chordKm, connectedComponents, countryGraph, edgeBetween, goodsScale, parseFacts } from '../world';

/**
 * The real map, read from the committed pipeline output. These checks guard
 * the generated data as much as world.ts: a rebuild that breaks an invariant
 * fails here rather than in a game.
 */
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const readJson = (path: string): unknown => JSON.parse(readFileSync(join(ROOT, path), 'utf8'));

const facts = parseFacts(readJson('public/province-facts.json'));
const seeds = readJson('src/data/countries.seed.json') as CountrySeed[];
const map = buildMap(facts, seeds);
const terrainOverrides = readJson('src/data/terrain-overrides.json') as TerrainOverride[];
const goodOverrides = readJson('src/data/good-overrides.json') as GoodOverride[];

const named = (country: string, name: string): ProvinceFact[] =>
  facts.provinces.filter((p) => p.countryId === country && p.name === name);
const provinceOf = (country: string, name: string) => {
  const [fact] = named(country, name);
  const ix = map.provinceById.get(fact?.id ?? '');
  if (ix === undefined) throw new Error(`no ${name} in ${country}`);
  return map.provinces[ix];
};
const count = <T>(values: readonly T[], value: T): number => values.filter((v) => v === value).length;

// ------------------------------------------------ planar point-in-province

interface Topo {
  arcs: [number, number][][];
  transform: { scale: [number, number]; translate: [number, number] };
  objects: { provinces: { geometries: { id: string; type: 'Polygon' | 'MultiPolygon'; arcs: number[][] | number[][][] }[] } };
}

/** Decodes the rendered topology's rings in lon/lat, the same way topojson-client does. */
function provinceRings(topo: Topo): Map<string, [number, number][][]> {
  const [kx, ky] = topo.transform.scale;
  const [dx, dy] = topo.transform.translate;
  const arcs = topo.arcs.map((arc) => {
    let x = 0;
    let y = 0;
    return arc.map(([ax, ay]): [number, number] => {
      x += ax;
      y += ay;
      return [x * kx + dx, y * ky + dy];
    });
  });
  const ring = (indices: number[]): [number, number][] =>
    indices.flatMap((i) => (i >= 0 ? (arcs[i] ?? []) : [...(arcs[~i] ?? [])].reverse()));
  const out = new Map<string, [number, number][][]>();
  for (const g of topo.objects.provinces.geometries) {
    const polygons = g.type === 'Polygon' ? [g.arcs as number[][]] : (g.arcs as number[][][]);
    out.set(g.id, polygons.flatMap((rings) => rings.map(ring)));
  }
  return out;
}

function insideRings(rings: [number, number][][], x: number, y: number): boolean {
  let inside = false;
  for (const r of rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i, i += 1) {
      const [xi = 0, yi = 0] = r[i] ?? [];
      const [xj = 0, yj = 0] = r[j] ?? [];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/** The pipeline's version: FNV-1a over ids, neighbours, terrain and good, in file order. */
function factsVersion(f: ProvinceFacts): string {
  const text = f.provinces.map((p) => `${p.id}|${p.neighbours.join(',')}|${p.terrain}|${p.good}\n`).join('');
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// ------------------------------------------------------------------ tests

describe('the real map', () => {
  it('has the expected provinces, nations, capitals and VP', () => {
    expect(map.provinces.length).toBeGreaterThanOrEqual(1300);
    expect(map.provinces.length).toBeLessThanOrEqual(1800);
    expect(map.nations).toHaveLength(175);
    map.nations.forEach((nation, i) => {
      expect(nation.ix).toBe(i);
      expect(nation.home.length, nation.id).toBeGreaterThanOrEqual(1);
      expect(nation.home.filter((p) => map.provinces[p]?.isCapital), nation.id).toEqual([nation.capital]);
      expect(map.provinces[nation.capital]?.country).toBe(nation.ix);
    });
    expect(map.nations.map((n) => n.id)).toEqual([...map.nations.map((n) => n.id)].sort());
    expect(map.totalVp).toBe(3068);
    expect(map.goalVp).toBe(1534);
  });

  it('has symmetric edges with equal km, no self-loops, and one connected component', () => {
    let edges = 0;
    map.edges.forEach((list, from) => {
      expect(list.map((e) => e.to)).toEqual([...list.map((e) => e.to)].sort((a, b) => a - b));
      for (const e of list) {
        edges += 1;
        expect(e.to).not.toBe(from);
        const back = edgeBetween(map, e.to, asProvince(from));
        expect(back?.km, `${from} -> ${e.to}`).toBe(e.km);
        expect(back?.sea).toBe(e.sea);
        expect(e.km).toBeGreaterThan(0);
      }
    });
    expect(edges % 2).toBe(0);
    expect(connectedComponents(map)).toHaveLength(1);
  });

  it('crosses the Channel, the Korea Strait and the Timor Sea', () => {
    const seaBetween = (a: string, b: string): boolean =>
      map.provinces.some(
        (p) =>
          map.nations[p.country]?.id === a &&
          (map.edges[p.ix] ?? []).some((e) => e.sea && map.nations[map.provinces[e.to]?.country ?? 0]?.id === b),
      );
    expect(seaBetween('826', '250')).toBe(true);
    expect(seaBetween('392', '410')).toBe(true);
    expect(seaBetween('360', '036')).toBe(true);
    expect(map.edges.flat().filter((e) => e.sea).length / 2).toBe(101);
  });

  it('keeps each country’s Funds total at TIER_FUNDS × √population', () => {
    for (const nation of map.nations) {
      const sum = nation.home.reduce((s, p) => s + (map.provinces[p]?.fundsBase ?? 0), 0);
      const expected = (ECONOMY.TIER_FUNDS[nation.tier] ?? 0) * Math.sqrt(nation.population / 1e6);
      expect(Math.abs(sum - expected), nation.id).toBeLessThan(1e-9);
    }
  });

  it('puts every anchor inside its province, as a unit vector', () => {
    const rings = provinceRings(readJson('public/provinces.json') as Topo);
    const outside = facts.provinces.filter((p) => !insideRings(rings.get(p.id) ?? [], p.anchor[0], p.anchor[1]));
    expect(outside.map((p) => p.id)).toEqual([]);
    for (const p of map.provinces) {
      const [x, y, z] = p.xyz;
      expect(Math.abs(Math.sqrt(x * x + y * y + z * z) - 1), p.id).toBeLessThanOrEqual(1e-6);
    }
  });

  it('never measures an edge shorter than the chord between its anchors', () => {
    // The A* heuristic relies on this; 0.1 km covers rounding edgeKm to 0.1 and xyz to 6 decimals.
    for (const p of map.provinces) {
      for (const e of map.edges[p.ix] ?? []) {
        const q = map.provinces[e.to];
        if (q) expect(e.km + 0.1, `${p.id} -> ${q.id}`).toBeGreaterThanOrEqual(chordKm(p.xyz, q.xyz));
      }
    }
  });

  it('lands terrain and goods in the expected ranges', () => {
    const terrains = map.provinces.map((p) => p.terrain);
    const ranges: Record<Terrain, [number, number]> = {
      plains: [500, 700],
      hills: [180, 320],
      mountains: [180, 300],
      desert: [140, 260],
      urban: [80, 140],
      jungle: [60, 140],
      arctic: [5, 40],
    };
    for (const [terrain, [lo, hi]] of Object.entries(ranges)) {
      expect(count(terrains, terrain), terrain).toBeGreaterThanOrEqual(lo);
      expect(count(terrains, terrain), terrain).toBeLessThanOrEqual(hi);
    }
    const goods = map.provinces.map((p) => p.good);
    expect(count(goods, 'food')).toBeGreaterThanOrEqual(650);
    expect(count(goods, 'food')).toBeLessThanOrEqual(830);
    expect(count(goods, 'steel')).toBeGreaterThanOrEqual(420);
    expect(count(goods, 'steel')).toBeLessThanOrEqual(580);
    expect(count(goods, 'oil')).toBeGreaterThanOrEqual(200);
    expect(count(goods, 'oil')).toBeLessThanOrEqual(320);
    expect(map.provinces.filter((p) => p.oilField)).toHaveLength(53);
  });

  it('passes the spot checks', () => {
    expect(provinceOf('250', 'Paris')?.terrain).toBe('urban');
    expect(provinceOf('756', 'Bern')?.terrain).toBe('mountains');
    expect(provinceOf('682', 'Dammam')).toMatchObject({ good: 'oil', oilField: true });
    expect(provinceOf('250', 'Grand Est')?.good).toBe('steel');
    expect(provinceOf('818', 'Al Minya')).toMatchObject({ terrain: 'plains', good: 'food' });
  });

  it('matches every authored override exactly once, and applies it', () => {
    expect(goodOverrides).toHaveLength(72);
    for (const o of goodOverrides) {
      expect(named(o.country, o.province), `${o.country} ${o.province}`).toHaveLength(1);
      expect(provinceOf(o.country, o.province)).toMatchObject({ good: o.good, oilField: o.oilField });
    }
    for (const o of terrainOverrides) {
      if (o.province === undefined) {
        expect(map.nationById.has(o.country), o.country).toBe(true);
        const from = o.from;
        if (from !== undefined) {
          const left = map.provinces.filter((p) => map.nations[p.country]?.id === o.country && p.terrain === from);
          expect(left.map((p) => p.id), `${o.country} ${from}`).toEqual([]);
        }
      } else {
        expect(named(o.country, o.province), `${o.country} ${o.province}`).toHaveLength(1);
        expect(provinceOf(o.country, o.province)?.terrain).toBe(o.to);
      }
    }
  });

  it('derives the static facts from the §2.2 formulas', () => {
    const paris = provinceOf('250', 'Paris');
    const fact = named('250', 'Paris')[0];
    if (!paris || !fact) throw new Error('no Paris');
    expect(paris.vp).toBe(1 + 2 + 3);
    expect(paris.recruitsBase).toBeCloseTo(fact.population * ECONOMY.RECRUITS_PER_PERSON, 9);
    const militia = Math.min(GARRISON.BASE_HP + GARRISON.HP_PER_SQRT_MILLION * Math.sqrt(fact.population / 1e6), GARRISON.MAX_BASE_HP);
    expect(paris.garrisonBase).toBeCloseTo(militia * GARRISON.CAPITAL_MULT * GARRISON.CITY_MULT, 9);
    const france = map.nations[paris.country];
    expect(paris.goodsBase).toBeCloseTo(
      ECONOMY.GOODS_BASE.steel * 1 * goodsScale(fact.population, fact.areaKm2) * (ECONOMY.GOODS_TIER[france?.tier ?? 0] ?? 0),
      9,
    );
    const dammam = provinceOf('682', 'Dammam');
    const dammamFact = named('682', 'Dammam')[0];
    if (!dammam || !dammamFact) throw new Error('no Dammam');
    const saudi = map.nations[dammam.country];
    expect(dammam.goodsBase).toBeCloseTo(
      ECONOMY.GOODS_BASE.oil * ECONOMY.OIL_FIELD_YIELD * goodsScale(dammamFact.population, dammamFact.areaKm2) * (ECONOMY.GOODS_TIER[saudi?.tier ?? 0] ?? 0),
      9,
    );
  });

  it('has a stable hash equal to the pipeline version', () => {
    expect(factsVersion(facts)).toBe(facts.version);
    expect(map.hash).toBe(facts.version);
    expect(buildMap(parseFacts(readJson('public/province-facts.json')), seeds).hash).toBe(map.hash);
  });

  it('derives country adjacency from province edges', () => {
    const graph = countryGraph(map);
    expect(Object.keys(graph)).toHaveLength(175);
    expect(graph['250']).toContain('276');
    expect(graph['826']).toContain('250');
    for (const [id, list] of Object.entries(graph)) {
      expect(list).not.toContain(id);
      for (const other of list) expect(graph[other], `${id} <-> ${other}`).toContain(id);
    }
  });
});

// ------------------------------------------------------------ small maps

function fact(id: string, countryId: string, extra: Partial<ProvinceFact> = {}): ProvinceFact {
  return {
    id,
    name: id,
    countryId,
    population: 1_000_000,
    areaKm2: 40_000,
    city: null,
    capital: false,
    anchor: [0, 0],
    xyz: [1, 0, 0],
    terrain: 'plains',
    good: 'food',
    oilField: false,
    neighbours: [],
    edgeKm: [],
    sea: [],
    ...extra,
  };
}

function tinyFacts(): ProvinceFacts {
  return {
    source: 'test',
    format: 2,
    version: 'abc',
    provinces: [
      fact('a-0', 'a', { capital: true, neighbours: ['a-1', 'b-0'], edgeKm: [100, 200], sea: [false, true] }),
      fact('a-1', 'a', { neighbours: ['a-0'], edgeKm: [100], sea: [false], population: 3_000_000 }),
      fact('b-0', 'b', { capital: true, neighbours: ['a-0'], edgeKm: [200], sea: [true] }),
      fact('c-0', 'c', { capital: true }),
    ],
  };
}
const tinySeeds: CountrySeed[] = [
  { id: 'c', name: 'C', population: 1_000_000, economyTier: 1 },
  { id: 'b', name: 'B', population: 1_000_000, economyTier: 2 },
  { id: 'a', name: 'A', population: 16_000_000, economyTier: 3 },
];

describe('buildMap on a tiny world', () => {
  it('indexes nations by ascending id and splits Funds by population share', () => {
    const tiny = buildMap(tinyFacts(), tinySeeds);
    expect(tiny.nations.map((n) => n.id)).toEqual(['a', 'b', 'c']);
    expect(tiny.provinces[0]?.fundsBase).toBeCloseTo(50 * 4 * 0.25, 12);
    expect(tiny.provinces[1]?.fundsBase).toBeCloseTo(50 * 4 * 0.75, 12);
    expect(tiny.nations[0]?.neighbours).toEqual([1]);
    expect(tiny.nations[2]?.neighbours).toEqual([]);
    expect(edgeBetween(tiny, asProvince(0), asProvince(2))).toEqual({ to: 2, km: 200, sea: true });
    expect(edgeBetween(tiny, asProvince(1), asProvince(2))).toBeNull();
    expect(connectedComponents(tiny)).toEqual([[0, 1, 2], [3]]);
    expect(tiny.totalVp).toBe(1 + 3 + 1 + 1 + 3 + 1 + 3);
    expect(tiny.goalVp).toBe(Math.ceil(0.5 * tiny.totalVp));
  });

  it('rejects an unmirrored edge, a second capital and an unseeded country', () => {
    const lopsided = tinyFacts();
    lopsided.provinces[1] = fact('a-1', 'a', { neighbours: ['a-0'], edgeKm: [101], sea: [false] });
    expect(() => buildMap(lopsided, tinySeeds)).toThrow(/not mirrored/);
    const twoCapitals = tinyFacts();
    twoCapitals.provinces[1] = fact('a-1', 'a', { capital: true, neighbours: ['a-0'], edgeKm: [100], sea: [false] });
    expect(() => buildMap(twoCapitals, tinySeeds)).toThrow(/2 capitals/);
    expect(() => buildMap(tinyFacts(), tinySeeds.slice(0, 2))).toThrow(/unseeded country a/);
  });
});

describe('parseFacts', () => {
  it('round-trips a valid file', () => {
    const tiny = tinyFacts();
    expect(parseFacts(JSON.parse(JSON.stringify(tiny)))).toEqual(tiny);
  });

  it('names the bad field', () => {
    const tiny = JSON.parse(JSON.stringify(tinyFacts())) as { format: number; provinces: Record<string, unknown>[] };
    expect(() => parseFacts({ ...tiny, format: 1 })).toThrow(/format/);
    expect(() => parseFacts(null)).toThrow(/root/);
    const badTerrain = structuredClone(tiny);
    if (badTerrain.provinces[2]) badTerrain.provinces[2]['terrain'] = 'swamp';
    expect(() => parseFacts(badTerrain)).toThrow(/provinces\[2\]\.terrain/);
    const shortSea = structuredClone(tiny);
    if (shortSea.provinces[0]) shortSea.provinces[0]['sea'] = [false];
    expect(() => parseFacts(shortSea)).toThrow(/provinces\[0\]\.sea/);
  });
});

describe('goodsScale and chordKm', () => {
  it('uses the larger of the area and population scales, clamped', () => {
    expect(goodsScale(4_000_000, 10_000)).toBeCloseTo(1, 12);
    expect(goodsScale(1_000_000, 160_000)).toBeCloseTo(2, 12);
    expect(goodsScale(1_000, 100)).toBe(MAP.GOODS_SCALE_MIN);
    expect(goodsScale(400_000_000, 1)).toBe(MAP.GOODS_SCALE_MAX);
  });

  it('measures straight through the globe', () => {
    expect(chordKm([1, 0, 0], [-1, 0, 0])).toBeCloseTo(2 * MAP.EARTH_RADIUS_KM, 9);
    expect(chordKm([0, 0, 1], [0, 0, 1])).toBe(0);
  });
});
