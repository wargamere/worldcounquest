/**
 * Loads the three map files the game needs (§2.1, §9.6): the simplified
 * province outlines (`public/provinces.json`, TopoJSON), the derived facts
 * (`public/province-facts.json`) and the authored country seeds, which are
 * small enough to ship inside the bundle. Everything is fetched under the
 * deployment basePath, and every file is checked before it is used, so a stale
 * or truncated deploy fails with a message that names the bad file.
 */
import type { GeometryCollection, Topology } from 'topojson-specification';
import seedsJson from '@/data/countries.seed.json';
import { parseFacts } from '@/next/game/world';
import type { CountrySeed, ProvinceFacts } from '@/next/game/types';

export type ProvincesTopology = Topology<{ provinces: GeometryCollection<{ id: string }> }>;
export interface MapFiles {
  topology: ProvincesTopology;
  facts: ProvinceFacts;
  seeds: readonly CountrySeed[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Checks the parts of the topology geometry.ts reads; throws a descriptive Error otherwise. */
export function parseTopology(json: unknown): ProvincesTopology {
  if (!isRecord(json) || json['type'] !== 'Topology') throw new Error('provinces.json is not a TopoJSON topology');
  const arcs = json['arcs'];
  if (!Array.isArray(arcs) || arcs.length === 0) throw new Error('provinces.json has no arcs');
  const transform = json['transform'];
  if (transform !== undefined) {
    const ok = isRecord(transform) && Array.isArray(transform['scale']) && Array.isArray(transform['translate']);
    if (!ok) throw new Error('provinces.json has a malformed transform');
  }
  const objects = json['objects'];
  const provinces = isRecord(objects) ? objects['provinces'] : undefined;
  if (!isRecord(provinces) || provinces['type'] !== 'GeometryCollection' || !Array.isArray(provinces['geometries'])) {
    throw new Error('provinces.json has no "provinces" geometry collection');
  }
  provinces['geometries'].forEach((geometry: unknown, i) => {
    if (!isRecord(geometry) || typeof geometry['id'] !== 'string') throw new Error(`provinces.json geometries[${i}] has no string id`);
    const type = geometry['type'];
    if (type !== 'Polygon' && type !== 'MultiPolygon') throw new Error(`provinces.json geometries[${i}] is a ${String(type)}, not a polygon`);
    if (!Array.isArray(geometry['arcs'])) throw new Error(`provinces.json geometries[${i}] has no arcs`);
  });
  return json as unknown as ProvincesTopology;
}

/** Validates the country seed rows. */
export function parseSeeds(json: unknown): CountrySeed[] {
  if (!Array.isArray(json)) throw new Error('countries.seed.json is not an array');
  return json.map((row: unknown, i): CountrySeed => {
    const ok =
      isRecord(row) &&
      typeof row['id'] === 'string' &&
      typeof row['name'] === 'string' &&
      typeof row['population'] === 'number' &&
      typeof row['economyTier'] === 'number';
    if (!ok) throw new Error(`countries.seed.json row ${i} needs id, name, population and economyTier`);
    return { id: row['id'] as string, name: row['name'] as string, population: row['population'] as number, economyTier: row['economyTier'] as number };
  });
}

async function fetchJson(url: string, label: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load the ${label} (${response.status}).`);
  return (await response.json()) as unknown;
}

/** Fetches and validates the map files under `basePath` (no CDN at runtime). */
export async function fetchMapFiles(basePath: string): Promise<MapFiles> {
  const [topology, facts] = await Promise.all([
    fetchJson(`${basePath}/provinces.json`, 'province outlines'),
    fetchJson(`${basePath}/province-facts.json`, 'province facts'),
  ]);
  return { topology: parseTopology(topology), facts: parseFacts(facts), seeds: parseSeeds(seedsJson) };
}
