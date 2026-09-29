import { VICTORY } from './balance';
import type { GameState, GameStatus, NationId } from './types';

export function countryCount(state: GameState, nationId: NationId): number {
  return Object.values(state.countries).filter((c) => c.ownerId === nationId).length;
}

export function controlShare(state: GameState, nationId: NationId): number {
  const total = Object.keys(state.countries).length;
  return total === 0 ? 0 : countryCount(state, nationId) / total;
}

/** An AI nation that has reached hegemony, if any. */
export function rivalHegemon(state: GameState): NationId | null {
  const counts = new Map<NationId, number>();
  for (const country of Object.values(state.countries)) {
    counts.set(country.ownerId, (counts.get(country.ownerId) ?? 0) + 1);
  }
  const total = Object.keys(state.countries).length;
  for (const [nationId, owned] of counts) {
    if (nationId !== state.playerId && total > 0 && owned / total >= VICTORY.CONTROL_FRACTION) {
      return nationId;
    }
  }
  return null;
}

/** The AI nation holding the most countries, for "who is winning" displays. */
export function leadingRival(state: GameState): { nationId: NationId; countries: number } | null {
  const counts = new Map<NationId, number>();
  for (const country of Object.values(state.countries)) {
    if (country.ownerId === state.playerId) continue;
    counts.set(country.ownerId, (counts.get(country.ownerId) ?? 0) + 1);
  }
  let best: { nationId: NationId; countries: number } | null = null;
  for (const [nationId, countries] of counts) {
    if (!best || countries > best.countries) best = { nationId, countries };
  }
  return best;
}

export function evaluateStatus(state: GameState): GameStatus {
  const owned = countryCount(state, state.playerId);
  if (owned === 0) return 'lost';
  if (controlShare(state, state.playerId) >= VICTORY.CONTROL_FRACTION) return 'won';
  if (VICTORY.RIVAL_HEGEMONY_DEFEATS && rivalHegemon(state) !== null) return 'lost';
  return 'playing';
}
