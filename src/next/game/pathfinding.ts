/**
 * Routes over the province graph (§4.5). Edge costs are the integer leg ticks
 * from travel.ts, so a route's cost is its real ETA; attack routes add a fixed
 * penalty for every hostile province crossed before the target, which keeps
 * them inside friendly land for as long as possible.
 *
 * A* uses the straight-line chord at the best possible speed. Sea legs are
 * capped at MOVEMENT.SEA_MAX_KM, so a few long crossings cost less than their
 * chord suggests; the heuristic also bounds routes through those capped legs,
 * which keeps it admissible on every map (tested). Queue ties go to the lower
 * ProvinceIx, so every search is deterministic. Scratch arrays are reused per
 * map, so a search allocates only its result.
 */
import { MOVEMENT, TIME } from './balance';
import { isContested } from './cache';
import { hoursToTicks } from './clock';
import { asProvince } from './ids';
import type { MapStatic, NationIx, ProvinceIx, Sim } from './types';
import { legTicks } from './travel';
import { chordKm } from './world';

export type RouteMode = 'own' | 'attack' | 'retreat';
export interface PathOptions {
  nation: NationIx;
  speedKmh: number;
  mode: RouteMode;
  maxTicks: number;
}
/** `nodes` excludes the start; `ticks` is the real travel time; `hostile` counts hostile provinces before the target. */
export interface PathResult {
  nodes: ProvinceIx[];
  ticks: number;
  hostile: number;
}
/** Per province: ticks to the nearest source and the next province on the way; −1 = unreachable. */
export interface TravelField {
  ticks: Int32Array;
  next: Int32Array;
}

/** Extra route cost of each hostile province entered before the target. */
export const HOSTILE_PENALTY_TICKS = hoursToTicks(MOVEMENT.HOSTILE_PATH_PENALTY_HOURS);
/** The ticks of a sea leg at the cap: the most any crossing costs. */
const CAPPED_SEA_TICKS = Math.max(1, Math.ceil((MOVEMENT.SEA_MAX_KM * TIME.TICKS_PER_HOUR) / MOVEMENT.SEA_KMH));

// ------------------------------------------------------------------ min-heap

/** Binary min-heap of (key, node) with ties to the lower node; `cost` rides along to spot stale entries. */
class Heap {
  keys = new Float64Array(64);
  nodes = new Int32Array(64);
  costs = new Float64Array(64);
  size = 0;
  /** The key and cost of the last popped entry. */
  lastKey = 0;
  lastCost = 0;

  clear(): void {
    this.size = 0;
  }

  private less(i: number, j: number): boolean {
    const a = this.keys[i]!;
    const b = this.keys[j]!;
    if (a !== b) return a < b;
    const na = this.nodes[i]!;
    const nb = this.nodes[j]!;
    if (na !== nb) return na < nb;
    return this.costs[i]! < this.costs[j]!;
  }

  private swap(i: number, j: number): void {
    const k = this.keys[i]!;
    this.keys[i] = this.keys[j]!;
    this.keys[j] = k;
    const n = this.nodes[i]!;
    this.nodes[i] = this.nodes[j]!;
    this.nodes[j] = n;
    const c = this.costs[i]!;
    this.costs[i] = this.costs[j]!;
    this.costs[j] = c;
  }

  push(key: number, node: number, cost: number): void {
    if (this.size === this.keys.length) {
      const grow = (old: Float64Array): Float64Array<ArrayBuffer> => {
        const next = new Float64Array(old.length * 2);
        next.set(old);
        return next;
      };
      this.keys = grow(this.keys);
      this.costs = grow(this.costs);
      const nodes = new Int32Array(this.nodes.length * 2);
      nodes.set(this.nodes);
      this.nodes = nodes;
    }
    let i = this.size;
    this.size += 1;
    this.keys[i] = key;
    this.nodes[i] = node;
    this.costs[i] = cost;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.less(i, parent)) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  /** Removes the smallest entry and returns its node (−1 when empty). */
  pop(): number {
    if (this.size === 0) return -1;
    const node = this.nodes[0]!;
    this.lastKey = this.keys[0]!;
    this.lastCost = this.costs[0]!;
    this.size -= 1;
    if (this.size > 0) {
      this.keys[0] = this.keys[this.size]!;
      this.nodes[0] = this.nodes[this.size]!;
      this.costs[0] = this.costs[this.size]!;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < this.size && this.less(l, m)) m = l;
        if (r < this.size && this.less(r, m)) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return node;
  }
}

// --------------------------------------------------------------- workspace

interface CappedLeg {
  from: ProvinceIx;
  to: ProvinceIx;
}
interface Workspace {
  heap: Heap;
  /** Search generation per province; a slot is valid only when it equals `generation`. */
  seen: Uint32Array;
  generation: number;
  cost: Float64Array;
  real: Float64Array;
  hostile: Int32Array;
  parent: Int32Array;
  /** Sea legs whose length is capped: the only legs cheaper than their chord at sea speed. */
  capped: readonly CappedLeg[];
}
const workspaces = new WeakMap<MapStatic, Workspace>();

function workspace(map: MapStatic): Workspace {
  const known = workspaces.get(map);
  if (known !== undefined) return known;
  const count = map.provinces.length;
  const capped: CappedLeg[] = [];
  map.edges.forEach((list, from) => {
    for (const e of list) {
      if (e.sea && e.km + MOVEMENT.SEA_EMBARK_KM > MOVEMENT.SEA_MAX_KM) capped.push({ from: asProvince(from), to: e.to });
    }
  });
  const fresh: Workspace = {
    heap: new Heap(),
    seen: new Uint32Array(count),
    generation: 0,
    cost: new Float64Array(count),
    real: new Float64Array(count),
    hostile: new Int32Array(count),
    parent: new Int32Array(count),
    capped,
  };
  workspaces.set(map, fresh);
  return fresh;
}

function nextGeneration(ws: Workspace): number {
  ws.generation += 1;
  if (ws.generation === 0xffffffff) {
    ws.seen.fill(0);
    ws.generation = 1;
  }
  return ws.generation;
}

// --------------------------------------------------------------- heuristic

/** Ticks per km at the fastest possible land pace (best Roads) or at sea, whichever is faster. */
function ticksPerKm(speedKmh: number): number {
  return TIME.TICKS_PER_HOUR / Math.max(speedKmh * MOVEMENT.MAX_SPEED_FACTOR, MOVEMENT.SEA_KMH);
}

function chordTicks(map: MapStatic, a: ProvinceIx, b: ProvinceIx, perKm: number): number {
  return chordKm(map.provinces[a]!.xyz, map.provinces[b]!.xyz) * perKm;
}

/**
 * A lower bound on the ticks from `from` to `to`. A route either uses no capped
 * sea leg (then it is at least the chord at the best pace) or it uses one, so
 * it costs at least the chord to that leg's start, the capped leg, and then the
 * lesser of the chord onward and another capped leg.
 */
export function heuristicTicks(sim: Sim, from: ProvinceIx, to: ProvinceIx, speedKmh: number): number {
  const { map } = sim;
  const perKm = ticksPerKm(speedKmh);
  let best = chordTicks(map, from, to, perKm);
  for (const leg of workspace(map).capped) {
    const via = chordTicks(map, from, leg.from, perKm) + CAPPED_SEA_TICKS + Math.min(chordTicks(map, leg.to, to, perKm), CAPPED_SEA_TICKS);
    if (via < best) best = via;
  }
  return best;
}

// -------------------------------------------------------------------- modes

/** Whether a route may pass through `p` (the start and, except in retreat mode, the target are always allowed). */
function passable(sim: Sim, p: ProvinceIx, o: PathOptions): boolean {
  if (o.mode === 'attack') return true;
  if (sim.state.provinces[p]!.owner !== o.nation) return false;
  return o.mode === 'own' || !isContested(sim, p);
}

function isHostile(sim: Sim, p: ProvinceIx, nation: NationIx): boolean {
  return sim.state.provinces[p]!.owner !== nation;
}

// --------------------------------------------------------------------- A*

/** The cheapest route from `from` to `to` under the mode, or null if none costs at most maxTicks. */
export function findPath(sim: Sim, from: ProvinceIx, to: ProvinceIx, o: PathOptions): PathResult | null {
  sim.cache.counters.paths += 1;
  if (o.mode === 'retreat' && !passable(sim, to, o)) return null;
  if (from === to) return { nodes: [], ticks: 0, hostile: 0 };
  const { map } = sim;
  const ws = workspace(map);
  const gen = nextGeneration(ws);
  const { heap, seen, cost, real, hostile, parent } = ws;
  heap.clear();

  // Lower bounds for the target are computed once per province reached.
  const perKm = ticksPerKm(o.speedKmh);
  const onward = ws.capped.map((leg) => Math.min(chordTicks(map, leg.to, to, perKm), CAPPED_SEA_TICKS));
  const h = (p: ProvinceIx): number => {
    let best = chordTicks(map, p, to, perKm);
    ws.capped.forEach((leg, i) => {
      const via = chordTicks(map, p, leg.from, perKm) + CAPPED_SEA_TICKS + onward[i]!;
      if (via < best) best = via;
    });
    return best;
  };

  seen[from] = gen;
  cost[from] = 0;
  real[from] = 0;
  hostile[from] = 0;
  parent[from] = -1;
  heap.push(h(from), from, 0);
  while (heap.size > 0) {
    const u = asProvince(heap.pop());
    // A stale entry: the province was reached more cheaply after this was queued.
    if (heap.lastCost > cost[u]!) continue;
    if (u === to) break;
    if (u !== from && !passable(sim, u, o)) continue;
    for (const e of map.edges[u]!) {
      const v = e.to;
      const isTarget = v === to;
      if (!isTarget && !passable(sim, v, o)) continue;
      const ticks = legTicks(sim, u, v, e.km, e.sea, o.speedKmh);
      const crossing = !isTarget && o.mode === 'attack' && isHostile(sim, v, o.nation);
      const next = cost[u]! + ticks + (crossing ? HOSTILE_PENALTY_TICKS : 0);
      if (next > o.maxTicks) continue;
      if (seen[v] === gen && next >= cost[v]!) continue;
      seen[v] = gen;
      cost[v] = next;
      real[v] = real[u]! + ticks;
      hostile[v] = hostile[u]! + (crossing ? 1 : 0);
      parent[v] = u;
      heap.push(next + h(v), v, next);
    }
  }
  if (seen[to] !== gen) return null;
  const nodes: ProvinceIx[] = [];
  for (let p: number = to; p !== from; p = parent[p]!) nodes.push(asProvince(p));
  nodes.reverse();
  return { nodes, ticks: real[to]!, hostile: hostile[to]! };
}

// -------------------------------------------------------------- travel field

/**
 * Reverse multi-source Dijkstra: for every province, the route cost (same rules
 * as findPath, with the sources as targets) to the nearest source. `ticks` is
 * that route's real travel time and `next` its first step.
 */
export function travelField(sim: Sim, sources: readonly ProvinceIx[], o: PathOptions): TravelField {
  sim.cache.counters.fields += 1;
  const { map } = sim;
  const count = map.provinces.length;
  const ticksOut = new Int32Array(count).fill(-1);
  const next = new Int32Array(count).fill(-1);
  const ws = workspace(map);
  const gen = nextGeneration(ws);
  const { heap, seen, cost, real } = ws;
  heap.clear();
  const isSource = new Uint8Array(count);
  for (const s of sources) {
    // As in findPath, a retreat never ends in an unsafe province.
    if (isSource[s] === 1 || (o.mode === 'retreat' && !passable(sim, s, o))) continue;
    isSource[s] = 1;
    seen[s] = gen;
    cost[s] = 0;
    real[s] = 0;
    heap.push(0, s, 0);
  }
  while (heap.size > 0) {
    const v = asProvince(heap.pop());
    if (heap.lastCost > cost[v]!) continue;
    if (ticksOut[v] !== -1) continue;
    ticksOut[v] = real[v]!;
    // Anything may start a route, but only passable provinces lie inside one.
    if (isSource[v] === 0 && !passable(sim, v, o)) continue;
    const crossing = isSource[v] === 0 && o.mode === 'attack' && isHostile(sim, v, o.nation);
    for (const e of map.edges[v]!) {
      const u = e.to;
      if (ticksOut[u] !== -1) continue;
      const ticks = legTicks(sim, u, v, e.km, e.sea, o.speedKmh);
      const total = cost[v]! + ticks + (crossing ? HOSTILE_PENALTY_TICKS : 0);
      if (total > o.maxTicks) continue;
      if (seen[u] === gen && total >= cost[u]!) continue;
      seen[u] = gen;
      cost[u] = total;
      real[u] = real[v]! + ticks;
      next[u] = v;
      heap.push(total, u, total);
    }
  }
  return { ticks: ticksOut, next };
}

/** The route a field gives from `from`, excluding it; empty for a source or an unreachable province. */
export function pathFromField(field: TravelField, from: ProvinceIx): ProvinceIx[] {
  const nodes: ProvinceIx[] = [];
  if (field.ticks[from] === undefined || field.ticks[from] < 0) return nodes;
  let p = field.next[from]!;
  while (p >= 0 && nodes.length < field.next.length) {
    nodes.push(asProvince(p));
    p = field.next[p]!;
  }
  return nodes;
}
