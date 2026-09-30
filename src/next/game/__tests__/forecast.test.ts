import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as RngModule from '../rng';
import { COMBAT, GARRISON, UNITS } from '../balance';
import { battleInputAt } from '../combat';
import { forecastPlans, hypotheticalInput, predictBattle, roundOffset, verdictOf, winChance, type Arrival } from '../forecast';
import { asProvince } from '../ids';
import { planOrder } from '../movement';
import { garrisonCap } from '../province';
import { refreshVision } from '../supply';
import type { BattleInput, NationIx, UnitCounts } from '../types';
import { unitsFromCounts } from '../units';
import { tinySim } from './helpers';
import { battleWorld, runBattle, type BattleSetup } from './steps';

const rolls = vi.hoisted(() => ({ fixed: false }));
vi.mock('../rng', async (importOriginal) => {
  const actual = await importOriginal<typeof RngModule>();
  return {
    ...actual,
    roll: (...args: Parameters<typeof actual.roll>): number => (rolls.fixed ? 1 : actual.roll(...args)),
  };
});

beforeEach(() => {
  rolls.fixed = false;
});

const SINGLE_ARMY_CASES: BattleSetup[] = [
  { garrison: 76, attackers: [{ rifles: 6 }] },
  { garrison: 76, attackers: [{ rifles: 6, guns: 2 }] },
  { terrain: 'mountains', garrison: 76, attackers: [{ rifles: 6 }] },
  { garrison: 0, defenders: { rifles: 10 }, attackers: [{ rifles: 10 }] },
  { garrison: 0, defenders: { rifles: 10 }, attackers: [{ rifles: 14 }] },
  { terrain: 'urban', garrison: 238, ramparts: 1, attackers: [{ rifles: 12, guns: 4 }] },
  { terrain: 'urban', garrison: 351, ramparts: 1, defenders: { rifles: 8, hunters: 2 }, attackers: [{ rifles: 30, guns: 10, tanks: 6 }] },
  { garrison: 0, defenders: { hunters: 10 }, attackers: [{ tanks: 8 }] },
  { garrison: 40, defenders: { rifles: 6 }, defenderRetreatAt: 0.5, attackers: [{ rifles: 12 }], attackerRetreatAt: 0.25 },
];

describe('predictBattle', () => {
  it('equals resolveBattles with rolls of 1 when each side is one army', () => {
    for (const setup of SINGLE_ARMY_CASES) {
      const world = battleWorld(setup);
      const input = battleInputAt(world.sim, world.target)!;
      const prediction = predictBattle(input, world.n('me'), [], COMBAT.PREDICT_MAX_HOURS);
      rolls.fixed = true;
      const run = runBattle(world);
      rolls.fixed = false;
      expect(prediction.winner).toBe(run.captured ? 'attacker' : 'defender');
      expect(prediction.hours).toBe(run.hours);
      expect(prediction.attackerKeeps).toBeCloseTo(run.attackerKeeps, 9);
      // The forecast's defender figure counts the garrison; the armies-only figure matches without one.
      if (setup.garrison === 0) expect(prediction.defenderKeeps).toBeCloseTo(run.defenderKeeps, 9);
    }
  });

  it('reports losses by type and stops undecided at the hour cap', () => {
    const world = battleWorld({ garrison: 0, defenders: { rifles: 10 }, attackers: [{ rifles: 14 }] });
    const input = battleInputAt(world.sim, world.target)!;
    const prediction = predictBattle(input, world.n('me'), [], COMBAT.PREDICT_MAX_HOURS);
    expect(prediction.attackerLosses.rifles).toBeGreaterThan(0);
    expect(prediction.attackerLosses.tanks).toBeUndefined();
    const short = predictBattle(input, world.n('me'), [], 3);
    expect(short).toMatchObject({ winner: 'undecided', hours: 3 });
  });

  it('adds reinforcements at their hour', () => {
    const world = battleWorld({ garrison: 0, defenders: { rifles: 6 }, attackers: [{ rifles: 10 }] });
    const input = battleInputAt(world.sim, world.target)!;
    const alone = predictBattle(input, world.n('me'), [], COMBAT.PREDICT_MAX_HOURS);
    expect(alone.winner).toBe('attacker');
    const help = { ...input.defender, units: unitsFromCounts({ rifles: 12 }) };
    const held = predictBattle(input, world.n('me'), [{ atHour: 2, side: help }], COMBAT.PREDICT_MAX_HOURS);
    expect(held.winner).toBe('defender');
    const late = predictBattle(input, world.n('me'), [{ atHour: 80, side: help }], COMBAT.PREDICT_MAX_HOURS);
    expect(late.winner).toBe('attacker');
  });
});

describe('winChance', () => {
  const inputFor = (attack: UnitCounts): { input: BattleInput; me: NationIx } => {
    const world = battleWorld({ garrison: 60, defenders: { rifles: 10 }, attackers: [attack] });
    return { input: battleInputAt(world.sim, world.target)!, me: world.n('me') };
  };

  it('is deterministic for identical input and never touches state.rng', () => {
    const world = battleWorld({ garrison: 60, defenders: { rifles: 10 }, attackers: [{ rifles: 16 }] });
    const rng = world.sim.state.rng;
    const a = inputFor({ rifles: 16 });
    const b = inputFor({ rifles: 16 });
    const first = winChance(a.input, a.me, [], COMBAT.WIN_CHANCE_SAMPLES);
    expect(winChance(b.input, b.me, [], COMBAT.WIN_CHANCE_SAMPLES)).toBe(first);
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(1);
    expect(world.sim.state.rng).toBe(rng);
  });

  it('is monotone in attacker size', () => {
    let last = -1;
    for (let rifles = 10; rifles <= 24; rifles += 1) {
      const { input, me } = inputFor({ rifles });
      const chance = winChance(input, me, [], COMBAT.WIN_CHANCE_SAMPLES);
      expect(chance).toBeGreaterThanOrEqual(last);
      last = chance;
    }
    expect(last).toBe(1);
  });

  it('counts holding as a win for the defender', () => {
    const { input, me } = inputFor({ rifles: 16 });
    const attack = winChance(input, me, [], COMBAT.WIN_CHANCE_SAMPLES);
    expect(winChance(input, input.defender.nation, [], COMBAT.WIN_CHANCE_SAMPLES)).toBeCloseTo(1 - attack, 9);
  });
});

describe('verdictOf', () => {
  it('maps the bands', () => {
    expect(verdictOf(1)).toBe('decisive');
    expect(verdictOf(0.9)).toBe('decisive');
    expect(verdictOf(0.89)).toBe('likely');
    expect(verdictOf(0.7)).toBe('likely');
    expect(verdictOf(0.69)).toBe('close');
    expect(verdictOf(0.4)).toBe('close');
    expect(verdictOf(0.39)).toBe('unlikely');
    expect(verdictOf(0.1)).toBe('unlikely');
    expect(verdictOf(0.09)).toBe('hopeless');
    expect(verdictOf(0)).toBe('hopeless');
  });
});

describe('hypothetical battles', () => {
  /** me0 - x1 - x2 - x3 - t in a line; `def` holds x1..t. */
  const line = () =>
    tinySim({
      provinces: {
        me0: { owner: 'me', capitalOf: 'me' },
        x1: { owner: 'def', capitalOf: 'def' },
        x2: { owner: 'def' },
        x3: { owner: 'def' },
        t: { owner: 'def', garrison: 10 },
      },
      edges: [
        ['me0', 'x1'],
        ['x1', 'x2'],
        ['x2', 'x3'],
        ['x3', 't'],
      ],
      armies: [
        { owner: 'me', at: 'me0', units: { rifles: 10 } },
        { owner: 'def', at: 't', units: { rifles: 5 } },
      ],
      player: 'me',
    });

  it('counts the garrison regenerated to the arrival and, for the player, only visible armies', () => {
    const { sim, p, n } = line();
    refreshVision(sim);
    const arrival: Arrival = { nation: n('me'), units: unitsFromCounts({ rifles: 10 }), direction: p('x3'), landed: false, atHour: 5 };
    const seen = hypotheticalInput(sim, p('t'), [arrival], n('me'));
    expect(seen.fogged).toBe(true);
    expect(seen.input.defender.units.rifles.count).toBe(0);
    expect(seen.input.defender.garrison).toBeGreaterThan(10);
    expect(seen.input.defender.garrison).toBeLessThanOrEqual(garrisonCap(sim, p('t')));
    const all = hypotheticalInput(sim, p('t'), [arrival], null);
    expect(all.fogged).toBe(false);
    expect(all.input.defender.units.rifles.count).toBe(5);
    expect(all.input.attackers).toHaveLength(1);
    expect(all.input.attackers[0]!.directions).toBe(1);
  });

  it('later arrivals are reinforcements carrying their side’s directions once joined', () => {
    const { sim, p, n } = line();
    const units = unitsFromCounts({ rifles: 4 });
    const arrivals: Arrival[] = [
      { nation: n('me'), units, direction: p('x3'), landed: false, atHour: 3 },
      { nation: n('me'), units, direction: p('x2'), landed: true, atHour: 5 },
    ];
    const { input, reinforcements } = hypotheticalInput(sim, p('t'), arrivals, null);
    expect(input.attackers[0]!.units.rifles.count).toBe(4);
    expect(reinforcements).toHaveLength(1);
    expect(reinforcements[0]!.atHour).toBe(2);
    expect(reinforcements[0]!.side.directions).toBe(2);
    expect(reinforcements[0]!.side.landed.rifles).toBe(4 * UNITS.rifles.hp);
  });

  it('rounds are hourly: an army arriving within the hour fights in the next round', () => {
    const { sim } = line();
    sim.state.tick = 1;
    // Next round at tick 4. Arriving by tick 4 fights then; by tick 5, an hour later.
    expect(roundOffset(sim, 1)).toBe(0);
    expect(roundOffset(sim, 4)).toBe(0);
    expect(roundOffset(sim, 5)).toBe(1);
    expect(roundOffset(sim, 8)).toBe(1);
  });

  it('forecastPlans forecasts an order and leaves the game untouched', () => {
    const { sim, p, n, a } = line();
    sim.state.provinces[p('x1')]!.garrison = 0;
    const plans = planOrder(sim, n('me'), [a(0)], p('x1'), false);
    if (typeof plans === 'string') throw new Error(plans);
    const rng = sim.state.rng;
    const before = JSON.stringify(sim.state);
    const forecast = forecastPlans(sim, n('me'), p('x1'), plans)!;
    // The empty garrison regenerates until the army arrives, so there is a short fight.
    expect(forecast.winner).toBe('attacker');
    expect(forecast.verdict).toBe('decisive');
    expect(forecast.winChance).toBe(1);
    expect(sim.state.rng).toBe(rng);
    expect(JSON.stringify(sim.state)).toBe(before);
    const home = planOrder(sim, n('me'), [a(0)], p('me0'), false);
    if (typeof home === 'string') throw new Error(home);
    expect(forecastPlans(sim, n('me'), p('me0'), home)).toBeNull();
  });

  it('a garrison below GARRISON.EMPTY_BELOW does not defend', () => {
    const { sim, p, n } = line();
    sim.state.provinces[p('x2')]!.garrison = GARRISON.EMPTY_BELOW / 2;
    const arrival: Arrival = { nation: n('me'), units: unitsFromCounts({ rifles: 1 }), direction: asProvince(p('x1')), landed: false, atHour: 0 };
    const { input } = hypotheticalInput(sim, p('x2'), [arrival], null);
    expect(input.defender.garrison).toBe(0);
  });
});
