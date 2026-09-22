import { VICTORY } from './balance';
import type { GameState, GameStatus, NationId } from './types';

export function countryCount(state: GameState, nationId: NationId): number {
  return Object.values(state.countries).filter((c) => c.ownerId === nationId).length;
}

export function controlShare(state: GameState, nationId: NationId): number {
  const total = Object.keys(state.countries).length;
  return total === 0 ? 0 : countryCount(state, nationId) / total;
}

/** Countries the player still needs to reach the victory threshold. */
export function countriesToWin(state: GameState): number {
  const total = Object.keys(state.countries).length;
  const needed = Math.ceil(total * VICTORY.CONTROL_FRACTION);
  return Math.max(0, needed - countryCount(state, state.playerId));
}

export function evaluateStatus(state: GameState): GameStatus {
  const owned = countryCount(state, state.playerId);
  if (owned === 0) return 'lost';
  if (controlShare(state, state.playerId) >= VICTORY.CONTROL_FRACTION) return 'won';
  return 'playing';
}
