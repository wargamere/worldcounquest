/**
 * The player's running statistics for the end screen. Callers record only
 * events that involve the player; these functions never filter by nation.
 */
import type { PlayerStats, ProvinceIx, Sim, SurrenderRecord, UnitType } from './types';

export type CountedStat =
  | 'attacksWon'
  | 'attacksLost'
  | 'defencesHeld'
  | 'provincesCaptured'
  | 'provincesLost'
  | 'enemyUnitsDestroyed'
  | 'capitalMoves'
  | 'revoltsSuffered'
  | 'fundsEarned'
  | 'tradeVolume';

export function recordStat(sim: Sim, stat: CountedStat, amount: number): void {
  const stats: PlayerStats = sim.state.stats;
  stats[stat] += amount;
}

export function recordUnits(sim: Sim, which: 'unitsTrained' | 'unitsLost', unit: UnitType, count: number): void {
  sim.state.stats[which][unit] += count;
}

/** Keeps the biggest battle by HP destroyed; `hp` is the battle's running total. */
export function recordBattleSize(sim: Sim, p: ProvinceIx, hp: number): void {
  const { stats, tick } = sim.state;
  if (stats.largestBattle === null || hp > stats.largestBattle.hp) stats.largestBattle = { province: p, tick, hp };
}

export function recordSurrender(sim: Sim, record: SurrenderRecord): void {
  sim.state.surrenders.push({ ...record });
}

/** Raises the player's peak VP, province count and gross Funds per day. */
export function recordPeaks(sim: Sim): void {
  const { state, cache } = sim;
  const { stats, player } = state;
  stats.peakVp = Math.max(stats.peakVp, cache.vp[player] ?? 0);
  stats.peakProvinces = Math.max(stats.peakProvinces, cache.nationProvinces[player]?.length ?? 0);
  stats.peakFundsPerDay = Math.max(stats.peakFundsPerDay, cache.income[player]?.funds ?? 0);
}
