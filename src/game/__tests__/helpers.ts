import { moveTroops, recruit } from '@/game/actions';
import { adviseAttack, adviseMove, executePlan } from '@/game/ai';
import { maxAffordableTroops } from '@/game/economy';
import { combinedThreat } from '@/game/threat';
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
    history: [],
    ...overrides,
  };
}

/**
 * One turn played the way a player who always takes the advisor's advice would:
 * recruit everything into the country most at risk, then accept advised attacks
 * and moves until the advisor has nothing left to suggest.
 */
export function advisorTurn(state: GameState): GameState {
  let current = state;
  const me = current.playerId;
  const mine = Object.values(current.countries).filter((c) => c.ownerId === me);
  const worst = mine.sort((a, b) => combinedThreat(current, b.id) - combinedThreat(current, a.id))[0];
  const affordable = maxAffordableTroops(current, me);
  if (worst && affordable > 0) current = recruit(current, me, worst.id, affordable).state;
  for (let i = 0; i < 40; i += 1) {
    const plan = adviseAttack(current);
    if (plan) {
      current = executePlan(current, me, plan);
      continue;
    }
    const move = adviseMove(current);
    if (!move) break;
    current = moveTroops(current, me, move.fromId, move.toId, move.troops).state;
  }
  return current;
}
