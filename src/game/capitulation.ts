import { CAPITAL } from './balance';
import { countryIncome } from './economy';
import { appendLog } from './log';
import type { Country, CountryId, GameState, NationId } from './types';

/**
 * A nation is identified by the country it started from, and that country is its
 * capital. Only a nation holding its own capital has one: the player, whose
 * government can flee, may lose it and fight on.
 */
export function isCapital(state: GameState, countryId: CountryId): boolean {
  return state.countries[countryId]?.ownerId === countryId;
}

/** The countries a nation would hand over besides its capital, if it capitulated. */
export function provinces(state: GameState, nationId: NationId): Country[] {
  return Object.values(state.countries).filter((c) => c.ownerId === nationId && c.id !== nationId);
}

/**
 * Whether capturing this country makes its owner capitulate: it is the capital of
 * an AI nation that holds anything else.
 */
export function capitulatesOnCapture(state: GameState, countryId: CountryId): boolean {
  if (!isCapital(state, countryId)) return false;
  const owner = state.nations[countryId];
  if (!owner || owner.isPlayer) return false;
  return provinces(state, countryId).length > 0;
}

/**
 * Income a capture brings in: the country's own, or, for a capital that
 * capitulates, the whole nation's. This is what makes a capital worth a larger
 * army than any single province.
 */
export function captureIncome(state: GameState, countryId: CountryId): number {
  const target = state.countries[countryId];
  if (!target) return 0;
  const own = countryIncome(target);
  if (!capitulatesOnCapture(state, countryId)) return own;
  return provinces(state, countryId).reduce((sum, c) => sum + countryIncome(c), own);
}

/** Troops a surrendering garrison brings over; the rest disband. */
export function troopsKept(troops: number): number {
  return Math.floor(troops * CAPITAL.TROOPS_KEPT);
}

/**
 * Hands every country `loserId` still holds to `winnerId`. Surrendered garrisons
 * shrink to CAPITAL.TROOPS_KEPT and cannot act until next turn, so one fallen
 * capital never lets the winner chain straight on through the loser's borders.
 * The loser's treasury and manpower are lost with its government.
 */
export function capitulate(state: GameState, loserId: NationId, winnerId: NationId): GameState {
  const loser = state.nations[loserId];
  const winner = state.nations[winnerId];
  if (!loser || !winner) return state;

  const countries = { ...state.countries };
  let handed = 0;
  let troops = 0;
  for (const country of provinces(state, loserId)) {
    const kept = troopsKept(country.troops);
    countries[country.id] = { ...country, ownerId: winnerId, troops: kept, hasMoved: true };
    handed += 1;
    troops += kept;
  }

  const next: GameState = {
    ...state,
    countries,
    nations: { ...state.nations, [loserId]: { ...loser, treasury: 0, manpower: 0 } },
  };
  const what = handed === 1 ? '1 more country' : `${handed} more countries`;
  return appendLog(
    next,
    'system',
    `${loser.name} capitulated to ${winner.name}: ${what} and ${troops} troops change hands.`,
    [loserId, winnerId],
    undefined,
    { loserId, winnerId, countries: handed, troops },
  );
}
