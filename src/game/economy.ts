import { DEVELOPMENT, ECONOMY, MANPOWER, RECRUITMENT } from './balance';
import type { Country, GameState, NationId } from './types';

/** Gross income a single country produces per turn. */
export function countryIncome(country: Pick<Country, 'population' | 'economyTier' | 'development'>): number {
  const tierFactor = ECONOMY.TIER_FACTOR[country.economyTier] ?? 1;
  const scale = Math.sqrt(country.population / 1_000_000);
  return scale * tierFactor * (1 + ECONOMY.DEV_INCOME_PER_LEVEL * country.development);
}

export function ownedCountries(state: GameState, nationId: NationId): Country[] {
  return Object.values(state.countries).filter((c) => c.ownerId === nationId);
}

export function grossIncome(state: GameState, nationId: NationId): number {
  return ownedCountries(state, nationId).reduce((sum, c) => sum + countryIncome(c), 0);
}

export function troopUpkeep(state: GameState, nationId: NationId): number {
  return ownedCountries(state, nationId).reduce((sum, c) => sum + c.troops, 0) * ECONOMY.TROOP_UPKEEP;
}

/** What actually lands in the treasury: gross income minus upkeep. Can be negative. */
export function netIncome(state: GameState, nationId: NationId): number {
  return grossIncome(state, nationId) - troopUpkeep(state, nationId);
}

export function totalPopulation(state: GameState, nationId: NationId): number {
  return ownedCountries(state, nationId).reduce((sum, c) => sum + c.population, 0);
}

/** Manpower added per turn. Recomputed from current holdings, so losing land cuts it at once. */
export function manpowerRegen(state: GameState, nationId: NationId): number {
  return totalPopulation(state, nationId) * MANPOWER.REGEN_RATE;
}

/** Ceiling on the banked pool: a year of regen. */
export function manpowerCap(state: GameState, nationId: NationId): number {
  return manpowerRegen(state, nationId) * MANPOWER.CAP_MONTHS;
}

export function totalTroops(state: GameState, nationId: NationId): number {
  return ownedCountries(state, nationId).reduce((sum, c) => sum + c.troops, 0);
}

/** Cost to raise a country from its current level to the next one. */
export function investmentCost(currentLevel: number): number {
  return Math.round(DEVELOPMENT.BASE_COST * currentLevel ** DEVELOPMENT.COST_EXPONENT);
}

export function recruitmentCost(troops: number): { money: number; manpower: number } {
  return {
    money: troops * RECRUITMENT.MONEY_PER_TROOP,
    manpower: troops * MANPOWER.COST_PER_TROOP,
  };
}

/** Most troops a nation could recruit right now, given money and manpower both. */
export function maxAffordableTroops(state: GameState, nationId: NationId): number {
  const nation = state.nations[nationId];
  if (!nation) return 0;
  const byMoney = Math.floor(nation.treasury / RECRUITMENT.MONEY_PER_TROOP);
  const byManpower = Math.floor(nation.manpower / MANPOWER.COST_PER_TROOP);
  return Math.max(0, Math.min(byMoney, byManpower));
}

/**
 * Applies one turn of income and manpower regen to a nation.
 * A treasury that ends up below zero triggers desertion: every stack loses a
 * fixed fraction and the treasury is floored to zero.
 */
export function applyIncome(
  state: GameState,
  nationId: NationId,
  incomeMultiplier: number,
): { state: GameState; net: number; deserted: number } {
  const nation = state.nations[nationId];
  if (!nation) return { state, net: 0, deserted: 0 };

  const net = grossIncome(state, nationId) * incomeMultiplier - troopUpkeep(state, nationId);
  const cap = manpowerCap(state, nationId);
  const manpower = Math.min(cap, nation.manpower + manpowerRegen(state, nationId));
  let treasury = nation.treasury + net;

  let countries = state.countries;
  let deserted = 0;
  if (treasury < 0) {
    countries = { ...countries };
    for (const country of Object.values(countries)) {
      if (country.ownerId !== nationId || country.troops <= 0) continue;
      const lost = Math.ceil(country.troops * ECONOMY.BANKRUPTCY_DESERTION_RATE);
      deserted += lost;
      countries[country.id] = { ...country, troops: country.troops - lost };
    }
    treasury = 0;
  }

  return {
    state: {
      ...state,
      countries,
      nations: { ...state.nations, [nationId]: { ...nation, treasury, manpower } },
    },
    net,
    deserted,
  };
}
