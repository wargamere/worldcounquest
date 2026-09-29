import { DEVELOPMENT, MANPOWER, RECRUITMENT } from './balance';
import { areAdjacent } from './adjacency';
import { describeCombat, resolveCombat } from './combat';
import { investmentCost } from './economy';
import { appendLog } from './log';
import type { CountryId, GameState, NationId } from './types';

export interface ActionOutcome {
  state: GameState;
  /** Absent when the action succeeded. */
  error?: string;
}

const fail = (state: GameState, error: string): ActionOutcome => ({ state, error });

/**
 * Purchases are logged for the player only. Logging every AI recruitment filled
 * the capped log within two turns and pushed the battles out of it.
 */
function logPlayerAction(state: GameState, nationId: NationId, text: string): GameState {
  return nationId === state.playerId ? appendLog(state, 'action', text, [nationId]) : state;
}

/** Raises a country's development by one level. Cost scales with the current level. */
export function invest(state: GameState, nationId: NationId, countryId: CountryId): ActionOutcome {
  const country = state.countries[countryId];
  const nation = state.nations[nationId];
  if (!country || !nation) return fail(state, 'No such country.');
  if (country.ownerId !== nationId) return fail(state, 'You do not own this country.');
  if (country.development >= DEVELOPMENT.MAX_LEVEL) return fail(state, 'Already fully developed.');

  const cost = investmentCost(country.development);
  if (nation.treasury < cost) return fail(state, `Needs ${cost} in the treasury.`);

  const next: GameState = {
    ...state,
    countries: {
      ...state.countries,
      [countryId]: { ...country, development: country.development + 1 },
    },
    nations: { ...state.nations, [nationId]: { ...nation, treasury: nation.treasury - cost } },
  };
  return {
    state: logPlayerAction(
      next,
      nationId,
      `${nation.name} developed ${country.name} to level ${country.development + 1} for ${cost}.`,
    ),
  };
}

/** Recruits troops into an owned country. Costs money and manpower. */
export function recruit(
  state: GameState,
  nationId: NationId,
  countryId: CountryId,
  troops: number,
): ActionOutcome {
  const country = state.countries[countryId];
  const nation = state.nations[nationId];
  if (!country || !nation) return fail(state, 'No such country.');
  if (country.ownerId !== nationId) return fail(state, 'You do not own this country.');

  const wanted = Math.floor(troops);
  if (wanted <= 0) return fail(state, 'Recruit at least one troop.');

  const money = wanted * RECRUITMENT.MONEY_PER_TROOP;
  const manpower = wanted * MANPOWER.COST_PER_TROOP;
  if (nation.treasury < money) return fail(state, `Needs ${money} in the treasury.`);
  if (nation.manpower < manpower) return fail(state, 'Not enough manpower.');

  const next: GameState = {
    ...state,
    countries: { ...state.countries, [countryId]: { ...country, troops: country.troops + wanted } },
    nations: {
      ...state.nations,
      [nationId]: {
        ...nation,
        treasury: nation.treasury - money,
        manpower: nation.manpower - manpower,
      },
    },
  };
  return {
    state: logPlayerAction(next, nationId, `${nation.name} recruited ${wanted} troops in ${country.name}.`),
  };
}

/**
 * Moves troops between two adjacent owned countries. Free, but a country's
 * garrison can only move once per turn — the flag sits on the source.
 */
export function moveTroops(
  state: GameState,
  nationId: NationId,
  fromId: CountryId,
  toId: CountryId,
  troops: number,
): ActionOutcome {
  const from = state.countries[fromId];
  const to = state.countries[toId];
  if (!from || !to) return fail(state, 'No such country.');
  if (from.ownerId !== nationId || to.ownerId !== nationId) return fail(state, 'Both must be yours.');
  if (from.hasMoved) return fail(state, 'This garrison already moved this turn.');
  if (!areAdjacent(state.adjacency, fromId, toId)) return fail(state, 'Those are not adjacent.');

  const moving = Math.floor(troops);
  if (moving <= 0) return fail(state, 'Move at least one troop.');
  if (moving > from.troops) return fail(state, 'Not that many troops there.');

  return {
    state: {
      ...state,
      countries: {
        ...state.countries,
        [fromId]: { ...from, troops: from.troops - moving, hasMoved: true },
        [toId]: { ...to, troops: to.troops + moving },
      },
    },
  };
}

/**
 * Attacks an adjacent enemy country. Committed troops either take the territory
 * or die. Every battle writes its numbers to the log so balance can be debugged.
 */
export function attack(
  state: GameState,
  nationId: NationId,
  fromId: CountryId,
  targetId: CountryId,
  troops: number,
): ActionOutcome {
  const from = state.countries[fromId];
  const target = state.countries[targetId];
  const attacker = state.nations[nationId];
  if (!from || !target || !attacker) return fail(state, 'No such country.');
  if (from.ownerId !== nationId) return fail(state, 'You do not own the staging country.');
  if (target.ownerId === nationId) return fail(state, 'That country is already yours.');
  if (from.hasMoved) return fail(state, 'This garrison already acted this turn.');
  if (!areAdjacent(state.adjacency, fromId, targetId)) return fail(state, 'Those are not adjacent.');

  const committed = Math.floor(troops);
  if (committed <= 0) return fail(state, 'Commit at least one troop.');
  if (committed > from.troops) return fail(state, 'Not that many troops there.');

  const defenderId = target.ownerId;
  const input = {
    attackerTroops: committed,
    attackerDev: from.development,
    defenderTroops: target.troops,
    defenderDev: target.development,
  };
  const { result, rngState } = resolveCombat(input, state.rngState);

  const countries = { ...state.countries };
  countries[fromId] = { ...from, troops: from.troops - committed, hasMoved: true };
  countries[targetId] = result.captured
    ? { ...target, ownerId: nationId, troops: result.attackerSurvivors, hasMoved: true }
    : { ...target, troops: result.defenderSurvivors };

  const next = appendLog(
    { ...state, countries, rngState, stats: tallyBattle(state, nationId, defenderId, result.captured, countries) },
    'combat',
    describeCombat(attacker.name, target.name, input, result),
    [nationId, defenderId],
    { attackerId: nationId, defenderId, countryId: targetId, captured: result.captured },
  );
  return { state: next };
}

/** Updates the player's battle record if the player fought in this battle. */
function tallyBattle(
  state: GameState,
  attackerId: NationId,
  defenderId: NationId,
  captured: boolean,
  countries: GameState['countries'],
): GameState['stats'] {
  const stats = { ...state.stats };
  if (attackerId === state.playerId) {
    if (captured) stats.battlesWon += 1;
    else stats.battlesLost += 1;
    const owned = Object.values(countries).filter((c) => c.ownerId === state.playerId).length;
    stats.peakCountries = Math.max(stats.peakCountries, owned);
  } else if (defenderId === state.playerId) {
    if (captured) stats.countriesLost += 1;
    else stats.defencesHeld += 1;
  }
  return stats;
}
