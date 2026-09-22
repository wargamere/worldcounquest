import { describe, expect, it } from 'vitest';
import topology from '../../../public/countries-110m.json';
import seeds from '@/data/countries.seed.json';
import seaLinks from '@/data/sea-links.json';
import { buildWorld, type CountriesTopology } from '@/lib/world';
import { isolatedCountries } from '@/game/adjacency';
import { createGame } from '@/game/init';
import { endTurn } from '@/game/turn';
import { countryCount } from '@/game/victory';

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
  const newGame = (difficulty: 'relaxed' | 'standard' | 'ruthless' = 'standard') =>
    createGame({
      seeds,
      adjacency: world.adjacency,
      playerCountryId: '250',
      difficulty,
      randomSeed: 'test',
    });

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

  it('promotes roughly the intended number of major powers', () => {
    const state = newGame();
    const majors = Object.values(state.nations).filter((n) => n.isMajor);
    expect(majors.length).toBeGreaterThanOrEqual(20);
    expect(majors.length).toBeLessThan(60);
  });

  it('runs two years without throwing and keeps the world consistent', () => {
    let state = newGame();
    for (let i = 0; i < 24; i += 1) state = endTurn(state);

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

  it('is deterministic for a given seed', () => {
    let a = newGame();
    let b = newGame();
    for (let i = 0; i < 12; i += 1) {
      a = endTurn(a);
      b = endTurn(b);
    }
    expect(a.countries).toEqual(b.countries);
  });

  it('actually fights — some borders move within two years', () => {
    let state = newGame();
    const before = Object.values(state.countries).map((c) => c.ownerId).join();
    for (let i = 0; i < 24; i += 1) state = endTurn(state);
    const after = Object.values(state.countries).map((c) => c.ownerId).join();
    expect(after).not.toBe(before);
  });

  it('consolidates at a playable rate rather than collapsing in the first year', () => {
    for (const difficulty of ['relaxed', 'standard', 'ruthless'] as const) {
      let state = newGame(difficulty);
      for (let i = 0; i < 12; i += 1) state = endTurn(state);
      const afterOneYear = new Set(Object.values(state.countries).map((c) => c.ownerId)).size;
      expect(afterOneYear).toBeGreaterThan(60);
    }
  });

  it('never deadlocks: the map keeps moving long after the opening', () => {
    // Regression guard. Comparing raw troop counts instead of expected combat
    // strength froze the world solid — every border sat at parity, no stack could
    // clear the aggression threshold, and ownership stopped changing entirely.
    for (const difficulty of ['relaxed', 'standard', 'ruthless'] as const) {
      let state = newGame(difficulty);
      for (let i = 0; i < 24; i += 1) state = endTurn(state);
      const atTwoYears = Object.values(state.countries).map((c) => c.ownerId).join();

      for (let i = 0; i < 36; i += 1) state = endTurn(state);
      const atFiveYears = Object.values(state.countries).map((c) => c.ownerId).join();

      expect(atFiveYears, `${difficulty} froze after two years`).not.toBe(atTwoYears);
    }
  });

  it('eventually produces large empires, so the game is winnable', () => {
    let state = newGame('standard');
    for (let i = 0; i < 120; i += 1) state = endTurn(state);
    const biggest = Math.max(
      ...Object.values(state.nations).map(
        (n) => Object.values(state.countries).filter((c) => c.ownerId === n.id).length,
      ),
    );
    expect(biggest).toBeGreaterThan(10);
  });

  it('writes combat lines with the numbers in them', () => {
    let state = newGame();
    for (let i = 0; i < 24; i += 1) state = endTurn(state);
    const combat = state.log.filter((e) => e.kind === 'combat');
    expect(combat.length).toBeGreaterThan(0);
    expect(combat[0]?.text).toMatch(/A \d+\.\d/);
  });
});
