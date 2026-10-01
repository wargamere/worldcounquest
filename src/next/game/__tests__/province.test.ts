import { describe, expect, it } from 'vitest';
import { GARRISON, PROVINCE, REVOLT, TIME } from '../balance';
import { setOwner } from '../cache';
import { nextRandom } from '../rng';
import {
  dailyProvinces,
  garrisonAt,
  garrisonCap,
  hourlyProvinces,
  onCaptured,
  rollRevolts,
  stabilityFactor,
  statusOf,
} from '../province';
import type { TinyArmy } from './helpers';
import { tinySim } from './helpers';

const HOURS_PER_DAY = TIME.TICKS_PER_DAY / TIME.TICKS_PER_HOUR;

function hours(run: () => void, count: number): void {
  for (let i = 0; i < count; i += 1) run();
}

/**
 * me holds home (its capital), occ (taken from foe, which is alive) and gone
 * (from ch, which no longer exists). foe holds its capital fc.
 */
function world() {
  return tinySim({
    provinces: {
      home: { owner: 'me', capitalOf: 'me' },
      occ: { owner: 'me', country: 'foe', stability: 60 },
      gone: { owner: 'me', country: 'ch', stability: 60 },
      fc: { owner: 'foe', capitalOf: 'foe' },
    },
    edges: [
      ['home', 'occ'],
      ['home', 'gone'],
      ['occ', 'fc'],
    ],
  });
}

describe('status', () => {
  it('follows the table: home, occupied, integrated, and liberation makes it home again', () => {
    const { sim, p, n } = world();
    expect(statusOf(sim, p('home'))).toBe('home');
    expect(statusOf(sim, p('occ'))).toBe('occupied');
    sim.state.provinces[p('gone')]!.integrated = true;
    expect(statusOf(sim, p('gone'))).toBe('integrated');
    setOwner(sim, p('occ'), n('foe'));
    onCaptured(sim, p('occ'), PROVINCE.STABILITY_ON_LIBERATION);
    expect(statusOf(sim, p('occ'))).toBe('home');
  });
});

describe('stability', () => {
  it('scales output from 0.4 at 0 to 1 at 100', () => {
    expect(stabilityFactor(0)).toBe(0.4);
    expect(stabilityFactor(50)).toBeCloseTo(0.7, 12);
    expect(stabilityFactor(100)).toBe(1);
  });

  it('drifts 5 points a day toward the status target and never overshoots', () => {
    const { sim, p } = world();
    sim.state.provinces[p('home')]!.stability = 90;
    sim.state.provinces[p('occ')]!.stability = PROVINCE.STABILITY_ON_CAPTURE;
    sim.state.provinces[p('gone')]!.integrated = true;
    sim.state.provinces[p('gone')]!.stability = 100;
    hours(() => hourlyProvinces(sim), HOURS_PER_DAY);
    expect(sim.state.provinces[p('home')]!.stability).toBeCloseTo(95, 9);
    expect(sim.state.provinces[p('occ')]!.stability).toBeCloseTo(30, 9);
    expect(sim.state.provinces[p('gone')]!.stability).toBeCloseTo(95, 9);
    hours(() => hourlyProvinces(sim), 10 * HOURS_PER_DAY);
    expect(sim.state.provinces[p('home')]!.stability).toBe(PROVINCE.STABILITY_TARGET.home);
    expect(sim.state.provinces[p('occ')]!.stability).toBe(PROVINCE.STABILITY_TARGET.occupied);
    expect(sim.state.provinces[p('gone')]!.stability).toBe(PROVINCE.STABILITY_TARGET.integrated);
  });

  it('loses 3 per combat hour and 2 a day in every province while Food is short', () => {
    const { sim, p, n } = tinySim({
      provinces: { a: { owner: 'me' }, b: { owner: 'me', stability: 50 }, f: { owner: 'foe' } },
      edges: [
        ['a', 'b'],
        ['a', 'f'],
      ],
      armies: [{ owner: 'foe', at: 'a', units: { rifles: 2 } }],
    });
    expect(sim.cache.battles).toEqual([p('a')]);
    const drift = PROVINCE.STABILITY_DRIFT_PER_DAY / HOURS_PER_DAY;
    hourlyProvinces(sim);
    expect(sim.state.provinces[p('a')]!.stability).toBeCloseTo(100 + PROVINCE.STABILITY_PER_BATTLE_HOUR + drift, 12);
    expect(sim.state.provinces[p('b')]!.stability).toBeCloseTo(50 + drift, 12);

    sim.state.nations[n('me')]!.shortage.food = true;
    hourlyProvinces(sim);
    const hunger = PROVINCE.STABILITY_HUNGER_PER_DAY / HOURS_PER_DAY;
    expect(sim.state.provinces[p('b')]!.stability).toBeCloseTo(50 + 2 * drift + hunger, 12);
    // The foe is not short: its province stays where it was.
    expect(sim.state.provinces[p('f')]!.stability).toBe(100);
  });

  it('does not count the capture hour as a combat hour once the battle is over', () => {
    const { sim, p, n } = tinySim({
      provinces: { a: { owner: 'me' }, f: { owner: 'foe' } },
      edges: [['a', 'f']],
      armies: [{ owner: 'foe', at: 'a', units: { rifles: 2 } }],
    });
    // captureProvince in this hour's round: new owner, battle over, index not yet rebuilt.
    setOwner(sim, p('a'), n('foe'));
    onCaptured(sim, p('a'), PROVINCE.STABILITY_ON_CAPTURE);
    sim.state.provinces[p('a')]!.battleSince = null;
    hourlyProvinces(sim);
    const drift = PROVINCE.STABILITY_DRIFT_PER_DAY / HOURS_PER_DAY;
    expect(sim.state.provinces[p('a')]!.stability).toBeCloseTo(PROVINCE.STABILITY_ON_CAPTURE + drift, 12);
  });
});

describe('garrison', () => {
  it('caps by status and Ramparts', () => {
    const { sim, p } = tinySim({
      provinces: {
        h: { owner: 'me', buildings: { ramparts: 2 } },
        o: { owner: 'me', country: 'x' },
        i: { owner: 'me', country: 'y' },
        xc: { owner: 'x' },
      },
      edges: [
        ['h', 'o'],
        ['o', 'i'],
        ['i', 'xc'],
      ],
    });
    sim.state.provinces[p('i')]!.integrated = true;
    const base = (key: string) => sim.map.provinces[p(key)]!.garrisonBase;
    expect(garrisonCap(sim, p('h'))).toBeCloseTo(base('h') * 1.5, 12);
    expect(garrisonCap(sim, p('o'))).toBeCloseTo(base('o') * PROVINCE.GARRISON.occupied, 12);
    expect(garrisonCap(sim, p('i'))).toBeCloseTo(base('i') * PROVINCE.GARRISON.integrated, 12);
  });

  it('regenerates 20% of cap a day times the stability factor, up to the cap, and garrisonAt predicts it', () => {
    const { sim, p } = tinySim({
      provinces: { a: { owner: 'me', garrison: 0 }, b: { owner: 'me', garrison: 0, stability: 50 } },
      edges: [['a', 'b']],
    });
    const cap = garrisonCap(sim, p('a'));
    const predicted = garrisonAt(sim, p('a'), 10);
    hours(() => hourlyProvinces(sim), 10);
    expect(sim.state.provinces[p('a')]!.garrison).toBeCloseTo((cap * GARRISON.REGEN_SHARE_PER_DAY * 10) / HOURS_PER_DAY, 9);
    expect(predicted).toBeCloseTo(sim.state.provinces[p('a')]!.garrison, 9);
    // b started at stability 50 and drifts up, so it regenerates a little more than 0.7x.
    const b = sim.state.provinces[p('b')]!.garrison;
    const capB = garrisonCap(sim, p('b'));
    expect(b).toBeGreaterThan((0.7 * capB * GARRISON.REGEN_SHARE_PER_DAY * 10) / HOURS_PER_DAY);
    expect(b).toBeLessThan((0.75 * capB * GARRISON.REGEN_SHARE_PER_DAY * 10) / HOURS_PER_DAY);
    hours(() => hourlyProvinces(sim), 6 * HOURS_PER_DAY);
    expect(sim.state.provinces[p('a')]!.garrison).toBe(cap);
    expect(garrisonAt(sim, p('a'), 50)).toBe(cap);
  });

  it('does not regenerate while contested', () => {
    const { sim, p } = tinySim({
      provinces: { a: { owner: 'me', garrison: 10 }, f: { owner: 'foe' } },
      edges: [['a', 'f']],
      armies: [{ owner: 'foe', at: 'a', units: { rifles: 1 } }],
    });
    expect(garrisonAt(sim, p('a'), 12)).toBe(10);
    hours(() => hourlyProvinces(sim), 12);
    expect(sim.state.provinces[p('a')]!.garrison).toBe(10);
  });

  it('is emptied on capture along with the queue, construction and rally', () => {
    const { sim, p, n } = world();
    const province = sim.state.provinces[p('occ')]!;
    province.queue.push({ unit: 'rifles', hoursLeft: 3, hoursTotal: 6, paid: { funds: 120 }, started: true });
    province.construction = { building: 'works', level: 1, hoursLeft: 4, hoursTotal: 12, paid: { funds: 400, steel: 30 } };
    province.rally = p('home');
    province.keepTraining = true;
    province.integrated = true;
    sim.state.tick = 77;
    setOwner(sim, p('occ'), n('foe'));
    onCaptured(sim, p('occ'), 40);
    expect(province).toMatchObject({ garrison: 0, stability: 40, heldSince: 77, integrated: false, queue: [], construction: null, rally: null, keepTraining: false });
    expect(sim.cache.incomeDirty[n('foe')]).toBe(true);
  });
});

describe('integration', () => {
  it('needs 45 days held and the original nation dead', () => {
    const { sim, p, n } = world();
    const heldTicks = PROVINCE.INTEGRATION_DAYS * TIME.TICKS_PER_DAY;
    sim.state.tick = heldTicks - TIME.TICKS_PER_DAY;
    dailyProvinces(sim);
    expect(sim.state.provinces[p('gone')]!.integrated).toBe(false);
    sim.cache.incomeDirty[n('me')] = false;
    sim.state.tick = heldTicks;
    dailyProvinces(sim);
    expect(sim.state.provinces[p('gone')]!.integrated).toBe(true);
    expect(statusOf(sim, p('gone'))).toBe('integrated');
    expect(sim.cache.incomeDirty[n('me')]).toBe(true);
    expect(sim.state.feed[0]).toMatchObject({ kind: 'integrated', province: p('gone') });
    // foe fights on: its old province never integrates.
    sim.state.tick = 10 * heldTicks;
    dailyProvinces(sim);
    expect(sim.state.provinces[p('occ')]!.integrated).toBe(false);
  });

  it('counts from the last change of hands', () => {
    const { sim, p } = world();
    sim.state.provinces[p('gone')]!.heldSince = TIME.TICKS_PER_DAY;
    sim.state.tick = PROVINCE.INTEGRATION_DAYS * TIME.TICKS_PER_DAY;
    dailyProvinces(sim);
    expect(sim.state.provinces[p('gone')]!.integrated).toBe(false);
  });
});

describe('revolts', () => {
  /** An occupied province below the revolt threshold, its original nation alive. */
  function unrest(seed: string, armies: TinyArmy[] = []) {
    return tinySim({
      provinces: {
        home: { owner: 'me' },
        occ: { owner: 'me', country: 'foe', stability: 10 },
        fc: { owner: 'foe' },
      },
      edges: [
        ['home', 'occ'],
        ['occ', 'fc'],
      ],
      armies,
      seed,
    });
  }

  it('rolls once per eligible province per hour on state.rng, and matches the seeded stream', () => {
    const { sim, p } = unrest('revolt-a');
    let rng = sim.state.rng;
    const expected: number[] = [];
    const got: number[] = [];
    for (let hour = 0; hour < 4000; hour += 1) {
      const draw = nextRandom(rng);
      rng = draw.state;
      if (draw.value < REVOLT.CHANCE_PER_HOUR) expected.push(hour);
      if (rollRevolts(sim).includes(p('occ'))) got.push(hour);
      expect(sim.state.rng).toBe(rng);
    }
    expect(got).toEqual(expected);
    // About 0.2% an hour.
    expect(got.length).toBeGreaterThan(2);
    expect(got.length).toBeLessThan(20);
  });

  it('is deterministic for a seed', () => {
    const run = (seed: string) => {
      const { sim } = unrest(seed);
      const out: number[] = [];
      for (let hour = 0; hour < 3000; hour += 1) if (rollRevolts(sim).length > 0) out.push(hour);
      return out;
    };
    expect(run('same')).toEqual(run('same'));
  });

  it('needs every condition, and does not touch the rng otherwise', () => {
    const rifle = { rifles: 1 };
    const cases: [string, TinyArmy[], (t: ReturnType<typeof unrest>) => void][] = [
      ['stable enough', [], ({ sim, p }) => void (sim.state.provinces[p('occ')]!.stability = REVOLT.STABILITY_BELOW)],
      ['home province', [], ({ sim, p, n }) => setOwner(sim, p('occ'), n('foe'))],
      ['integrated', [], ({ sim, p }) => void (sim.state.provinces[p('occ')]!.integrated = true)],
      ['in grace', [], ({ sim, p }) => void (sim.state.provinces[p('occ')]!.graceUntil = 1)],
      ['original nation dead', [], ({ sim, n }) => void (sim.state.nations[n('foe')]!.alive = false)],
      ['owner army present', [{ owner: 'me', at: 'occ', units: rifle }], () => undefined],
      ['contested', [{ owner: 'foe', at: 'occ', units: rifle }], () => undefined],
    ];
    for (const [label, armies, spoil] of cases) {
      const t = unrest('conditions', armies);
      spoil(t);
      const before = t.sim.state.rng;
      for (let hour = 0; hour < 200; hour += 1) expect(rollRevolts(t.sim), label).toEqual([]);
      expect(t.sim.state.rng, label).toBe(before);
    }
  });

  it('rolls again once the grace period ends', () => {
    const t = unrest('grace');
    t.sim.state.provinces[t.p('occ')]!.graceUntil = 8;
    const before = t.sim.state.rng;
    rollRevolts(t.sim);
    expect(t.sim.state.rng).toBe(before);
    t.sim.state.tick = 8;
    rollRevolts(t.sim);
    expect(t.sim.state.rng).not.toBe(before);
  });
});
