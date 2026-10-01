/**
 * AI tiers and the think schedule (§6.2). Majors (the strongest powers) think
 * every few hours and plan operations; minors think once a day. Thinks are
 * spread evenly over each period, so a tick runs at most a handful of them, and
 * a battle in an AI province pulls in a short alert think an hour later.
 *
 * The tier review runs every AI_TIERS.REVIEW_DAYS, starting at tick 0 (sim.ts
 * calls reviewTiers in the daily phase), and re-staggers both tiers.
 */
import { AI_TIERS, DIFFICULTY } from '../balance';
import { armiesOf, ownedProvinces } from '../cache';
import { hoursToTicks } from '../clock';
import { nationRates } from '../economy';
import { goodsValue } from '../market';
import type { NationIx, Sim, Tick } from '../types';
import { totalCount } from '../units';

/** Ticks between two regular thinks of a nation of this tier on the current difficulty. */
export function periodTicks(sim: Sim, major: boolean): number {
  const hours = major ? DIFFICULTY[sim.state.difficulty].majorThinkHours : AI_TIERS.MINOR_THINK_HOURS;
  return hoursToTicks(hours);
}

/**
 * The most regular thinks of one tier a tick may run. Evenly staggered, `count`
 * nations over `period` ticks never put more than ceil(count / period) in one
 * tick; the cap only bites when nations fall due together (before the first
 * review, or after a promotion), and the rest simply wait a tick.
 */
function perTickCap(count: number, period: number): number {
  return Math.max(1, Math.ceil(count / Math.max(1, period)));
}

/** First think ticks for nations 0..count-1 of a tier: evenly spaced over one period after `fromTick`. */
export function initialThinkTicks(count: number, periodTicks: number, fromTick: Tick): Tick[] {
  const out: Tick[] = [];
  for (let k = 0; k < count; k += 1) out.push(fromTick + 1 + Math.floor((k * periodTicks) / count));
  return out;
}

/** Funds/day + goods value/day + POWER_PER_UNIT × units: the ranking behind the tiers. */
function nationPower(sim: Sim, n: NationIx): number {
  const { income } = nationRates(sim, n);
  let units = 0;
  for (const army of armiesOf(sim, n)) if (army.alive) units += totalCount(army.units);
  return income.funds + goodsValue(sim.state.market, { food: income.food, steel: income.steel, oil: income.oil }) + AI_TIERS.POWER_PER_UNIT * units;
}

/**
 * Re-ranks the living AI nations by power. Majors are the top majorCount, plus
 * any nation that meets a promotion threshold, plus sitting majors still ranked
 * above DEMOTE_RANK_FACTOR × majorCount; at most MAX_MAJORS, in power order.
 * Both tiers are then re-staggered from this tick, in NationIx order.
 */
export function reviewTiers(sim: Sim): void {
  const { state } = sim;
  const majorCount = DIFFICULTY[state.difficulty].majorCount;
  const ranked: { n: NationIx; power: number; promoted: boolean }[] = [];
  for (const nation of state.nations) {
    if (!nation.alive || nation.isPlayer) continue;
    const n = nation.ix;
    const funds = nationRates(sim, n).income.funds;
    const promoted = ownedProvinces(sim, n).length >= AI_TIERS.PROMOTE_PROVINCES || funds >= AI_TIERS.PROMOTE_FUNDS_PER_DAY;
    ranked.push({ n, power: nationPower(sim, n), promoted });
  }
  ranked.sort((a, b) => b.power - a.power || a.n - b.n);
  const majors = new Set<NationIx>();
  ranked.forEach(({ n, promoted }, rank) => {
    if (majors.size >= AI_TIERS.MAX_MAJORS) return;
    const sitting = state.nations[n]!.tier === 'major' && rank < AI_TIERS.DEMOTE_RANK_FACTOR * majorCount;
    if (rank < majorCount || promoted || sitting) majors.add(n);
  });
  const majorList: NationIx[] = [];
  const minorList: NationIx[] = [];
  for (const { n } of [...ranked].sort((a, b) => a.n - b.n)) {
    state.nations[n]!.tier = majors.has(n) ? 'major' : 'minor';
    (majors.has(n) ? majorList : minorList).push(n);
  }
  const stagger = (list: readonly NationIx[], period: number): void => {
    const ticks = initialThinkTicks(list.length, period, state.tick);
    list.forEach((n, k) => {
      state.nations[n]!.ai.nextThink = ticks[k]!;
    });
  };
  stagger(majorList, periodTicks(sim, true));
  stagger(minorList, periodTicks(sim, false));
}

/**
 * The AI nations to think this tick, ascending: regular thinks that are due
 * (capped per tier; the rest wait a tick) and at most MAX_ALERTS_PER_TICK alert
 * thinks, for nations without a regular think this tick.
 */
export function dueNations(sim: Sim): { regular: NationIx[]; alerts: NationIx[] } {
  const { state } = sim;
  const tick = state.tick;
  const majorCap = perTickCap(AI_TIERS.MAX_MAJORS, periodTicks(sim, true));
  const minorCap = perTickCap(state.nations.length, periodTicks(sim, false));
  let majors = 0;
  let minors = 0;
  const regular: NationIx[] = [];
  const alerts: NationIx[] = [];
  for (const nation of state.nations) {
    if (!nation.alive || nation.isPlayer || nation.ai.nextThink > tick) continue;
    if (nation.tier === 'major') {
      if (majors >= majorCap) continue;
      majors += 1;
    } else {
      if (minors >= minorCap) continue;
      minors += 1;
    }
    regular.push(nation.ix);
  }
  for (const nation of state.nations) {
    if (alerts.length >= AI_TIERS.MAX_ALERTS_PER_TICK) break;
    if (!nation.alive || nation.isPlayer || nation.ai.alertAt === null || nation.ai.alertAt > tick) continue;
    if (!regular.includes(nation.ix)) alerts.push(nation.ix);
  }
  return { regular, alerts };
}

/** An alert think an hour from now for an AI nation that has none pending. */
export function scheduleAlert(sim: Sim, n: NationIx): void {
  const nation = sim.state.nations[n];
  if (nation === undefined || !nation.alive || nation.isPlayer || nation.ai.alertAt !== null) return;
  nation.ai.alertAt = sim.state.tick + hoursToTicks(AI_TIERS.ALERT_DELAY_HOURS);
}

/** After a regular think: the next one a whole number of periods later, strictly in the future. */
export function advanceSchedule(sim: Sim, n: NationIx): void {
  const nation = sim.state.nations[n]!;
  const period = Math.max(1, periodTicks(sim, nation.tier === 'major'));
  let next = nation.ai.nextThink;
  while (next <= sim.state.tick) next += period;
  nation.ai.nextThink = next;
}
