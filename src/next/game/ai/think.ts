/**
 * One AI nation's think and the AI phase of a tick (§6.2, §6.4). A think only
 * reads the state and returns Commands; aiPhase applies them at once, in order,
 * as source 'ai', and keeps the nation's AI memory: the operations still
 * running plus those the think launched, and the next think tick.
 *
 * cache.counters are reset before every think, so they hold that think's
 * operation counts (the budgets of §6.2) until the next one.
 */
import { TRAINING } from '../balance';
import { isContested } from '../cache';
import { applyCommand } from '../commands';
import type { Command, CommandResult, NationIx, Operation, Sim } from '../types';
import { assessNation, liveOperations, type NationView } from './assess';
import { planEconomy, planMarketAfter, planTraining, planUnit, queueLength, walletOf } from './economy';
import { minorThink } from './minor';
import {
  capitalShort,
  operationOf,
  planDefence,
  planHousekeeping,
  planOffensive,
  planRetreats,
  planStaging,
  settingsFor,
} from './military';
import { advanceSchedule, dueNations } from './scheduler';

/** Zeroes the operation counters at the start of a think. */
export function resetCounters(sim: Sim): void {
  const counters = sim.cache.counters;
  counters.predictions = 0;
  counters.paths = 0;
  counters.fields = 0;
  counters.orders = 0;
}

/** The capital could not be guarded: Rifles queued there from whatever Funds remain. */
function emergencyRifles(sim: Sim, view: NationView): Command[] {
  const capital = sim.state.nations[view.nation]!.capital;
  if (capital === null || sim.state.provinces[capital]!.buildings.training === 0 || isContested(sim, capital)) return [];
  const w = walletOf(sim, view);
  const out: Command[] = [];
  let planned = 0;
  while (planned < TRAINING.MAX_PER_ORDER && queueLength(sim, w, capital) < TRAINING.QUEUE_MAX) {
    if (!planUnit(sim, w, capital, 'rifles', 'all', out)) break;
    planned += 1;
  }
  return out;
}

function plan(sim: Sim, view: NationView, alertOnly: boolean): Command[] {
  const n = view.nation;
  const nation = sim.state.nations[n]!;
  const s = settingsFor(sim, n);
  if (alertOnly) return [...planDefence(sim, view, s), ...planRetreats(sim, view)];
  if (nation.tier === 'minor') return minorThink(sim, view);
  const out: Command[] = [...planEconomy(sim, view), ...planTraining(sim, view), ...planMarketAfter(sim, view)];
  out.push(...planDefence(sim, view, s));
  if (capitalShort(view)) out.push(...emergencyRifles(sim, view));
  out.push(...planRetreats(sim, view));
  out.push(...planOffensive(sim, view, s));
  out.push(...planStaging(sim, view, s));
  out.push(...planHousekeeping(sim, view));
  return out;
}

/**
 * Nation `n`'s think: a major runs economy, training and market, then defence,
 * retreats, offensive, staging and housekeeping; a minor runs its daily think;
 * an alert think only defence and retreats. Changes nothing but cache.counters.
 */
export function thinkNation(sim: Sim, n: NationIx, alertOnly: boolean): Command[] {
  resetCounters(sim);
  return plan(sim, assessNation(sim, n), alertOnly);
}

/** A command a think issued and what applying it gave. */
export interface AppliedCommand {
  source: 'ai' | 'staff';
  command: Command;
  result: CommandResult;
}

/** Applies a think's commands in order as `source` and records the operations it launched. */
export function runThink(sim: Sim, view: NationView, commands: readonly Command[], source: 'ai' | 'staff'): AppliedCommand[] {
  const { state } = sim;
  const n = view.nation;
  const kept: Operation[] = liveOperations(sim, n);
  const applied: AppliedCommand[] = [];
  for (const command of commands) {
    const result = applyCommand(sim, command, source);
    applied.push({ source, command, result });
    const op = operationOf(view, command);
    if (op !== undefined && result.ok && result.armies.length > 0) {
      kept.push({ target: op.target, armies: [...result.armies], launchedAt: state.tick });
    }
  }
  state.nations[n]!.ai.operations = kept;
  return applied;
}

/**
 * The AI phase: due regular thinks in ascending NationIx order, then up to
 * AI_TIERS.MAX_ALERTS_PER_TICK alert thinks. Nothing runs once the game is over
 * (outside the sandbox), when no command would be accepted anyway.
 */
export function aiPhase(sim: Sim): void {
  runAiPhase(sim);
}

/** The AI phase, reporting every command it applied (the harness and the tests count refusals). */
export function runAiPhase(sim: Sim): AppliedCommand[] {
  const { state } = sim;
  const applied: AppliedCommand[] = [];
  if (state.status !== 'playing' && !state.sandbox) return applied;
  const { regular, alerts } = dueNations(sim);
  for (const n of regular) applied.push(...runNation(sim, n, false));
  for (const n of alerts) applied.push(...runNation(sim, n, true));
  return applied;
}

/**
 * One due think of nation `n` as aiPhase runs it: plan, apply, record the
 * operations and move the schedule on (a regular think) or clear the alert
 * (an alert think). The harness calls it directly to time single thinks.
 */
export function runNation(sim: Sim, n: NationIx, alertOnly: boolean): AppliedCommand[] {
  const nation = sim.state.nations[n]!;
  if (alertOnly || (nation.ai.alertAt !== null && nation.ai.alertAt <= sim.state.tick)) nation.ai.alertAt = null;
  if (!nation.alive) return [];
  resetCounters(sim);
  const view = assessNation(sim, n);
  const applied = runThink(sim, view, plan(sim, view, alertOnly), 'ai');
  if (!alertOnly) advanceSchedule(sim, n);
  return applied;
}
