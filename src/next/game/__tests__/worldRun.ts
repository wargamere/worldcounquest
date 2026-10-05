/**
 * Whole-world games on the committed map with a passive player, shared by the
 * world.sim test files (§12.4). They are split over three files so Vitest can
 * run them in parallel workers.
 */
import { expect } from 'vitest';
import { TIME } from '../balance';
import { isHourStart } from '../clock';
import { stepTick } from '../sim';
import type { Sim } from '../types';
import { assertInvariants, realSim } from './helpers';

/** Game length of the §12.4 world games. */
export const WORLD_DAYS = 30;
const GREAT_POWERS = ['276', '826', '380', '724', '643', '156', '840', '356', '392', '076'];

export interface WorldRun {
  sim: Sim;
  firstBorderChangeDay: number | null;
}

export function runWorld(seed: string, days: number, invariants: boolean): WorldRun {
  const sim = realSim({ seed });
  let firstBorderChangeDay: number | null = null;
  for (let i = 0; i < days * TIME.TICKS_PER_DAY; i += 1) {
    stepTick(sim);
    if (firstBorderChangeDay === null && sim.cache.ownershipVersion > 0) firstBorderChangeDay = Math.floor((sim.state.tick - 1) / TIME.TICKS_PER_DAY) + 1;
    if (invariants && isHourStart(sim.state.tick)) assertInvariants(sim);
  }
  return { sim, firstBorderChangeDay };
}

/** The §12.4 health checks at the end of a world game. */
export function checkWorld({ sim, firstBorderChangeDay }: WorldRun): void {
  const { map, state } = sim;
  const alive = state.nations.filter((nation) => nation.alive).length;
  expect(alive, 'nations alive').toBeGreaterThanOrEqual(120);
  const holding = GREAT_POWERS.filter((id) => {
    const n = map.nationById.get(id)!;
    return state.provinces[map.nations[n]!.capital]!.owner === n;
  });
  expect(holding.length, `great powers holding their capital: ${holding.join(', ')}`).toBeGreaterThanOrEqual(8);
  for (const nation of state.nations) {
    if (!nation.alive || nation.isPlayer) continue;
    const name = map.nations[nation.ix]!.name;
    expect(nation.capital, `${name} has its seat`).toBe(map.nations[nation.ix]!.capital);
    expect(state.provinces[map.nations[nation.ix]!.capital]!.owner, `${name} holds its capital`).toBe(nation.ix);
  }
  expect(firstBorderChangeDay, 'a border changed').not.toBeNull();
  expect(firstBorderChangeDay!, 'day of the first border change').toBeLessThanOrEqual(10);
}
