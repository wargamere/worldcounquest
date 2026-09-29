import { describe, expect, it } from 'vitest';
import { evaluateStatus, leadingRival, rivalHegemon } from '@/game/victory';
import type { Country, GameState } from '@/game/types';

function worldOf(owners: string[]): GameState {
  const countries: Record<string, Country> = {};
  owners.forEach((ownerId, i) => {
    countries[`c${i}`] = {
      id: `c${i}`, name: `C${i}`, population: 1_000_000, economyTier: 3,
      ownerId, troops: 10, development: 5, hasMoved: false,
    };
  });
  return {
    turn: 0, countries, nations: {}, adjacency: {}, playerId: 'me', difficulty: 'standard',
    status: 'playing', log: [], nextLogId: 1, rngState: 1,
    stats: { battlesWon: 0, battlesLost: 0, defencesHeld: 0, countriesLost: 0, peakCountries: 1 },
    lastReport: null,
  };
}

describe('evaluateStatus', () => {
  it('keeps playing while nobody has hegemony', () => {
    expect(evaluateStatus(worldOf(['me', 'a', 'b', 'c', 'd']))).toBe('playing');
  });

  it('wins at 60% control', () => {
    expect(evaluateStatus(worldOf(['me', 'me', 'me', 'a', 'b']))).toBe('won');
  });

  it('loses when the last territory falls', () => {
    expect(evaluateStatus(worldOf(['a', 'a', 'b', 'c', 'd']))).toBe('lost');
  });

  it('loses when a rival reaches hegemony first', () => {
    const state = worldOf(['me', 'a', 'a', 'a', 'b']);
    expect(rivalHegemon(state)).toBe('a');
    expect(evaluateStatus(state)).toBe('lost');
  });
});

describe('standings', () => {
  it('names the biggest rival', () => {
    expect(leadingRival(worldOf(['me', 'a', 'a', 'b', 'b', 'b']))).toEqual({ nationId: 'b', countries: 3 });
  });

});
