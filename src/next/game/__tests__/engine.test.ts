import { describe, expect, it } from 'vitest';
import { AI_TIERS, DIFFICULTY, ECONOMY, START, TIME } from '../balance';
import { armiesOf, armyById } from '../cache';
import { applyCommand } from '../commands';
import { createGame } from '../init';
import { nationRates } from '../economy';
import { garrisonCap } from '../province';
import { advance, createSim, stepTick } from '../sim';
import { UNIT_TYPES } from '../types';
import type { Army, SimPhase, UnitType } from '../types';
import { totalCount } from '../units';
import { assertInvariants, realMapStatic, realSim, tinySim } from './helpers';

function counts(armies: readonly Army[]): Record<UnitType, number> {
  const out: Record<UnitType, number> = { rifles: 0, hunters: 0, motor: 0, guns: 0, tanks: 0 };
  for (const army of armies) for (const type of UNIT_TYPES) out[type] += army.units[type].count;
  return out;
}

describe('the tick', () => {
  const twoNations = (): ReturnType<typeof tinySim> =>
    tinySim({
      provinces: { a: { owner: 'me', capitalOf: 'me' }, b: { owner: 'me' }, c: { owner: 'foe', capitalOf: 'foe' }, d: { owner: 'foe' } },
      edges: [
        ['a', 'b'],
        ['b', 'c'],
        ['c', 'd'],
      ],
      player: 'me',
    });

  it('runs the phases in the fixed order, the hourly and daily ones only on their ticks', () => {
    const { sim } = twoNations();
    const seen: string[] = [];
    const hooks = { phase: (name: SimPhase, edge: 'start' | 'end'): void => void seen.push(`${name}:${edge}`) };
    const phasesOf = (): string[] => {
      seen.length = 0;
      stepTick(sim, hooks);
      expect(seen.filter((_, i) => i % 2 === 1)).toEqual(seen.filter((_, i) => i % 2 === 0).map((s) => s.replace(':start', ':end')));
      return seen.filter((s) => s.endsWith(':start')).map((s) => s.slice(0, -':start'.length));
    };
    expect(phasesOf()).toEqual(['movement', 'combat', 'economy', 'provinces', 'daily', 'ai', 'sweep']);
    expect(phasesOf()).toEqual(['movement', 'ai', 'sweep']);
    sim.state.tick = TIME.TICKS_PER_HOUR;
    expect(phasesOf()).toEqual(['movement', 'combat', 'economy', 'provinces', 'ai', 'sweep']);
  });

  it('advances the tick and hands back one batch of events', () => {
    const { sim } = twoNations();
    const events = advance(sim, 10);
    expect(sim.state.tick).toBe(10);
    expect(events.ticks).toBe(10);
    expect(advance(sim, 0).ticks).toBe(0);
  });

  it('re-times Oil users when the Oil flag flips during the hour', () => {
    const { sim, n, p, a } = tinySim({
      provinces: { a: { owner: 'me', capitalOf: 'me' }, b: { owner: 'me' } },
      edges: [['a', 'b', 1000]],
      armies: [{ owner: 'me', at: 'a', units: { tanks: 2 } }],
      stocks: { me: { funds: 1000, food: 1000, oil: 0.01 } },
    });
    expect(applyCommand(sim, { kind: 'move', nation: n('me'), armies: [a(0)], to: p('b'), together: false, append: false }, 'player').ok).toBe(true);
    stepTick(sim);
    const leg = armyById(sim, a(0))!.leg!;
    expect(sim.state.nations[n('me')]!.shortage.oil).toBe(true);
    const fullSpeedTicks = Math.ceil(1000 / (30 * 0.25));
    // The covered share keeps its place: done doubles with the halved speed, the rest takes twice as long.
    const doneBefore = leg.done * ECONOMY.OIL_SHORT_SPEED;
    expect(leg.ticks).toBe(leg.done + Math.ceil((fullSpeedTicks - doneBefore) / ECONOMY.OIL_SHORT_SPEED));
  });

  it('hands revolting provinces back to their original nation', () => {
    const { sim, n, p } = tinySim({
      provinces: { m: { owner: 'me', capitalOf: 'me' }, o: { owner: 'me', country: 'foe' }, f: { owner: 'foe', capitalOf: 'foe' } },
      edges: [
        ['m', 'o'],
        ['o', 'f'],
      ],
      stocks: { me: { funds: 10_000, food: 10_000 }, foe: { funds: 10_000, food: 10_000 } },
      seed: 'revolt',
    });
    let hours = 0;
    while (sim.state.provinces[p('o')]!.owner === n('me') && hours < 5000) {
      sim.state.provinces[p('o')]!.stability = 0;
      advance(sim, TIME.TICKS_PER_HOUR);
      hours += 1;
    }
    expect(sim.state.provinces[p('o')]!.owner).toBe(n('foe'));
    expect(sim.state.stats.revoltsSuffered).toBe(1);
    expect(sim.state.feed.some((e) => e.kind === 'revolt')).toBe(true);
  });

  it('auto-buys for the player on the 6-hour cadence', () => {
    const { sim, n } = tinySim({
      provinces: { a: { owner: 'me', capitalOf: 'me' } },
      edges: [],
      armies: [{ owner: 'me', at: 'a', units: { tanks: 3 } }],
      stocks: { me: { funds: 5000, food: 500, oil: 0 } },
    });
    stepTick(sim);
    const bought = sim.state.market.pressure.oil;
    expect(bought).toBeGreaterThan(0);
    expect(sim.state.nations[n('me')]!.stocks.oil).toBeGreaterThan(0);
    sim.state.nations[n('me')]!.stocks.oil = 0;
    advance(sim, TIME.TICKS_PER_HOUR * 5);
    expect(sim.state.market.pressure.oil).toBeLessThan(bought);
    advance(sim, 1);
    expect(sim.state.market.pressure.oil).toBeGreaterThan(bought * 0.9);
  });

  it('writes the midnight digest for the day that ended', () => {
    const { sim } = twoNations();
    advance(sim, TIME.TICKS_PER_DAY + 1);
    const digest = sim.state.feed.find((e) => e.kind === 'digest');
    expect(digest?.text).toMatch(/^Day 1: 2 provinces, VP 5 \(\+0 today, \d+\.\d%\), attacks won 0, lost 0$/);
    expect(digest?.tick).toBe(TIME.TICKS_PER_DAY);
  });

  it('keeps only the latest digest, so quiet days do not bury the news', () => {
    const { sim } = twoNations();
    advance(sim, TIME.TICKS_PER_DAY * 5 + 1);
    const digests = sim.state.feed.filter((e) => e.kind === 'digest');
    expect(digests).toHaveLength(1);
    expect(digests[0]?.text).toMatch(/^Day 5: /);
  });

  it('checks the result every hour', () => {
    const { sim } = tinySim({
      provinces: { a: { owner: 'me', capitalOf: 'me' }, b: { owner: 'me' }, c: { owner: 'foe', capitalOf: 'foe' } },
      edges: [
        ['a', 'b'],
        ['b', 'c'],
      ],
      player: 'me',
    });
    const events = advance(sim, 1);
    expect(sim.state.status).toBe('won');
    expect(events.statusChanged).toBe(true);
    expect(sim.state.feed[0]).toMatchObject({ kind: 'victory', text: 'Hegemony achieved' });
  });

  it('computes the player vision when a sim is created', () => {
    const { sim } = twoNations();
    const fresh = createSim(sim.map, sim.state, { recordCommands: false });
    expect([...fresh.cache.vision]).toEqual([1, 1, 1, 1]);
    expect(fresh.cache.commandLog).toBeNull();
  });
});

describe('the opening world', () => {
  const map = realMapStatic();

  it('is deterministic and refuses an unknown nation', () => {
    const options = { playerCountryId: '250', difficulty: 'standard' as const, seed: 'opening' };
    expect(JSON.stringify(createGame(map, options))).toBe(JSON.stringify(createGame(map, options)));
    expect(() => createGame(map, { ...options, playerCountryId: 'XYZ' })).toThrow(/no nation with id XYZ/);
  });

  it('starts every province at home, full stability and full garrison, and passes the invariants', () => {
    const sim = realSim({ seed: 'opening' });
    sim.state.provinces.forEach((province, i) => {
      expect(province.owner).toBe(map.provinces[i]!.country);
      expect(province.stability).toBe(100);
      expect(province.garrison).toBe(garrisonCap(sim, map.provinces[i]!.ix));
    });
    expect(sim.state.nations.every((nation) => nation.alive && nation.capital === map.nations[nation.ix]!.capital)).toBe(true);
    assertInvariants(sim);
  });

  it('places the §2.7 and §3.8 starting buildings', () => {
    const { provinces } = realSim({ seed: 'opening' }).state;
    for (const ns of map.nations) {
      const capital = provinces[ns.capital]!.buildings;
      expect(capital.ramparts).toBe(START.CAPITAL_RAMPARTS);
      expect(capital.training).toBe(START.TRAINING_LEVEL_BY_TIER[ns.tier]);
      expect(capital.works).toBe(ns.tier >= START.CAPITAL_WORKS_MIN_TIER ? 1 : 0);
      const others = ns.home.filter((p) => p !== ns.capital && provinces[p]!.buildings.training > 0);
      expect(others.length).toBe(ns.home.length >= START.SECOND_TRAINING_AT_PROVINCES ? 1 : 0);
    }
    const france = map.nations[map.nationById.get('250')!]!;
    const lyonLike = france.home.filter((p) => p !== france.capital).sort((x, y) => map.provinces[y]!.population - map.provinces[x]!.population)[0]!;
    expect(provinces[lyonLike]!.buildings.training).toBe(1);
  });

  // The opening as tuned after the first balance runs: twice the spec's §3.8 armies
  // (START.UNITS_PER_SQRT_FUNDS 0.8), because garrisons out-defended every army.
  it('reproduces the worked opening: player France on Standard (§3.8)', () => {
    const sim = realSim({ seed: 'opening' });
    const france = sim.state.player;
    const armies = armiesOf(sim, france);
    expect(counts(armies)).toEqual({ rifles: 16, hunters: 3, motor: 3, guns: 5, tanks: 5 });
    const capital = armies.filter((army) => army.at === map.nations[france]!.capital);
    expect(capital).toHaveLength(1);
    expect(totalCount(capital[0]!.units)).toBe(18);
    expect(armies.length).toBeLessThanOrEqual(1 + START.MAX_BORDER_ARMIES);
    expect(armies.every((army) => army.stance === 'manual' && army.retreatAt === 0.25)).toBe(true);
    const stocks = sim.state.nations[france]!.stocks;
    expect(Math.round(stocks.funds)).toBe(8545);
    expect(Math.round(stocks.recruits)).toBe(29_920);
    expect(stocks.oil).toBe(190);
    expect(stocks.steel).toBeGreaterThanOrEqual(150);
    expect(nationRates(sim, france).upkeep).toMatchObject({ funds: 177, food: 64, oil: 26 });
  });

  it('sizes AI nations by Funds per day, guards their capitals to the end, and ranks the majors', () => {
    const sim = realSim({ seed: 'opening' });
    const { state } = sim;
    const germany = map.nationById.get('276')!;
    expect(counts(armiesOf(sim, germany))).toEqual({ rifles: 14, hunters: 3, motor: 3, guns: 4, tanks: 4 });
    const luxembourg = map.nationById.get('442')!;
    expect(UNIT_TYPES.reduce((sum, type) => sum + counts(armiesOf(sim, luxembourg))[type], 0)).toBe(10);
    for (const nation of state.nations) {
      if (nation.isPlayer) continue;
      const guard = armiesOf(sim, nation.ix).find((army) => army.at === map.nations[nation.ix]!.capital);
      expect(guard?.retreatAt).toBe(0);
    }
    const world = state.armies.reduce((sum, army) => sum + totalCount(army.units), 0);
    expect(world).toBeGreaterThan(1900);
    expect(world).toBeLessThan(2300);
    const majors = state.nations.filter((nation) => !nation.isPlayer && nation.tier === 'major').length;
    expect(majors).toBeGreaterThanOrEqual(DIFFICULTY.standard.majorCount);
    expect(majors).toBeLessThanOrEqual(AI_TIERS.MAX_MAJORS);
    expect(state.armies.map((army) => army.id)).toEqual(state.armies.map((_, i) => i + 1));
  });

  it('scales the player opening by difficulty', () => {
    const relaxed = realSim({ seed: 'opening', difficulty: 'relaxed' });
    const ruthless = realSim({ seed: 'opening', difficulty: 'ruthless' });
    const france = relaxed.state.player;
    const units = (sim: typeof relaxed): number => armiesOf(sim, france).reduce((sum, army) => sum + totalCount(army.units), 0);
    expect(units(relaxed)).toBe(41);
    expect(units(ruthless)).toBe(27);
    expect(relaxed.state.nations[france]!.stocks.funds / ruthless.state.nations[france]!.stocks.funds).toBeCloseTo(12 / 4, 9);
  });
});
