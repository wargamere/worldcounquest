/**
 * Orders and marching (§4.4, §4.6): planning routes for one or many armies,
 * arrive-together departure times, stop, retreat, rally, and the per-tick
 * movement phase (departures, leg progress, arrivals in army-id order).
 *
 * The per-tick phase keeps the standing and inbound lists current as armies
 * leave and arrive, so an arrival sees the armies that arrived before it in the
 * same tick; the full index is rebuilt after the phase anyway.
 */
import { MOVEMENT } from './balance';
import { armiesOf, armyById, isContested, rebuildArmyIndex } from './cache';
import { hoursToTicks } from './clock';
import { tryWalkIn } from './capture';
import { pushFeed } from './feed';
import { engage, isContestedNow, isIdle, loseShare, mergeArmies, ownArmies, removeArmy, armyStatus } from './armies';
import { findPath, type PathResult, type RouteMode } from './pathfinding';
import { armySpeedKmh, edgeTicks, retimeLeg } from './travel';
import type { Army, ArmyId, CommandResult, Intent, NationIx, ProvinceIx, Sim, Tick } from './types';
import { addUnits, copyUnits, isEmpty, slowestSpeed, speedAtOilFactor, totalHp, usesOil } from './units';
import { edgeBetween } from './world';

export interface DeparturePlan {
  army: ArmyId;
  path: PathResult;
  departAt: Tick;
  /** The province the army enters the target from: its flank direction. */
  approach: ProvinceIx | null;
}

const fail = (reason: string): CommandResult => ({ ok: false, reason });

// ------------------------------------------------------------------ index upkeep

function insertById(list: Army[], army: Army): void {
  if (list.includes(army)) return;
  let i = list.length;
  while (i > 0 && list[i - 1]!.id > army.id) i -= 1;
  list.splice(i, 0, army);
}

function dropFrom(list: Army[] | undefined, army: Army): void {
  if (list === undefined) return;
  const i = list.indexOf(army);
  if (i >= 0) list.splice(i, 1);
}

// ------------------------------------------------------------------ helpers

/** Where an army's next leg would start: the end of its current leg, or where it stands. */
function startOf(army: Army): ProvinceIx {
  return army.leg !== null ? army.leg.to : army.at;
}

/** Ticks until the current leg ends (0 when standing). */
function legRemaining(army: Army): number {
  return army.leg !== null ? Math.max(0, army.leg.ticks - army.leg.done) : 0;
}

/** Leaving a contested province costs MOVEMENT.DISENGAGE_HP_LOSS of current HP. */
function isLeavingBattle(sim: Sim, army: Army): boolean {
  return army.leg === null && (army.battle !== null || isContested(sim, army.at));
}

/** Pays the disengage cost and leaves the battle; false if the army did not survive it. */
function disengage(sim: Sim, army: Army): boolean {
  loseShare(sim, army, MOVEMENT.DISENGAGE_HP_LOSS);
  army.battle = null;
  if (isEmpty(army.units)) {
    removeArmy(sim, army);
    return false;
  }
  return true;
}

/**
 * The route an order uses: own-territory first when the target is ours, falling
 * back to an attack route ("crosses enemy land"); an attack route otherwise.
 */
function routeFor(sim: Sim, n: NationIx, from: ProvinceIx, to: ProvinceIx, speedKmh: number): PathResult | null {
  const options = (mode: RouteMode) => ({ nation: n, speedKmh, mode, maxTicks: Number.POSITIVE_INFINITY });
  if (sim.state.provinces[to]!.owner === n) {
    const own = findPath(sim, from, to, options('own'));
    if (own !== null) return own;
  }
  return findPath(sim, from, to, options('attack'));
}

/** The flank direction a route adds: the province before the target. */
function approachOf(start: ProvinceIx, nodes: readonly ProvinceIx[]): ProvinceIx | null {
  if (nodes.length === 0) return null;
  return nodes.length >= 2 ? nodes[nodes.length - 2]! : start;
}

function intentFor(sim: Sim, n: NationIx, to: ProvinceIx, path: PathResult): Intent {
  return sim.state.provinces[to]!.owner === n && path.hostile === 0 ? 'move' : 'attack';
}

// ------------------------------------------------------------------ planning

/**
 * Co-located idle armies march as one (the implicit merge); every other army is
 * its own group. Groups are keyed by their lowest id, ascending.
 */
function groupsOf(sim: Sim, armies: readonly Army[]): Army[][] {
  const groups: Army[][] = [];
  for (const army of armies) {
    const idle = isIdle(sim, army);
    const group = idle ? groups.find((g) => isIdle(sim, g[0]!) && g[0]!.at === army.at) : undefined;
    if (group !== undefined) group.push(army);
    else groups.push([army]);
  }
  return groups;
}

/**
 * Routes and departure times for an order, without changing anything. Armies
 * that would merge (co-located and idle) share one route at the pace of the
 * slowest among them, and each gets a plan. With `together` and two or more
 * groups, each group departs `max ETA − its ETA` late, so every army enters the
 * target in the same tick.
 */
export function planOrder(sim: Sim, n: NationIx, ids: readonly ArmyId[], to: ProvinceIx, together: boolean): DeparturePlan[] | string {
  const armies = ownArmies(sim, n, ids);
  if (typeof armies === 'string') return armies;
  if (!Number.isInteger(to) || to < 0 || to >= sim.map.provinces.length) return 'No such province';
  for (const army of armies) if (armyStatus(sim, army) === 'frozen') return `${army.name} cannot move yet`;
  const oilShort = sim.state.nations[n]!.shortage.oil;
  const routes: { group: Army[]; path: PathResult; eta: number; start: ProvinceIx }[] = [];
  for (const group of groupsOf(sim, armies)) {
    const leader = group[0]!;
    const units = copyUnits(leader.units);
    for (const other of group.slice(1)) addUnits(units, other.units);
    const start = startOf(leader);
    const path = routeFor(sim, n, start, to, slowestSpeed(units, oilShort));
    if (path === null) return `No route to ${sim.map.provinces[to]!.name} for ${leader.name}`;
    routes.push({ group, path, eta: legRemaining(leader) + path.ticks, start });
  }
  const latest = routes.reduce((max, r) => Math.max(max, r.eta), 0);
  const tick = sim.state.tick;
  const align = together && routes.length >= 2;
  const plans: DeparturePlan[] = [];
  for (const { group, path, eta, start } of routes) {
    // An army already at (or on its leg into) the target has nothing to wait for.
    const departAt = tick + legRemaining(group[0]!) + (align && path.nodes.length > 0 ? latest - eta : 0);
    for (const army of group) plans.push({ army: army.id, path, departAt, approach: approachOf(start, path.nodes) });
  }
  return plans;
}

/** Arrival in ticks from now for a plan (the army's current leg included). */
export function planEta(sim: Sim, plan: DeparturePlan): number {
  return plan.departAt - sim.state.tick + plan.path.ticks;
}

/**
 * A move or attack order. Co-located idle armies merge first and march as one.
 * With `append`, each army's new route starts where its current route ends
 * (a waypoint), and departure times are left alone.
 */
export function orderMove(sim: Sim, n: NationIx, ids: readonly ArmyId[], to: ProvinceIx, together: boolean, append: boolean): CommandResult {
  if (append) return appendRoute(sim, n, ids, to);
  const first = planOrder(sim, n, ids, to, together);
  if (typeof first === 'string') return fail(first);
  const armies = ownArmies(sim, n, ids);
  if (typeof armies === 'string') return fail(armies);
  let remaining: ArmyId[] = [];
  for (const group of groupsOf(sim, armies)) {
    if (group.length === 1) {
      remaining.push(group[0]!.id);
      continue;
    }
    const merged = mergeArmies(
      sim,
      n,
      group.map((a) => a.id),
    );
    if (!merged.ok) return merged;
    remaining = remaining.concat(merged.armies);
  }
  const plans = planOrder(sim, n, remaining, to, together);
  if (typeof plans === 'string') return fail(plans);
  const ordered: ArmyId[] = [];
  for (const plan of plans) {
    const army = armyById(sim, plan.army)!;
    // An army leaving a battle pays to disengage when it actually leaves: one that
    // waits to arrive together keeps fighting until then (advanceMovement).
    const leavesNow = plan.departAt <= sim.state.tick;
    if (plan.path.nodes.length > 0 && leavesNow && isLeavingBattle(sim, army) && !disengage(sim, army)) continue;
    army.path = plan.path.nodes.slice();
    army.departAt = plan.departAt;
    army.intent = intentFor(sim, n, to, plan.path);
    army.orderedAt = sim.state.tick;
    ordered.push(army.id);
  }
  sim.cache.armyVersion += 1;
  return { ok: true, armies: ordered };
}

function appendRoute(sim: Sim, n: NationIx, ids: readonly ArmyId[], to: ProvinceIx): CommandResult {
  const armies = ownArmies(sim, n, ids);
  if (typeof armies === 'string') return fail(armies);
  const oilShort = sim.state.nations[n]!.shortage.oil;
  const extensions: { army: Army; path: PathResult }[] = [];
  for (const army of armies) {
    if (armyStatus(sim, army) === 'frozen') return fail(`${army.name} cannot move yet`);
    const from = army.path.length > 0 ? army.path[army.path.length - 1]! : startOf(army);
    const path = routeFor(sim, n, from, to, slowestSpeed(army.units, oilShort));
    if (path === null) return fail(`No route to ${sim.map.provinces[to]!.name} for ${army.name}`);
    extensions.push({ army, path });
  }
  const ordered: ArmyId[] = [];
  for (const { army, path } of extensions) {
    const fresh = army.path.length === 0;
    if (fresh && path.nodes.length > 0 && isLeavingBattle(sim, army) && !disengage(sim, army)) continue;
    army.path = army.path.concat(path.nodes);
    if (fresh) army.departAt = sim.state.tick + legRemaining(army);
    if (fresh) army.intent = intentFor(sim, n, to, path);
    else if (path.hostile > 0 || sim.state.provinces[to]!.owner !== n) army.intent = 'attack';
    army.orderedAt = sim.state.tick;
    ordered.push(army.id);
  }
  sim.cache.armyVersion += 1;
  return { ok: true, armies: ordered };
}

/** Whether units at `from` can march over `owner`'s own land to `to`. */
export function canRally(sim: Sim, owner: NationIx, from: ProvinceIx, to: ProvinceIx): boolean {
  const path = findPath(sim, from, to, { nation: owner, speedKmh: 1, mode: 'own', maxTicks: Number.POSITIVE_INFINITY });
  return path !== null && path.nodes.length > 0;
}

/** A newly trained army marches over own land to the rally province and merges there. */
export function orderRally(sim: Sim, army: Army, to: ProvinceIx): void {
  const path = findPath(sim, army.at, to, {
    nation: army.owner,
    speedKmh: armySpeedKmh(sim, army),
    mode: 'own',
    maxTicks: Number.POSITIVE_INFINITY,
  });
  if (path === null || path.nodes.length === 0) return;
  army.path = path.nodes.slice();
  army.departAt = Math.max(army.departAt, sim.state.tick);
  army.intent = 'rally';
  sim.cache.armyVersion += 1;
}

/**
 * Stop: the route is cleared. An army less than half-way along a leg turns back
 * to where it came from; one further along finishes the leg and halts there.
 */
export function stopArmies(sim: Sim, n: NationIx, ids: readonly ArmyId[]): CommandResult {
  const armies = ownArmies(sim, n, ids);
  if (typeof armies === 'string') return fail(armies);
  let reversed = false;
  for (const army of armies) {
    const leg = army.leg;
    if (leg !== null && leg.done * 2 < leg.ticks) {
      army.leg = { from: leg.to, to: leg.from, ticks: leg.ticks, done: leg.ticks - leg.done, sea: leg.sea };
      army.at = leg.to;
      reversed = true;
    }
    if (army.path.length > 0) army.departAt = Math.min(army.departAt, sim.state.tick);
    army.path = [];
    army.intent = 'move';
    army.orderedAt = sim.state.tick;
  }
  if (reversed) rebuildArmyIndex(sim);
  sim.cache.armyVersion += 1;
  return { ok: true, armies: armies.map((a) => a.id) };
}

/**
 * Where an army falls back to: the province it came from if that is still own
 * and uncontested, otherwise the adjacent own uncontested province with the most
 * defence (garrison plus own armies' HP; ties to the lower index).
 */
export function retreatTarget(sim: Sim, army: Army): ProvinceIx | null {
  const { map, state } = sim;
  const safe = (p: ProvinceIx): boolean => state.provinces[p]!.owner === army.owner && !isContested(sim, p);
  const from = army.cameFrom;
  if (from !== null && from !== army.at && edgeBetween(map, army.at, from) !== null && safe(from)) return from;
  let best: ProvinceIx | null = null;
  let bestDefence = -1;
  for (const e of map.edges[army.at]!) {
    if (!safe(e.to)) continue;
    let defence = state.provinces[e.to]!.garrison;
    for (const other of sim.cache.armiesAt[e.to] ?? []) {
      if (other.alive && other.owner === army.owner && other.leg === null) defence += totalHp(other.units);
    }
    if (defence > bestDefence) {
      best = e.to;
      bestDefence = defence;
    }
  }
  return best;
}

/**
 * Sends an army back to `target` next tick with intent retreat; from a battle
 * it pays the disengage cost. Returns false if the army did not survive it.
 */
export function beginRetreat(sim: Sim, army: Army, path: readonly ProvinceIx[]): boolean {
  if (isLeavingBattle(sim, army) && !disengage(sim, army)) return false;
  army.battle = null;
  army.path = path.slice();
  army.departAt = sim.state.tick;
  army.intent = 'retreat';
  army.orderedAt = sim.state.tick;
  sim.cache.armyVersion += 1;
  return true;
}

/** Retreat: to `to` over own uncontested land, or to each army's retreatTarget. Costs 10% from a battle. */
export function retreatArmies(sim: Sim, n: NationIx, ids: readonly ArmyId[], to: ProvinceIx | null): CommandResult {
  const armies = ownArmies(sim, n, ids);
  if (typeof armies === 'string') return fail(armies);
  const routes: { army: Army; path: ProvinceIx[] }[] = [];
  for (const army of armies) {
    if (army.leg !== null) return fail(`${army.name} is on the move`);
    if (armyStatus(sim, army) === 'frozen') return fail(`${army.name} cannot move yet`);
    if (to === null) {
      const target = retreatTarget(sim, army);
      if (target === null) return fail(`${army.name} has nowhere to fall back to`);
      routes.push({ army, path: [target] });
      continue;
    }
    if (to === army.at) return fail(`${army.name} is already there`);
    const path = findPath(sim, army.at, to, { nation: n, speedKmh: armySpeedKmh(sim, army), mode: 'retreat', maxTicks: Number.POSITIVE_INFINITY });
    if (path === null) return fail(`${army.name} has no safe route to ${sim.map.provinces[to]!.name}`);
    routes.push({ army, path: path.nodes });
  }
  const moved: ArmyId[] = [];
  for (const { army, path } of routes) if (beginRetreat(sim, army, path)) moved.push(army.id);
  return { ok: true, armies: moved };
}

/** Ticks until the army reaches the end of its route, or null with no route. */
export function etaTicks(sim: Sim, army: Army): number | null {
  if (!army.alive || (army.leg === null && army.path.length === 0)) return null;
  const tick = sim.state.tick;
  const wait = Math.max(legRemaining(army), army.departAt - tick, 0);
  if (army.path.length === 0) return wait;
  const speed = armySpeedKmh(sim, army);
  let total = wait;
  let from = startOf(army);
  for (const to of army.path) {
    const edge = edgeBetween(sim.map, from, to);
    if (edge === null) return null;
    total += edgeTicks(sim, from, edge, speed);
    from = to;
  }
  return total;
}

// ------------------------------------------------------------------ the tick

/**
 * Before a leg of a move, rally or retreat, a next province that turned hostile
 * means a new route over own land. False when none exists: the army stops.
 */
function reroute(sim: Sim, army: Army): boolean {
  if (army.intent === 'attack') return true;
  const next = army.path[0]!;
  const target = army.path[army.path.length - 1]!;
  // A move or rally whose destination fell on the way stops rather than attack it.
  const lost = army.intent !== 'retreat' && sim.state.provinces[target]!.owner !== army.owner;
  if (!lost && sim.state.provinces[next]!.owner === army.owner) return true;
  const mode: RouteMode = army.intent === 'retreat' ? 'retreat' : 'own';
  const path = lost ? null : findPath(sim, army.at, target, { nation: army.owner, speedKmh: armySpeedKmh(sim, army), mode, maxTicks: Number.POSITIVE_INFINITY });
  if (path !== null && path.nodes.length > 0) {
    army.path = path.nodes.slice();
    return true;
  }
  army.path = [];
  army.intent = 'move';
  pushFeed(sim, {
    kind: 'routeBlocked',
    severity: 'bad',
    text: `Route blocked: ${army.name} stopped in ${sim.map.provinces[army.at]!.name}`,
    nations: [army.owner],
    province: army.at,
    army: army.id,
  });
  return false;
}

function depart(sim: Sim, army: Army): void {
  if (!reroute(sim, army)) return;
  const next = army.path[0]!;
  const edge = edgeBetween(sim.map, army.at, next);
  if (edge === null) {
    army.path = [];
    return;
  }
  army.path.shift();
  army.leg = { from: army.at, to: next, ticks: edgeTicks(sim, army.at, edge, armySpeedKmh(sim, army)), done: 0, sea: edge.sea };
  dropFrom(sim.cache.armiesAt[army.at], army);
  insertById(sim.cache.inbound[next]!, army);
}

/** A rally army reaching its rally province joins the lowest-id idle army there. */
function mergeRally(sim: Sim, army: Army): void {
  army.intent = 'move';
  for (const other of sim.cache.armiesAt[army.at] ?? []) {
    if (other === army || other.owner !== army.owner || other.at !== army.at || !isIdle(sim, other)) continue;
    addUnits(other.units, army.units);
    other.retreatAt = Math.max(other.retreatAt, army.retreatAt);
    removeArmy(sim, army);
    return;
  }
}

function arrive(sim: Sim, army: Army): void {
  const { state } = sim;
  const leg = army.leg!;
  const to = leg.to;
  army.leg = null;
  army.at = to;
  army.cameFrom = leg.from;
  dropFrom(sim.cache.inbound[to], army);
  insertById(sim.cache.armiesAt[to]!, army);
  const province = state.provinces[to]!;
  if (province.owner === army.owner) {
    if (isContestedNow(sim, to)) engage(sim, to);
    else if (army.path.length === 0 && army.intent === 'rally') mergeRally(sim, army);
    else if (army.path.length === 0) army.intent = 'move';
    return;
  }
  if (leg.sea) army.landingUntil = state.tick + hoursToTicks(MOVEMENT.LANDING_HOURS);
  if (tryWalkIn(sim, army)) {
    if (army.path.length === 0) army.intent = 'move';
    return;
  }
  engage(sim, to);
}

/**
 * The movement phase of a tick: departures, then one tick of progress on every
 * leg, then arrivals, each pass in army-id order. The lowest id arriving in an
 * undefended province takes it; later arrivals attack the new owner.
 */
export function advanceMovement(sim: Sim): void {
  const { state } = sim;
  const tick = state.tick;
  for (const army of state.armies) {
    if (!army.alive || army.leg !== null || army.path.length === 0 || army.departAt > tick) continue;
    // An army in a battle holds, unless its order came during the battle (it was
    // waiting to arrive together): then it pays to disengage and leaves on time.
    if (army.battle !== null && (army.orderedAt < army.battle.joinedAt || !disengage(sim, army))) continue;
    depart(sim, army);
  }
  for (const army of state.armies) if (army.alive && army.leg !== null) army.leg.done += 1;
  for (const army of state.armies) {
    if (army.alive && army.leg !== null && army.leg.done >= army.leg.ticks) arrive(sim, army);
  }
  sim.cache.armyVersion += 1;
}

/**
 * An Oil shortage flag flipped for `n`: every moving land leg with Oil users is
 * re-timed from the speed factor before to the one after (ECONOMY.OIL_SHORT_SPEED or 1).
 */
export function onOilShortageChanged(sim: Sim, n: NationIx, oldFactor: number, newFactor: number): void {
  for (const army of armiesOf(sim, n)) {
    const leg = army.leg;
    if (!army.alive || leg === null || leg.sea || !usesOil(army.units)) continue;
    retimeLeg(leg, speedAtOilFactor(army.units, oldFactor), speedAtOilFactor(army.units, newFactor));
  }
}
