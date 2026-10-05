/**
 * The advisor (§6.9): Suggest (A) runs the major planner as a dry run over the
 * player's idle Manual armies with the advisor's settings and returns cards the
 * player can accept as-is; "Attack with…" pre-ticks the smallest force with
 * suggestForce; onboarding picks its first target with suggestFirstTarget.
 *
 * Nothing here changes the state. Every card's commands validate on the state
 * it was made from, and no card leaves the capital below its guard (planners
 * only use armies whose province keeps its need without them).
 */
import { ADVISOR, AI } from '../balance';
import { armiesOf, isContested, ownedProvinces } from '../cache';
import { armyStatus, isIdle } from '../armies';
import { forecastPlans } from '../forecast';
import { quote } from '../market';
import { planOrder } from '../movement';
import { previewOrder } from '../orders';
import { bestProvincesFor } from '../buildings';
import { canTrain } from '../training';
import type { ArmyId, BuildingType, Command, Forecast, Good, NationIx, OrderPreview, ProvinceIx, Sim, UnitType } from '../types';
import { assessPlayer, withAvailable, type NationView } from './assess';
import { forceCounts, freshWallet, marketStep, pickUnit, targetMix } from './economy';
import { advisorSettings, operationOf, planDefence, planOffensive, sizeAttack, type OperationPlan } from './military';
import { resetCounters } from './think';

export type Suggestion =
  | { kind: 'attack'; plan: OperationPlan; forecast: Forecast; commands: Command[] }
  | { kind: 'defend'; province: ProvinceIx; armies: ArmyId[]; commands: Command[] }
  | { kind: 'build'; province: ProvinceIx; building: BuildingType; paybackDays: number; commands: Command[] }
  | { kind: 'train'; province: ProvinceIx; unit: UnitType; commands: Command[] }
  | { kind: 'market'; good: Good; amount: number; funds: number; commands: Command[] };

/** The player's view with `pick` deciding which armies the advisor may use. */
function playerView(sim: Sim, pick: (id: ArmyId) => boolean): NationView {
  const n = sim.state.player;
  const view = assessPlayer(sim);
  const ids = armiesOf(sim, n)
    .filter((a) => pick(a.id))
    .map((a) => a.id);
  return withAvailable(view, ids);
}

/** The player's idle Manual armies: the ones a Suggest card may use. */
function idleManual(sim: Sim): (id: ArmyId) => boolean {
  const ids = new Set<ArmyId>();
  for (const army of armiesOf(sim, sim.state.player)) if (isIdle(sim, army) && army.stance === 'manual') ids.add(army.id);
  return (id) => ids.has(id);
}

function defendCards(sim: Sim, view: NationView): Suggestion[] {
  const byProvince = new Map<ProvinceIx, Command[]>();
  for (const command of planDefence(sim, view, advisorSettings('all'))) {
    if (command.kind !== 'move') continue;
    const list = byProvince.get(command.to);
    if (list === undefined) byProvince.set(command.to, [command]);
    else list.push(command);
  }
  const out: Suggestion[] = [];
  for (const [province, commands] of byProvince) {
    const armies = commands.flatMap((c) => (c.kind === 'move' ? [...c.armies] : []));
    out.push({ kind: 'defend', province, armies, commands });
  }
  return out;
}

function attackCards(sim: Sim, view: NationView): Suggestion[] {
  const n = view.nation;
  const out: Suggestion[] = [];
  for (const command of planOffensive(sim, view, advisorSettings('all'))) {
    const plan = operationOf(view, command);
    if (plan === undefined) continue;
    const plans = planOrder(sim, n, plan.armies, plan.target, true);
    if (typeof plans === 'string') continue;
    const forecast = forecastPlans(sim, n, plan.target, plans);
    if (forecast === null) continue;
    out.push({ kind: 'attack', plan, forecast, commands: [command] });
  }
  return out;
}

function marketCards(sim: Sim, n: NationIx): Suggestion[] {
  const out: Suggestion[] = [];
  // Each good is traded at most once per step and pressure is per good, so the live quote is the card's price.
  for (const command of marketStep(sim, freshWallet(sim, n))) {
    if (command.kind !== 'trade' || command.amount <= 0) continue;
    const { funds } = quote(sim.state.market, command.good, command.amount);
    out.push({ kind: 'market', good: command.good, amount: command.amount, funds, commands: [command] });
  }
  return out;
}

function buildCards(sim: Sim, n: NationIx): Suggestion[] {
  for (const { province, preview } of bestProvincesFor(sim, n, 'works', AI.MAX_TARGETS)) {
    if (preview.reason !== null || preview.paybackDays === null || preview.paybackDays > AI.WORKS_MAX_PAYBACK_DAYS) continue;
    return [{ kind: 'build', province, building: 'works', paybackDays: preview.paybackDays, commands: [{ kind: 'build', nation: n, province, building: 'works' }] }];
  }
  return [];
}

function trainCards(sim: Sim, n: NationIx): Suggestion[] {
  const { state } = sim;
  const counts = forceCounts(sim, n);
  const capital = state.nations[n]!.capital;
  const sites = ownedProvinces(sim, n)
    .filter((p) => state.provinces[p]!.buildings.training > 0 && state.provinces[p]!.queue.length === 0 && !isContested(sim, p))
    .sort((a, b) => (a === capital ? -1 : b === capital ? 1 : a - b));
  for (const p of sites) {
    const unit = pickUnit(targetMix(state.provinces[p]!.buildings.training, false, !state.nations[n]!.shortage.oil), counts);
    if (!canTrain(sim, n, p, unit, 1).ok) continue;
    return [{ kind: 'train', province: p, unit, commands: [{ kind: 'train', nation: n, province: p, unit, count: 1 }] }];
  }
  return [];
}

/**
 * Up to `limit` cards, most urgent first: defences, attacks, purchases of goods
 * about to run out, the best-payback Works, then an idle Training Ground.
 */
export function advise(sim: Sim, limit: number): Suggestion[] {
  const { state } = sim;
  const n = state.player;
  if (!state.nations[n]!.alive || limit <= 0) return [];
  resetCounters(sim);
  const view = playerView(sim, idleManual(sim));
  const cards = [...defendCards(sim, view), ...attackCards(sim, view), ...marketCards(sim, n), ...buildCards(sim, n), ...trainCards(sim, n)];
  return cards.slice(0, limit);
}

/** Armies "Attack with…" may list: not fighting, not frozen. */
function orderable(sim: Sim): (id: ArmyId) => boolean {
  const ids = new Set<ArmyId>();
  for (const army of armiesOf(sim, sim.state.player)) {
    if (army.leg === null && army.battle === null && armyStatus(sim, army) !== 'frozen') ids.add(army.id);
  }
  return (id) => ids.has(id);
}

/**
 * The fewest of the player's armies within ADVISOR.ATTACK_WITH_MAX_HOURS that
 * together keep ADVISOR.ATTACK_KEEP and win ADVISOR.MIN_WIN_CHANCE, preferring
 * armies that add a direction; null when even all of them fall short.
 */
export function suggestForce(sim: Sim, target: ProvinceIx): { armies: ArmyId[]; preview: OrderPreview } | null {
  return forceFor(sim, target, ADVISOR.ATTACK_WITH_MAX_HOURS);
}

function forceFor(sim: Sim, target: ProvinceIx, hours: number): { armies: ArmyId[]; preview: OrderPreview } | null {
  const { state } = sim;
  const n = state.player;
  if (!state.nations[n]!.alive || state.provinces[target]!.owner === n) return null;
  resetCounters(sim);
  const view = playerView(sim, orderable(sim));
  const plan = sizeAttack(sim, view, { ...advisorSettings('all'), maxOperations: Number.POSITIVE_INFINITY }, target, hours, false);
  if (plan === null) return null;
  return { armies: plan.armies, preview: previewOrder(sim, n, plan.armies, target, true) };
}

/**
 * Onboarding's first target: a hostile province next to the player's land that
 * the fewest armies reach within ADVISOR.FIRST_TARGET_MAX_HOURS at the advisor's
 * odds (ties: the better forecast, then the lower index).
 */
export function suggestFirstTarget(sim: Sim): { target: ProvinceIx; armies: ArmyId[]; preview: OrderPreview } | null {
  const { map, state } = sim;
  const n = state.player;
  const near = new Set<ProvinceIx>();
  for (const p of ownedProvinces(sim, n)) for (const e of map.edges[p]!) if (state.provinces[e.to]!.owner !== n) near.add(e.to);
  let best: { target: ProvinceIx; armies: ArmyId[]; preview: OrderPreview; chance: number } | null = null;
  for (const target of [...near].sort((a, b) => a - b)) {
    const force = forceFor(sim, target, ADVISOR.FIRST_TARGET_MAX_HOURS);
    if (force === null) continue;
    const chance = force.preview.forecast?.winChance ?? 0;
    if (best === null || force.armies.length < best.armies.length || (force.armies.length === best.armies.length && chance > best.chance)) {
      best = { target, armies: force.armies, preview: force.preview, chance };
    }
  }
  return best === null ? null : { target: best.target, armies: best.armies, preview: best.preview };
}
