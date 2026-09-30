import { describe, expect, it } from 'vitest';
import topology from '../../../public/countries-110m.json';
import seeds from '@/data/countries.seed.json';
import seaLinks from '@/data/sea-links.json';
import { buildWorld, type CountriesTopology } from '@/lib/world';
import { isolatedCountries } from '@/game/adjacency';
import { createGame } from '@/game/init';
import { endTurn } from '@/game/turn';
import { countryCount } from '@/game/victory';
import type { Difficulty, GameState } from '@/game/types';
import { advisorTurn } from './helpers';

const world = buildWorld(topology as unknown as CountriesTopology, seeds, seaLinks);

describe('the real world', () => {
  it('excludes Antarctica and keeps every other territory', () => {
    expect(world.shapes).toHaveLength(175);
    expect(world.shapes.some((s) => s.name === 'Antarctica')).toBe(false);
  });

  it('gives every seeded country a shape and vice versa', () => {
    const shapeIds = new Set(world.shapes.map((s) => s.id));
    const seedIds = new Set(seeds.map((s) => s.id));
    expect([...seedIds].filter((id) => !shapeIds.has(id))).toEqual([]);
    expect([...shapeIds].filter((id) => !seedIds.has(id))).toEqual([]);
  });

  it('leaves no country stranded without a neighbour', () => {
    expect(isolatedCountries(world.adjacency)).toEqual([]);
  });

  it('is symmetric', () => {
    for (const [id, neighbours] of Object.entries(world.adjacency)) {
      for (const neighbour of neighbours) {
        expect(world.adjacency[neighbour]).toContain(id);
      }
    }
  });

  it('connects islands by sea link — Japan reaches South Korea', () => {
    expect(world.adjacency['392']).toContain('410');
    expect(world.adjacency['826']).toContain('250');
    expect(world.adjacency['360']).toContain('036');
  });

  it('finds land borders without help — France touches Germany', () => {
    expect(world.adjacency['250']).toContain('276');
    expect(world.adjacency['840']).toContain('484');
  });
});

describe('a full game', () => {
  const newGame = (difficulty: Difficulty = 'standard', randomSeed = 'test') =>
    createGame({ seeds, adjacency: world.adjacency, playerCountryId: '250', difficulty, randomSeed });

  /**
   * Advances the world `turns` months regardless of the player's fate.
   *
   * endTurn correctly does nothing once the game is over, so a test that simply
   * loops endTurn silently stops measuring the moment the observer nation dies —
   * which once made a live world look frozen. World-level tests go through here.
   */
  const simulate = (state: GameState, turns: number): GameState => {
    let current = state;
    for (let i = 0; i < turns; i += 1) current = endTurn({ ...current, status: 'playing' });
    return current;
  };

  const ownership = (state: GameState) => Object.values(state.countries).map((c) => c.ownerId).join();
  const nationCount = (state: GameState) => new Set(Object.values(state.countries).map((c) => c.ownerId)).size;

  it('starts with every country independent', () => {
    const state = newGame();
    expect(Object.keys(state.countries)).toHaveLength(175);
    expect(countryCount(state, '250')).toBe(1);
    expect(state.nations['250']?.isPlayer).toBe(true);
  });

  it('gives every nation an opening treasury and manpower', () => {
    const state = newGame();
    for (const nation of Object.values(state.nations)) {
      expect(nation.treasury).toBeGreaterThan(0);
      expect(nation.manpower).toBeGreaterThan(0);
    }
  });

  it('gives the player a bigger war chest on easier difficulties', () => {
    const treasury = (d: Difficulty) => newGame(d).nations['250']!.treasury;
    expect(treasury('relaxed')).toBeGreaterThan(treasury('standard'));
    expect(treasury('standard')).toBeGreaterThan(treasury('ruthless'));
  });

  it('promotes roughly the intended number of major powers', () => {
    const majors = Object.values(newGame().nations).filter((n) => n.isMajor);
    expect(majors.length).toBeGreaterThanOrEqual(20);
    expect(majors.length).toBeLessThan(60);
  });

  it('keeps the world consistent over two years', () => {
    const state = simulate(newGame(), 24);
    expect(state.turn).toBe(24);
    expect(Object.keys(state.countries)).toHaveLength(175);
    for (const country of Object.values(state.countries)) {
      expect(country.troops).toBeGreaterThanOrEqual(0);
      expect(state.nations[country.ownerId]).toBeDefined();
    }
    for (const nation of Object.values(state.nations)) {
      expect(nation.treasury).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(nation.manpower)).toBe(true);
    }
  });

  it('stops advancing once the game is over', () => {
    const over = { ...newGame(), status: 'lost' as const };
    expect(endTurn(over)).toBe(over);
  });

  it('is deterministic for a given seed', () => {
    expect(simulate(newGame(), 12).countries).toEqual(simulate(newGame(), 12).countries);
  });

  it('actually fights — borders move within the first year', () => {
    const start = newGame();
    expect(ownership(simulate(start, 12))).not.toBe(ownership(start));
  });

  it('writes combat lines with the numbers in them', () => {
    const combat = simulate(newGame(), 24).log.filter((e) => e.kind === 'combat');
    expect(combat.length).toBeGreaterThan(0);
    expect(combat[0]?.text).toMatch(/A \d+\.\d/);
  });

  it('lets great powers keep their homelands through year one', () => {
    // Regression guard. The AI once attacked with most of a stack and never
    // checked what it left behind: the Netherlands owned Germany in month one and
    // Belgium owned the United Kingdom in month two.
    const greatPowers = ['276', '826', '380', '724', '643', '156', '840', '356', '392', '076'];
    const state = simulate(newGame('standard', 'homelands'), 12);
    const held = greatPowers.filter((id) => state.countries[id]?.ownerId === id);
    expect(held.length).toBeGreaterThanOrEqual(7);
  });

  it('consolidates at a playable rate rather than collapsing in the first year', () => {
    for (const difficulty of ['relaxed', 'standard', 'ruthless'] as const) {
      expect(nationCount(simulate(newGame(difficulty), 12)), difficulty).toBeGreaterThan(100);
    }
  });

  it('never deadlocks: the map keeps moving long after the opening', () => {
    // Regression guard for three separate freezes: comparing raw troop counts,
    // reinforcing before attacking (which used up every source's action), and
    // capping attacks at a size too small to hold what they took.
    for (const difficulty of ['relaxed', 'standard', 'ruthless'] as const) {
      const atTwoYears = simulate(newGame(difficulty), 24);
      const atFiveYears = simulate(atTwoYears, 36);
      expect(ownership(atFiveYears), `${difficulty} froze after two years`).not.toBe(ownership(atTwoYears));
      expect(nationCount(atFiveYears), `${difficulty} barely moved`).toBeLessThan(nationCount(atTwoYears) - 5);
    }
  });

  it('leaves no AI nation alive without its capital: losing it means capitulating', () => {
    const state = simulate(newGame(), 48);
    const alive = new Set(Object.values(state.countries).map((c) => c.ownerId));
    for (const id of alive) {
      if (id === state.playerId) continue;
      expect(state.countries[id]?.ownerId, `${state.nations[id]?.name} lives on without its capital`).toBe(id);
    }
    expect(state.log.some((entry) => entry.surrender)).toBe(true);
  });

  it('eventually produces large empires, so there is someone to beat', () => {
    const state = simulate(newGame('standard'), 120);
    const biggest = Math.max(...Object.keys(state.nations).map((id) => countryCount(state, id)));
    expect(biggest).toBeGreaterThan(20);
  });
});

describe('history', () => {
  it('records one point per month, always including the player, never more than the tracked nations', () => {
    let state = createGame({ seeds, adjacency: world.adjacency, playerCountryId: '250', difficulty: 'standard', randomSeed: 'h' });
    expect(state.history).toHaveLength(1);
    for (let i = 0; i < 12; i += 1) state = endTurn({ ...state, status: 'playing' });
    expect(state.history.map((p) => p.turn)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    for (const point of state.history) {
      expect(point.counts['250']).toBeDefined();
      expect(Object.keys(point.counts).length).toBeLessThanOrEqual(11);
    }
    const last = state.history[state.history.length - 1]!;
    expect(last.counts['250']).toBe(Object.values(state.countries).filter((c) => c.ownerId === '250').length);
  });
});

describe('the advisor', () => {
  it('makes real progress, but does not hand the player hegemony within two years on standard', () => {
    // Regression guard. When combined assaults were first added, for the player
    // only and under the old difficulty settings, a player who did nothing but
    // press Advise won at turn 30: 18, then 50, then 107 countries. AI great
    // powers now combine too and Standard's AI is stronger; this pins the
    // outcome rather than either cause.
    let state = createGame({ seeds, adjacency: world.adjacency, playerCountryId: '276', difficulty: 'standard', randomSeed: 'advisor' });
    for (let i = 0; i < 24 && state.status === 'playing'; i += 1) state = endTurn(advisorTurn(state));
    expect(state.status).not.toBe('won');
    const held = countryCount(state, '276');
    expect(held).toBeGreaterThanOrEqual(8);
    expect(held).toBeLessThan(95);
  });
});
