import type { Country, GameState, Nation } from '@/game/types';

export interface CountrySpec {
  owner: string;
  troops: number;
  development?: number;
  population?: number;
  tier?: number;
}

/**
 * A small hand-built world for rule tests. Countries are keyed by id; each owner
 * becomes a nation with no money, so nothing recruits unless a test says so.
 */
export function tinyWorld(
  countries: Record<string, CountrySpec>,
  edges: [string, string][],
  overrides: Partial<GameState> = {},
): GameState {
  const built: Record<string, Country> = {};
  const nations: Record<string, Nation> = {};
  for (const [id, spec] of Object.entries(countries)) {
    built[id] = {
      id,
      name: id.toUpperCase(),
      population: spec.population ?? 10_000_000,
      economyTier: spec.tier ?? 3,
      ownerId: spec.owner,
      troops: spec.troops,
      development: spec.development ?? 5,
      hasMoved: false,
    };
    nations[spec.owner] ??= {
      id: spec.owner,
      name: spec.owner.toUpperCase(),
      colour: '#888',
      treasury: 0,
      manpower: 0,
      isPlayer: spec.owner === 'me',
      isMajor: true,
    };
  }
  const adjacency: Record<string, string[]> = {};
  for (const id of Object.keys(countries)) adjacency[id] = [];
  for (const [a, b] of edges) {
    adjacency[a]!.push(b);
    adjacency[b]!.push(a);
  }
  return {
    turn: 0,
    countries: built,
    nations,
    adjacency,
    playerId: 'me',
    difficulty: 'standard',
    status: 'playing',
    log: [],
    nextLogId: 1,
    rngState: 7,
    stats: { battlesWon: 0, battlesLost: 0, defencesHeld: 0, countriesLost: 0, peakCountries: 1 },
    lastReport: null,
    ...overrides,
  };
}
