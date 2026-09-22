import { feature, neighbors } from 'topojson-client';
import type { GeometryCollection, Topology } from 'topojson-specification';
import type { Feature, MultiPolygon, Polygon } from 'geojson';
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
}

export interface World {
  shapes: CountryShape[];
  adjacency: AdjacencyGraph;
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
    shapes.push({ id, name: shape.properties.name, feature: shape });
  });

  const adjacency = buildAdjacency(neighbors(geometries), idsByIndex, seaLinks, playableIds);
  return { shapes, adjacency };
}

/** Loads the vendored topology. No CDN at runtime. */
export async function fetchTopology(basePath: string): Promise<CountriesTopology> {
  const response = await fetch(`${basePath}/countries-110m.json`);
  if (!response.ok) throw new Error(`Could not load the world map (${response.status}).`);
  return (await response.json()) as CountriesTopology;
}
