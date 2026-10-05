/**
 * Read-only facts the map derives from the live Sim, memoised per Sim on the
 * cache versions that invalidate them, so a frame never recomputes a BFS or a
 * supply map. DOM-free; nothing here writes to the Sim.
 */
import { ADVISOR, AI } from '@/next/game/balance';
import { armiesAt, inboundTo, ownedProvinces } from '@/next/game/cache';
import { asProvince } from '@/next/game/ids';
import { zeroUnits } from '@/next/game/keys';
import { computeSupply, isArmyVisible } from '@/next/game/supply';
import { softShare, strength } from '@/next/game/ai/assess';
import { UNIT_TYPES } from '@/next/game/types';
import type { Army, ProvinceIx, Sim, SupplyMap, Units } from '@/next/game/types';

interface Memo {
  supplyVersion: number;
  supply: SupplyMap | null;
  hopsVersion: number;
  hops: Uint8Array | null;
  threatKey: string;
  threatened: ProvinceIx[];
}

const memos = new WeakMap<Sim, Memo>();

function memoOf(sim: Sim): Memo {
  let memo = memos.get(sim);
  if (memo === undefined) {
    memo = { supplyVersion: -1, supply: null, hopsVersion: -1, hops: null, threatKey: '', threatened: [] };
    memos.set(sim, memo);
  }
  return memo;
}

/** The player's supply map: the cached one when it is clean, else one computed per ownership version. */
export function playerSupply(sim: Sim): SupplyMap {
  const player = sim.state.player;
  const cached = sim.cache.supply[player];
  if (sim.cache.supplyDirty[player] !== true && cached !== null && cached !== undefined) return cached;
  const memo = memoOf(sim);
  if (memo.supply === null || memo.supplyVersion !== sim.cache.ownershipVersion) {
    memo.supply = computeSupply(sim.map, sim.state, player);
    memo.supplyVersion = sim.cache.ownershipVersion;
  }
  return memo.supply;
}

/** Beyond this many hops the distance is not tracked. */
export const FAR = 255;

/** Hops from the player's land per province (0 on it), over land and sea edges; FAR beyond 254. */
export function hopsFromPlayerLand(sim: Sim): Uint8Array {
  const memo = memoOf(sim);
  if (memo.hops !== null && memo.hopsVersion === sim.cache.ownershipVersion) return memo.hops;
  const hops = memo.hops ?? new Uint8Array(sim.map.provinces.length);
  hops.fill(FAR);
  const queue: ProvinceIx[] = [];
  for (const p of ownedProvinces(sim, sim.state.player)) {
    hops[p] = 0;
    queue.push(p);
  }
  for (let head = 0; head < queue.length; head++) {
    const p = queue[head]!;
    const next = hops[p]! + 1;
    if (next >= FAR) continue;
    for (const e of sim.map.edges[p]!) {
      if (hops[e.to]! <= next) continue;
      hops[e.to] = next;
      queue.push(e.to);
    }
  }
  memo.hops = hops;
  memo.hopsVersion = sim.cache.ownershipVersion;
  return hops;
}

function addWeighted(into: Units, units: Units, weight: number): void {
  for (const type of UNIT_TYPES) {
    into[type].count += weight * units[type].count;
    into[type].hp += weight * units[type].hp;
  }
}

/**
 * The player's provinces whose threat/defence is at least
 * ADVISOR.DANGER_THREAT_RATIO (the red dashed outline). Threat sums the hostile
 * armies the player can see within AI.THREAT_HOPS, weighted as the AI weighs
 * them, plus hostile armies marching in; with `showAll` every army counts.
 * Recomputed once per game hour and ownership version.
 */
export function threatenedProvinces(sim: Sim, showAll: boolean): readonly ProvinceIx[] {
  const memo = memoOf(sim);
  const key = `${Math.floor(sim.state.tick / 4)}|${sim.cache.ownershipVersion}|${showAll ? 1 : 0}`;
  if (memo.threatKey === key) return memo.threatened;
  const { map, state } = sim;
  const player = state.player;
  const seen = (army: Army): boolean => army.alive && army.owner !== player && (showAll || isArmyVisible(sim, army));
  const out: ProvinceIx[] = [];
  const distance = new Int8Array(map.provinces.length);
  for (const p of ownedProvinces(sim, player)) {
    const hostile = zeroUnits();
    // A small BFS to AI.THREAT_HOPS: 1 hop counts in full, 2 hops at the far weight.
    distance.fill(-1);
    distance[p] = 0;
    const ring: ProvinceIx[] = [p];
    for (let head = 0; head < ring.length; head++) {
      const at = ring[head]!;
      const d = distance[at]!;
      if (d > 0) {
        const weight = d <= 1 ? AI.THREAT_NEAR_WEIGHT : AI.THREAT_FAR_WEIGHT;
        for (const army of armiesAt(sim, at)) if (seen(army)) addWeighted(hostile, army.units, weight);
      }
      if (d >= AI.THREAT_HOPS) continue;
      for (const e of map.edges[at]!) {
        if (distance[e.to] !== -1) continue;
        distance[e.to] = d + 1;
        ring.push(asProvince(e.to));
      }
    }
    for (const army of inboundTo(sim, p)) if (seen(army)) addWeighted(hostile, army.units, AI.THREAT_NEAR_WEIGHT);
    if (hostile.rifles.hp + hostile.hunters.hp + hostile.motor.hp + hostile.guns.hp + hostile.tanks.hp <= 0) continue;
    const own = zeroUnits();
    for (const army of armiesAt(sim, p)) if (army.alive && army.owner === player) addWeighted(own, army.units, 1);
    const province = state.provinces[p]!;
    const terrain = map.provinces[p]!.terrain;
    const threat = strength(hostile, 0, 'attacker', softShare(own, province.garrison), terrain, province.buildings.ramparts).f;
    const defence = strength(own, province.garrison, 'defender', softShare(hostile, 0), terrain, province.buildings.ramparts).f;
    if (threat > 0 && threat >= ADVISOR.DANGER_THREAT_RATIO * defence) out.push(p);
  }
  memo.threatKey = key;
  memo.threatened = out;
  return out;
}
