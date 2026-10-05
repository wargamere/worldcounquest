import { describe, expect, it } from 'vitest';
import { MARKET, START, UNITS } from '../balance';
import { nationRates } from '../economy';
import {
  autoTrade,
  dailyMarket,
  decayHour,
  goodsValue,
  integratedCost,
  priceFactor,
  quote,
  sellableToFactor,
  setTradePolicy,
  trade,
  unitPrice,
} from '../market';
import { GOODS } from '../types';
import type { Good, Market, Stocks } from '../types';
import { tinySim } from './helpers';

function market(pressure: Partial<Record<Good, number>> = {}): Market {
  return { pressure: { food: 0, steel: 0, oil: 0, ...pressure }, history: [] };
}

/** Midpoint Riemann sum of base × f from `from` to `from + amount`. */
function riemann(from: number, amount: number, good: Good, steps: number): number {
  const h = amount / steps;
  let total = 0;
  for (let i = 0; i < steps; i += 1) total += priceFactor(from + (i + 0.5) * h, good);
  return MARKET.BASE_PRICE[good] * total * h;
}

describe('price factor', () => {
  it('is 1 at zero pressure and clamps at the floor and the ceiling', () => {
    for (const good of GOODS) {
      expect(priceFactor(0, good)).toBe(1);
      expect(priceFactor(MARKET.DEPTH[good] / 2, good)).toBe(1.5);
      expect(priceFactor(-1e9, good)).toBe(MARKET.MIN_FACTOR);
      expect(priceFactor(1e9, good)).toBe(MARKET.MAX_FACTOR);
    }
    expect(unitPrice(market({ steel: 4000 }), 'steel')).toBe(7.5);
  });
});

describe('integratedCost', () => {
  it('matches a 100,000-step Riemann sum within 1e-6 across the clamps', () => {
    const cases: [number, number, Good][] = [
      [0, 3000, 'food'],
      [0, -3000, 'food'],
      [-10_000, 5000, 'food'], // starts on the floor
      [15_000, 6000, 'food'], // runs into the ceiling
      [-9000, 40_000, 'food'], // crosses both
      [30_000, -45_000, 'food'], // both, selling
      [-3000, 2000, 'oil'], // entirely on the floor
      [7000, 1000, 'oil'], // entirely on the ceiling
      [1234.5, -987.25, 'steel'],
    ];
    for (const [from, amount, good] of cases) {
      const exact = integratedCost(from, amount, good);
      const approx = riemann(from, amount, good, 100_000);
      expect(Math.abs(exact - approx) / Math.max(1, Math.abs(exact)), `${good} ${from} ${amount}`).toBeLessThan(1e-6);
    }
    expect(integratedCost(500, 0, 'food')).toBe(0);
  });

  it('is exact on each piece', () => {
    expect(integratedCost(0, 100, 'food')).toBeCloseTo(2 * (100 + (100 * 100) / (2 * 12_000)), 9);
    expect(integratedCost(-100_000, 100, 'food')).toBeCloseTo(2 * 0.4 * 100, 9);
    expect(integratedCost(100_000, 100, 'food')).toBeCloseTo(2 * 2.5 * 100, 9);
  });
});

describe('quotes and trades', () => {
  it('buys at the integral x 1.10, sells at x 0.90, and a round trip loses at least 20% of the market value', () => {
    const m = market({ oil: 500 });
    const buy = quote(m, 'oil', 400);
    const fair = integratedCost(500, 400, 'oil');
    expect(buy.funds).toBeCloseTo(MARKET.BUY_FEE * fair, 9);
    expect(buy.factorAfter).toBeCloseTo(priceFactor(900, 'oil'), 12);
    m.pressure.oil += buy.amount;
    const sell = quote(m, 'oil', -400);
    expect(sell.amount).toBe(-400);
    expect(sell.funds).toBeCloseTo(MARKET.SELL_FEE * fair, 9);
    expect(buy.funds - sell.funds).toBeGreaterThanOrEqual(0.2 * fair - 1e-9);
    // Selling later, after the pressure has relaxed, loses more.
    m.pressure.oil *= MARKET.DECAY_PER_HOUR;
    expect(quote(m, 'oil', -400).funds).toBeLessThan(sell.funds);
  });

  it('caps one trade at MAX_TRADE_DEPTH_SHARE of depth', () => {
    const cap = MARKET.MAX_TRADE_DEPTH_SHARE * MARKET.DEPTH.oil;
    expect(quote(market(), 'oil', 10_000).amount).toBe(cap);
    expect(quote(market(), 'oil', -10_000).amount).toBe(-cap);
  });

  it('trades through the command path, with the checks it needs', () => {
    const { sim, n } = tinySim({ provinces: { a: { owner: 'me' } }, edges: [], stocks: { me: { funds: 1000, food: 50 } } });
    const me = sim.state.nations[n('me')]!;
    expect(trade(sim, n('me'), 'food', 0)).toEqual({ ok: false, reason: 'Nothing to trade' });
    expect(trade(sim, n('me'), 'food', -60)).toEqual({ ok: false, reason: 'Only 50 Food in stock' });
    expect(trade(sim, n('me'), 'steel', 1000)).toEqual({ ok: false, reason: 'Needs 4,844 more Funds' });
    const q = quote(sim.state.market, 'food', 200);
    expect(trade(sim, n('me'), 'food', 200)).toEqual({ ok: true, armies: [] });
    expect(me.stocks.food).toBe(250);
    expect(me.stocks.funds).toBeCloseTo(1000 - q.funds, 9);
    expect(sim.state.market.pressure.food).toBe(200);
    expect(sim.state.stats.tradeVolume).toBeCloseTo(q.funds, 9);
    // A capped order goes through at the cap.
    me.stocks.funds = 1e6;
    trade(sim, n('me'), 'oil', 5000);
    expect(sim.state.market.pressure.oil).toBe(MARKET.MAX_TRADE_DEPTH_SHARE * MARKET.DEPTH.oil);
  });

  it('values goods at current prices', () => {
    expect(goodsValue(market({ food: 12_000 }), { food: 10, steel: 2, oil: 1 })).toBe(10 * 4 + 2 * 5 + 6);
  });
});

describe('sellableToFactor', () => {
  it('stops the price at exactly the factor asked for', () => {
    for (const good of GOODS) {
      for (const pressure of [0, 777, MARKET.DEPTH[good] * 2]) {
        const m = market({ [good]: pressure });
        const q = sellableToFactor(m, good, MARKET.AUTO_SELL_MIN_FACTOR);
        expect(priceFactor(pressure - q, good)).toBeCloseTo(MARKET.AUTO_SELL_MIN_FACTOR, 12);
      }
    }
    expect(sellableToFactor(market({ food: -2000 }), 'food', 0.9)).toBe(0);
  });
});

describe('decay and history', () => {
  it('relaxes pressure by 0.9907 per hour, about 20% a day', () => {
    const { sim } = tinySim({ provinces: { a: { owner: 'me' } }, edges: [] });
    sim.state.market.pressure = { food: 6000, steel: -3000, oil: 1000 };
    let k = 1;
    for (let h = 0; h < 24; h += 1) {
      decayHour(sim);
      k *= MARKET.DECAY_PER_HOUR;
    }
    expect(sim.state.market.pressure.food).toBeCloseTo(6000 * k, 9);
    expect(sim.state.market.pressure.steel).toBeCloseTo(-3000 * k, 9);
    expect(k).toBeGreaterThan(0.79);
    expect(k).toBeLessThan(0.81);
  });

  it('keeps the last 14 daily factors', () => {
    const { sim } = tinySim({ provinces: { a: { owner: 'me' } }, edges: [] });
    for (let day = 0; day < 20; day += 1) {
      sim.state.market.pressure.food = day * 600;
      dailyMarket(sim);
    }
    const history = sim.state.market.history;
    expect(history).toHaveLength(MARKET.HISTORY_DAYS);
    expect(history[0]!.food).toBeCloseTo(priceFactor(6 * 600, 'food'), 12);
    expect(history[history.length - 1]).toEqual({ food: priceFactor(19 * 600, 'food'), steel: 1, oil: 1 });
  });
});

describe('player auto-trade', () => {
  /** 10 Rifles and 5 Tanks: 40+50 = 90 Funds, 30 Food and 20 Oil upkeep a day. */
  function trader(stocks: Partial<Stocks>) {
    return tinySim({
      provinces: { a: { owner: 'me' } },
      edges: [],
      armies: [{ owner: 'me', at: 'a', units: { rifles: 10, tanks: 5 } }],
      stocks: { me: stocks },
    });
  }

  it('keeps stocked up to max(keepDays x upkeep, GOODS_MIN), Food and Oil on by default, Steel off', () => {
    const { sim, n } = trader({ funds: 10_000, food: 0, oil: 0, steel: 0 });
    const me = sim.state.nations[n('me')]!;
    autoTrade(sim, n('me'));
    const oilUpkeep = 5 * UNITS.tanks.upkeep.oil!;
    expect(me.stocks.food).toBeCloseTo(Math.max(MARKET.DEFAULT_KEEP_DAYS.food * 30, START.GOODS_MIN.food), 9);
    expect(me.stocks.oil).toBeCloseTo(Math.max(MARKET.DEFAULT_KEEP_DAYS.oil * oilUpkeep, START.GOODS_MIN.oil), 9);
    expect(me.stocks.steel).toBe(0);
    // Already stocked: nothing more to buy.
    const funds = me.stocks.funds;
    autoTrade(sim, n('me'));
    expect(me.stocks.funds).toBe(funds);
  });

  it('never spends Funds below 2 days of Funds upkeep', () => {
    const { sim, n } = trader({ funds: 400, food: 0, oil: 0 });
    const me = sim.state.nations[n('me')]!;
    const reserve = MARKET.AUTO_FUNDS_RESERVE_DAYS * nationRates(sim, n('me')).upkeep.funds;
    autoTrade(sim, n('me'));
    expect(me.stocks.food).toBeGreaterThan(0);
    expect(me.stocks.funds).toBeGreaterThanOrEqual(reserve - 1e-6);
    expect(me.stocks.funds).toBeLessThan(reserve + 1);
    const food = me.stocks.food;
    autoTrade(sim, n('me'));
    expect(me.stocks.food).toBe(food);
  });

  it('buys only one day of upkeep above factor 2.0, and skips trades under MIN_AUTO_TRADE', () => {
    const { sim, n } = trader({ funds: 10_000, food: 0, oil: 55 });
    sim.state.market.pressure.food = 1.5 * MARKET.DEPTH.food;
    const me = sim.state.nations[n('me')]!;
    autoTrade(sim, n('me'));
    expect(me.stocks.food).toBeCloseTo(30, 9);
    // Oil wanted 60 - 55 = 5, below the smallest automatic trade.
    expect(me.stocks.oil).toBe(55);
  });

  it('sells above N days only when asked, down to max(N x upkeep, GOODS_MIN), never below factor 0.9', () => {
    const { sim, n } = trader({ funds: 0, food: 5000 });
    const me = sim.state.nations[n('me')]!;
    autoTrade(sim, n('me'));
    expect(me.stocks.food).toBe(5000);
    const policy = { keepDays: { food: 0, steel: 0, oil: 0 }, sellAboveDays: { food: 10, steel: 0, oil: 0 } };
    expect(setTradePolicy(sim, n('me'), policy).ok).toBe(true);
    autoTrade(sim, n('me'));
    // 5000 - 300 = 4700 would push the factor below 0.9; it stops there instead.
    const sold = 5000 - me.stocks.food;
    expect(sold).toBeCloseTo(0.1 * MARKET.DEPTH.food, 9);
    expect(priceFactor(sim.state.market.pressure.food, 'food')).toBeCloseTo(MARKET.AUTO_SELL_MIN_FACTOR, 12);
    expect(me.stocks.funds).toBeGreaterThan(0);
    autoTrade(sim, n('me'));
    expect(5000 - me.stocks.food).toBeCloseTo(sold, 9);
  });

  it('rejects a policy with negative days', () => {
    const { sim, n } = trader({});
    const bad = { keepDays: { food: -1, steel: 0, oil: 0 }, sellAboveDays: { food: 0, steel: 0, oil: 0 } };
    expect(setTradePolicy(sim, n('me'), bad)).toEqual({ ok: false, reason: 'Days must be 0 or more' });
  });
});
