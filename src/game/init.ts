import { ECONOMY, GARRISON, MANPOWER, TURN } from './balance';
import { recomputeTiers } from './ai';
import { nationColour } from './colours';
import { countryIncome, manpowerRegen } from './economy';
import { appendLog } from './log';
import { seedFromString } from './rng';
import type {
  AdjacencyGraph,
  Country,
  CountryId,
  CountrySeed,
  Difficulty,
  GameState,
  Nation,
} from './types';

export interface NewGameOptions {
  seeds: readonly CountrySeed[];
  adjacency: AdjacencyGraph;
  playerCountryId: CountryId;
  difficulty: Difficulty;
  /** Any string; the same string always produces the same game. */
  randomSeed: string;
}

function openingGarrison(population: number): number {
  return Math.round(GARRISON.BASE + Math.sqrt(population / 1_000_000) * GARRISON.PER_ROOT_MILLION);
}

/**
 * Builds a fresh world. Every country starts as its own independent nation —
 * there are no neutral territories, so conquest is continuous rather than gated
 * behind a handful of great powers.
 */
export function createGame(options: NewGameOptions): GameState {
  const countries: Record<CountryId, Country> = {};
  const nations: Record<string, Nation> = {};

  for (const seed of options.seeds) {
    if (!options.adjacency[seed.id]) continue;
    const development = Math.max(1, Math.min(10, seed.economyTier * 2 - 1));
    countries[seed.id] = {
      id: seed.id,
      name: seed.name,
      population: seed.population,
      economyTier: seed.economyTier,
      ownerId: seed.id,
      troops: openingGarrison(seed.population),
      development,
      hasMoved: false,
    };
    nations[seed.id] = {
      id: seed.id,
      name: seed.name,
      colour: nationColour(seed.id, options.playerCountryId),
      treasury: 0,
      manpower: 0,
      isPlayer: seed.id === options.playerCountryId,
      isMajor: false,
    };
  }

  let state: GameState = {
    turn: 0,
    countries,
    nations,
    adjacency: options.adjacency,
    playerId: options.playerCountryId,
    difficulty: options.difficulty,
    status: 'playing',
    log: [],
    nextLogId: 1,
    rngState: seedFromString(options.randomSeed),
  };

  // Opening treasury and manpower are derived from what each nation actually holds.
  const funded: Record<string, Nation> = {};
  for (const nation of Object.values(state.nations)) {
    const country = state.countries[nation.id];
    const gross = country ? countryIncome(country) : 0;
    funded[nation.id] = {
      ...nation,
      treasury: Math.round(gross * ECONOMY.STARTING_TREASURY_MONTHS),
      manpower: Math.round(manpowerRegen(state, nation.id) * MANPOWER.STARTING_MONTHS),
    };
  }
  state = recomputeTiers({ ...state, nations: funded });

  const player = state.nations[options.playerCountryId];
  return appendLog(
    state,
    'system',
    `${player?.name ?? 'Your nation'} takes the field, ${monthLabel()}.`,
    [options.playerCountryId],
  );
}

function monthLabel(): string {
  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  return `${months[TURN.START_MONTH - 1] ?? 'January'} ${TURN.START_YEAR}`;
}
