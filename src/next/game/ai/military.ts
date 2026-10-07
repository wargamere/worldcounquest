/**
 * The military planner (§6.4) shared by AI majors, the Staff and the advisor:
 * defence, retreats, offensives sized by the mean-roll forecast, staging and
 * housekeeping. Planners only read the state and return Commands; the caller
 * applies them in order.
 *
 * Planners called on the same NationView share a per-think context: armies one
 * step has used are not used again, armies sent to defend count where they are
 * going, and the operation budgets in cache.counters are shared. Every decision
 * is deterministic (no RNG; ties go to the lower index or id).
 */
import { ADVISOR, AI, COMBAT, DIFFICULTY, EFFECTS, MOVEMENT } from '../balance';
import { retreatOfArmies, battleInputAt, setSideRetreat, sideRetreat } from '../combat';
import { armiesAt, armiesOf, armyById, ownedProvinces } from '../cache';
import { dayOf, hoursToTicks } from '../clock';
import { hypotheticalInput, predictBattle, roundOffset, winChance, type Arrival } from '../forecast';
import { retreatTarget } from '../movement';
import { findPath, heuristicTicks, pathFromField, travelField } from '../pathfinding';
import { armySpeedKmh, legTicks } from '../travel';
import { UNIT_TYPES } from '../types';
import type { Army, ArmyId, BattleInput, BattlePrediction, Command, NationIx, ProvinceIx, Reinforcement, Sim, UnitCounts, Units } from '../types';
import { addUnits, copyUnits, scaleUnits, totalCount, totalHp } from '../units';
import { zeroUnits } from '../keys';
import { edgeBetween } from '../world';
import {
  defenceF,
  lanchester,
  liveOperations,
  needWithout,
  OPERATION_TIMEOUT_HOURS,
  ownUnitsAt,
  provinceValue,
  provincesWithin,
  sameOwnRegion,
  softShare,
  strength,
  threatSoft,
  threatUnitsAt,
  type NationView,
} from './assess';

export interface PlannerSettings {
  /** HP share an attack must keep in the mean-roll forecast. */
  attackKeep: number;
  /** Monte Carlo win chance an attack also needs (the advisor); null for the AI. */
  minWinChance: number | null;
  maxOperations: number;
  /** The armies the planner may order. */
  armies: 'all' | ReadonlySet<ArmyId>;
  /** Offensives allowed (false during the opening calm, and for Defend armies). */
  attack: boolean;
  /** Defend stance: an army only goes to provinces this many ticks from its post. */
  defendRadiusTicks: number | null;
  allowPlayerTargets: boolean;
}

export interface OperationPlan {
  target: ProvinceIx;
  armies: ArmyId[];
  prediction: BattlePrediction;
  value: number;
  etaTicks: number;
  directions: number;
}

// ------------------------------------------------------------- settings

/** The advisor's settings (Suggest, Staff): keep ADVISOR.ATTACK_KEEP and win ADVISOR.MIN_WIN_CHANCE. */
export function advisorSettings(armies: 'all' | ReadonlySet<ArmyId>): PlannerSettings {
  return {
    attackKeep: ADVISOR.ATTACK_KEEP,
    minWinChance: ADVISOR.MIN_WIN_CHANCE,
    maxOperations: ADVISOR.MAX_OPERATIONS,
    armies,
    attack: true,
    defendRadiusTicks: null,
    allowPlayerTargets: false,
  };
}

/**
 * Recent operations (launched within OPERATION_TIMEOUT_HOURS) by any nation
 * whose target `n` still holds: how many fronts `n` is already fighting on.
 */
function operationsAgainst(sim: Sim, n: NationIx): number {
  const { state } = sim;
  const since = state.tick - hoursToTicks(OPERATION_TIMEOUT_HOURS);
  let count = 0;
  for (const nation of state.nations) {
    for (const op of nation.ai.operations) if (op.launchedAt > since && state.provinces[op.target]!.owner === n) count += 1;
  }
  return count;
}

/**
 * The player gets the advisor's settings. An AI nation attacks after the opening
 * calm, keeps its difficulty's (or the minors') share, and spares the player
 * through the grace days unless the player provoked it; after that, only so
 * many operations may run against the player at once, so an emptied homeland
 * falls to a neighbour or two rather than to everyone in the same week.
 */
export function settingsFor(sim: Sim, n: NationIx): PlannerSettings {
  const { state } = sim;
  const nation = state.nations[n]!;
  if (nation.isPlayer) return advisorSettings('all');
  const spec = DIFFICULTY[state.difficulty];
  return {
    attackKeep: nation.tier === 'major' ? spec.attackKeep : AI.MINOR_KEEP,
    minWinChance: null,
    maxOperations: spec.maxOperations,
    armies: 'all',
    attack: state.tick >= hoursToTicks(spec.openingCalmHours),
    defendRadiusTicks: null,
    allowPlayerTargets: nation.ai.provoked || (dayOf(state.tick) > spec.playerGraceDays && operationsAgainst(sim, state.player) < spec.playerOperations),
  };
}

// ------------------------------------------------------------- the context

interface Context {
  used: Set<ArmyId>;
  /** Own standing units per province as the plan so far leaves them. */
  units: Map<ProvinceIx, Units>;
  operations: number;
  staging: number;
  predictionCap: number;
  /** The capital's need could not be met: no offensive this think. */
  cancelOffensive: boolean;
  /** Screening scores of attack candidates, for staging. */
  scores: Map<ProvinceIx, number>;
  /** Move commands that launch an operation, by identity. */
  launched: Map<Command, OperationPlan>;
  /** Need at a province with a target's defenders gone, keyed province × count + target. */
  needWithout: Map<number, number>;
}

const contexts = new WeakMap<NationView, Context>();

/** The longest any single leg can take (a capped sea crossing): fields reach one such leg past the gathering radius. */
const CAPPED_LEG_TICKS = hoursToTicks(MOVEMENT.SEA_MAX_KM / MOVEMENT.SEA_KMH);

/** Bisection steps when sizing the share of a guard that must stay. */
const SURPLUS_STEPS = 12;

function contextOf(view: NationView): Context {
  let ctx = contexts.get(view);
  if (ctx === undefined) {
    ctx = {
      used: new Set(),
      units: new Map(),
      operations: view.operations,
      staging: 0,
      predictionCap: AI.MAX_PREDICTIONS,
      cancelOffensive: false,
      scores: new Map(),
      launched: new Map(),
      needWithout: new Map(),
    };
    contexts.set(view, ctx);
  }
  return ctx;
}

/** Minors plan with a smaller forecast budget. */
export function limitPredictions(view: NationView, cap: number): void {
  contextOf(view).predictionCap = cap;
}

/** The operation a planned move command launches, if it is one. */
export function operationOf(view: NationView, command: Command): OperationPlan | undefined {
  return contexts.get(view)?.launched.get(command);
}

function projected(sim: Sim, view: NationView, ctx: Context, p: ProvinceIx): Units {
  let units = ctx.units.get(p);
  if (units === undefined) {
    units = ownUnitsAt(sim, view.nation, p);
    ctx.units.set(p, units);
  }
  return units;
}

function subtract(into: Units, from: Units): void {
  for (const type of UNIT_TYPES) {
    into[type].count = Math.max(0, into[type].count - from[type].count);
    into[type].hp = Math.max(0, into[type].hp - from[type].hp);
  }
}

/** Defence F at `p` with the plan so far. */
function projectedDefence(sim: Sim, view: NationView, ctx: Context, p: ProvinceIx): number {
  return defenceF(sim, p, projected(sim, view, ctx, p), threatSoft(view, p));
}

/** Whether `army`'s province keeps its need without it: the rule that keeps capitals guarded. */
function canLeave(sim: Sim, view: NationView, ctx: Context, army: Army): boolean {
  return canLeaveWith(sim, view, ctx, army, [], null);
}

/** canLeave, with `alsoLeaving` (picked for the same order) gone from the province as well. */
function canLeaveWith(sim: Sim, view: NationView, ctx: Context, army: Army, alsoLeaving: readonly Pick[], target: ProvinceIx | null): boolean {
  const p = army.at;
  if (sim.state.provinces[p]!.owner !== view.nation) return true;
  let need = view.need[p] ?? 0;
  if (need <= 0) return true;
  const rest = copyUnits(projected(sim, view, ctx, p));
  subtract(rest, army.units);
  for (const other of alsoLeaving) if (other.army.at === p) subtract(rest, other.army.units);
  const defence = defenceF(sim, p, rest, threatSoft(view, p));
  if (defence >= need || target === null) return defence >= need;
  // An attack that wins removes the target's defenders from the threat this province faces.
  const key = p * sim.map.provinces.length + target;
  let without = ctx.needWithout.get(key);
  if (without === undefined) {
    without = needWithout(sim, view, p, target);
    ctx.needWithout.set(key, without);
  }
  need = Math.min(need, without);
  return defence >= need;
}

/** The available armies these settings may order, before the guard check. */
function orderableArmies(sim: Sim, view: NationView, ctx: Context, s: PlannerSettings): Army[] {
  const out: Army[] = [];
  for (const id of view.available) {
    if (ctx.used.has(id) || (s.armies !== 'all' && !s.armies.has(id))) continue;
    const army = armyById(sim, id);
    if (army !== undefined && army.alive && army.leg === null && army.battle === null) out.push(army);
  }
  return out;
}

/** The available armies these settings may order now, ascending id. */
function freeArmies(sim: Sim, view: NationView, ctx: Context, s: PlannerSettings): Army[] {
  return orderableArmies(sim, view, ctx, s).filter((army) => canLeave(sim, view, ctx, army));
}

/** Records an order: the army leaves its province and, for a defence, counts where it goes. */
function commit(sim: Sim, view: NationView, ctx: Context, army: Army, to: ProvinceIx | null): void {
  ctx.used.add(army.id);
  subtract(projected(sim, view, ctx, army.at), army.units);
  if (to !== null && sim.state.provinces[to]!.owner === view.nation) addUnits(projected(sim, view, ctx, to), army.units);
}

function predictionsLeft(sim: Sim, ctx: Context): boolean {
  return sim.cache.counters.predictions < ctx.predictionCap;
}

function ordersLeft(sim: Sim, count: number): boolean {
  return sim.cache.counters.orders + count <= AI.MAX_ORDERS;
}

function move(n: NationIx, armies: readonly ArmyId[], to: ProvinceIx, together: boolean): Command {
  return { kind: 'move', nation: n, armies: [...armies], to, together, append: false };
}

/**
 * A cheap lower estimate of an army's ETA to `p`: the straight-line bound, or
 * (if larger) its own-territory distance to the nearest frontier province or
 * capital, which any route out of its land must cover first. The view's field
 * is timed at REFERENCE_SPEED_KMH, so it is scaled to the army's pace.
 */
function etaBound(sim: Sim, view: NationView, army: Army, p: ProvinceIx): number {
  const speed = armySpeedKmh(sim, army);
  const chord = heuristicTicks(sim, army.at, p, speed);
  const ticks = view.field.ticks[army.at] ?? -1;
  if (ticks < 0 || speed <= 0) return chord;
  return Math.max(chord, (ticks * AI.REFERENCE_SPEED_KMH) / speed);
}

/** Threat over defence: how exposed a province is. */
function pressureAt(view: NationView, p: ProvinceIx): number {
  return view.threat[p]! / Math.max(view.defence[p]!, 1e-9);
}

// ------------------------------------------------------------- forecasts

/** A candidate attacker: its real ETA along the field route, its approach and whether it lands from the sea. */
export interface Pick {
  army: Army;
  eta: number;
  /** Ticks to reach the approach province: the gathering time that ATTACK_ETA_HOURS bounds. */
  gather: number;
  approach: ProvinceIx | null;
  landed: boolean;
}

/** Ticks along a route at this army's pace. */
function routeTicks(sim: Sim, army: Army, nodes: readonly ProvinceIx[]): number {
  const speed = armySpeedKmh(sim, army);
  let from = army.at;
  let total = 0;
  for (const to of nodes) {
    const edge = edgeBetween(sim.map, from, to);
    if (edge === null) return Number.POSITIVE_INFINITY;
    total += legTicks(sim, from, to, edge.km, edge.sea, speed);
    from = to;
  }
  return total;
}

/** The pick for an army routed to `target` by a field built from it, or null if the field does not reach it. */
function pickFromField(sim: Sim, field: { ticks: Int32Array; next: Int32Array }, army: Army, target: ProvinceIx): Pick | null {
  if (army.at === target || (field.ticks[army.at] ?? -1) < 0) return null;
  const nodes = pathFromField(field, army.at);
  if (nodes.length === 0 || nodes[nodes.length - 1] !== target) return null;
  const approach = nodes.length >= 2 ? nodes[nodes.length - 2]! : army.at;
  const gather = routeTicks(sim, army, nodes.slice(0, -1));
  return { army, eta: routeTicks(sim, army, nodes), gather, approach, landed: edgeBetween(sim.map, approach, target)?.sea === true };
}

/**
 * The defender's help as the planner counts it: owner armies one hop away at
 * full strength and two hops away at THREAT_FAR_WEIGHT, each arriving at its
 * own ETA (never before our first round).
 */
function defenderArrivals(sim: Sim, target: ProvinceIx): { army: Army; units: Units; eta: number }[] {
  const { map, state } = sim;
  const owner = state.provinces[target]!.owner;
  const out: { army: Army; units: Units; eta: number }[] = [];
  for (const { p: q, d } of provincesWithin(sim, target, AI.THREAT_HOPS)) {
    if (d === 0) continue;
    for (const army of armiesAt(sim, q)) {
      if (!army.alive || army.owner !== owner || army.leg !== null || army.battle !== null) continue;
      const speed = armySpeedKmh(sim, army);
      let eta = Number.POSITIVE_INFINITY;
      if (d === 1) {
        const edge = edgeBetween(map, q, target)!;
        eta = legTicks(sim, q, target, edge.km, edge.sea, speed);
      } else {
        for (const e of map.edges[q]!) {
          const onward = edgeBetween(map, e.to, target);
          if (onward === null) continue;
          eta = Math.min(eta, legTicks(sim, q, e.to, e.km, e.sea, speed) + legTicks(sim, e.to, target, onward.km, onward.sea, speed));
        }
      }
      if (!Number.isFinite(eta)) continue;
      out.push({ army, units: d === 1 ? copyUnits(army.units) : scaleUnits(army.units, AI.THREAT_FAR_WEIGHT), eta });
    }
  }
  return out;
}

export interface PicksForecast {
  input: BattleInput;
  reinforcements: Reinforcement[];
  prediction: BattlePrediction;
}

/**
 * The mean-roll forecast of `picks` attacking `target` together (all entering
 * in the tick of the slowest), against the garrison at that time, the owner's
 * armies there and the owner's help from up to two hops. The ordered armies
 * retreat at their own thresholds. `viewer` applies the player's fog.
 */
export function forecastPicks(sim: Sim, n: NationIx, target: ProvinceIx, picks: readonly Pick[], viewer: NationIx | null, withHelp: boolean): PicksForecast {
  const latest = picks.reduce((max, p) => Math.max(max, p.eta), 0);
  const hour = roundOffset(sim, latest);
  const arrivals: Arrival[] = picks.map((p) => ({ nation: n, units: copyUnits(p.army.units), direction: p.approach, landed: p.landed, atHour: hour }));
  if (withHelp) {
    const owner = sim.state.provinces[target]!.owner;
    for (const help of defenderArrivals(sim, target)) {
      arrivals.push({ nation: owner, units: help.units, direction: null, landed: false, atHour: Math.max(hour, roundOffset(sim, help.eta)) });
    }
  }
  const { input, reinforcements } = hypotheticalInput(sim, target, arrivals, viewer);
  const retreatAt = retreatOfArmies(picks.map((p) => p.army)).retreatAt;
  for (const side of input.attackers) if (side.nation === n) setSideRetreat(side, { ...sideRetreat(side), retreatAt });
  for (const r of reinforcements) if (r.side.nation === n) setSideRetreat(r.side, { ...sideRetreat(r.side), retreatAt });
  sim.cache.counters.predictions += 1;
  const prediction = predictBattle(input, n, reinforcements, COMBAT.PREDICT_MAX_HOURS);
  return { input, reinforcements, prediction };
}

/**
 * The hold check: after the capture, the survivors (the attackers scaled by the
 * share they keep) must stand at least HOLD_GUARD × the hostile force left within
 * two hops of the prize.
 */
function canHold(sim: Sim, n: NationIx, target: ProvinceIx, picks: readonly Pick[], keeps: number): boolean {
  const units = copyUnits(picks[0]!.army.units);
  for (const p of picks.slice(1)) addUnits(units, p.army.units);
  const survivors = scaleUnits(units, keeps);
  const hostile = threatUnitsAt(sim, n, target, target);
  const terrain = sim.map.provinces[target]!.terrain;
  const ramparts = Math.max(0, sim.state.provinces[target]!.buildings.ramparts - EFFECTS.CAPTURE_LEVEL_LOSS.ramparts);
  const hold = strength(survivors, 0, 'defender', softShare(hostile, 0), terrain, ramparts).f;
  const threat = strength(hostile, 0, 'attacker', softShare(survivors, 0), terrain, ramparts).f;
  return hold >= AI.HOLD_GUARD * threat;
}

// ------------------------------------------------------------- defence

/**
 * For each frontier province in order, while its defence is below its need,
 * the nearest free army at most DEFENCE_ETA_HOURS away (by an own-territory
 * route) is sent. Defend armies only go within their radius of their post. If
 * the capital stays short, offensives are off for this think.
 */
export function planDefence(sim: Sim, view: NationView, s: PlannerSettings): Command[] {
  return defend(sim, view, s, view.frontier);
}

/** Defence over an explicit list of provinces (a minor guards only its capital). */
export function defend(sim: Sim, view: NationView, s: PlannerSettings, provinces: readonly ProvinceIx[]): Command[] {
  const ctx = contextOf(view);
  const n = view.nation;
  const capital = sim.state.nations[n]!.capital;
  const out: Command[] = [];
  const reach = hoursToTicks(AI.DEFENCE_ETA_HOURS);
  for (const f of provinces) {
    if (sim.state.provinces[f]!.owner !== n) continue;
    let def = projectedDefence(sim, view, ctx, f);
    const need = view.need[f] ?? 0;
    if (def >= need) continue;
    const candidates = freeArmies(sim, view, ctx, s)
      .filter((a) => a.at !== f)
      .map((army) => ({ army, h: etaBound(sim, view, army, f) }))
      .filter((c) => c.h <= reach)
      .sort((x, y) => x.h - y.h || x.army.id - y.army.id);
    for (const { army } of candidates) {
      if (def >= need || !ordersLeft(sim, 1)) break;
      if (sim.cache.counters.paths >= AI.MAX_PATHS) break;
      // An earlier pick from the same province may have used up what it could spare.
      if (!canLeave(sim, view, ctx, army)) continue;
      if (s.defendRadiusTicks !== null) {
        const post = army.post ?? army.at;
        if (post !== army.at && heuristicTicks(sim, post, f, armySpeedKmh(sim, army)) > s.defendRadiusTicks) continue;
      }
      const limit = s.defendRadiusTicks === null ? reach : Math.min(reach, s.defendRadiusTicks);
      const path = findPath(sim, army.at, f, { nation: n, speedKmh: armySpeedKmh(sim, army), mode: 'own', maxTicks: limit });
      if (path === null) continue;
      out.push(move(n, [army.id], f, false));
      commit(sim, view, ctx, army, f);
      sim.cache.counters.orders += 1;
      def = projectedDefence(sim, view, ctx, f);
    }
    if (f === capital && def < need) ctx.cancelOffensive = true;
  }
  return out;
}

/** Whether a defence step left the capital short (the AI then queues emergency Rifles). */
export function capitalShort(view: NationView): boolean {
  return contexts.get(view)?.cancelOffensive === true;
}

// ------------------------------------------------------------- retreats

/** Armies this planner may pull out of a battle: all of an AI's, only the player's Delegate armies. */
function commandable(sim: Sim, army: Army): boolean {
  return !sim.state.nations[army.owner]!.isPlayer || army.stance === 'delegate';
}

/**
 * Attacking armies below RETREAT_BELOW_HP of the HP they joined with, in a
 * battle the forecast says they lose, fall back (where a safe province exists).
 */
export function planRetreats(sim: Sim, view: NationView): Command[] {
  const ctx = contextOf(view);
  const n = view.nation;
  const out: Command[] = [];
  for (const p of sim.cache.battles) {
    if (sim.state.provinces[p]!.owner === n) continue;
    const weak = armiesAt(sim, p).filter(
      (a) =>
        a.alive &&
        a.owner === n &&
        a.leg === null &&
        a.battle !== null &&
        !ctx.used.has(a.id) &&
        commandable(sim, a) &&
        totalHp(a.units) < AI.RETREAT_BELOW_HP * a.battle.startHp,
    );
    if (weak.length === 0) continue;
    if (!predictionsLeft(sim, ctx)) break;
    const input = battleInputAt(sim, p);
    if (input === null) continue;
    sim.cache.counters.predictions += 1;
    const prediction = predictBattle(input, n, [], COMBAT.PREDICT_MAX_HOURS);
    if (prediction.winner === 'attacker') continue;
    const leaving = weak.filter((a) => retreatTarget(sim, a) !== null);
    if (leaving.length === 0) continue;
    out.push({ kind: 'retreat', nation: n, armies: leaving.map((a) => a.id), to: null });
    for (const army of leaving) ctx.used.add(army.id);
  }
  return out;
}

// ------------------------------------------------------------- offensive

/** Whether `p` may be attacked: hostile, not already an operation's target, the player only after grace, not a battle we are in. */
export function isAllowedTarget(sim: Sim, view: NationView, s: PlannerSettings, p: ProvinceIx, running: ReadonlySet<ProvinceIx>): boolean {
  const { state } = sim;
  const owner = state.provinces[p]!.owner;
  if (owner === view.nation || running.has(p)) return false;
  if (state.nations[owner]!.isPlayer && !s.allowPlayerTargets) return false;
  // Armies already fighting there are reinforced by the defence and retreat steps, not a new operation.
  return !armiesAt(sim, p).some((a) => a.owner === view.nation && a.battle !== null);
}

/**
 * Hostile provinces next to own land or own armies, screened by Lanchester
 * against the free armies within ATTACK_ETA_HOURS and scored by value over
 * (expected HP loss + SCORE_ETA_HOUR_COST × mean ETA hours + SCORE_BASE_COST);
 * the best MAX_TARGETS, best first.
 */
export function candidateTargets(sim: Sim, view: NationView, s: PlannerSettings): ProvinceIx[] {
  const { map, state } = sim;
  const ctx = contextOf(view);
  const n = view.nation;
  const running = new Set<ProvinceIx>(liveOperations(sim, n).map((op) => op.target));
  const near = new Set<ProvinceIx>();
  const around = (p: ProvinceIx): void => {
    for (const e of map.edges[p]!) if (isAllowedTarget(sim, view, s, e.to, running)) near.add(e.to);
  };
  for (const p of ownedProvinces(sim, n)) around(p);
  for (const army of armiesOf(sim, n)) if (army.alive && army.leg === null) around(army.at);

  const orderable = orderableArmies(sim, view, ctx, s);
  const armies = orderable.filter((army) => canLeave(sim, view, ctx, army));
  if (orderable.length === 0 || near.size === 0 || !targetFieldLeft(sim)) return [];
  const reach = hoursToTicks(AI.ATTACK_ETA_HOURS);
  const targets = [...near].sort((x, y) => x - y);
  // Who can reach what: each army counts for the candidate its own-territory route
  // reaches first (one field over every candidate) and for any candidate next door.
  const fastest = orderable.reduce<number>((max, a) => Math.max(max, armySpeedKmh(sim, a)), AI.REFERENCE_SPEED_KMH);
  const field = travelField(sim, targets, { nation: n, speedKmh: AI.REFERENCE_SPEED_KMH, mode: 'own', maxTicks: Math.ceil((reach * fastest) / AI.REFERENCE_SPEED_KMH) + CAPPED_LEG_TICKS });
  const reaching = new Map<ProvinceIx, { army: Army; eta: number }[]>();
  const reaches = (t: ProvinceIx, army: Army, eta: number, gather: number): void => {
    if (gather > reach) return;
    const list = reaching.get(t);
    if (list === undefined) reaching.set(t, [{ army, eta }]);
    else if (!list.some((r) => r.army === army)) list.push({ army, eta });
  };
  // An army may join an attack on any candidate in reach, not only on the one its
  // route reaches first (§6.4: the screen counts every available army within
  // ATTACK_ETA_HOURS). The field gives the exact route to that nearest candidate;
  // for the others, the straight-line time to an own approach province bounds
  // the gathering time from below and the nearest ETA bounds the arrival.
  for (const army of armies) {
    const nodes = pathFromField(field, army.at);
    if (nodes.length === 0) continue;
    const nearest = nodes[nodes.length - 1]!;
    const eta = routeTicks(sim, army, nodes);
    reaches(nearest, army, eta, routeTicks(sim, army, nodes.slice(0, -1)));
    const speed = armySpeedKmh(sim, army);
    for (const t of targets) {
      if (t === nearest) continue;
      let gather = Number.POSITIVE_INFINITY;
      for (const e of map.edges[t]!) {
        if (e.to === army.at) gather = 0;
        else if (state.provinces[e.to]!.owner === n) gather = Math.min(gather, heuristicTicks(sim, army.at, e.to, speed));
      }
      if (gather <= reach) reaches(t, army, Math.max(eta, heuristicTicks(sim, army.at, t, speed)), gather);
    }
  }
  // A guard pinned by the army next door may still strike that army's province.
  for (const army of orderable) {
    for (const e of map.edges[army.at]!) {
      if (near.has(e.to) && canLeaveWith(sim, view, ctx, army, [], e.to)) reaches(e.to, army, legTicks(sim, army.at, e.to, e.km, e.sea, armySpeedKmh(sim, army)), 0);
    }
  }
  const scored: { p: ProvinceIx; score: number }[] = [];
  for (const p of targets) {
    const list = reaching.get(p);
    if (list === undefined) continue;
    const force = zeroUnits();
    let etaSum = 0;
    for (const { army, eta } of list) {
      addUnits(force, army.units);
      etaSum += eta;
    }
    const owner = state.provinces[p]!.owner;
    const defenders = ownUnitsAt(sim, owner, p);
    const garrison = state.provinces[p]!.garrison;
    const terrain = map.provinces[p]!.terrain;
    const ramparts = state.provinces[p]!.buildings.ramparts;
    const attack = strength(force, 0, 'attacker', softShare(defenders, garrison), terrain, ramparts);
    const defence = strength(defenders, garrison, 'defender', softShare(force, 0), terrain, ramparts);
    const fight = lanchester(attack, defence);
    if (!fight.aWins) continue;
    const loss = attack.hp * (1 - fight.keep);
    const etaHours = etaSum / list.length / hoursToTicks(1);
    const score = provinceValue(sim, p, n) / (loss + AI.SCORE_ETA_HOUR_COST * etaHours + AI.SCORE_BASE_COST);
    scored.push({ p, score });
    ctx.scores.set(p, score);
  }
  scored.sort((a, b) => b.score - a.score || a.p - b.p);
  return scored.slice(0, AI.MAX_TARGETS).map((c) => c.p);
}

/**
 * Sizes one attack on `target`: a travel field from the target over own land
 * gives every free army's route and ETA; armies join nearest first, except that
 * one adding a new direction wins if at most FLANK_PREFERENCE_HOURS slower; the
 * force grows until the forecast wins keeping attackKeep (and, for the advisor,
 * wins minWinChance of the samples) and the survivors can hold the prize. It is
 * never capped below that: if every candidate together falls short, null.
 */
export function planOperation(sim: Sim, view: NationView, s: PlannerSettings, target: ProvinceIx): OperationPlan | null {
  return sizeAttack(sim, view, s, target, AI.ATTACK_ETA_HOURS, true);
}

/**
 * The sizing loop behind planOperation, also used by "Attack with…" and the
 * onboarding target: armies within `reachHours`, with or without the hold check.
 */
export function sizeAttack(sim: Sim, view: NationView, s: PlannerSettings, target: ProvinceIx, reachHours: number, hold: boolean): OperationPlan | null {
  const ctx = contextOf(view);
  const n = view.nation;
  if (!targetFieldLeft(sim) || !predictionsLeft(sim, ctx)) return null;
  const armies = orderableArmies(sim, view, ctx, s).filter((army) => canLeaveWith(sim, view, ctx, army, [], target));
  if (armies.length === 0) return null;
  const fastest = armies.reduce<number>((max, a) => Math.max(max, armySpeedKmh(sim, a)), AI.REFERENCE_SPEED_KMH);
  const reach = hoursToTicks(reachHours);
  const field = travelField(sim, [target], {
    nation: n,
    speedKmh: AI.REFERENCE_SPEED_KMH,
    mode: 'own',
    maxTicks: Math.ceil((reach * fastest) / AI.REFERENCE_SPEED_KMH) + CAPPED_LEG_TICKS,
  });
  const pool: Pick[] = [];
  for (const army of armies) {
    const pick = pickFromField(sim, field, army, target);
    if (pick !== null && pick.gather <= reach) pool.push(pick);
  }
  pool.sort((a, b) => a.eta - b.eta || a.army.id - b.army.id);
  const chosen: Pick[] = [];
  const directions = new Set<ProvinceIx>();
  const slack = hoursToTicks(AI.FLANK_PREFERENCE_HOURS);
  const viewer = sim.state.nations[n]!.isPlayer ? n : null;
  while (pool.length > 0) {
    if (!predictionsLeft(sim, ctx) || !ordersLeft(sim, chosen.length + 1)) return null;
    const nearest = pool[0]!;
    let index = 0;
    if (nearest.approach !== null && directions.has(nearest.approach)) {
      const flank = pool.findIndex((p) => p.approach !== null && !directions.has(p.approach) && p.eta <= nearest.eta + slack);
      if (flank >= 0) index = flank;
    }
    const pick = pool.splice(index, 1)[0]!;
    // Armies already picked from the same province leave too: it must still keep its need.
    if (!canLeaveWith(sim, view, ctx, pick.army, chosen, target)) continue;
    chosen.push(pick);
    if (pick.approach !== null) directions.add(pick.approach);
    const forecast = forecastPicks(sim, n, target, chosen, viewer, true);
    const { prediction } = forecast;
    if (prediction.winner !== 'attacker' || prediction.attackerKeeps < s.attackKeep) continue;
    if (s.minWinChance !== null) {
      if (!predictionsLeft(sim, ctx)) return null;
      sim.cache.counters.predictions += 1;
      if (winChance(forecast.input, n, forecast.reinforcements, COMBAT.WIN_CHANCE_SAMPLES) < s.minWinChance) continue;
    }
    if (hold && !canHold(sim, n, target, chosen, prediction.attackerKeeps)) continue;
    return {
      target,
      armies: chosen.map((p) => p.army.id),
      prediction,
      value: provinceValue(sim, target, n),
      etaTicks: chosen.reduce((max, p) => Math.max(max, p.eta), 0),
      directions: Math.max(1, directions.size),
    };
  }
  return null;
}

/**
 * Whether another target travel field fits the think's budget. One field is
 * always kept back for the frontier field, which the view builds lazily on first
 * use: without the reserve, eight target fields followed by defence or staging
 * made ten (Brazil, in a 30-day world game).
 */
function targetFieldLeft(sim: Sim): boolean {
  return sim.cache.counters.fields < AI.MAX_FIELDS - 1;
}

/** Whether `army` may join an order with `picks` and still leave its province guarded. */
export function keepsNeedWith(sim: Sim, view: NationView, army: Army, picks: readonly Pick[], target: ProvinceIx): boolean {
  return canLeaveWith(sim, view, contextOf(view), army, picks, target);
}

/** The armies these settings may order before the guard check (callers check keepsNeedWith per target). */
export function orderableFor(sim: Sim, view: NationView, s: PlannerSettings): Army[] {
  return orderableArmies(sim, view, contextOf(view), s);
}

/** Operations running or launched so far this think. */
export function operationCount(view: NationView): number {
  return contextOf(view).operations;
}

/** Whether forecasts remain in this think's budget. */
export function canPredict(sim: Sim, view: NationView): boolean {
  return predictionsLeft(sim, contextOf(view));
}

/** Launches a sized attack: one arrive-together move, recorded as an operation. */
export function launch(sim: Sim, view: NationView, plan: OperationPlan): Command {
  const ctx = contextOf(view);
  const command = move(view.nation, plan.armies, plan.target, true);
  ctx.launched.set(command, plan);
  ctx.operations += 1;
  sim.cache.counters.orders += plan.armies.length;
  for (const id of plan.armies) commit(sim, view, ctx, armyById(sim, id)!, null);
  return command;
}

/**
 * After the opening calm and while operations are below the cap: plan the best
 * candidates in turn and launch each sized attack as one arrive-together move.
 */
export function planOffensive(sim: Sim, view: NationView, s: PlannerSettings): Command[] {
  const ctx = contextOf(view);
  const out: Command[] = [];
  if (!s.attack || ctx.cancelOffensive) return out;
  for (const target of candidateTargets(sim, view, s)) {
    if (ctx.operations >= s.maxOperations) break;
    const plan = planOperation(sim, view, s, target);
    if (plan !== null) out.push(launch(sim, view, plan));
  }
  return out;
}

// ------------------------------------------------------------- staging

/**
 * Idle interior armies move to the frontier province within STAGING_RADIUS_HOURS
 * with the highest threat/defence plus best adjacent target score (normalised
 * to the best screened target), at most MAX_STAGING_ORDERS per think.
 */
export function planStaging(sim: Sim, view: NationView, s: PlannerSettings): Command[] {
  const ctx = contextOf(view);
  const { map, state } = sim;
  const n = view.nation;
  const out: Command[] = [];
  // The capital heads the frontier list but is interior unless it borders hostile land.
  const onBorder = (p: ProvinceIx): boolean => map.edges[p]!.some((e) => state.provinces[e.to]!.owner !== n);
  let best = 0;
  for (const score of ctx.scores.values()) best = Math.max(best, score);
  const targetScore = (f: ProvinceIx): number => {
    if (best <= 0) return 0;
    let top = 0;
    for (const e of map.edges[f]!) top = Math.max(top, ctx.scores.get(e.to) ?? 0);
    return top / best;
  };
  const scoreOf = new Map<ProvinceIx, number>();
  for (const f of view.frontier) scoreOf.set(f, pressureAt(view, f) + targetScore(f));
  const reach = hoursToTicks(AI.STAGING_RADIUS_HOURS);
  for (const army of freeArmies(sim, view, ctx, s)) {
    if (ctx.staging >= AI.MAX_STAGING_ORDERS || !ordersLeft(sim, 1)) break;
    if (state.provinces[army.at]!.owner !== n || onBorder(army.at) || !canLeave(sim, view, ctx, army)) continue;
    let to: ProvinceIx | null = null;
    let top = 0;
    for (const f of view.frontier) {
      const score = scoreOf.get(f)!;
      if (f === army.at || !onBorder(f) || score <= top || !sameOwnRegion(sim, view, army.at, f) || etaBound(sim, view, army, f) > reach) continue;
      to = f;
      top = score;
    }
    if (to === null) continue;
    out.push(move(n, [army.id], to, false));
    commit(sim, view, ctx, army, to);
    ctx.staging += 1;
    sim.cache.counters.orders += 1;
  }
  return out;
}

// ------------------------------------------------------------- housekeeping

/**
 * A guard that cannot leave as a whole may still hold more than its province
 * needs (new units join the idle army where they are trained). The largest such
 * surplus, in whole units taken evenly from every type, is split off so that it
 * can be used once the reassignment window has passed.
 */
function guardSurplus(sim: Sim, view: NationView, ctx: Context, free: readonly Army[]): { army: Army; take: UnitCounts } | null {
  let best: { army: Army; take: UnitCounts; units: number } | null = null;
  for (const army of free) {
    // Only an army bigger than a mergeable one can shed a surplus that is not merged straight back.
    if (ctx.used.has(army.id) || totalCount(army.units) <= AI.MERGE_BELOW_UNITS || canLeave(sim, view, ctx, army)) continue;
    const p = army.at;
    const need = view.need[p] ?? 0;
    const others = copyUnits(projected(sim, view, ctx, p));
    subtract(others, army.units);
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < SURPLUS_STEPS; i += 1) {
      const mid = (lo + hi) / 2;
      const guard = copyUnits(others);
      addUnits(guard, scaleUnits(army.units, mid));
      if (defenceF(sim, p, guard, threatSoft(view, p)) >= need) hi = mid;
      else lo = mid;
    }
    const take: UnitCounts = {};
    let units = 0;
    for (const type of UNIT_TYPES) {
      const count = Math.floor(army.units[type].count * (1 - hi));
      take[type] = count;
      units += count;
    }
    // A surplus smaller than a mergeable army would only be merged straight back.
    if (units < AI.MERGE_BELOW_UNITS || units >= totalCount(army.units)) continue;
    if (best === null || units > best.units) best = { army, take, units };
  }
  return best === null ? null : { army: best.army, take: best.take };
}

/**
 * Co-located idle armies smaller than MERGE_BELOW_UNITS merge (up to
 * MERGE_MAX_UNITS); one army above SPLIT_ABOVE_UNITS splits in half, since
 * frontage makes very large armies inefficient, or failing that a guard splits
 * off what its province does not need. Capital guards fight to the end
 * (retreatAt 0); AI armies elsewhere use the AI threshold.
 */
export function planHousekeeping(sim: Sim, view: NationView): Command[] {
  const ctx = contextOf(view);
  const { state } = sim;
  const n = view.nation;
  const nation = state.nations[n]!;
  const out: Command[] = [];
  const free = view.available
    .map((id) => armyById(sim, id))
    .filter((a): a is Army => a !== undefined && a.alive && a.leg === null && a.battle === null && !ctx.used.has(a.id));

  const byProvince = new Map<ProvinceIx, Army[]>();
  for (const army of free) {
    if (totalCount(army.units) >= AI.MERGE_BELOW_UNITS) continue;
    const list = byProvince.get(army.at);
    if (list === undefined) byProvince.set(army.at, [army]);
    else list.push(army);
  }
  for (const p of [...byProvince.keys()].sort((x, y) => x - y)) {
    const group: Army[] = [];
    let units = 0;
    for (const army of byProvince.get(p)!) {
      const size = totalCount(army.units);
      if (group.length > 0 && army.stance !== group[0]!.stance) continue;
      if (units + size > AI.MERGE_MAX_UNITS) continue;
      group.push(army);
      units += size;
    }
    if (group.length < 2) continue;
    out.push({ kind: 'merge', nation: n, armies: group.map((a) => a.id) });
    for (const army of group) ctx.used.add(army.id);
  }

  const big = free.find((a) => !ctx.used.has(a.id) && totalCount(a.units) > AI.SPLIT_ABOVE_UNITS);
  if (big !== undefined) {
    const take: UnitCounts = {};
    for (const type of UNIT_TYPES) take[type] = Math.floor(big.units[type].count / 2);
    out.push({ kind: 'split', nation: n, army: big.id, take });
    ctx.used.add(big.id);
  } else {
    const surplus = guardSurplus(sim, view, ctx, free);
    if (surplus !== null) {
      out.push({ kind: 'split', nation: n, army: surplus.army.id, take: surplus.take });
      ctx.used.add(surplus.army.id);
    }
  }

  if (!nation.isPlayer) {
    const guards: ArmyId[] = [];
    const field: ArmyId[] = [];
    for (const army of free) {
      if (ctx.used.has(army.id)) continue;
      if (army.at === nation.capital && army.retreatAt !== 0) guards.push(army.id);
      else if (army.at !== nation.capital && army.retreatAt !== COMBAT.AI_RETREAT_AT) field.push(army.id);
    }
    if (guards.length > 0) out.push({ kind: 'retreatAt', nation: n, armies: guards, at: 0 });
    if (field.length > 0) out.push({ kind: 'retreatAt', nation: n, armies: field, at: COMBAT.AI_RETREAT_AT });
  }
  return out;
}
