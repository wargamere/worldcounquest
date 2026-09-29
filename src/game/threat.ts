import { AI_BUDGET } from './balance';
import { captureProbability, expectedSurvivors } from './combat';
import { maxAffordableTroops } from './economy';
import type { CountryId, GameState, NationId } from './types';

/**
 * Troops an enemy country could plausibly throw at a neighbour this turn: a share
 * of what stands there now plus what its nation can afford to raise first.
 *
 * Counting only the standing garrison badly understates the danger, because every
 * nation recruits before it attacks. France judged a 23-troop garrison safe
 * against Italy's 25, and Italy then recruited and attacked with 37.
 */
export function strikeForce(state: GameState, countryId: CountryId): number {
  const country = state.countries[countryId];
  if (!country) return 0;
  const reserve = Math.floor(
    maxAffordableTroops(state, country.ownerId) * AI_BUDGET.THREAT_RESERVE_SHARE,
  );
  return Math.floor((country.troops + reserve) * AI_BUDGET.THREAT_COMMIT_SHARE);
}

export interface Threat {
  /** The enemy country best placed to take this one. */
  fromId: CountryId;
  ownerId: NationId;
  /** Chance that country takes this one next turn, if it attacks with its usual share. */
  chance: number;
}

/**
 * The single most dangerous enemy neighbour of `countryId`, assuming the country
 * were garrisoned by `garrison` troops (defaults to what is there now).
 *
 * Each enemy is assumed to attack with its strikeForce — what it holds there plus
 * what it can recruit first.
 */
export function strongestThreat(
  state: GameState,
  countryId: CountryId,
  garrison?: number,
  ignoreId?: CountryId,
): Threat | null {
  const country = state.countries[countryId];
  if (!country) return null;
  const defenders = garrison ?? country.troops;

  let worst: Threat | null = null;
  for (const neighbourId of state.adjacency[countryId] ?? []) {
    if (neighbourId === ignoreId) continue;
    const enemy = state.countries[neighbourId];
    if (!enemy || enemy.ownerId === country.ownerId) continue;
    const chance = captureProbability({
      attackerTroops: strikeForce(state, neighbourId),
      attackerDev: enemy.development,
      defenderTroops: defenders,
      defenderDev: country.development,
    });
    if (!worst || chance > worst.chance) {
      worst = { fromId: neighbourId, ownerId: enemy.ownerId, chance };
    }
  }
  return worst;
}

/**
 * Chance that at least one enemy neighbour takes `countryId` next turn, treating
 * each border as an independent attempt: 1 - Π(1 - pᵢ).
 *
 * The single strongest threat understates danger for a country with many
 * borders. China has fourteen: several neighbours that each look harmless can
 * still grind a garrison down within one month, and with only the strongest
 * counted, China fell to Vietnam in year one.
 */
export function combinedThreat(
  state: GameState,
  countryId: CountryId,
  garrison?: number,
  ignoreId?: CountryId,
): number {
  const country = state.countries[countryId];
  if (!country) return 0;
  const defenders = garrison ?? country.troops;

  let survives = 1;
  for (const neighbourId of state.adjacency[countryId] ?? []) {
    if (neighbourId === ignoreId) continue;
    const enemy = state.countries[neighbourId];
    if (!enemy || enemy.ownerId === country.ownerId) continue;
    survives *= 1 - captureProbability({
      attackerTroops: strikeForce(state, neighbourId),
      attackerDev: enemy.development,
      defenderTroops: defenders,
      defenderDev: country.development,
    });
  }
  return 1 - survives;
}

/**
 * Chance of losing `targetId` straight back, if `nationId` took it by committing
 * `troops` and kept the expected survivors there.
 */
export function holdRisk(
  state: GameState,
  nationId: NationId,
  attackerDev: number,
  targetId: CountryId,
  troops: number,
): number {
  const target = state.countries[targetId];
  if (!target) return 1;
  const survivors = expectedSurvivors({
    attackerTroops: troops,
    attackerDev,
    defenderTroops: target.troops,
    defenderDev: target.development,
  });
  if (survivors <= 0) return 1;
  const captured: GameState = {
    ...state,
    countries: { ...state.countries, [targetId]: { ...target, ownerId: nationId, troops: survivors } },
  };
  return combinedThreat(captured, targetId);
}
