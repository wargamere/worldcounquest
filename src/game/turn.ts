import { DIFFICULTY } from './balance';
import { recomputeTiers, takeAITurn } from './ai';
import { applyIncome, countryIncome, grossIncome, ownedCountries } from './economy';
import { appendLog } from './log';
import { evaluateStatus } from './victory';
import type { GameState, NationId } from './types';

/** Income for the player only. Runs at the top of their turn, before they act. */
export function startPlayerTurn(state: GameState): GameState {
  const { state: paid, net, deserted } = applyIncome(state, state.playerId, 1);
  let next = { ...paid, countries: clearMoveFlags(paid) };
  if (deserted > 0) {
    next = appendLog(
      next,
      'economy',
      `Treasury empty — ${deserted} troops deserted.`,
      [state.playerId],
    );
  } else {
    next = appendLog(next, 'economy', `Treasury received ${net.toFixed(0)}.`, [state.playerId]);
  }
  return next;
}

function clearMoveFlags(state: GameState): GameState['countries'] {
  const countries: GameState['countries'] = {};
  for (const [id, country] of Object.entries(state.countries)) {
    countries[id] = country.hasMoved ? { ...country, hasMoved: false } : country;
  }
  return countries;
}

/** Nations still holding at least one country, excluding the player. */
export function livingAINations(state: GameState): NationId[] {
  const alive = new Set<NationId>();
  for (const country of Object.values(state.countries)) alive.add(country.ownerId);
  alive.delete(state.playerId);
  return [...alive].sort();
}

/**
 * Ends the player's turn: every AI nation takes income and acts, in one batch,
 * then the clock advances and victory is re-checked.
 */
export function endTurn(state: GameState): GameState {
  if (state.status !== 'playing') return state;

  let current = recomputeTiers(state);
  const multiplier = DIFFICULTY[current.difficulty].incomeMultiplier;

  for (const nationId of livingAINations(current)) {
    if (ownedCountries(current, nationId).length === 0) continue;
    current = applyIncome(current, nationId, multiplier).state;
    current = takeAITurn(current, nationId);
  }

  current = {
    ...current,
    turn: current.turn + 1,
    countries: clearMoveFlags(current),
  };
  current = { ...current, status: evaluateStatus(current) };

  if (current.status === 'won') {
    current = appendLog(current, 'system', 'Hegemony achieved.', [current.playerId]);
  } else if (current.status === 'lost') {
    current = appendLog(current, 'system', 'Your last territory has fallen.', [current.playerId]);
  } else {
    current = startPlayerTurn(current);
  }

  return current;
}

/** Per-country income, for the side panel. */
export { countryIncome, grossIncome };
