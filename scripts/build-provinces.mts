/**
 * Builds the province map from Natural Earth (public domain):
 *
 *   npx tsx scripts/build-provinces.mts
 *
 * Inputs, downloaded once into .cache/natural-earth at a pinned commit:
 *   - 10m admin-1 states and provinces (4,596 units across 251 countries)
 *   - 10m populated places (7,342 cities with population and capital flags)
 * plus world-atlas countries-110m for the 175 playable countries and
 * src/data/countries.seed.json / sea-links.json.
 *
 * Outputs, both committed:
 *   - public/provinces.json — simplified TopoJSON, one geometry per province,
 *     keyed by province id, for rendering.
 *   - src/data/provinces.json — per-province facts the game reads: country,
 *     name, population, largest city, capital flag, neighbours (land and sea).
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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, '.cache', 'natural-earth');
/** natural-earth-vector master as inspected when this pipeline was written. */
const NATURAL_EARTH_COMMIT = 'ca96624a56bd078437bca8184e78163e5039ad19';
const SOURCES = {
  admin1: 'geojson/ne_10m_admin_1_states_provinces.geojson',
  places: 'geojson/ne_10m_populated_places_simple.geojson',
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
        : (regionName(g) ?? (g.members.length > 1 && topCity ? topCity.name : largestMemberName(g)));
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
