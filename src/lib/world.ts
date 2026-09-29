import { feature, mesh, neighbors } from 'topojson-client';
import type { GeometryCollection, Topology } from 'topojson-specification';
import type { Feature, MultiLineString, MultiPolygon, Polygon } from 'geojson';
import { geoArea } from 'd3-geo';
import { buildAdjacency } from '@/game/adjacency';
import type { AdjacencyGraph, CountryId, CountrySeed, SeaLink } from '@/game/types';

/**
 * countries-110m ships three geometries with no `id` at all (disputed
 * territories). They get ids in the 9xx private-use range so every territory has
 * a stable key. Verified against the file, not assumed — see scripts/inspect-topojson.ts.
 */
export const SYNTHETIC_IDS: Record<string, CountryId> = {
  'N. Cyprus': '900',
  Somaliland: '901',
  Kosovo: '902',
};

/** Antarctica and the French Southern and Antarctic Lands are not playable. */
export const EXCLUDED_IDS: ReadonlySet<CountryId> = new Set(['010', '260']);

export interface CountryShape {
  id: CountryId;
  name: string;
  feature: Feature<Polygon | MultiPolygon>;
  /**
   * The country's largest polygon. Labels and camera framing use this rather than
   * the whole feature: France's full centroid is pulled out to sea by French
   * Guiana, and the United States' toward Alaska.
   */
  mainland: Feature<Polygon>;
}

export interface World {
  shapes: CountryShape[];
  adjacency: AdjacencyGraph;
  topology: CountriesTopology;
  /** Country id for each geometry in the topology, in topology order. */
  idsByIndex: (CountryId | undefined)[];
}

interface CountryProperties {
  name: string;
}

export type CountriesTopology = Topology<{ countries: GeometryCollection<CountryProperties> }>;

/**
 * The topology's geometry properties are typed as `P | {}`, so the name is read
 * defensively rather than asserted.
 */
function geometryName(properties: CountryProperties | Record<string, never> | undefined): string {
  if (properties && 'name' in properties && typeof properties.name === 'string') {
    return properties.name;
  }
  return '';
}

/** The largest single polygon of a country, by spherical area. */
export function largestPolygon(shape: Feature<Polygon | MultiPolygon>): Feature<Polygon> {
  if (shape.geometry.type === 'Polygon') {
    return { type: 'Feature', properties: {}, geometry: shape.geometry };
  }
  let best: Polygon | null = null;
  let bestArea = -1;
  for (const coordinates of shape.geometry.coordinates) {
    const polygon: Polygon = { type: 'Polygon', coordinates };
    const area = geoArea(polygon);
    if (area > bestArea) {
      best = polygon;
      bestArea = area;
    }
  }
  return { type: 'Feature', properties: {}, geometry: best ?? { type: 'Polygon', coordinates: [] } };
}

/** Resolves the id for a geometry, falling back to the synthetic table. */
function resolveId(id: string | number | undefined, name: string): CountryId | undefined {
  if (id !== undefined) return String(id);
  return SYNTHETIC_IDS[name];
}

/**
 * Turns the raw topology into drawable shapes plus the adjacency graph.
 * Pure — no fetch, no DOM — so it can be exercised in tests against the real file.
 */
export function buildWorld(
  topology: CountriesTopology,
  seeds: readonly CountrySeed[],
  seaLinks: readonly SeaLink[],
): World {
  const geometries = topology.objects.countries.geometries;
  const playableIds = new Set(seeds.map((s) => s.id));

  const idsByIndex = geometries.map((geometry) =>
    resolveId(geometry.id, geometryName(geometry.properties)),
  );

  const collection = feature(topology, topology.objects.countries) as unknown as {
    features: Feature<Polygon | MultiPolygon, CountryProperties>[];
  };

  const shapes: CountryShape[] = [];
  collection.features.forEach((shape, index) => {
    const id = idsByIndex[index];
    if (id === undefined || EXCLUDED_IDS.has(id) || !playableIds.has(id)) return;
    shapes.push({ id, name: shape.properties.name, feature: shape, mainland: largestPolygon(shape) });
  });

  const adjacency = buildAdjacency(neighbors(geometries), idsByIndex, seaLinks, playableIds);
  return { shapes, adjacency, topology, idsByIndex };
}

/**
 * Lines along every land border where the two sides belong to different
 * nations — the outlines of empires, not of countries. Drawn heavier than
 * country borders so the political map reads as a handful of blocs, and serving
 * as the separator wherever two similar colours meet.
 */
export function nationBorders(world: World, ownerOf: (id: CountryId) => string | undefined): MultiLineString {
  const index = new Map<object, CountryId | undefined>();
  world.topology.objects.countries.geometries.forEach((geometry, i) => {
    index.set(geometry, world.idsByIndex[i]);
  });
  const owner = (geometry: object): string | undefined => {
    const id = index.get(geometry);
    return id === undefined ? undefined : ownerOf(id);
  };
  return mesh(world.topology, world.topology.objects.countries, (a, b) => {
    const oa = owner(a);
    const ob = owner(b);
    return oa !== undefined && ob !== undefined && oa !== ob;
  });
}

/** Loads the vendored topology. No CDN at runtime. */
export async function fetchTopology(basePath: string): Promise<CountriesTopology> {
  const response = await fetch(`${basePath}/countries-110m.json`);
  if (!response.ok) throw new Error(`Could not load the world map (${response.status}).`);
  return (await response.json()) as CountriesTopology;
}
