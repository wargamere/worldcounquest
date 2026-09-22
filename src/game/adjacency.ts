import type { AdjacencyGraph, CountryId, SeaLink } from './types';

/**
 * Builds the territory adjacency graph.
 *
 * Land borders come from topojson.neighbors(), which returns, for each geometry
 * index, the indices of the geometries sharing an arc. That call lives in the
 * map-loading layer; this function takes its plain output so it stays pure and
 * testable.
 *
 * Sea links are added on top from authored data — islands would otherwise be
 * unreachable and the game unwinnable.
 *
 * Geometries whose id is missing or not playable (e.g. Antarctica) are dropped,
 * and the result is symmetric with no self-edges or duplicates.
 */
export function buildAdjacency(
  neighbourIndices: readonly (readonly number[])[],
  idsByIndex: readonly (CountryId | undefined)[],
  seaLinks: readonly SeaLink[],
  playableIds: ReadonlySet<CountryId>,
): AdjacencyGraph {
  const sets = new Map<CountryId, Set<CountryId>>();
  for (const id of playableIds) sets.set(id, new Set());

  const link = (a: CountryId | undefined, b: CountryId | undefined): void => {
    if (a === undefined || b === undefined || a === b) return;
    const aSet = sets.get(a);
    const bSet = sets.get(b);
    if (!aSet || !bSet) return;
    aSet.add(b);
    bSet.add(a);
  };

  neighbourIndices.forEach((neighbours, index) => {
    const from = idsByIndex[index];
    for (const neighbourIndex of neighbours) link(from, idsByIndex[neighbourIndex]);
  });

  for (const sea of seaLinks) link(sea.a, sea.b);

  const graph: AdjacencyGraph = {};
  for (const [id, neighbours] of sets) graph[id] = [...neighbours].sort();
  return graph;
}

export function areAdjacent(graph: AdjacencyGraph, a: CountryId, b: CountryId): boolean {
  return graph[a]?.includes(b) ?? false;
}

/** Countries reachable from `id` that are NOT owned by `ownerId`. */
export function hostileNeighbours(
  graph: AdjacencyGraph,
  countries: Record<CountryId, { ownerId: string }>,
  id: CountryId,
  ownerId: string,
): CountryId[] {
  return (graph[id] ?? []).filter((n) => countries[n] !== undefined && countries[n].ownerId !== ownerId);
}

/** Countries in the graph with no neighbours at all — these would be unplayable. */
export function isolatedCountries(graph: AdjacencyGraph): CountryId[] {
  return Object.keys(graph).filter((id) => (graph[id] ?? []).length === 0);
}
