/**
 * One AI game on the committed map with a passive player, watched command by
 * command, for the world AI tests (§12.3, §12.4). Each difficulty runs in its
 * own test file so Vitest can play them in parallel.
 */
import { expect } from 'vitest';
import { AI, AI_TIERS, MARKET, TIME } from '../../balance';
import { hoursToTicks } from '../../clock';
import { priceFactor } from '../../market';
import { dueNations, periodTicks } from '../../ai/scheduler';
import { thinkNation } from '../../ai/think';
import { stepTick } from '../../sim';
import { GOODS } from '../../types';
import type { ArmyId, Command, CommandResult, Difficulty, GoodAmounts, Sim } from '../../types';
import { realSim } from '../helpers';
import { watchAi } from './fixtures';

/**
 * One 60-day game per difficulty (§12.4). The spec's frozen-map check looks at
 * days 60 to 90 of a longer game; to stay within the CI budget it looks at the
 * last third of these games instead.
 */
export const WORLD_AI_DAYS = 60;
export const FROZEN_WINDOW = { from: 40, to: WORLD_AI_DAYS };

export interface WorldGame {
  sim: Sim;
  /** Living nations at the end of each day (index 0 = the start). */
  alive: number[];
  /** cache.ownershipVersion at the end of each day. */
  ownership: number[];
  rejected: { tick: number; command: Command; result: CommandResult }[];
  /** Price factor right after every AI sale. */
  saleFactors: number[];
  /** For each army id, the ticks it was given a move by the AI or the Staff. */
  moves: Map<ArmyId, number[]>;
  /** The most thinks of each kind that ran in a single tick. */
  busiest: { majors: number; minors: number; alerts: number };
  /** Every AI think checked against the budgets, at the given days. */
  budgets: { checked: number; over: string[] };
}

/** The real world on `difficulty` for `days`, with a passive player (France). */
export function playWorld(difficulty: Difficulty, seed: string, days: number, budgetDays: readonly number[]): WorldGame {
  const sim = realSim({ difficulty, seed });
  const game: WorldGame = {
    sim,
    alive: [sim.state.nations.filter((n) => n.alive).length],
    ownership: [0],
    rejected: [],
    saleFactors: [],
    moves: new Map(),
    busiest: { majors: 0, minors: 0, alerts: 0 },
    budgets: { checked: 0, over: [] },
  };
  // Pressure before the AI phase; trades replayed in order give the factor after each sale.
  let pressure: GoodAmounts = { ...sim.state.market.pressure };
  const watched = watchAi(sim, ({ command, result }, tick) => {
    if (!result.ok) {
      game.rejected.push({ tick, command, result });
      return;
    }
    if (command.kind === 'trade') {
      pressure[command.good] += command.amount;
      if (command.amount < 0) game.saleFactors.push(priceFactor(pressure[command.good], command.good));
    }
    if (command.kind === 'move') {
      for (const id of command.armies) {
        const list = game.moves.get(id);
        if (list === undefined) game.moves.set(id, [tick]);
        else list.push(tick);
      }
    }
  });
  const hooks = {
    phase(name: Parameters<typeof watched.phase>[0], edge: Parameters<typeof watched.phase>[1]) {
      if (name === 'ai' && edge === 'start') {
        pressure = { ...sim.state.market.pressure };
        const { regular, alerts } = dueNations(sim);
        const majors = regular.filter((n) => sim.state.nations[n]!.tier === 'major').length;
        game.busiest.majors = Math.max(game.busiest.majors, majors);
        game.busiest.minors = Math.max(game.busiest.minors, regular.length - majors);
        game.busiest.alerts = Math.max(game.busiest.alerts, alerts.length);
      }
      watched.phase(name, edge);
    },
  };
  for (let day = 1; day <= days; day += 1) {
    for (let i = 0; i < TIME.TICKS_PER_DAY; i += 1) stepTick(sim, hooks);
    game.alive.push(sim.state.nations.filter((n) => n.alive).length);
    game.ownership.push(sim.cache.ownershipVersion);
    if (budgetDays.includes(day)) checkBudgets(sim, game);
  }
  return game;
}

/** Every living AI nation's regular and alert think, planned now, stays within the §6.2 budgets. */
function checkBudgets(sim: Sim, game: WorldGame): void {
  for (const nation of sim.state.nations) {
    if (!nation.alive || nation.isPlayer) continue;
    for (const alertOnly of [false, true]) {
      thinkNation(sim, nation.ix, alertOnly);
      const c = sim.cache.counters;
      const predictionCap = nation.tier === 'major' || alertOnly ? AI.MAX_PREDICTIONS : AI.MINOR_MAX_PREDICTIONS;
      const label = `${sim.map.nations[nation.ix]!.name} (${nation.tier}${alertOnly ? ', alert' : ''}) at tick ${sim.state.tick}`;
      if (c.predictions > predictionCap) game.budgets.over.push(`${label}: ${c.predictions} predictions`);
      if (c.paths > AI.MAX_PATHS) game.budgets.over.push(`${label}: ${c.paths} paths`);
      if (c.fields > AI.MAX_FIELDS) game.budgets.over.push(`${label}: ${c.fields} fields`);
      if (c.orders > AI.MAX_ORDERS) game.budgets.over.push(`${label}: ${c.orders} orders`);
      game.budgets.checked += 1;
    }
  }
}

/** The checks every difficulty's world game must pass. */
export function checkWorldGame(game: WorldGame, window: { from: number; to: number }): void {
  const { sim } = game;
  expect(game.rejected.map((r) => `${r.command.kind}: ${r.result.ok ? '' : r.result.reason}`), 'rejected AI commands').toEqual([]);
  // frozen-map: borders still move late in the game, and the world consolidates.
  expect(game.ownership[window.to]! - game.ownership[window.from]!, `ownership changes between days ${window.from} and ${window.to}`).toBeGreaterThan(0);
  expect(game.alive[0]! - game.alive[window.to]!, 'nations fallen').toBeGreaterThanOrEqual(5);
  // market-no-dump.
  const lowest = Math.min(...game.saleFactors);
  expect(lowest, 'lowest factor after an AI sale').toBeGreaterThanOrEqual(MARKET.AUTO_SELL_MIN_FACTOR - 1e-9);
  // no-oscillation.
  const settle = hoursToTicks(AI.REASSIGN_AFTER_HOURS);
  for (const [id, ticks] of game.moves) {
    for (let i = 1; i < ticks.length; i += 1) expect(ticks[i]! - ticks[i - 1]!, `army ${id} reassigned`).toBeGreaterThanOrEqual(settle);
  }
  // budgets: the scheduler and every think.
  expect(game.busiest.majors).toBeLessThanOrEqual(Math.ceil(AI_TIERS.MAX_MAJORS / periodTicks(sim, true)));
  expect(game.busiest.minors).toBeLessThanOrEqual(Math.ceil(sim.state.nations.length / periodTicks(sim, false)));
  expect(game.busiest.alerts).toBeLessThanOrEqual(AI_TIERS.MAX_ALERTS_PER_TICK);
  expect(game.budgets.checked).toBeGreaterThan(0);
  expect(game.budgets.over).toEqual([]);
  for (const good of GOODS) expect(Number.isFinite(sim.state.market.pressure[good])).toBe(true);
}
