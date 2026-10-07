/**
 * Builds the province map from Natural Earth (public domain):
 *
 *   npx tsx scripts/build-provinces.mts
 *
 * Inputs, downloaded once into .cache/natural-earth at a pinned commit:
 *   - 10m admin-1 states and provinces (4,596 units across 251 countries)
 *   - 10m populated places (7,342 cities with population and capital flags)
 *   - 10m geography regions (mountain ranges, deserts, plateaus, foothills, tundra)
 * plus world-atlas countries-110m for the 175 playable countries,
 * src/data/countries.seed.json / sea-links.json, and the authored
 * src/data/terrain-overrides.json / good-overrides.json / name-overrides.json.
 *
 * Outputs, all committed:
 *   - public/provinces.json — simplified TopoJSON, one geometry per province,
 *     keyed by province id, for rendering.
 *   - src/data/provinces.json — per-province facts the turn-based game reads:
 *     country, name, population, largest city, capital flag, neighbours (land and sea).
 *   - public/province-facts.json — the real-time game's facts (format 2): the
 *     same, plus anchors, edge lengths, sea flags, terrain and goods.
 *
 * Admin-1 units are wildly uneven (the UK has 232, Slovenia 193, Brazil 27),
 * so each country's units are merged greedily — smallest into its smallest
 * neighbour, preferring the same region — down to a target that grows with the
 * square root of the country's area.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { geoArea, geoBounds, geoCentroid, geoContains, geoDistance } from 'd3-geo';
import type { Feature, FeatureCollection, MultiPolygon, Polygon, Position } from 'geojson';
import mapshaper from 'mapshaper';
import { feature, neighbors } from 'topojson-client';
import type { GeometryCollection, Topology } from 'topojson-specification';
import { MAP } from '../src/next/game/balance';
import type { Good, GoodOverride, ProvinceFact, ProvinceFacts, Terrain, TerrainOverride } from '../src/next/game/types';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, '.cache', 'natural-earth');
/** natural-earth-vector master as inspected when this pipeline was written. */
const NATURAL_EARTH_COMMIT = 'ca96624a56bd078437bca8184e78163e5039ad19';
const SOURCES = {
  admin1: 'geojson/ne_10m_admin_1_states_provinces.geojson',
  places: 'geojson/ne_10m_populated_places_simple.geojson',
  regions: 'geojson/ne_10m_geography_regions_polys.geojson',
} as const;

/** Provinces per country = round(sqrt(area km²) / AREA_DIVISOR), at least 1. */
const AREA_DIVISOR = 60;
/**
 * A microstate missing from the 110m map joins the nearest playable country if
 * its outline is this close, in km (Monaco, Malta, Bahrain); anything more
 * remote (Tonga, Saint Helena, Guam) is left off the map, as it always was.
 */
const FOLD_KM = 200;
/**
 * Provinces smaller than this, in km², are merged into a neighbour whatever the
 * country's target: Berlin, Washington D.C. and Macquarie Island are too small to
 * click, and a tiny city-state province would only be a fiddly extra capture.
 */
const MIN_PROVINCE_KM2 = 2500;
/** A same-country island may merge with a group this close, in km, when it has no land neighbour. */
const ISLAND_MERGE_KM = 300;
/** Share of a country's population spread by city population; the rest by area. */
const URBAN_SHARE = 0.55;
/** Share of points kept when simplifying the rendered map. */
const SIMPLIFY = '3%';
const EARTH_RADIUS_KM = 6371;

/** countries-110m ships these three with no id; the game has always used these. */
const SYNTHETIC_IDS: Record<string, string> = { 'N. Cyprus': '900', Somaliland: '901', Kosovo: '902' };
/** Antarctica and the French Southern and Antarctic Lands are not playable. */
const EXCLUDED_COUNTRIES = new Set(['010', '260']);
const EXCLUDED_ADM0 = new Set(['ATA', 'ATF']);

type Area = Polygon | MultiPolygon;

interface Admin1Properties {
  adm0_a3: string;
  admin: string;
  name: string | null;
  region: string | null;
}

interface PlaceProperties {
  name: string;
  adm0_a3: string;
  adm0cap: number;
  pop_max: number;
  latitude: number;
  longitude: number;
}

interface CountrySeed {
  id: string;
  name: string;
  population: number;
  economyTier: number;
}

interface SeaLink {
  a: string;
  b: string;
  note: string;
}

export interface ProvinceCity {
  name: string;
  population: number;
  lon: number;
  lat: number;
}

export interface ProvinceRecord {
  id: string;
  name: string;
  countryId: string;
  population: number;
  areaKm2: number;
  city: ProvinceCity | null;
  capital: boolean;
  neighbours: string[];
}

export interface ProvinceData {
  source: string;
  provinces: ProvinceRecord[];
  /** Neighbour pairs joined across water rather than by a shared border. */
  seaLinks: [string, string][];
}

// --- Inputs -------------------------------------------------------------------

function cached(path: string): string {
  const local = join(CACHE, path.split('/').pop() ?? path);
  if (!existsSync(local)) {
    mkdirSync(CACHE, { recursive: true });
    const url = `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/${NATURAL_EARTH_COMMIT}/${path}`;
    console.log(`downloading ${url}`);
    execFileSync('curl', ['-sSfL', '-o', local, url], { stdio: 'inherit' });
  }
  return readFileSync(local, 'utf8');
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(join(ROOT, path), 'utf8')) as T;
}

const admin1 = JSON.parse(cached(SOURCES.admin1)) as FeatureCollection<Area | null, Admin1Properties>;
const places = JSON.parse(cached(SOURCES.places)) as FeatureCollection<null, PlaceProperties>;
const seeds = readJson<CountrySeed[]>('src/data/countries.seed.json');
const countrySeaLinks = readJson<SeaLink[]>('src/data/sea-links.json');
const seedById = new Map(seeds.map((s) => [s.id, s]));

type CountriesTopology = Topology<{ countries: GeometryCollection<{ name: string }> }>;
const countries110 = readJson<CountriesTopology>('node_modules/world-atlas/countries-110m.json');
const countryShapes = (feature(countries110, countries110.objects.countries) as FeatureCollection<Area, { name: string }>).features
  .map((f) => ({ id: f.id === undefined ? SYNTHETIC_IDS[f.properties.name] : String(f.id), shape: f }))
  .filter((c): c is { id: string; shape: Feature<Area, { name: string }> } => c.id !== undefined && !EXCLUDED_COUNTRIES.has(c.id));

// --- Geometry helpers ---------------------------------------------------------

const areaKm2 = (f: Feature<Area>): number => geoArea(f) * EARTH_RADIUS_KM * EARTH_RADIUS_KM;

function vertices(geometry: Area): Position[] {
  const rings = geometry.type === 'Polygon' ? geometry.coordinates : geometry.coordinates.flat();
  return rings.flat();
}

/** Every `step`-th vertex: enough to measure how close two coastlines come. */
function sample(geometry: Area, step: number): [number, number][] {
  return vertices(geometry)
    .filter((_, i) => i % step === 0)
    .map((p) => [p[0] ?? 0, p[1] ?? 0]);
}

function closestKm(a: [number, number][], b: [number, number][]): number {
  let best = Infinity;
  for (const p of a) for (const q of b) best = Math.min(best, geoDistance(p, q));
  return best * EARTH_RADIUS_KM;
}

// --- 1. Which playable country each admin-1 unit belongs to -------------------

const units = admin1.features
  .filter((f): f is Feature<Area, Admin1Properties> => f.geometry !== null && !EXCLUDED_ADM0.has(f.properties.adm0_a3))
  .map((f, index) => ({ index, f, area: areaKm2(f), centroid: geoCentroid(f) as [number, number], countryId: '' }));

const containing = (point: [number, number]): string | undefined =>
  countryShapes.find((c) => geoContains(c.shape, point))?.id;

// Majority vote of unit centroids per admin-0 code.
const votes = new Map<string, Map<string, number>>();
for (const unit of units) {
  const id = containing(unit.centroid);
  if (!id) continue;
  const tally = votes.get(unit.f.properties.adm0_a3) ?? new Map<string, number>();
  tally.set(id, (tally.get(id) ?? 0) + 1);
  votes.set(unit.f.properties.adm0_a3, tally);
}
const countryOfAdm0 = new Map<string, string>();
for (const [adm0, tally] of votes) {
  const [winner] = [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (winner) countryOfAdm0.set(adm0, winner[0]);
}

// Microstates missing from the 110m map join the playable country whose outline
// comes closest, when one is near enough; the rest are dropped.
const countrySamples = countryShapes.map((c) => ({ id: c.id, points: sample(c.shape.geometry, 1) }));
const folded = new Map<string, string>();
const dropped = new Set<string>();
for (const unit of units) {
  const adm0 = unit.f.properties.adm0_a3;
  const mapped = countryOfAdm0.get(adm0);
  if (mapped) {
    unit.countryId = mapped;
    continue;
  }
  const nearest = countrySamples
    .map((c) => ({ id: c.id, km: closestKm(sample(unit.f.geometry, 5), c.points) }))
    .sort((a, b) => a.km - b.km)[0];
  if (nearest && nearest.km <= FOLD_KM) {
    unit.countryId = nearest.id;
    folded.set(unit.f.properties.admin, seedById.get(nearest.id)?.name ?? nearest.id);
  } else {
    dropped.add(unit.f.properties.admin);
  }
}
for (const [microstate, into] of folded) console.log(`folded ${microstate} into ${into}`);
console.log(`dropped ${dropped.size} remote territories: ${[...dropped].sort().join(', ')}`);
units.splice(0, units.length, ...units.filter((u) => u.countryId !== ''));
for (const c of countryShapes) {
  if (!units.some((u) => u.countryId === c.id)) throw new Error(`country ${c.id} ended up with no provinces`);
}

// --- 2. Land adjacency between admin-1 units ----------------------------------

async function toTopology(
  features: Feature<Area, Record<string, unknown>>[],
  extra: string,
): Promise<Topology<{ layer: GeometryCollection<Record<string, unknown>> }>> {
  const output = await mapshaper.applyCommands(
    `-i layer.json ${extra} -o format=topojson quantization=100000 out.json`,
    { 'layer.json': { type: 'FeatureCollection', features } },
  );
  const text = output['out.json'];
  if (text === undefined) throw new Error('mapshaper produced no output');
  return JSON.parse(typeof text === 'string' ? text : new TextDecoder().decode(text)) as Topology<{
    layer: GeometryCollection<Record<string, unknown>>;
  }>;
}

const unitTopology = await toTopology(
  units.map((u) => ({ ...u.f, properties: { unit: u.index } })),
  '',
);
const unitGeometries = unitTopology.objects.layer.geometries;
/** Geometry properties are typed `{} | P`; read one defensively. */
const prop = (g: { properties?: object | null | undefined }, key: string): unknown =>
  (g.properties as Record<string, unknown> | null | undefined)?.[key];
const unitAt = unitGeometries.map((g) => Number(prop(g, 'unit')));
const unitNeighbours = new Map<number, number[]>();
neighbors(unitGeometries).forEach((list, i) => {
  unitNeighbours.set(unitAt[i] ?? -1, list.map((j) => unitAt[j] ?? -1));
});

// --- 3. Merge each country's units down to its target --------------------------

const parent = new Map(units.map((u) => [u.index, u.index]));
const find = (i: number): number => {
  const p = parent.get(i) ?? i;
  if (p === i) return i;
  const root = find(p);
  parent.set(i, root);
  return root;
};
const unitByIndex = new Map(units.map((u) => [u.index, u]));

for (const countryId of new Set(units.map((u) => u.countryId))) {
  const members = units.filter((u) => u.countryId === countryId);
  const total = members.reduce((sum, u) => sum + u.area, 0);
  const target = Math.max(1, Math.round(Math.sqrt(total) / AREA_DIVISOR));
  const groupArea = new Map(members.map((u) => [u.index, u.area]));
  const stuck = new Set<number>();

  // Two passes: down to the target, then until nothing is too small to click.
  const wanted = (): boolean =>
    groupArea.size > target || [...groupArea.entries()].some(([root, a]) => a < MIN_PROVINCE_KM2 && !stuck.has(root));
  while (groupArea.size > 1 && wanted()) {
    const overTarget = groupArea.size > target;
    const candidates = [...groupArea.entries()]
      .filter(([root, a]) => !stuck.has(root) && (overTarget || a < MIN_PROVINCE_KM2))
      .sort((a, b) => a[1] - b[1]);
    const smallest = candidates[0];
    if (!smallest) break;
    const [root] = smallest;
    const tiny = smallest[1] < MIN_PROVINCE_KM2;
    const inGroup = members.filter((u) => find(u.index) === root);

    let best: { root: number; score: number } | null = null;
    for (const u of inGroup) {
      for (const n of unitNeighbours.get(u.index) ?? []) {
        const other = unitByIndex.get(n);
        if (!other || other.countryId !== countryId) continue;
        const otherRoot = find(n);
        if (otherRoot === root) continue;
        const sameRegion = Boolean(u.f.properties.region) && u.f.properties.region === other.f.properties.region;
        const score = (groupArea.get(otherRoot) ?? 0) * (sameRegion ? 1 : 3);
        if (!best || score < best.score) best = { root: otherRoot, score };
      }
    }
    if (!best) {
      // An island with no land neighbour at home: join the nearest group close by.
      const here = inGroup.map((u) => u.centroid);
      const near = members
        .filter((u) => find(u.index) !== root)
        .map((u) => ({ root: find(u.index), km: closestKm(here, [u.centroid]) }))
        .sort((a, b) => a.km - b.km)[0];
      if (near && (near.km <= ISLAND_MERGE_KM || tiny)) best = { root: near.root, score: 0 };
    }
    if (!best) {
      stuck.add(root);
      continue;
    }
    parent.set(root, best.root);
    groupArea.set(best.root, (groupArea.get(best.root) ?? 0) + smallest[1]);
    groupArea.delete(root);
  }
}

// --- 4. Cities, population, names, ids ----------------------------------------

const placeList = places.features.map((p) => ({
  ...p.properties,
  point: [p.properties.longitude, p.properties.latitude] as [number, number],
}));

interface Group {
  root: number;
  countryId: string;
  members: typeof units;
  area: number;
  cities: typeof placeList;
}
const groups = new Map<number, Group>();
for (const u of units) {
  const root = find(u.index);
  const group = groups.get(root) ?? { root, countryId: u.countryId, members: [], area: 0, cities: [] };
  group.members.push(u);
  group.area += u.area;
  groups.set(root, group);
}

// Assign each city to the unit that contains it, bounding boxes first.
const unitBounds = units.map((u) => ({ u, b: geoBounds(u.f) }));
const inBounds = (b: [[number, number], [number, number]], [x, y]: [number, number]): boolean =>
  y >= b[0][1] && y <= b[1][1] && (b[0][0] <= b[1][0] ? x >= b[0][0] && x <= b[1][0] : x >= b[0][0] || x <= b[1][0]);
for (const place of placeList) {
  const hit = unitBounds.find(({ u, b }) => inBounds(b, place.point) && geoContains(u.f, place.point));
  if (hit) groups.get(find(hit.u.index))?.cities.push(place);
}

function regionName(group: Group): string | null {
  const region = group.members[0]?.f.properties.region;
  if (!region || group.members.length < 2) return null;
  if (!group.members.every((u) => u.f.properties.region === region)) return null;
  const wholeRegion = units.filter((u) => u.countryId === group.countryId && u.f.properties.region === region);
  return wholeRegion.length === group.members.length ? region : null;
}

/**
 * Natural Earth's names are written for atlases, not map labels: it spells the
 * Arabic ayn with a backtick, joins Moroccan regions with " - ", adds alternate
 * spellings in brackets and has a few doubled spaces. Labels keep the first,
 * plain name ("Marrakech", "Homs", "Central Luzon").
 */
function tidyName(name: string): string {
  return name
    .replace(/\s*\([^)]*\)\s*$/, '')
    .split(' - ')[0]!
    .replace(/^`/, '')
    .replace(/`/g, '’')
    .replace(/\s+/g, ' ')
    .trim();
}

function largestMemberName(group: Group): string {
  const topCity = [...group.cities].sort((a, b) => b.pop_max - a.pop_max)[0];
  const home = topCity
    ? group.members.find((u) => geoContains(u.f, topCity.point))
    : [...group.members].sort((a, b) => b.area - a.area)[0];
  return home?.f.properties.name ?? topCity?.name ?? 'Unnamed';
}

const byCountry = new Map<string, Group[]>();
for (const group of groups.values()) {
  const list = byCountry.get(group.countryId) ?? [];
  list.push(group);
  byCountry.set(group.countryId, list);
}

const provinceOfRoot = new Map<number, string>();
const records: ProvinceRecord[] = [];
for (const [countryId, list] of [...byCountry.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  const seed = seedById.get(countryId);
  if (!seed) throw new Error(`no seed for country ${countryId}`);
  const cityPop = (g: Group) => g.cities.reduce((sum, c) => sum + Math.max(0, c.pop_max), 0);
  const totalCityPop = list.reduce((sum, g) => sum + cityPop(g), 0);
  const totalArea = list.reduce((sum, g) => sum + g.area, 0);
  const share = (g: Group): number =>
    totalCityPop > 0 ? URBAN_SHARE * (cityPop(g) / totalCityPop) + (1 - URBAN_SHARE) * (g.area / totalArea) : g.area / totalArea;

  const capitalCity = list
    .flatMap((g) => g.cities.filter((c) => c.adm0cap === 1).map((c) => ({ g, c })))
    .sort((a, b) => b.c.pop_max - a.c.pop_max)[0];
  const capitalGroup = capitalCity?.g ?? [...list].sort((a, b) => share(b) - share(a))[0];

  const ordered = [...list].sort((a, b) => {
    if (a === capitalGroup) return -1;
    if (b === capitalGroup) return 1;
    return share(b) - share(a) || a.root - b.root;
  });

  const usedNames = new Map<string, number>();
  ordered.forEach((g, i) => {
    const id = `${countryId}-${i}`;
    provinceOfRoot.set(g.root, id);
    const topCity = [...g.cities].sort((a, b) => b.pop_max - a.pop_max)[0];
    // A whole region keeps its name; any other merged group is named for its
    // largest city, as the provinces of this genre are; a single unit keeps its own.
    let name =
      list.length === 1
        ? seed.name
        : tidyName(regionName(g) ?? (g.members.length > 1 && topCity ? topCity.name : largestMemberName(g)));
    const seen = usedNames.get(name) ?? 0;
    usedNames.set(name, seen + 1);
    if (seen > 0) name = `${name} ${seen + 1}`;
    records.push({
      id,
      name,
      countryId,
      population: Math.max(1000, Math.round((seed.population * share(g)) / 1000) * 1000),
      areaKm2: Math.round(g.area),
      city: topCity
        ? { name: topCity.name, population: Math.round(topCity.pop_max), lon: +topCity.longitude.toFixed(3), lat: +topCity.latitude.toFixed(3) }
        : null,
      capital: g === capitalGroup,
      neighbours: [],
    });
  });
}
/** A hand fix for a name no rule repairs: a typo in the source, a duplicate, a legal description. */
interface NameOverride {
  country: string;
  province: string;
  name: string;
}
for (const o of readJson<NameOverride[]>('src/data/name-overrides.json')) {
  const r = namedProvince(o.country, o.province, 'name-overrides.json');
  // A province named for its largest city carries the same typo in the city.
  if (r.city?.name === r.name) r.city.name = o.name;
  r.name = o.name;
}
const recordById = new Map(records.map((r) => [r.id, r]));

// --- 5. Dissolve and simplify -------------------------------------------------

const labelled = units.map((u) => ({ ...u.f, properties: { province: provinceOfRoot.get(find(u.index)) ?? '' } }));
const dissolved = await toTopology(labelled, '-dissolve province');
const renderTopology = await toTopology(
  (feature(dissolved, dissolved.objects.layer) as FeatureCollection<Area, Record<string, unknown>>).features,
  `-simplify dp ${SIMPLIFY} keep-shapes -clean`,
);

// Land neighbours from the unsimplified dissolve, so slivers never lose a border.
const dissolvedIds = dissolved.objects.layer.geometries.map((g) => String(prop(g, 'province')));
const link = (a: string, b: string): void => {
  const ra = recordById.get(a);
  const rb = recordById.get(b);
  if (!ra || !rb || a === b) return;
  if (!ra.neighbours.includes(b)) ra.neighbours.push(b);
  if (!rb.neighbours.includes(a)) rb.neighbours.push(a);
};
neighbors(dissolved.objects.layer.geometries).forEach((list, i) => {
  for (const j of list) link(dissolvedIds[i] ?? '', dissolvedIds[j] ?? '');
});

// --- 6. Sea links: the authored country crossings, then any stranded island ----

const renderFeatures = (feature(renderTopology, renderTopology.objects.layer) as FeatureCollection<Area, Record<string, unknown>>).features;
const shapeSample = new Map(renderFeatures.map((f) => [String(f.properties['province']), sample(f.geometry, 3)]));
const seaLinks: [string, string][] = [];
const seaLink = (a: string, b: string): void => {
  const ra = recordById.get(a);
  if (!ra || ra.neighbours.includes(b)) return;
  link(a, b);
  seaLinks.push(a < b ? [a, b] : [b, a]);
};

function closestPair(from: string[], to: string[]): { a: string; b: string; km: number } | null {
  let best: { a: string; b: string; km: number } | null = null;
  for (const a of from) {
    for (const b of to) {
      const km = closestKm(shapeSample.get(a) ?? [], shapeSample.get(b) ?? []);
      if (!best || km < best.km) best = { a, b, km };
    }
  }
  return best;
}

const provincesOf = (countryId: string) => records.filter((r) => r.countryId === countryId).map((r) => r.id);
for (const crossing of countrySeaLinks) {
  const pair = closestPair(provincesOf(crossing.a), provincesOf(crossing.b));
  if (pair) seaLink(pair.a, pair.b);
}

function components(): string[][] {
  const seen = new Set<string>();
  const out: string[][] = [];
  for (const start of records) {
    if (seen.has(start.id)) continue;
    const queue = [start.id];
    seen.add(start.id);
    for (let head = 0; head < queue.length; head += 1) {
      for (const n of recordById.get(queue[head] ?? '')?.neighbours ?? []) {
        if (!seen.has(n)) {
          seen.add(n);
          queue.push(n);
        }
      }
    }
    out.push(queue);
  }
  return out.sort((a, b) => b.length - a.length);
}

// Join every smaller landmass to its nearest province elsewhere, a country's
// own coast first when it is nearly as close, until the world is one graph.
for (let parts = components(); parts.length > 1; parts = components()) {
  const island = parts[parts.length - 1] ?? [];
  const rest = records.map((r) => r.id).filter((id) => !island.includes(id));
  const home = recordById.get(island[0] ?? '')?.countryId;
  const any = closestPair(island, rest);
  const domestic = closestPair(island, rest.filter((id) => recordById.get(id)?.countryId === home));
  const chosen = domestic && any && domestic.km <= any.km * 1.5 ? domestic : any;
  if (!chosen) throw new Error('cannot connect the world');
  seaLink(chosen.a, chosen.b);
}

// --- 7. Write -----------------------------------------------------------------

for (const r of records) r.neighbours.sort();
seaLinks.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));

for (const g of renderTopology.objects.layer.geometries) {
  g.id = String(prop(g, 'province'));
  delete g.properties;
}
const renderOut = { ...renderTopology, objects: { provinces: renderTopology.objects.layer } };
writeFileSync(join(ROOT, 'public', 'provinces.json'), JSON.stringify(renderOut));

const data: ProvinceData = {
  source: `Natural Earth 10m admin-1 and populated places @ ${NATURAL_EARTH_COMMIT}, merged by scripts/build-provinces.mts`,
  provinces: records,
  seaLinks,
};
// One province per line: small, and a rebuild diffs province by province.
const lines = [
  '{',
  `"source": ${JSON.stringify(data.source)},`,
  '"provinces": [',
  data.provinces.map((r) => JSON.stringify(r)).join(',\n'),
  '],',
  `"seaLinks": ${JSON.stringify(data.seaLinks)}`,
  '}',
];
writeFileSync(join(ROOT, 'src', 'data', 'provinces.json'), `${lines.join('\n')}\n`);

const counts = [...byCountry.entries()].map(([id, list]) => `${seedById.get(id)?.name ?? id} ${list.length}`);
console.log(`${records.length} provinces in ${byCountry.size} countries, ${seaLinks.length} sea links`);
console.log(counts.sort().join(', '));

// --- 8. Real-time facts: anchors, edge lengths, terrain, goods (pipeline v2) ---

const RAD = Math.PI / 180;
type RegionClass = 'Range/mtn' | 'Desert' | 'Plateau' | 'Foothills' | 'Tundra';
const REGION_CLASSES: ReadonlySet<string> = new Set<RegionClass>(['Range/mtn', 'Desert', 'Plateau', 'Foothills', 'Tundra']);

/** A polygon set in plain lon/lat, for fast point tests. */
interface Shape {
  rings: Position[][];
  bbox: [number, number, number, number];
}

function toShape(geometry: Area): Shape {
  const rings = geometry.type === 'Polygon' ? geometry.coordinates : geometry.coordinates.flat();
  const bbox: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const ring of rings) {
    for (const [x = 0, y = 0] of ring) {
      bbox[0] = Math.min(bbox[0], x);
      bbox[1] = Math.min(bbox[1], y);
      bbox[2] = Math.max(bbox[2], x);
      bbox[3] = Math.max(bbox[3], y);
    }
  }
  return { rings, bbox };
}

/**
 * Even-odd rule over every ring, so holes and multipolygons need no special
 * case. Planar in lon/lat, which is how the world test re-checks anchors
 * against public/provinces.json without a geo library.
 */
function insidePlanar(shape: Shape, x: number, y: number): boolean {
  const [x0, y0, x1, y1] = shape.bbox;
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  let inside = false;
  for (const ring of shape.rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      const [xi = 0, yi = 0] = ring[i] ?? [];
      const [xj = 0, yj = 0] = ring[j] ?? [];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/** Distance to the nearest ring edge, in degrees of latitude (longitude scaled by cos lat). */
function boundaryDistance(shape: Shape, x: number, y: number): number {
  const k = Math.cos(y * RAD);
  let best = Infinity;
  for (const ring of shape.rings) {
    for (let i = 1; i < ring.length; i += 1) {
      const [ax = 0, ay = 0] = ring[i - 1] ?? [];
      const [bx = 0, by = 0] = ring[i] ?? [];
      const dx = (bx - ax) * k;
      const dy = by - ay;
      const px = (x - ax) * k;
      const py = y - ay;
      const len = dx * dx + dy * dy;
      const t = len > 0 ? Math.max(0, Math.min(1, (px * dx + py * dy) / len)) : 0;
      best = Math.min(best, Math.hypot(px - t * dx, py - t * dy));
    }
  }
  return best;
}

function largestPolygon(geometry: Area): Polygon {
  if (geometry.type === 'Polygon') return geometry;
  let best: Polygon = { type: 'Polygon', coordinates: geometry.coordinates[0] ?? [] };
  let bestArea = -1;
  for (const coordinates of geometry.coordinates) {
    const polygon: Polygon = { type: 'Polygon', coordinates };
    const area = geoArea(polygon);
    if (area > bestArea) {
      best = polygon;
      bestArea = area;
    }
  }
  return best;
}

const round = (value: number, decimals: number): number => {
  const k = 10 ** decimals;
  return Math.round(value * k) / k;
};

/** 32-bit FNV-1a over UTF-16 code units: the hills coin flip and the map version. */
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// Anchors are chosen against the rendered (simplified) outline, because that is
// where the player sees armies stand, and it is what the world test can check.
const renderShapes = new Map(
  renderFeatures.map((f) => [String(f.properties['province']), { f, shape: toShape(f.geometry) }]),
);
const anchorRules = { city: 0, centroid: 0, grid: 0 };

function chooseAnchor(r: ProvinceRecord): [number, number] {
  const render = renderShapes.get(r.id);
  if (!render) throw new Error(`no rendered shape for ${r.id}`);
  const within = (p: [number, number]): boolean => geoContains(render.f, p) && insidePlanar(render.shape, p[0], p[1]);
  if (r.city && within([r.city.lon, r.city.lat])) {
    anchorRules.city += 1;
    return [r.city.lon, r.city.lat];
  }
  const main = largestPolygon(render.f.geometry);
  const centre = geoCentroid(main);
  const centroid: [number, number] = [round(centre[0], 4), round(centre[1], 4)];
  if (within(centroid)) {
    anchorRules.centroid += 1;
    return centroid;
  }
  // The pole of inaccessibility on a 16x16 grid, refined only if a sliver defeats it.
  const [x0, y0, x1, y1] = toShape(main).bbox;
  for (let cells = 16; cells <= 256; cells *= 2) {
    let best: { p: [number, number]; d: number } | null = null;
    for (let i = 0; i < cells; i += 1) {
      for (let j = 0; j < cells; j += 1) {
        const p: [number, number] = [round(x0 + ((i + 0.5) / cells) * (x1 - x0), 4), round(y0 + ((j + 0.5) / cells) * (y1 - y0), 4)];
        if (!within(p)) continue;
        const d = boundaryDistance(render.shape, p[0], p[1]);
        if (!best || d > best.d) best = { p, d };
      }
    }
    if (best) {
      if (cells > 16) console.log(`anchor for ${r.id} ${r.name} needed a ${cells}x${cells} grid`);
      anchorRules.grid += 1;
      return best.p;
    }
  }
  throw new Error(`no interior point found for ${r.id} ${r.name}`);
}

const anchors = new Map(records.map((r) => [r.id, chooseAnchor(r)]));
const anchorOf = (id: string): [number, number] => {
  const a = anchors.get(id);
  if (!a) throw new Error(`no anchor for ${id}`);
  return a;
};

// Terrain samples the true (unsimplified) outline.
const regionFile = JSON.parse(cached(SOURCES.regions)) as FeatureCollection<Area | null, { FEATURECLA: string }>;
const regionShapes = regionFile.features
  .filter((f): f is Feature<Area, { FEATURECLA: string }> => f.geometry !== null && REGION_CLASSES.has(f.properties.FEATURECLA))
  .map((f) => ({ cls: f.properties.FEATURECLA as RegionClass, shape: toShape(f.geometry) }));
const trueShapes = new Map(
  (feature(dissolved, dissolved.objects.layer) as FeatureCollection<Area, Record<string, unknown>>).features.map((f) => [
    String(f.properties['province']),
    toShape(f.geometry),
  ]),
);

function classify(r: ProvinceRecord, anchor: [number, number]): Terrain {
  const shape = trueShapes.get(r.id);
  if (!shape) throw new Error(`no shape for ${r.id}`);
  const n = MAP.TERRAIN_SAMPLES;
  const [x0, y0, x1, y1] = shape.bbox;
  const points: [number, number][] = [];
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      const x = x0 + ((i + 0.5) / n) * (x1 - x0);
      const y = y0 + ((j + 0.5) / n) * (y1 - y0);
      if (insidePlanar(shape, x, y)) points.push([x, y]);
    }
  }
  // A province too thin for the grid is judged at its anchor.
  if (points.length === 0) points.push(anchor);
  const share = (classes: readonly RegionClass[]): number =>
    points.filter(([x, y]) => regionShapes.some((g) => classes.includes(g.cls) && insidePlanar(g.shape, x, y))).length /
    points.length;

  const density = r.population / r.areaKm2;
  const lat = Math.abs(anchor[1]);
  const cityPop = r.city?.population ?? 0;
  const mountains = share(['Range/mtn']);
  if (
    (density >= MAP.URBAN_DENSITY && r.areaKm2 < MAP.URBAN_MAX_AREA_KM2) ||
    (cityPop >= MAP.URBAN_BIG_CITY && density >= MAP.URBAN_BIG_CITY_DENSITY)
  )
    return 'urban';
  if (mountains >= MAP.MOUNTAIN_SHARE) return 'mountains';
  if (share(['Desert']) >= MAP.DESERT_SHARE) return 'desert';
  if ((lat >= MAP.ARCTIC_LAT && density < MAP.ARCTIC_MAX_DENSITY) || share(['Tundra']) >= MAP.TUNDRA_SHARE) return 'arctic';
  if (share(['Plateau', 'Foothills']) >= MAP.HILLS_SHARE || mountains >= MAP.HILLS_MOUNTAIN_SHARE) return 'hills';
  if (lat <= MAP.JUNGLE_LAT && density < MAP.JUNGLE_MAX_DENSITY) return 'jungle';
  return 'plains';
}

const terrainOf = new Map(records.map((r) => [r.id, classify(r, anchorOf(r.id))]));

/** The one province an override names, or a build failure: overrides must never silently miss. */
function namedProvince(country: string, name: string, file: string): ProvinceRecord {
  const hits = records.filter((r) => r.countryId === country && r.name === name);
  if (hits.length !== 1) throw new Error(`${file}: ${country} ${name} matches ${hits.length} provinces`);
  return hits[0] as ProvinceRecord;
}

const terrainOverrides = readJson<TerrainOverride[]>('src/data/terrain-overrides.json');
for (const o of terrainOverrides) {
  const targets =
    o.province === undefined
      ? records.filter((r) => r.countryId === o.country)
      : [namedProvince(o.country, o.province, 'terrain-overrides.json')];
  if (targets.length === 0) throw new Error(`terrain-overrides.json: country ${o.country} has no provinces`);
  for (const r of targets) if (o.from === undefined || terrainOf.get(r.id) === o.from) terrainOf.set(r.id, o.to);
}

const goodOf = new Map<string, { good: Good; oilField: boolean }>();
for (const r of records) {
  const terrain = terrainOf.get(r.id) ?? 'plains';
  const good: Good =
    terrain === 'plains' || terrain === 'jungle'
      ? 'food'
      : terrain === 'mountains' || terrain === 'urban'
        ? 'steel'
        : terrain === 'desert' || terrain === 'arctic'
          ? 'oil'
          : fnv1a(r.id) / 4294967296 < MAP.HILLS_STEEL_SHARE
            ? 'steel'
            : 'food';
  goodOf.set(r.id, { good, oilField: false });
}
for (const o of readJson<GoodOverride[]>('src/data/good-overrides.json')) {
  const r = namedProvince(o.country, o.province, 'good-overrides.json');
  goodOf.set(r.id, { good: o.good, oilField: o.oilField });
}

const seaPairs = new Set(seaLinks.map(([a, b]) => `${a}|${b}`));
const edgeKm = (a: string, b: string): number => {
  // Measured once per unordered pair, so both directions carry the same number.
  const [p, q] = a < b ? [a, b] : [b, a];
  return round(geoDistance(anchorOf(p), anchorOf(q)) * EARTH_RADIUS_KM, 1);
};

const facts: ProvinceFact[] = records.map((r) => {
  const anchor = anchorOf(r.id);
  const lon = anchor[0] * RAD;
  const lat = anchor[1] * RAD;
  const good = goodOf.get(r.id) ?? { good: 'food', oilField: false };
  return {
    id: r.id,
    name: r.name,
    countryId: r.countryId,
    population: r.population,
    areaKm2: r.areaKm2,
    city: r.city,
    capital: r.capital,
    anchor,
    xyz: [round(Math.cos(lat) * Math.cos(lon), 6), round(Math.cos(lat) * Math.sin(lon), 6), round(Math.sin(lat), 6)],
    terrain: terrainOf.get(r.id) ?? 'plains',
    good: good.good,
    oilField: good.oilField,
    neighbours: r.neighbours,
    edgeKm: r.neighbours.map((n) => edgeKm(r.id, n)),
    sea: r.neighbours.map((n) => seaPairs.has(r.id < n ? `${r.id}|${n}` : `${n}|${r.id}`)),
  };
});

/** The map version saves carry as mapHash: FNV-1a over ids, neighbours, terrain and good, in file order. */
const version = fnv1a(facts.map((f) => `${f.id}|${f.neighbours.join(',')}|${f.terrain}|${f.good}\n`).join(''))
  .toString(16)
  .padStart(8, '0');
const factsOut: ProvinceFacts = {
  source: `Natural Earth 10m admin-1, populated places and geography regions @ ${NATURAL_EARTH_COMMIT}, built by scripts/build-provinces.mts (pipeline v2)`,
  format: 2,
  version,
  provinces: facts,
};
const factLines = [
  '{',
  `"source": ${JSON.stringify(factsOut.source)},`,
  `"format": ${factsOut.format},`,
  `"version": ${JSON.stringify(factsOut.version)},`,
  '"provinces": [',
  factsOut.provinces.map((f) => JSON.stringify(f)).join(',\n'),
  ']',
  '}',
];
writeFileSync(join(ROOT, 'public', 'province-facts.json'), `${factLines.join('\n')}\n`);

const tally = <K extends string>(keys: K[]): string =>
  Object.entries(keys.reduce<Record<string, number>>((acc, k) => ({ ...acc, [k]: (acc[k] ?? 0) + 1 }), {}))
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k} ${n}`)
    .join(', ');
console.log(`anchors: ${anchorRules.city} at the largest city, ${anchorRules.centroid} at a centroid, ${anchorRules.grid} on the grid`);
console.log(`terrain: ${tally(facts.map((f) => f.terrain))}`);
console.log(`goods: ${tally(facts.map((f) => f.good))}; ${facts.filter((f) => f.oilField).length} oil fields`);
console.log(`province-facts.json version ${version}`);
