import type { AdjacencyGraph, NationId } from './types';

/**
 * AI nation colours: the reference data-viz palette's validated dark-mode steps,
 * minus yellow, which is kept back so the player's gold is unique on the map.
 */
export const PALETTE = [
  '#3987e5', // blue
  '#d95926', // orange
  '#199e70', // aqua
  '#d55181', // magenta
  '#008300', // green
  '#9085e9', // violet
  '#e66767', // red
] as const;

/**
 * The player. Validated against every AI colour on the ocean surface #0b1120:
 * worst colour-blind ΔE 17.5, worst normal-vision ΔE 22.8. Deliberately brighter
 * than the AI band so "you are here" reads at a glance.
 */
export const PLAYER_COLOUR = '#f2c14e';
export const UNCLAIMED_COLOUR = '#1e293b';

const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

/**
 * Cost of two colours meeting at a border, from the palette validator
 * (scripts/validate_palette.js --pairs all, dark mode, surface #0b1120).
 *
 * Seven hues cannot pass all-pairs, and on this map no colouring can keep every
 * failing pair apart — an exhaustive search proves it infeasible — so failures
 * are ranked instead:
 *  - normal-vision ΔE below 15 (hard to tell apart for everyone): cost 10
 *  - colour-blind ΔE below 6 only: cost 3
 *  - colour-blind ΔE in the 6–8 floor band only: cost 1
 * Identical colours are never allowed. Every border between two nations is also
 * drawn as a line, which is the secondary encoding for whatever pairs remain.
 */
const PAIR_COST: ReadonlyMap<string, number> = new Map([
  [pairKey('#3987e5', '#9085e9'), 10], // blue–violet: CVD 1.9, normal 9.8
  [pairKey('#d95926', '#d55181'), 10], // orange–magenta: normal 11.6
  [pairKey('#d95926', '#e66767'), 10], // orange–red: normal 7.1
  [pairKey('#199e70', '#008300'), 10], // aqua–green: normal 11.9
  [pairKey('#d55181', '#e66767'), 10], // magenta–red: normal 7.8
  [pairKey('#d95926', '#008300'), 3], // orange–green: CVD 2.7
  [pairKey('#199e70', '#d55181'), 3], // aqua–magenta: CVD 1.6
  [pairKey('#199e70', '#e66767'), 1], // aqua–red: CVD 6.5
]);

/** Cost of `a` and `b` sharing a border. Infinite for the same colour. */
export function borderCost(a: string, b: string): number {
  if (a === b) return Number.POSITIVE_INFINITY;
  return PAIR_COST.get(pairKey(a, b)) ?? 0;
}

function costAt(
  colours: Record<NationId, string>,
  adjacency: AdjacencyGraph,
  id: NationId,
  colour: string,
): number {
  let total = 0;
  for (const n of adjacency[id] ?? []) {
    const c = colours[n];
    if (c !== undefined) total += borderCost(colour, c);
  }
  return total;
}

/**
 * Assigns each starting nation a colour. Guarantees no two neighbours share a
 * colour, then minimises the validator-ranked cost of the pairs that do meet.
 *
 * Built in two passes: DSatur (colour next whichever nation has the most
 * distinct neighbouring colours, i.e. the fewest options left), then a
 * deterministic local search that recolours one nation at a time whenever a
 * cheaper distinct colour exists. Same input, same map, every time.
 *
 * Colours are fixed at game start: a nation keeps its colour as it grows.
 */
export function assignColours(
  nationIds: readonly NationId[],
  adjacency: AdjacencyGraph,
  playerId: NationId,
): Record<NationId, string> {
  const colours: Record<NationId, string> = { [playerId]: PLAYER_COLOUR };
  const pending = new Set(nationIds.filter((id) => id !== playerId));

  const saturation = (id: NationId): number =>
    new Set((adjacency[id] ?? []).map((n) => colours[n]).filter(Boolean)).size;
  const degree = (id: NationId): number => adjacency[id]?.length ?? 0;

  while (pending.size > 0) {
    let next: NationId | null = null;
    for (const id of pending) {
      if (next === null) {
        next = id;
        continue;
      }
      const s = saturation(id) - saturation(next);
      const d = degree(id) - degree(next);
      if (s > 0 || (s === 0 && (d > 0 || (d === 0 && id < next)))) next = id;
    }
    if (next === null) break;
    pending.delete(next);
    colours[next] = cheapest(colours, adjacency, next);
  }

  const ids = Object.keys(colours).filter((id) => id !== playerId).sort();
  for (let pass = 0; pass < 50; pass += 1) {
    let improved = false;
    for (const id of ids) {
      const current = colours[id]!;
      const best = cheapest(colours, adjacency, id);
      if (costAt(colours, adjacency, id, best) < costAt(colours, adjacency, id, current)) {
        colours[id] = best;
        improved = true;
      }
    }
    if (!improved) break;
  }
  return colours;
}

function cheapest(colours: Record<NationId, string>, adjacency: AdjacencyGraph, id: NationId): string {
  let best: string = PALETTE[0];
  let bestCost = Number.POSITIVE_INFINITY;
  for (const colour of PALETTE) {
    const cost = costAt(colours, adjacency, id, colour);
    if (cost < bestCost) {
      best = colour;
      bestCost = cost;
    }
  }
  return best;
}
