/**
 * Leg durations (§4.4). Every leg's length in whole ticks is fixed when it
 * starts, so an ETA is a sum of integers and the arrival tick is exact. Route
 * search uses the same function, so a path's cost is its real travel time.
 */
import { EFFECTS, MOVEMENT, TERRAIN, TIME } from './balance';
import type { Army, Edge, Leg, ProvinceIx, Sim } from './types';
import { slowestSpeed } from './units';

/** The army's pace: its slowest unit type, with Oil users halved during its nation's Oil shortage. */
export function armySpeedKmh(sim: Sim, army: Army): number {
  return slowestSpeed(army.units, sim.state.nations[army.owner]?.shortage.oil === true);
}

/**
 * Whole ticks for one leg. Land: the army's speed × the terrain entered × the
 * mean Roads bonus of both ends. Sea: everyone at MOVEMENT.SEA_KMH over the
 * edge plus the embarkation allowance, capped. At least one tick.
 */
export function legTicks(sim: Sim, from: ProvinceIx, to: ProvinceIx, km: number, sea: boolean, speedKmh: number): number {
  let speed: number;
  let distance: number;
  if (sea) {
    speed = MOVEMENT.SEA_KMH;
    distance = Math.min(km + MOVEMENT.SEA_EMBARK_KM, MOVEMENT.SEA_MAX_KM);
  } else {
    const roads = sim.state.provinces[from]!.buildings.roads + sim.state.provinces[to]!.buildings.roads;
    speed = speedKmh * TERRAIN[sim.map.provinces[to]!.terrain].speed * (1 + (EFFECTS.ROADS_SPEED_PER_LEVEL * roads) / 2);
    distance = km;
  }
  return Math.max(1, Math.ceil((distance * TIME.TICKS_PER_HOUR) / speed));
}

export function edgeTicks(sim: Sim, from: ProvinceIx, edge: Edge, speedKmh: number): number {
  return legTicks(sim, from, edge.to, edge.km, edge.sea, speedKmh);
}

/** Share of the leg covered, 0..1, for drawing between ticks; never overshoots. */
export function legProgress(leg: Leg, alpha: number): number {
  return Math.min(1, (leg.done + alpha) / leg.ticks);
}

/** Re-times the rest of a leg when the army's speed changes (an Oil shortage flip): done + ceil(rest × old / new). */
export function retimeLeg(leg: Leg, oldSpeed: number, newSpeed: number): void {
  if (oldSpeed <= 0 || newSpeed <= 0 || oldSpeed === newSpeed) return;
  const rest = leg.ticks - leg.done;
  if (rest <= 0) return;
  // Progress is scaled too, so the column keeps its place on the map (drawn at done / ticks).
  const done = Math.round((leg.done * oldSpeed) / newSpeed);
  leg.done = done;
  leg.ticks = done + Math.max(1, Math.ceil((rest * oldSpeed) / newSpeed));
}
