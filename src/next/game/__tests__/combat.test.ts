import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as RngModule from '../rng';
import { COMBAT, EFFECTS, GARRISON, MOVEMENT, SUPPLY, TERRAIN, UNITS } from '../balance';
import { armyById } from '../cache';
import { isHourStart } from '../clock';
import { battleInputAt, battleModifiers, frontageFactor, resolveBattles, roundDamage } from '../combat';
import { asNation, asProvince } from '../ids';
import { zeroUnitHp } from '../keys';
import { nextInRange } from '../rng';
import { TERRAINS, UNIT_TYPES } from '../types';
import type { BattleInput, BattleSide, Terrain, UnitCounts } from '../types';
import { totalHp, unitsFromCounts } from '../units';
import { assertInvariants, stateHash, tinySim } from './helpers';
import { battleWorld, runBattle, step, steps, type BattleSetup } from './steps';

/** Rolls pinned at 1 on demand: the §5.4 cases are defined with fixed rolls. */
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

// ------------------------------------------------------------ worked cases

interface WorkedCase {
  name: string;
  setup: BattleSetup;
  /** The spec's prototype figures (§5.4). */
  spec: { hours: number; keep: number; retreat?: boolean };
  /** This implementation's figures, frozen. */
  frozen: { hours: number; keep: number };
}

const split = (units: UnitCounts, parts: number): UnitCounts[] => {
  const out: UnitCounts[] = [];
  for (let i = 0; i < parts; i += 1) {
    const part: UnitCounts = {};
    for (const type of UNIT_TYPES) {
      const count = units[type] ?? 0;
      // Largest parts first, so the split is the same every run.
      part[type] = Math.floor(count / parts) + (i < count % parts ? 1 : 0);
    }
    out.push(part);
  }
  return out;
};

const CASES: WorkedCase[] = [
  { name: '6 Rifles vs a median 76 HP garrison, plains', setup: { garrison: 76, attackers: [{ rifles: 6 }] }, spec: { hours: 10, keep: 0.75 }, frozen: { hours: 10, keep: 0.7524 } },
  { name: '6 Rifles + 2 Field Guns, same', setup: { garrison: 76, attackers: [{ rifles: 6, guns: 2 }] }, spec: { hours: 5, keep: 0.9 }, frozen: { hours: 5, keep: 0.8961 } },
  { name: '6 Rifles vs 76 HP, mountains', setup: { terrain: 'mountains', garrison: 76, attackers: [{ rifles: 6 }] }, spec: { hours: 11, keep: 0.62 }, frozen: { hours: 11, keep: 0.6184 } },
  { name: '10 Rifles attack 10 Rifles, plains', setup: { garrison: 0, defenders: { rifles: 10 }, attackers: [{ rifles: 10 }] }, spec: { hours: 9, keep: 0.55, retreat: true }, frozen: { hours: 9, keep: 0.5543 } },
  { name: '14 Rifles attack 10 Rifles, plains', setup: { garrison: 0, defenders: { rifles: 10 }, attackers: [{ rifles: 14 }] }, spec: { hours: 14, keep: 0.54 }, frozen: { hours: 14, keep: 0.5369 } },
  { name: '16 Rifles attack 10 Rifles', setup: { garrison: 0, defenders: { rifles: 10 }, attackers: [{ rifles: 16 }] }, spec: { hours: 11, keep: 0.66 }, frozen: { hours: 11, keep: 0.6648 } },
  {
    name: 'Brussels garrison vs 12 Rif + 4 Gun, 1 direction',
    setup: { terrain: 'urban', garrison: 238, ramparts: 1, attackers: [{ rifles: 12, guns: 4 }] },
    spec: { hours: 10, keep: 0.56 },
    frozen: { hours: 9, keep: 0.565 },
  },
  {
    name: 'Brussels, 2 directions',
    setup: { terrain: 'urban', garrison: 238, ramparts: 1, attackers: split({ rifles: 12, guns: 4 }, 2) },
    spec: { hours: 8, keep: 0.6 },
    frozen: { hours: 8, keep: 0.6074 },
  },
  {
    name: 'Paris-like capital vs 30 Rif + 10 Gun + 6 Tnk, 1 direction',
    setup: { terrain: 'urban', garrison: 351, ramparts: 1, defenders: { rifles: 8, hunters: 2 }, attackers: [{ rifles: 30, guns: 10, tanks: 6 }] },
    spec: { hours: 14, keep: 0.58 },
    frozen: { hours: 14, keep: 0.5815 },
  },
  {
    name: 'Paris-like capital, 3 directions',
    setup: { terrain: 'urban', garrison: 351, ramparts: 1, defenders: { rifles: 8, hunters: 2 }, attackers: split({ rifles: 30, guns: 10, tanks: 6 }, 3) },
    spec: { hours: 6, keep: 0.78 },
    frozen: { hours: 6, keep: 0.7825 },
  },
  { name: '60 Rifles attack 25 Rifles, 1 direction', setup: { garrison: 0, defenders: { rifles: 25 }, attackers: [{ rifles: 60 }] }, spec: { hours: 12, keep: 0.75 }, frozen: { hours: 12, keep: 0.7475 } },
  { name: '60 Rifles attack 25 Rifles, 2 directions', setup: { garrison: 0, defenders: { rifles: 25 }, attackers: split({ rifles: 60 }, 2) }, spec: { hours: 7, keep: 0.84 }, frozen: { hours: 7, keep: 0.8383 } },
  { name: '8 Tanks attack 10 Rifles, plains', setup: { garrison: 0, defenders: { rifles: 10 }, attackers: [{ tanks: 8 }] }, spec: { hours: 8, keep: 0.89 }, frozen: { hours: 8, keep: 0.8879 } },
  { name: '8 Tanks attack 10 Rifles, mountains', setup: { terrain: 'mountains', garrison: 0, defenders: { rifles: 10 }, attackers: [{ tanks: 8 }] }, spec: { hours: 16, keep: 0.7 }, frozen: { hours: 16, keep: 0.7015 } },
  { name: '8 Tanks attack 10 Tank Hunters, plains', setup: { garrison: 0, defenders: { hunters: 10 }, attackers: [{ tanks: 8 }] }, spec: { hours: 11, keep: 0.41 }, frozen: { hours: 11, keep: 0.4123 } },
];

describe('§5.4 worked cases (rolls fixed at 1, attackers retreat at 35%)', () => {
  for (const c of CASES) {
    it(c.name, () => {
      rolls.fixed = true;
      const world = battleWorld(c.setup);
      const run = runBattle(world);
      const keep = c.spec.retreat === true ? run.defenderKeeps : run.attackerKeeps;
      expect(run.captured).toBe(c.spec.retreat !== true);
      // Frozen implementation values...
      expect(run.hours).toBe(c.frozen.hours);
      expect(keep).toBeCloseTo(c.frozen.keep, 4);
      // ...which stay within 1 round and 2 points of the prototype.
      expect(Math.abs(run.hours - c.spec.hours)).toBeLessThanOrEqual(1);
      expect(Math.abs(keep - c.spec.keep)).toBeLessThanOrEqual(0.02);
      assertInvariants(world.sim);
    });
  }

  it('attacking from more directions is faster and cheaper', () => {
    const byName = (name: string): WorkedCase => CASES.find((c) => c.name === name)!;
    for (const [one, many] of [
      ['Brussels garrison vs 12 Rif + 4 Gun, 1 direction', 'Brussels, 2 directions'],
      ['Paris-like capital vs 30 Rif + 10 Gun + 6 Tnk, 1 direction', 'Paris-like capital, 3 directions'],
      ['60 Rifles attack 25 Rifles, 1 direction', '60 Rifles attack 25 Rifles, 2 directions'],
    ] as const) {
      expect(byName(many).frozen.hours).toBeLessThan(byName(one).frozen.hours);
      expect(byName(many).frozen.keep).toBeGreaterThan(byName(one).frozen.keep);
    }
  });
});

// ------------------------------------------------------------ the round

function side(nation: number, role: 'attacker' | 'defender', counts: UnitCounts, extra: Partial<BattleSide> = {}): BattleSide {
  return {
    nation: asNation(nation),
    role,
    units: unitsFromCounts(counts),
    landed: zeroUnitHp(),
    garrison: 0,
    directions: 1,
    supplied: true,
    oilShort: false,
    ...extra,
  };
}

function input(defender: BattleSide, attackers: BattleSide[], terrain: Terrain = 'plains', ramparts = 0, totalDirections = 1): BattleInput {
  return { ctx: { province: asProvince(0), terrain, ramparts, totalDirections }, defender, attackers };
}

const lossOf = (hp: Record<string, number>): number => Object.values(hp).reduce((s, v) => s + v, 0);
const S = COMBAT.DAMAGE_SCALE;

describe('roundDamage', () => {
  it('routes soft damage to soft pools and hard damage to Tanks, by their shares of side HP', () => {
    const d = side(0, 'defender', { rifles: 5, tanks: 5 });
    const a = side(1, 'attacker', { rifles: 10 });
    const [intoD] = roundDamage(input(d, [a]), [1, 1]).losses;
    const sideHp = 5 * 20 + 5 * 36;
    // 10 attacking Rifles: soft 30, hard 10 per hour before scaling.
    expect(intoD!.hp.rifles).toBeCloseTo(S * (100 / sideHp) * 30, 9);
    expect(intoD!.hp.tanks).toBeCloseTo(S * (180 / sideHp) * 10, 9);
    expect(intoD!.hp.guns + intoD!.hp.hunters + intoD!.hp.motor).toBe(0);
  });

  it('spreads soft damage by HP × exposure, so Field Guns are shielded', () => {
    const d = side(0, 'defender', { rifles: 5, guns: 5 });
    const a = side(1, 'attacker', { rifles: 10 });
    const [intoD] = roundDamage(input(d, [a]), [1, 1]).losses;
    const weightRifles = 100 * UNITS.rifles.exposure;
    const weightGuns = 70 * UNITS.guns.exposure;
    expect(UNITS.guns.exposure).toBe(0.5);
    expect(intoD!.hp.guns / intoD!.hp.rifles).toBeCloseTo(weightGuns / weightRifles, 9);
    expect(lossOf(intoD!.hp)).toBeCloseTo(S * 30, 9);
  });

  it('Field Guns deal ×1.5 to the garrison and ignore the Ramparts reduction', () => {
    const garrison = 400;
    const guns = roundDamage(input(side(0, 'defender', {}, { garrison }), [side(1, 'attacker', { guns: 4 })], 'plains', 2), [1, 1]).losses[0]!;
    const rifles = roundDamage(input(side(0, 'defender', {}, { garrison }), [side(1, 'attacker', { rifles: 8 })], 'plains', 2), [1, 1]).losses[0]!;
    expect(guns.garrison).toBeCloseTo(S * 4 * UNITS.guns.attack.soft * UNITS.guns.vsGarrison, 9);
    expect(rifles.garrison).toBeCloseTo(S * 8 * UNITS.rifles.attack.soft * (1 - 2 * EFFECTS.RAMPARTS_PROTECTION_PER_LEVEL), 9);
  });

  it('the garrison fights as soft militia at GARRISON.DEFENCE per unit-equivalent', () => {
    const d = side(0, 'defender', {}, { garrison: 100 });
    const a = side(1, 'attacker', { rifles: 5, tanks: 5 });
    const [, intoA] = roundDamage(input(d, [a]), [1, 1]).losses;
    const ue = 100 / GARRISON.HP_PER_UNIT;
    const hp = 100 + 180;
    expect(intoA!.hp.rifles).toBeCloseTo(S * ue * GARRISON.DEFENCE.soft * (100 / hp), 9);
    expect(intoA!.hp.tanks).toBeCloseTo(S * ue * GARRISON.DEFENCE.hard * (180 / hp), 9);
  });

  it('applies every modifier', () => {
    const base = (): number => lossOf(roundDamage(input(side(0, 'defender', { rifles: 10 }), [side(1, 'attacker', { rifles: 10 })]), [1, 1]).losses[1]!.hp);
    const intoAttacker = (d: BattleSide, a: BattleSide, terrain: Terrain = 'plains', ramparts = 0): number =>
      lossOf(roundDamage(input(d, [a], terrain, ramparts), [1, 1]).losses[1]!.hp);
    const intoDefender = (d: BattleSide, a: BattleSide, terrain: Terrain = 'plains', ramparts = 0): number =>
      lossOf(roundDamage(input(d, [a], terrain, ramparts), [1, 1]).losses[0]!.hp);
    const ten = { rifles: 10 };
    expect(base()).toBeCloseTo(S * 40, 9);
    // Terrain: the defender deals ×defence (frontage is not binding at 10 units).
    expect(intoAttacker(side(0, 'defender', ten), side(1, 'attacker', ten), 'mountains')).toBeCloseTo(S * 40 * TERRAIN.mountains.defence, 9);
    // Ramparts: the owner deals +20% and takes 12% less per level.
    expect(intoAttacker(side(0, 'defender', ten), side(1, 'attacker', ten), 'plains', 1)).toBeCloseTo(S * 40 * 1.2, 9);
    expect(intoDefender(side(0, 'defender', ten), side(1, 'attacker', ten), 'plains', 1)).toBeCloseTo(S * 30 * 0.88, 9);
    // Out of supply.
    expect(intoDefender(side(0, 'defender', ten), side(1, 'attacker', ten, { supplied: false }))).toBeCloseTo(S * 30 * SUPPLY.UNSUPPLIED_DAMAGE, 9);
    // Landing: landed units count ×0.75.
    const landed = side(1, 'attacker', ten, { landed: { ...zeroUnitHp(), rifles: 200 } });
    expect(intoDefender(side(0, 'defender', ten), landed)).toBeCloseTo(S * 30 * COMBAT.LANDING_ATTACK, 9);
    // Oil shortage: Oil users ×0.7; Rifles are unaffected.
    const motor = { motor: 10 };
    const dry = intoDefender(side(0, 'defender', ten), side(1, 'attacker', motor, { oilShort: true }));
    expect(dry).toBeCloseTo(intoDefender(side(0, 'defender', ten), side(1, 'attacker', motor)) * 0.7, 9);
    expect(intoDefender(side(0, 'defender', ten), side(1, 'attacker', ten, { oilShort: true }))).toBeCloseTo(S * 30, 9);
    // Tanks by terrain, both roles.
    const tanks = { tanks: 4 };
    const plains = intoDefender(side(0, 'defender', ten), side(1, 'attacker', tanks), 'plains');
    const urban = intoDefender(side(0, 'defender', ten), side(1, 'attacker', tanks), 'urban');
    expect(urban / plains).toBeCloseTo(TERRAIN.urban.tanks / TERRAIN.plains.tanks, 9);
  });

  it('labels each modifier that applies', () => {
    const d = side(0, 'defender', { rifles: 10, tanks: 2 }, { garrison: 50, supplied: false });
    const a = side(1, 'attacker', { rifles: 40, guns: 4, motor: 2 }, { directions: 2, oilShort: true, landed: { ...zeroUnitHp(), rifles: 100 } });
    const codes = battleModifiers(input(d, [a], 'mountains', 1, 2)).map((m) => `${m.side}:${m.code}`);
    expect(codes).toEqual([
      'defender:terrain',
      'defender:ramparts',
      'attacker:flank',
      'attacker:frontage',
      'attacker:landing',
      'defender:unsupplied',
      'defender:tankTerrain',
      'attacker:oilShort',
      'attacker:gunsVsGarrison',
    ]);
    expect(battleModifiers(input(side(0, 'defender', { rifles: 5 }), [side(1, 'attacker', { rifles: 5 })]))).toEqual([]);
  });

  it('frontage per terrain: only TERRAIN.frontage unit-equivalents fight at full effect', () => {
    for (const terrain of TERRAINS) {
      // 60 Rifles against a garrison alone: the garrison takes everything the engaged share delivers.
      const delivered = roundDamage(input(side(0, 'defender', {}, { garrison: 10_000 }), [side(1, 'attacker', { rifles: 60 })], terrain), [1, 1]).losses[0]!.garrison;
      expect(delivered).toBeCloseTo(S * 60 * UNITS.rifles.attack.soft * Math.min(1, TERRAIN[terrain].frontage / 60), 9);
    }
    expect(frontageFactor(10, 30)).toBe(1);
    expect(frontageFactor(60, 30)).toBe(0.5);
  });

  it('caps flanking: frontage ×2 and damage +20% for attackers, frontage ×1.5 for the defender', () => {
    const delivered = (dirs: number): number =>
      roundDamage(input(side(0, 'defender', {}, { garrison: 10_000 }), [side(1, 'attacker', { rifles: 120 }, { directions: dirs })]), [1, 1]).losses[0]!.garrison;
    const one = delivered(1);
    expect(delivered(2) / one).toBeCloseTo(1.5 * 1.1, 9);
    expect(delivered(3) / one).toBeCloseTo(2 * 1.2, 9);
    expect(delivered(5)).toBeCloseTo(delivered(3), 9);
    const defending = (total: number): number =>
      lossOf(roundDamage(input(side(0, 'defender', { rifles: 120 }), [side(1, 'attacker', { rifles: 10 })], 'plains', 0, total), [1, 1]).losses[1]!.hp);
    expect(defending(2) / defending(1)).toBeCloseTo(1.25, 9);
    expect(defending(3) / defending(1)).toBeCloseTo(1.5, 9);
    expect(defending(6)).toBeCloseTo(defending(3), 9);
  });

  it('splits the defender output across attackers by HP; attackers never damage each other', () => {
    const d = side(0, 'defender', { rifles: 10 });
    const big = side(1, 'attacker', { rifles: 12 });
    const small = side(2, 'attacker', { rifles: 4 });
    const result = roundDamage(input(d, [big, small]), [1, 1, 1]);
    const intoBig = lossOf(result.losses[1]!.hp);
    const intoSmall = lossOf(result.losses[2]!.hp);
    expect(intoBig / intoSmall).toBeCloseTo(3, 9);
    // All the attackers' losses come from the defender's output alone.
    expect(intoBig + intoSmall).toBeCloseTo(S * 40, 9);
    expect(result.losses[0]!.dealt).toBeCloseTo(intoBig + intoSmall, 9);
    expect(result.losses[1]!.dealt / result.losses[2]!.dealt).toBeCloseTo(3, 9);
  });

  it('caps losses at the pool and wipes a pool left below 0.5 HP', () => {
    const d = side(0, 'defender', { rifles: 1 }, { garrison: 1 });
    const a = side(1, 'attacker', { rifles: 30 });
    const [intoD] = roundDamage(input(d, [a]), [1.15, 1.15]).losses;
    expect(intoD!.hp.rifles).toBe(20);
    expect(intoD!.garrison).toBe(1);
  });
});

// ------------------------------------------------------------ the battle phase

describe('resolveBattles', () => {
  it('the strongest attacker captures, and the next attacker then fights the new owner', () => {
    const { sim, p, n } = tinySim({
      provinces: {
        home: { owner: 'me', capitalOf: 'me' },
        t: { owner: 'def', garrison: 1 },
        d0: { owner: 'def', capitalOf: 'def' },
        x: { owner: 'xx' },
      },
      edges: [
        ['home', 't'],
        ['t', 'd0'],
        ['t', 'x'],
      ],
      armies: [
        { owner: 'me', at: 't', units: { rifles: 4 } },
        { owner: 'xx', at: 't', units: { rifles: 10 } },
      ],
      player: 'me',
    });
    rolls.fixed = true;
    step(sim);
    expect(sim.state.provinces[p('t')]!.owner).toBe(n('xx'));
    expect(sim.state.provinces[p('t')]!.battleSince).not.toBeNull();
    expect(sim.cache.battles).toEqual([p('t')]);
    const mine = sim.state.armies.find((a) => a.owner === n('me'))!;
    const theirs = sim.state.armies.find((a) => a.owner === n('xx'))!;
    const before = totalHp(mine.units);
    steps(sim, 4);
    // Now xx defends: my army takes the defender's fire and theirs takes mine.
    expect(totalHp(mine.units)).toBeLessThan(before);
    expect(battleInputAt(sim, p('t'))?.defender.nation).toBe(n('xx'));
    expect(theirs.battle).not.toBeNull();
    assertInvariants(sim);
  });

  it('an attacker below its threshold falls back where it came from and pays the disengage cost', () => {
    rolls.fixed = true;
    const world = battleWorld({ garrison: 0, defenders: { rifles: 10 }, attackers: [{ rifles: 10 }] });
    const { sim } = world;
    const army = sim.state.armies.find((a) => a.owner === world.n('me'))!;
    let afterRound = 0;
    while (army.intent !== 'retreat') {
      if (isHourStart(sim.state.tick)) {
        const round = roundDamage(battleInputAt(sim, world.target)!, [1, 1]);
        afterRound = totalHp(army.units) - lossOf(round.losses[1]!.hp);
      }
      step(sim);
    }
    expect(afterRound).toBeLessThan(COMBAT.AI_RETREAT_AT * 10 * UNITS.rifles.hp);
    expect(totalHp(army.units)).toBeCloseTo(afterRound * (1 - MOVEMENT.DISENGAGE_HP_LOSS), 6);
    expect(army.battle).toBeNull();
    expect(army.path).toEqual([world.p('a0')]);
    expect(sim.cache.battleLog.has(world.target)).toBe(false);
    step(sim);
    expect(army.leg?.to).toBe(world.p('a0'));
    expect(sim.state.feed.some((e) => e.kind === 'retreated' && e.army === army.id)).toBe(true);
    assertInvariants(sim);
  });

  it('the garrison never leaves: defender armies retreat and the garrison fights on', () => {
    rolls.fixed = true;
    const world = battleWorld({ garrison: 200, defenders: { rifles: 4 }, defenderRetreatAt: 0.99, attackers: [{ rifles: 10 }], attackerRetreatAt: 0 });
    const { sim, target } = world;
    step(sim);
    const defender = sim.state.armies.find((a) => a.owner === world.n('def'))!;
    expect(defender.intent).toBe('retreat');
    expect(defender.path).toEqual([world.p('d0')]);
    step(sim);
    expect(defender.leg?.to).toBe(world.p('d0'));
    expect(sim.state.provinces[target]!.owner).toBe(world.n('def'));
    expect(sim.state.provinces[target]!.battleSince).not.toBeNull();
    steps(sim, 3);
    expect(sim.state.provinces[target]!.garrison).toBeGreaterThan(0);
    expect(sim.cache.battles).toEqual([target]);
  });

  it('removes destroyed armies and reports them', () => {
    rolls.fixed = true;
    const world = battleWorld({ garrison: 0, defenders: { rifles: 1 }, attackers: [{ rifles: 30 }] });
    const { sim, target } = world;
    const doomed = sim.state.armies.find((a) => a.owner === world.n('def'))!;
    step(sim);
    expect(doomed.alive).toBe(false);
    expect(armyById(sim, doomed.id)).toBeUndefined();
    expect(sim.state.provinces[target]!.owner).toBe(world.n('me'));
    expect(sim.state.stats.enemyUnitsDestroyed).toBe(1);
    expect(sim.state.feed.some((e) => e.kind === 'armyDestroyed' && e.army === doomed.id)).toBe(true);
    expect(sim.state.stats.attacksWon).toBe(1);
  });

  it('a fixed seed reproduces the battle; another seed does not', () => {
    const run = (seed: string): string => {
      const world = battleWorld({ garrison: 120, defenders: { rifles: 8 }, attackers: [{ rifles: 12, guns: 2 }], seed });
      steps(world.sim, 40);
      return stateHash(world.sim);
    };
    expect(run('alpha')).toBe(run('alpha'));
    expect(run('alpha')).not.toBe(run('beta'));
  });

  it('draws one roll per side per battle: provinces ascending, defender first, then attackers in order', () => {
    const { sim, p, n } = tinySim({
      provinces: {
        a: { owner: 'aa', capitalOf: 'aa' },
        b: { owner: 'bb', capitalOf: 'bb' },
        t1: { owner: 'dd', garrison: 100 },
        t2: { owner: 'dd', garrison: 100 },
        d: { owner: 'dd', capitalOf: 'dd' },
      },
      edges: [
        ['a', 't1'],
        ['b', 't1'],
        ['a', 't2'],
        ['t1', 'd'],
        ['t2', 'd'],
      ],
      armies: [
        { owner: 'bb', at: 't1', units: { rifles: 5 } },
        { owner: 'aa', at: 't1', units: { rifles: 5 } },
        { owner: 'aa', at: 't2', units: { rifles: 5 } },
      ],
      player: 'aa',
    });
    const inputs = [battleInputAt(sim, p('t1'))!, battleInputAt(sim, p('t2'))!];
    let state = sim.state.rng;
    const draws: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const r = nextInRange(state, COMBAT.ROLL_MIN, COMBAT.ROLL_MAX);
      draws.push(r.value);
      state = r.state;
    }
    const expected1 = roundDamage(inputs[0]!, draws.slice(0, 3));
    const expected2 = roundDamage(inputs[1]!, draws.slice(3, 5));
    expect(inputs[0]!.attackers.map((a) => a.nation)).toEqual([n('aa'), n('bb')]);
    resolveBattles(sim);
    expect(sim.state.rng).toBe(state);
    expect(sim.state.provinces[p('t1')]!.garrison).toBeCloseTo(100 - expected1.losses[0]!.garrison, 9);
    expect(sim.state.provinces[p('t2')]!.garrison).toBeCloseTo(100 - expected2.losses[0]!.garrison, 9);
    const bb = sim.state.armies.find((a) => a.owner === n('bb'))!;
    expect(20 * 5 - totalHp(bb.units)).toBeCloseTo(lossOf(expected1.losses[2]!.hp), 9);
  });

  it('keeps the last rounds in the battle log', () => {
    const world = battleWorld({ garrison: 10_000, attackers: [{ rifles: 200 }], attackerRetreatAt: 0 });
    steps(world.sim, 4 * (COMBAT.LOG_ROUNDS + 5));
    const log = world.sim.cache.battleLog.get(world.target)!;
    expect(log).toHaveLength(COMBAT.LOG_ROUNDS);
    expect(log[log.length - 1]!.sides[0]!.nation).toBe(world.n('def'));
  });
});
