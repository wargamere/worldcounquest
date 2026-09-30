/**
 * The derived SimCache: indexes over the state that are rebuilt on load and
 * never saved. `setOwner` is the only writer of Province.owner, so ownership,
 * per-nation province lists and VP can never drift apart.
 */
import { GARRISON } from './balance';
import { asProvince } from './ids';
import { zeroStocks } from './keys';
import type { Army, ArmyId, GameState, MapStatic, NationIx, ProvinceIx, Sim, SimCache, TickEvents } from './types';

/** `sightedAt` value for a province where nothing has been reported yet. */
const NEVER = -0x80000000;
const NO_ARMIES: readonly Army[] = [];
const NO_PROVINCES: readonly ProvinceIx[] = [];

/** VP per nation at the last victory check; victory.ts detects milestone crossings against it. */
const checkedVpByCache = new WeakMap<SimCache, number[]>();

function lists<T>(count: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < count; i += 1) out.push([]);
  return out;
}

/** Inserts keeping ascending order; the common case (a new largest value) is a push. */
function insertSorted(list: number[], value: number): void {
  let i = list.length;
  while (i > 0 && list[i - 1]! > value) i -= 1;
  list.splice(i, 0, value);
}

function removeSorted(list: number[], value: number): void {
  const i = list.indexOf(value);
  if (i >= 0) list.splice(i, 1);
}

function insertArmy(list: Army[], army: Army): void {
  let i = list.length;
  while (i > 0 && list[i - 1]!.id > army.id) i -= 1;
  list.splice(i, 0, army);
}

export function emptyEvents(): TickEvents {
  return { ticks: 0, feed: [], ownershipChanged: [], alerts: [], statusChanged: false };
}

export function createCache(map: MapStatic, state: GameState, recordCommands: boolean): SimCache {
  const provinceCount = map.provinces.length;
  const nationCount = map.nations.length;
  const nationProvinces = lists<ProvinceIx>(nationCount);
  const vp: number[] = new Array<number>(nationCount).fill(0);
  state.provinces.forEach((province, i) => {
    nationProvinces[province.owner]!.push(asProvince(i));
    vp[province.owner]! += map.provinces[i]!.vp;
  });
  const cache: SimCache = {
    armyById: new Map(),
    armiesAt: lists<Army>(provinceCount),
    armiesOf: lists<Army>(nationCount),
    inbound: lists<Army>(provinceCount),
    nationProvinces,
    vp,
    battles: [],
    contested: new Uint8Array(provinceCount),
    incomeDirty: new Array<boolean>(nationCount).fill(true),
    income: map.nations.map(() => zeroStocks()),
    supply: new Array<null>(nationCount).fill(null),
    supplyDirty: new Array<boolean>(nationCount).fill(true),
    vision: new Uint8Array(provinceCount),
    sightedAt: new Int32Array(provinceCount).fill(NEVER),
    battleLog: new Map(),
    ownershipVersion: 0,
    territoryVersion: new Array<number>(nationCount).fill(0),
    armyVersion: 0,
    events: emptyEvents(),
    commandLog: recordCommands ? [] : null,
    counters: { predictions: 0, paths: 0, fields: 0, orders: 0 },
  };
  checkedVpByCache.set(cache, vp.slice());
  rebuildIndex(map, state, cache);
  return cache;
}

function rebuildIndex(map: MapStatic, state: GameState, cache: SimCache): void {
  cache.armyById.clear();
  for (const list of cache.armiesAt) list.length = 0;
  for (const list of cache.armiesOf) list.length = 0;
  for (const list of cache.inbound) list.length = 0;
  // state.armies is sorted by id, so every list below comes out ascending.
  for (const army of state.armies) {
    if (!army.alive) continue;
    cache.armyById.set(army.id, army);
    cache.armiesOf[army.owner]!.push(army);
    if (army.leg === null) cache.armiesAt[army.at]!.push(army);
    else cache.inbound[army.leg.to]!.push(army);
  }
  cache.battles.length = 0;
  cache.contested.fill(0);
  for (let p = 0; p < map.provinces.length; p += 1) {
    const here = cache.armiesAt[p]!;
    if (here.length === 0) continue;
    const province = state.provinces[p]!;
    let foreign = false;
    let ownerSide = province.garrison >= GARRISON.EMPTY_BELOW;
    for (const army of here) {
      if (army.owner === province.owner) ownerSide = true;
      else foreign = true;
    }
    if (foreign && ownerSide) {
      cache.battles.push(asProvince(p));
      cache.contested[p] = 1;
    }
  }
  cache.armyVersion += 1;
}

/** Rebuilds armiesAt, armiesOf, inbound, battles and contested from state.armies. */
export function rebuildArmyIndex(sim: Sim): void {
  rebuildIndex(sim.map, sim.state, sim.cache);
}

/** Adds a live army created mid-tick to the indexes; the per-tick rebuild handles armies that move. */
export function indexArmy(sim: Sim, army: Army): void {
  const { cache } = sim;
  cache.armyById.set(army.id, army);
  const own = cache.armiesOf[army.owner]!;
  if (!own.includes(army)) insertArmy(own, army);
  const list = army.leg === null ? cache.armiesAt[army.at]! : cache.inbound[army.leg.to]!;
  if (!list.includes(army)) insertArmy(list, army);
  cache.armyVersion += 1;
}

export function armyById(sim: Sim, id: ArmyId): Army | undefined {
  return sim.cache.armyById.get(id);
}

export function armiesAt(sim: Sim, p: ProvinceIx): readonly Army[] {
  return sim.cache.armiesAt[p] ?? NO_ARMIES;
}

export function armiesOf(sim: Sim, n: NationIx): readonly Army[] {
  return sim.cache.armiesOf[n] ?? NO_ARMIES;
}

export function inboundTo(sim: Sim, p: ProvinceIx): readonly Army[] {
  return sim.cache.inbound[p] ?? NO_ARMIES;
}

export function ownedProvinces(sim: Sim, n: NationIx): readonly ProvinceIx[] {
  return sim.cache.nationProvinces[n] ?? NO_PROVINCES;
}

export function isContested(sim: Sim, p: ProvinceIx): boolean {
  return sim.cache.contested[p] === 1;
}

/** The only writer of Province.owner: keeps province lists, VP, versions and dirty flags in step. */
export function setOwner(sim: Sim, p: ProvinceIx, owner: NationIx): void {
  const province = sim.state.provinces[p]!;
  const previous = province.owner;
  if (previous === owner) return;
  const { cache } = sim;
  const vp = sim.map.provinces[p]!.vp;
  removeSorted(cache.nationProvinces[previous]!, p);
  insertSorted(cache.nationProvinces[owner]!, p);
  cache.vp[previous]! -= vp;
  cache.vp[owner]! += vp;
  province.owner = owner;
  cache.ownershipVersion += 1;
  cache.territoryVersion[previous]! += 1;
  cache.territoryVersion[owner]! += 1;
  cache.supplyDirty[previous] = true;
  cache.supplyDirty[owner] = true;
  cache.incomeDirty[previous] = true;
  cache.incomeDirty[owner] = true;
  cache.events.ownershipChanged.push(p);
}

export function markIncomeDirty(sim: Sim, n: NationIx): void {
  sim.cache.incomeDirty[n] = true;
}

/** Hands the accumulated events to the caller and starts a fresh batch. */
export function takeEvents(sim: Sim): TickEvents {
  const events = sim.cache.events;
  sim.cache.events = emptyEvents();
  return events;
}

/**
 * VP per nation as of the last victory check, seeded at cache creation. Because
 * VP only changes inside ticks that also run the check, the seed taken on load
 * equals the value the uninterrupted game would hold, which keeps milestone news
 * identical across a save and load.
 */
export function checkedVp(sim: Sim): number[] {
  let vp = checkedVpByCache.get(sim.cache);
  if (vp === undefined) {
    vp = sim.cache.vp.slice();
    checkedVpByCache.set(sim.cache, vp);
  }
  return vp;
}
