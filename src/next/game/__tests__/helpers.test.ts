import { describe, expect, it } from 'vitest';
import { EFFECTS, GARRISON, UNITS } from '../balance';
import { PLAYER_COLOUR } from '../colours';
import { assertInvariants, deepFreeze, stateHash, tinySim } from './helpers';

describe('tinySim', () => {
  const tiny = () =>
    tinySim({
      provinces: {
        paris: { owner: 'me', capitalOf: 'me', buildings: { ramparts: 1 } },
        lille: { owner: 'me' },
        brussels: { owner: 'be', capitalOf: 'be', terrain: 'urban' },
        bern: { owner: 'me', country: 'ch', stability: 30 },
      },
      edges: [
        ['paris', 'lille'],
        ['lille', 'brussels', 120],
        ['paris', 'bern', 400, 'sea'],
      ],
      armies: [
        { owner: 'me', at: 'lille', units: { rifles: 3, guns: 1 } },
        { owner: 'be', at: 'brussels', units: { rifles: 2 }, stance: 'defend' },
        { owner: 'me', at: 'brussels', units: { tanks: 1 } },
      ],
      stocks: { me: { funds: 500 } },
    });

  it('builds a world-shaped map', () => {
    const { sim, p, n } = tiny();
    const { map } = sim;
    expect(map.nations.map((x) => x.id)).toEqual(['be', 'ch', 'me']);
    expect(map.provinces[p('bern')]!.country).toBe(n('ch'));
    expect(map.nations[n('ch')]!.capital).toBe(p('bern'));
    expect(map.provinces[p('paris')]!.isCapital).toBe(true);
    expect(map.provinces[p('lille')]!.isCapital).toBe(false);
    expect(map.totalVp).toBe(4 + 1 + 4 + 4);
    expect(map.goalVp).toBe(7);
    expect(map.edges[p('paris')]).toEqual([
      { to: p('lille'), km: 100, sea: false },
      { to: p('bern'), km: 400, sea: true },
    ]);
    expect(map.nations[n('me')]!.neighbours).toEqual([n('be'), n('ch')]);
  });

  it('builds a playable state', () => {
    const { sim, p, n, a } = tiny();
    const { state, map } = sim;
    expect(state.player).toBe(n('me'));
    expect(state.nations[n('ch')]!.alive).toBe(false);
    expect(state.nations[n('me')]!.stocks.funds).toBe(500);
    expect(state.nations[n('be')]!.stocks.funds).toBe(0);
    expect(state.nations[n('me')]!.capital).toBe(p('paris'));
    const paris = state.provinces[p('paris')]!;
    expect(paris.garrison).toBeCloseTo(map.provinces[p('paris')]!.garrisonBase * (1 + EFFECTS.RAMPARTS_GARRISON_PER_LEVEL), 9);
    expect(paris.garrison).toBeGreaterThan(GARRISON.BASE_HP);
    expect(state.provinces[p('bern')]!.stability).toBe(30);
    const first = state.armies[0]!;
    expect(first.id).toBe(a(0));
    expect(first.name).toBe('1st Army');
    expect(state.armies[2]!.name).toBe('2nd Army');
    expect(first.units.rifles).toEqual({ count: 3, hp: 3 * UNITS.rifles.hp });
    expect(first.stance).toBe('manual');
    expect(state.armies[1]!.post).toBe(p('brussels'));
    expect(state.nations[n('me')]!.colour).toBe(PLAYER_COLOUR);
    expect(state.nations[n('be')]!.colour).not.toBe(PLAYER_COLOUR);
    assertInvariants(sim);
  });

  it('starts battles where armies stand in defended hostile land', () => {
    const { sim, p, a } = tiny();
    expect(sim.cache.battles).toEqual([p('brussels')]);
    expect(sim.state.provinces[p('brussels')]!.battleSince).toBe(0);
    expect(sim.state.armies.find((x) => x.id === a(2))!.battle).toEqual({ joinedAt: 0, startHp: UNITS.tanks.hp, direction: null });
    expect(sim.state.armies.find((x) => x.id === a(0))!.battle).toBeNull();
  });

  it('rejects unknown names', () => {
    const { n, p, a } = tiny();
    expect(() => n('xx')).toThrow();
    expect(() => p('xx')).toThrow();
    expect(() => a(9)).toThrow();
    expect(() => tinySim({ provinces: { a: { owner: 'me' } }, edges: [['a', 'b']] })).toThrow();
  });
});

describe('assertInvariants', () => {
  it('catches a stale cache, negative stocks and an army both moving and fighting', () => {
    const stale = tinySim({ provinces: { a: { owner: 'me' }, b: { owner: 'ai' } }, edges: [['a', 'b']] });
    stale.sim.state.provinces[stale.p('b')]!.owner = stale.n('me');
    expect(() => assertInvariants(stale.sim)).toThrow();

    const broke = tinySim({ provinces: { a: { owner: 'me' } }, edges: [] });
    broke.sim.state.nations[0]!.stocks.food = -1;
    expect(() => assertInvariants(broke.sim)).toThrow();

    const busy = tinySim({
      provinces: { a: { owner: 'me' }, b: { owner: 'ai' } },
      edges: [['a', 'b']],
      armies: [{ owner: 'me', at: 'a', units: { rifles: 1 } }],
    });
    const army = busy.sim.state.armies[0]!;
    army.leg = { from: busy.p('a'), to: busy.p('b'), ticks: 20, done: 0, sea: false };
    army.battle = { joinedAt: 0, startHp: 20, direction: null };
    expect(() => assertInvariants(busy.sim)).toThrow();
  });
});

describe('stateHash and deepFreeze', () => {
  it('hashes equal states equally and different states differently', () => {
    const one = tinySim({ provinces: { a: { owner: 'me' } }, edges: [] });
    const two = tinySim({ provinces: { a: { owner: 'me' } }, edges: [] });
    expect(stateHash(one.sim)).toBe(stateHash(two.sim));
    two.sim.state.rng += 1;
    expect(stateHash(one.sim)).not.toBe(stateHash(two.sim));
  });

  it('freezes nested state', () => {
    const { sim } = tinySim({ provinces: { a: { owner: 'me' } }, edges: [] });
    const state = deepFreeze(sim.state);
    expect(Object.isFrozen(state.provinces[0]!.buildings)).toBe(true);
    expect(() => {
      state.nations[0]!.stocks.funds = 1;
    }).toThrow(TypeError);
    expect(deepFreeze(sim.cache).contested).toBeInstanceOf(Uint8Array);
  });
});
