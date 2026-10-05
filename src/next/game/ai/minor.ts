/**
 * A minor nation's daily think (§6.6): a modest economy around the capital, a
 * small army sized by population, the capital guard, and cautious attacks only
 * from next door, with a small forecast budget.
 */
import { AI, UNITS } from '../balance';
import { isContested, ownedProvinces } from '../cache';
import { buildCost } from '../buildings';
import { edgeBetween } from '../world';
import { armySpeedKmh, legTicks } from '../travel';
import { UNIT_TYPES } from '../types';
import type { Army, Command, NationIx, ProvinceIx, Sim, UnitType } from '../types';
import { assessNation, lanchester, liveOperations, ownUnitsAt, provinceValue, softShare, strength, type NationView } from './assess';
import { forceCounts, pickUnit, planUnit, queueLength, tryBuild, walletOf } from './economy';
import {
  canPredict,
  capitalShort,
  defend,
  forecastPicks,
  isAllowedTarget,
  keepsNeedWith,
  launch,
  orderableFor,
  limitPredictions,
  operationCount,
  planRetreats,
  settingsFor,
  type Pick,
  type PlannerSettings,
} from './military';

/** Capital Training Ground kept, capital Works when Funds allow, capital Ramparts when threatened. */
function minorEconomy(sim: Sim, view: NationView, out: Command[]): void {
  const { state } = sim;
  const n = view.nation;
  const capital = state.nations[n]!.capital;
  if (capital === null) return;
  const w = walletOf(sim, view);
  const levels = state.provinces[capital]!.buildings;
  if (levels.training === 0) tryBuild(sim, w, capital, 'training', 'free', out);
  if (levels.works < 3) {
    const cost = buildCost('works', levels.works + 1);
    if (w.stocks.funds > AI.MINOR_WORKS_FUNDS_DAYS * w.income.funds + (cost.funds ?? 0)) tryBuild(sim, w, capital, 'works', 'free', out);
  }
  const ratio = view.threat[capital]! / Math.max(view.defence[capital]!, 1e-9);
  if (levels.ramparts < AI.CAPITAL_RAMPARTS_MAX && ratio > AI.CAPITAL_RAMPARTS_THREAT) tryBuild(sim, w, capital, 'ramparts', 'free', out);
}

/**
 * Trains toward MINOR_ARMY_BASE + MINOR_ARMY_PER_SQRT_MILLION × √(millions),
 * MINOR_HUNTER_SHARE of it Tank Hunters and the rest Rifles, while projected
 * Funds upkeep stays within the upkeep ceiling.
 */
function minorTraining(sim: Sim, view: NationView, out: Command[]): void {
  const { map, state } = sim;
  const n = view.nation;
  const w = walletOf(sim, view);
  const target = AI.MINOR_ARMY_BASE + AI.MINOR_ARMY_PER_SQRT_MILLION * Math.sqrt(map.nations[n]!.population / 1e6);
  const counts = forceCounts(sim, n);
  let total = 0;
  for (const type of UNIT_TYPES) total += counts[type];
  const mix: Record<UnitType, number> = { rifles: 1 - AI.MINOR_HUNTER_SHARE, hunters: AI.MINOR_HUNTER_SHARE, motor: 0, guns: 0, tanks: 0 };
  const capital = state.nations[n]!.capital;
  const sites = ownedProvinces(sim, n)
    .filter((p) => state.provinces[p]!.buildings.training > 0 && !isContested(sim, p))
    .sort((a, b) => (a === capital ? -1 : b === capital ? 1 : a - b));
  for (const p of sites) {
    while (total < target && queueLength(sim, w, p) < AI.QUEUE_TARGET) {
      const unit = pickUnit(mix, counts);
      if (w.projectedUpkeep + (UNITS[unit].upkeep.funds ?? 0) > AI.UPKEEP_CEILING * w.income.funds) return;
      if (!planUnit(sim, w, p, unit, 'free', out)) return;
      counts[unit] += 1;
      total += 1;
    }
  }
}

/**
 * Attacks only from own provinces next to the target, with the armies standing
 * there, at most MINOR_MAX_PREDICTIONS forecasts: the forecast must win keeping
 * MINOR_KEEP, or MINOR_KEEP_VS_MAJOR against a major's (or the player's) province.
 */
function minorAttacks(sim: Sim, view: NationView, s: PlannerSettings, out: Command[]): void {
  const { map, state } = sim;
  const n = view.nation;
  if (!s.attack || capitalShort(view)) return;
  const running = new Set<ProvinceIx>(liveOperations(sim, n).map((op) => op.target));
  const byProvince = new Map<ProvinceIx, Army[]>();
  for (const army of orderableFor(sim, view, s)) {
    const list = byProvince.get(army.at);
    if (list === undefined) byProvince.set(army.at, [army]);
    else list.push(army);
  }
  const targets = new Set<ProvinceIx>();
  for (const p of byProvince.keys()) for (const e of map.edges[p]!) if (isAllowedTarget(sim, view, s, e.to, running)) targets.add(e.to);
  const scored: { t: ProvinceIx; score: number }[] = [];
  for (const t of [...targets].sort((a, b) => a - b)) {
    const force = ownUnitsAt(sim, n, t);
    for (const e of map.edges[t]!) for (const army of byProvince.get(e.to) ?? []) for (const type of UNIT_TYPES) force[type].hp += army.units[type].hp;
    const owner = state.provinces[t]!.owner;
    const defenders = ownUnitsAt(sim, owner, t);
    const garrison = state.provinces[t]!.garrison;
    const terrain = map.provinces[t]!.terrain;
    const ramparts = state.provinces[t]!.buildings.ramparts;
    const attack = strength(force, 0, 'attacker', softShare(defenders, garrison), terrain, ramparts);
    const fight = lanchester(attack, strength(defenders, garrison, 'defender', softShare(force, 0), terrain, ramparts));
    if (!fight.aWins) continue;
    scored.push({ t, score: provinceValue(sim, t, n) / (attack.hp * (1 - fight.keep) + AI.SCORE_BASE_COST) });
  }
  scored.sort((a, b) => b.score - a.score || a.t - b.t);
  for (const { t } of scored) {
    if (operationCount(view) >= s.maxOperations || !canPredict(sim, view)) return;
    const picks: Pick[] = [];
    for (const army of orderableFor(sim, view, s)) {
      const edge = edgeBetween(map, army.at, t);
      if (edge === null || !keepsNeedWith(sim, view, army, picks, t)) continue;
      picks.push({ army, eta: legTicks(sim, army.at, t, edge.km, edge.sea, armySpeedKmh(sim, army)), gather: 0, approach: army.at, landed: edge.sea });
    }
    if (picks.length === 0 || sim.cache.counters.orders + picks.length > AI.MAX_ORDERS) continue;
    const owner = state.nations[state.provinces[t]!.owner]!;
    const keep = owner.tier === 'major' ? AI.MINOR_KEEP_VS_MAJOR : AI.MINOR_KEEP;
    const { prediction } = forecastPicks(sim, n, t, picks, null, true);
    if (prediction.winner !== 'attacker' || prediction.attackerKeeps < keep) continue;
    const etaTicks = picks.reduce((max, p) => Math.max(max, p.eta), 0);
    out.push(launch(sim, view, { target: t, armies: picks.map((p) => p.army.id), prediction, value: provinceValue(sim, t, n), etaTicks, directions: new Set(picks.map((p) => p.approach)).size }));
  }
}

/** The minor think on an existing view (think.ts shares the view with the scheduler's bookkeeping). */
export function minorThink(sim: Sim, view: NationView): Command[] {
  const n = view.nation;
  const s = settingsFor(sim, n);
  limitPredictions(view, AI.MINOR_MAX_PREDICTIONS);
  const out: Command[] = [];
  minorEconomy(sim, view, out);
  minorTraining(sim, view, out);
  const capital = sim.state.nations[n]!.capital;
  if (capital !== null) out.push(...defend(sim, view, s, [capital]));
  out.push(...planRetreats(sim, view));
  minorAttacks(sim, view, s, out);
  return out;
}

export function planMinor(sim: Sim, n: NationIx): Command[] {
  return minorThink(sim, assessNation(sim, n));
}
