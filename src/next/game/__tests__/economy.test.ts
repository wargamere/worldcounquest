import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DIFFICULTY, ECONOMY, EFFECTS, PROVINCE, TIME, UNITS } from '../balance';
import { createCache, rebuildArmyIndex, takeEvents } from '../cache';
import {
  accrueHour,
  baseOutput,
  canAfford,
  daysLeft,
  missing,
  nationRates,
  pay,
  provinceOutput,
  recruitCap,
  refund,
  scaleCost,
  shortfallReason,
} from '../economy';
import { defaultTradePolicy, emptyStats, noBuildings, noShortage, zeroGoods, zeroStocks } from '../keys';
import { hourlyProvinces } from '../province';
import type { CountrySeed, Difficulty, GameState, Sim, Stocks } from '../types';
import { buildMap, parseFacts } from '../world';
import type { TinyArmy } from './helpers';
import { tinySim } from './helpers';

const HOURS_PER_DAY = TIME.TICKS_PER_DAY / TIME.TICKS_PER_HOUR;

/** me: capital mc, home mh, occupied occ (foe lives), integrated int (ch is gone); foe: capital fc. */
function world(options: { difficulty?: Difficulty; armies?: TinyArmy[]; stocks?: Record<string, Partial<Stocks>> } = {}) {
  const t = tinySim({
    provinces: {
      mc: { owner: 'me', capitalOf: 'me' },
      mh: { owner: 'me', terrain: 'mountains' },
      occ: { owner: 'me', country: 'foe' },
      int: { owner: 'me', country: 'ch' },
      fc: { owner: 'foe', capitalOf: 'foe' },
    },
    edges: [
      ['mc', 'mh'],
      ['mc', 'occ'],
      ['mc', 'int'],
      ['occ', 'fc'],
    ],
    ...options,
  });
  t.sim.state.provinces[t.p('int')]!.integrated = true;
  return t;
}

describe('provinceOutput', () => {
  it('scales by status: home 100%, integrated 80% (Recruits 50%), occupied 50% (no Recruits)', () => {
    const { sim, p } = world();
    const fact = (key: string) => sim.map.provinces[p(key)]!;
    expect(provinceOutput(sim, p('mh'))).toEqual({ funds: fact('mh').fundsBase, recruits: fact('mh').recruitsBase, good: 'steel', goods: fact('mh').goodsBase });
    const occ = provinceOutput(sim, p('occ'));
    expect(occ.funds).toBeCloseTo(fact('occ').fundsBase * PROVINCE.OUTPUT.occupied, 12);
    expect(occ.goods).toBeCloseTo(fact('occ').goodsBase * PROVINCE.OUTPUT.occupied, 12);
    expect(occ.recruits).toBe(0);
    const int = provinceOutput(sim, p('int'));
    expect(int.funds).toBeCloseTo(fact('int').fundsBase * PROVINCE.OUTPUT.integrated, 12);
    expect(int.goods).toBeCloseTo(fact('int').goodsBase * PROVINCE.OUTPUT.integrated, 12);
    expect(int.recruits).toBeCloseTo(fact('int').recruitsBase * PROVINCE.RECRUITS.integrated, 12);
  });

  it('scales by stability, Works, Draft Office and the current capital', () => {
    const { sim, p, n } = world();
    const fact = sim.map.provinces[p('mh')]!;
    const province = sim.state.provinces[p('mh')]!;
    province.stability = 50;
    let out = provinceOutput(sim, p('mh'));
    expect(out.funds).toBeCloseTo(fact.fundsBase * 0.7, 12);
    expect(out.goods).toBeCloseTo(fact.goodsBase * 0.7, 12);
    expect(out.recruits).toBeCloseTo(fact.recruitsBase * 0.7, 12);
    province.stability = 100;
    province.buildings.works = 2;
    province.buildings.draft = 1;
    out = provinceOutput(sim, p('mh'));
    expect(out.funds).toBeCloseTo(fact.fundsBase * (1 + 2 * EFFECTS.WORKS_FUNDS_PER_LEVEL), 12);
    expect(out.goods).toBeCloseTo(fact.goodsBase * (1 + 2 * EFFECTS.WORKS_GOODS_PER_LEVEL), 12);
    expect(out.recruits).toBeCloseTo(fact.recruitsBase * (1 + EFFECTS.DRAFT_RECRUITS_PER_LEVEL), 12);
    const capital = sim.map.provinces[p('mc')]!;
    out = provinceOutput(sim, p('mc'));
    expect(out.funds).toBeCloseTo(capital.fundsBase * (1 + ECONOMY.CAPITAL_FUNDS_BONUS), 12);
    expect(out.goods).toBe(capital.goodsBase);
    // The bonus follows the current seat, not the original capital.
    sim.state.nations[n('me')]!.capital = p('mh');
    expect(provinceOutput(sim, p('mc')).funds).toBe(capital.fundsBase);
  });

  it('is zero while contested', () => {
    const { sim, p } = world({ armies: [{ owner: 'foe', at: 'mh', units: { rifles: 1 } }] });
    expect(provinceOutput(sim, p('mh'))).toEqual({ funds: 0, recruits: 0, good: 'steel', goods: 0 });
    expect(baseOutput(sim, p('mh')).funds).toBe(sim.map.provinces[p('mh')]!.fundsBase);
  });

  it('applies aiOutput to AI Funds and goods only, never to the player or to Recruits', () => {
    const { sim, p } = world({ difficulty: 'ruthless' });
    const ai = DIFFICULTY.ruthless.aiOutput;
    const fc = sim.map.provinces[p('fc')]!;
    const out = provinceOutput(sim, p('fc'));
    expect(out.funds).toBeCloseTo(fc.fundsBase * (1 + ECONOMY.CAPITAL_FUNDS_BONUS) * ai, 12);
    expect(out.goods).toBeCloseTo(fc.goodsBase * ai, 12);
    expect(out.recruits).toBe(fc.recruitsBase);
    expect(provinceOutput(sim, p('mh')).funds).toBe(sim.map.provinces[p('mh')]!.fundsBase);
  });
});

describe('nationRates and accrual', () => {
  it('24 hourly accruals equal the daily net within 1e-9', () => {
    const { sim, n } = world({
      armies: [{ owner: 'me', at: 'mh', units: { rifles: 3, motor: 1 } }],
      stocks: { me: { funds: 5000, food: 400, steel: 300, oil: 200 } },
    });
    const rates = nationRates(sim, n('me'));
    const stocks = sim.state.nations[n('me')]!.stocks;
    const before = { ...stocks };
    for (let h = 0; h < HOURS_PER_DAY; h += 1) accrueHour(sim);
    for (const key of ['funds', 'food', 'steel', 'oil'] as const) {
      expect(Math.abs(stocks[key] - before[key] - rates.net[key]), key).toBeLessThan(1e-9);
    }
    expect(Math.abs(stocks.recruits - rates.income.recruits)).toBeLessThan(1e-9);
    expect(sim.state.stats.fundsEarned).toBeCloseTo(rates.income.funds, 9);
  });

  it('charges upkeep by whole units, so a damaged unit costs the same', () => {
    const { sim, n } = world({ armies: [{ owner: 'me', at: 'mh', units: { rifles: 3, tanks: 2 } }] });
    const army = sim.state.armies[0]!;
    army.units.rifles.hp = 25;
    army.units.tanks.hp = 40;
    const { upkeep } = nationRates(sim, n('me'));
    expect(upkeep.funds).toBe(3 * UNITS.rifles.upkeep.funds! + 2 * UNITS.tanks.upkeep.funds!);
    expect(upkeep.food).toBe(3 * UNITS.rifles.upkeep.food! + 2 * UNITS.tanks.upkeep.food!);
    expect(upkeep.oil).toBe(2 * UNITS.tanks.upkeep.oil!);
    expect(upkeep.steel).toBe(0);
  });

  it('leaves contested provinces out of income until the battle ends', () => {
    const { sim, n, p } = world({ armies: [{ owner: 'foe', at: 'mh', units: { rifles: 1 } }] });
    const contested = nationRates(sim, n('me')).income;
    sim.state.armies = [];
    rebuildArmyIndex(sim);
    const clear = nationRates(sim, n('me')).income;
    expect(clear.funds - contested.funds).toBeCloseTo(sim.map.provinces[p('mh')]!.fundsBase, 9);
    expect(clear.steel - contested.steel).toBeCloseTo(sim.map.provinces[p('mh')]!.goodsBase, 9);
  });

  it('caches income on accrual only; reads while dirty compute it without storing', () => {
    const { sim, n, p } = world();
    const me = n('me');
    expect(sim.cache.incomeDirty[me]).toBe(true);
    const fresh = nationRates(sim, me).income;
    expect(sim.cache.incomeDirty[me]).toBe(true);
    accrueHour(sim);
    expect(sim.cache.incomeDirty[me]).toBe(false);
    expect(sim.cache.income[me]).toEqual(fresh);
    // A raw write marks nothing; the hourly stability update marks the owner, so
    // the cache never differs from a fresh computation between setters.
    sim.state.provinces[p('mh')]!.stability = 50;
    expect(nationRates(sim, me).income).toEqual(fresh);
    hourlyProvinces(sim);
    expect(sim.cache.incomeDirty[me]).toBe(true);
    expect(nationRates(sim, me).income.funds).toBeLessThan(fresh.funds);
  });

  it('keeps a running cache equal to the fresh one a loaded game starts with, as stability drifts', () => {
    const { sim, n, p } = world({ stocks: { me: { funds: 1000, food: 1000 } } });
    const me = n('me');
    sim.state.provinces[p('occ')]!.stability = 5;
    sim.state.provinces[p('mh')]!.stability = 60;
    for (let hour = 0; hour < 30; hour += 1) {
      accrueHour(sim);
      hourlyProvinces(sim);
      const loaded: Sim = { map: sim.map, state: sim.state, cache: createCache(sim.map, sim.state, false) };
      expect(nationRates(sim, me)).toEqual(nationRates(loaded, me));
    }
  });

  it('caps Recruits at max(2,000, 20 days of regeneration)', () => {
    const small = tinySim({ provinces: { a: { owner: 'me' } }, edges: [], stocks: { me: { recruits: 1999.99 } } });
    const me = small.n('me');
    expect(recruitCap(small.sim, me)).toBe(ECONOMY.RECRUIT_CAP_MIN);
    accrueHour(small.sim);
    expect(small.sim.state.nations[me]!.stocks.recruits).toBe(ECONOMY.RECRUIT_CAP_MIN);

    const big = tinySim({ provinces: { a: { owner: 'me', population: 20_000_000 } }, edges: [], stocks: { me: { recruits: 50_000 } } });
    const daily = big.sim.map.provinces[0]!.recruitsBase;
    expect(recruitCap(big.sim, big.n('me'))).toBeCloseTo(ECONOMY.RECRUIT_CAP_DAYS * daily, 9);
    // A bank above the cap is not taken away, it just stops growing.
    accrueHour(big.sim);
    expect(big.sim.state.nations[0]!.stocks.recruits).toBe(50_000);
  });
});

describe('shortages', () => {
  /** One province (62.5 Funds, 14 Food a day) against 30 Rifles (120 Funds, 60 Food) and 2 Tanks (8 Oil). */
  function broke(stocks: Partial<Stocks>) {
    return tinySim({
      provinces: { a: { owner: 'me' }, f: { owner: 'foe' } },
      edges: [['a', 'f']],
      armies: [
        { owner: 'me', at: 'a', units: { rifles: 30, tanks: 2 } },
        { owner: 'foe', at: 'f', units: { rifles: 30 } },
      ],
      stocks: { me: stocks, foe: stocks },
    });
  }

  it('clamps at 0 and sets the flag, with a feed entry and an alert for the player', () => {
    const { sim, n } = broke({ funds: 1, food: 1, oil: 0.1, steel: 0 });
    accrueHour(sim);
    const me = sim.state.nations[n('me')]!;
    expect(me.stocks).toMatchObject({ funds: 0, food: 0, oil: 0, steel: 0 });
    expect(me.shortage).toEqual({ funds: true, food: true, steel: false, oil: true });
    const events = takeEvents(sim);
    expect(events.feed.map((e) => [e.kind, e.severity, e.text])).toEqual([
      [
        'shortage',
        'critical',
        'Treasury empty: armies lose 3% a day; Out of Food: armies lose 3% a day and provinces grow restless; Out of Oil: tanks and motor rifles at 50% speed',
      ],
    ]);
    expect(events.alerts).toEqual([{ kind: 'shortage', province: null, nation: n('me') }]);
    // The AI's shortage is flagged too, but is not news.
    expect(sim.state.nations[n('foe')]!.shortage.funds).toBe(true);
    expect(sim.state.feed.every((e) => e.nations.includes(n('me')))).toBe(true);
  });

  it('clears once the stock covers half a day of consumption', () => {
    const { sim, n } = broke({ funds: 1 });
    accrueHour(sim);
    const me = sim.state.nations[n('me')]!;
    expect(me.shortage.funds).toBe(true);
    const upkeep = nationRates(sim, n('me')).upkeep.funds;
    me.stocks.funds = ECONOMY.SHORTAGE_CLEARS_AT_DAYS * upkeep;
    accrueHour(sim);
    expect(me.shortage.funds).toBe(true);
    me.stocks.funds = ECONOMY.SHORTAGE_CLEARS_AT_DAYS * upkeep + 10;
    takeEvents(sim);
    accrueHour(sim);
    expect(me.shortage.funds).toBe(false);
    expect(takeEvents(sim).feed.map((e) => [e.kind, e.text])).toContainEqual(['shortageEnded', 'Funds supplies restored']);
  });

  it('drops a Food shortage when the army that ate it is gone', () => {
    const { sim, n } = broke({ food: 0 });
    accrueHour(sim);
    expect(sim.state.nations[n('me')]!.shortage.food).toBe(true);
    sim.state.armies = sim.state.armies.filter((a) => a.owner !== n('me'));
    rebuildArmyIndex(sim);
    accrueHour(sim);
    expect(sim.state.nations[n('me')]!.shortage.food).toBe(false);
  });
});

describe('costs', () => {
  const stocks: Stocks = { funds: 100, recruits: 1000, food: 5, steel: 0, oil: 0 };

  it('affords, reports what is missing, and names the first shortfall', () => {
    expect(canAfford(stocks, { funds: 100, recruits: 1000 })).toBe(true);
    expect(canAfford(stocks, { funds: 100.5 })).toBe(false);
    expect(missing(stocks, { funds: 1300.2, food: 5, steel: 20 })).toEqual({ funds: 1200.2, steel: 20 });
    expect(shortfallReason(stocks, { funds: 1300.2, steel: 20 })).toBe('Needs 1,201 more Funds');
    expect(shortfallReason(stocks, { funds: 50, steel: 20 })).toBe('Needs 20 more Steel');
    expect(shortfallReason(stocks, { funds: 50 })).toBeNull();
  });

  it('pays all or nothing, refunds a share and scales costs', () => {
    const { sim, n } = tinySim({ provinces: { a: { owner: 'me' } }, edges: [], stocks: { me: { funds: 100, steel: 10 } } });
    const me = sim.state.nations[n('me')]!;
    expect(pay(sim, n('me'), { funds: 60, steel: 20 })).toBe(false);
    expect(me.stocks).toMatchObject({ funds: 100, steel: 10 });
    expect(pay(sim, n('me'), { funds: 60, steel: 10 })).toBe(true);
    expect(me.stocks).toMatchObject({ funds: 40, steel: 0 });
    refund(sim, n('me'), { funds: 60, steel: 10 }, 0.5);
    expect(me.stocks).toMatchObject({ funds: 70, steel: 5 });
    expect(scaleCost({ funds: 120, food: 20 }, 3)).toEqual({ funds: 360, food: 60 });
  });

  it('counts days left only while falling', () => {
    expect(daysLeft(100, 10)).toBeNull();
    expect(daysLeft(100, 0)).toBeNull();
    expect(daysLeft(100, -40)).toBe(2.5);
    expect(daysLeft(0, -40)).toBe(0);
  });
});

describe('calibration on the committed map (§3.3)', () => {
  /** Every province at home and stability 100, no buildings, no armies, Standard. */
  function realWorld(): Sim {
    const root = fileURLToPath(new URL('../../../../', import.meta.url));
    const json = (path: string): unknown => JSON.parse(readFileSync(join(root, path), 'utf8'));
    const map = buildMap(parseFacts(json('public/province-facts.json')), json('src/data/countries.seed.json') as CountrySeed[]);
    const state: GameState = {
      format: 5,
      seed: 'calibration',
      tick: 0,
      rng: 1,
      difficulty: 'standard',
      player: map.nationById.get('250')!,
      status: 'playing',
      endedAt: null,
      sandbox: false,
      provinces: map.provinces.map((p) => ({
        owner: p.country,
        garrison: p.garrisonBase,
        stability: 100,
        heldSince: 0,
        integrated: false,
        buildings: noBuildings(),
        construction: null,
        queue: [],
        keepTraining: false,
        rally: null,
        battleSince: null,
        graceUntil: 0,
      })),
      nations: map.nations.map((ns) => ({
        ix: ns.ix,
        alive: true,
        isPlayer: ns.id === '250',
        tier: 'major',
        colour: '#888888',
        stocks: zeroStocks(),
        capital: ns.capital,
        shortage: noShortage(),
        trade: defaultTradePolicy(ns.id === '250'),
        armySerial: 0,
        ai: { nextThink: 0, alertAt: null, provoked: false, operations: [] },
        eliminatedAt: null,
      })),
      armies: [],
      nextArmyId: 1,
      market: { pressure: zeroGoods(), history: [] },
      feed: [],
      nextFeedId: 1,
      stats: emptyStats(),
      history: [],
      surrenders: [],
    };
    return { map, state, cache: createCache(map, state, false) };
  }

  it('reproduces the Funds and Recruits per day of the table, and its geography', () => {
    const sim = realWorld();
    const income = (id: string) => nationRates(sim, sim.map.nationById.get(id)!).income;
    const table: [string, number, number][] = [
      ['250', 1068, 2992], // France
      ['276', 1127, 3696], // Germany
      ['826', 1036, 2948], // United Kingdom
      ['840', 2206, 14_740], // USA
      ['156', 1893, 62_480], // China
      ['643', 612, 6336], // Russia
      ['356', 1151, 62_920], // India
      ['392', 1438, 5456], // Japan
      ['076', 738, 9504], // Brazil
      ['682', 509, 1584], // Saudi Arabia
      ['056', 471, 515], // Belgium
      ['442', 122, 29], // Luxembourg
    ];
    for (const [id, funds, recruits] of table) {
      expect(Math.abs(income(id).funds - funds), `${id} Funds`).toBeLessThanOrEqual(1);
      expect(Math.abs(income(id).recruits - recruits), `${id} Recruits`).toBeLessThanOrEqual(1);
    }
    // France, Germany and Japan have no Oil; Saudi Arabia has no Food.
    expect(income('250').oil).toBe(0);
    expect(income('276').oil).toBe(0);
    expect(income('392').oil).toBe(0);
    expect(income('682').food).toBe(0);
  });
});
