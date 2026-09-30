/**
 * Supply pockets and the player's fog of war (§5.9, §8.8). Both are plain
 * breadth-first searches over province edges, land and sea alike. Supply is
 * recomputed only for nations whose territory changed; vision hourly.
 */
import { SUPPLY } from './balance';
import { armiesAt, armiesOf, ownedProvinces } from './cache';
import { asProvince } from './ids';
import type { Army, GameState, MapStatic, NationIx, ProvinceIx, Sim, SupplyMap } from './types';

/**
 * Where a nation's supply starts: its capital, or for a nation without one (the
 * player after losing it), the lowest-index owned province with a Training
 * Ground, else the largest owned province. Whatever moves the root marks the
 * nation dirty: ownership, the capital, and a finished Training Ground.
 */
function supplyRoot(map: MapStatic, state: GameState, n: NationIx): ProvinceIx | null {
  const capital = state.nations[n]?.capital ?? null;
  if (capital !== null && state.provinces[capital]?.owner === n) return capital;
  let largest: ProvinceIx | null = null;
  let largestArea = -1;
  for (let p = 0; p < state.provinces.length; p += 1) {
    const province = state.provinces[p];
    if (province?.owner !== n) continue;
    if (province.buildings.training > 0) return asProvince(p);
    const area = map.provinces[p]?.areaKm2 ?? 0;
    if (area > largestArea) {
      largest = asProvince(p);
      largestArea = area;
    }
  }
  return largest;
}

/**
 * Multi-source BFS: marks `out` with 1 for every province within `hops` edges
 * of a province already marked. `queue` must hold exactly the marked sources.
 */
function spread(map: MapStatic, out: Uint8Array, queue: ProvinceIx[], hops: number): void {
  let frontierEnd = queue.length;
  let head = 0;
  for (let depth = 0; depth < hops; depth += 1) {
    for (; head < frontierEnd; head += 1) {
      for (const e of map.edges[queue[head] ?? 0] ?? []) {
        if (out[e.to] === 1) continue;
        out[e.to] = 1;
        queue.push(e.to);
      }
    }
    frontierEnd = queue.length;
  }
}

/** Connected: owned and linked to the root through owned provinces. Supplied: within the halo of a connected one. */
export function computeSupply(map: MapStatic, state: GameState, n: NationIx): SupplyMap {
  const count = map.provinces.length;
  const connected = new Uint8Array(count);
  const supplied = new Uint8Array(count);
  const root = supplyRoot(map, state, n);
  if (root === null) return { connected, supplied };

  connected[root] = 1;
  const queue: ProvinceIx[] = [root];
  for (let head = 0; head < queue.length; head += 1) {
    for (const e of map.edges[queue[head] ?? 0] ?? []) {
      if (connected[e.to] === 1 || state.provinces[e.to]?.owner !== n) continue;
      connected[e.to] = 1;
      queue.push(e.to);
    }
  }

  supplied.set(connected);
  spread(map, supplied, queue, SUPPLY.HALO_HOPS);
  return { connected, supplied };
}

/** Recomputes supply for dirty nations only, at the start of the hourly phase; dead nations drop theirs. */
export function refreshSupply(sim: Sim): void {
  const { cache, state } = sim;
  for (let n = 0; n < state.nations.length; n += 1) {
    if (cache.supplyDirty[n] !== true) continue;
    const nation = state.nations[n];
    cache.supply[n] = nation?.alive === true ? computeSupply(sim.map, state, nation.ix) : null;
    cache.supplyDirty[n] = false;
  }
}

/**
 * The cached map while it is clean, otherwise a fresh one that is not stored:
 * storing it here would make cache timing depend on who read it first. Reading
 * a dirty map fresh keeps every read a function of the state alone, so a loaded
 * game (whose cache starts empty) reads exactly what the running one would.
 */
function supplyOf(sim: Sim, n: NationIx): SupplyMap {
  const cached = sim.cache.supplyDirty[n] === true ? null : sim.cache.supply[n];
  return cached ?? computeSupply(sim.map, sim.state, n);
}

/** Whether nation `n`'s supply halo covers `p`. */
export function isSuppliedAt(sim: Sim, n: NationIx, p: ProvinceIx): boolean {
  return supplyOf(sim, n).supplied[p] === 1;
}

/** An army is supplied if the province it stands in (or its leg left) is. */
export function isSupplied(sim: Sim, army: Army): boolean {
  return isSuppliedAt(sim, army.owner, army.at);
}

export function isConnected(sim: Sim, n: NationIx, p: ProvinceIx): boolean {
  return supplyOf(sim, n).connected[p] === 1;
}

/** Provinces within SUPPLY.VISION_HOPS of the viewer's land or armies (both ends of a leg). */
function fillVision(sim: Sim, viewer: NationIx, out: Uint8Array): void {
  out.fill(0);
  const queue: ProvinceIx[] = [];
  const mark = (p: ProvinceIx): void => {
    if (out[p] === 1) return;
    out[p] = 1;
    queue.push(p);
  };
  for (const p of ownedProvinces(sim, viewer)) mark(p);
  for (const army of armiesOf(sim, viewer)) {
    mark(army.at);
    if (army.leg !== null) mark(army.leg.to);
  }
  spread(sim.map, out, queue, SUPPLY.VISION_HOPS);
}

export function computeVision(sim: Sim, viewer: NationIx): Uint8Array {
  const out = new Uint8Array(sim.map.provinces.length);
  fillVision(sim, viewer, out);
  return out;
}

/** Hourly: the player's vision, written in place into cache.vision. */
export function refreshVision(sim: Sim): void {
  fillVision(sim, sim.state.player, sim.cache.vision);
}

/**
 * Fog for the player. Own armies, armies standing in or on a leg touching a
 * visible province, and any army in a battle on the player's land or against
 * the player's armies are visible. "Show all armies" is the views' flag, not
 * checked here; stats.fogOff only records that it was ever used.
 */
export function isArmyVisible(sim: Sim, army: Army): boolean {
  const player = sim.state.player;
  if (army.owner === player) return true;
  const vision = sim.cache.vision;
  if (vision[army.at] === 1) return true;
  if (army.leg !== null) return vision[army.leg.to] === 1;
  if (army.battle === null) return false;
  if (sim.state.provinces[army.at]?.owner === player) return true;
  return armiesAt(sim, army.at).some((a) => a.owner === player);
}
