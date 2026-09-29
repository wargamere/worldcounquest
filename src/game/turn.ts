import { DIFFICULTY } from './balance';
import { recomputeTiers, takeAITurn } from './ai';
import { applyIncome, ownedCountries } from './economy';
import { appendLog, entriesSince } from './log';
import { evaluateStatus, rivalHegemon } from './victory';
import type { GameState, NationId } from './types';

/** Income for the player only. Runs at the top of their turn, before they act. */
export function startPlayerTurn(state: GameState): { state: GameState; net: number; deserted: number } {
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
  return { state: next, net, deserted };
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

  const heldBefore = new Set(ownedCountries(state, state.playerId).map((c) => c.id));
  let current = recomputeTiers(state);
  const multiplier = DIFFICULTY[current.difficulty].incomeMultiplier;

  for (const nationId of livingAINations(current)) {
    if (ownedCountries(current, nationId).length === 0) continue;
    current = applyIncome(current, nationId, multiplier).state;
    current = takeAITurn(current, nationId);
  }

  const aiPhase = entriesSince(state, current);
  const held = aiPhase.filter(
    (e) => e.combat?.defenderId === state.playerId && !e.combat.captured,
  ).length;
  const lost = [...heldBefore]
    .filter((id) => current.countries[id]?.ownerId !== state.playerId)
    .map((id) => ({
      countryId: id,
      name: current.countries[id]?.name ?? id,
      byId: current.countries[id]?.ownerId ?? '',
    }));

  current = {
    ...current,
    turn: current.turn + 1,
    countries: clearMoveFlags(current),
  };
  current = { ...current, status: evaluateStatus(current) };

  let income = 0;
  let deserted = 0;
  if (current.status === 'won') {
    current = appendLog(current, 'system', 'Hegemony achieved.', [current.playerId]);
  } else if (current.status === 'lost') {
    const hegemon = rivalHegemon(current);
    const text = hegemon
      ? `${current.nations[hegemon]?.name ?? 'A rival'} has achieved hegemony over the world.`
      : 'Your last territory has fallen.';
    current = appendLog(current, 'system', text, [current.playerId, ...(hegemon ? [hegemon] : [])]);
  } else {
    const started = startPlayerTurn(current);
    current = started.state;
    income = started.net;
    deserted = started.deserted;
  }

  return {
    ...current,
    lastReport: { turn: state.turn, lost, held, income, deserted },
  };
}
