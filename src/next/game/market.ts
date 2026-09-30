/**
 * The Exchange, one global market per good (§3.7).
 *
 * The price factor is f(P) = clamp(1 + P / depth, MIN, MAX): piecewise linear
 * in the pressure P, so the Funds for a trade of q units, base × ∫ f from P to
 * P + q, has a closed form made of at most three pieces. Buying pays the
 * integral × BUY_FEE and raises P; selling receives it × SELL_FEE and lowers P.
 */
import { MARKET, START } from './balance';
import { nationRates, shortfallReason, STOCK_LABELS } from './economy';
import { recordStat } from './stats';
import { GOODS } from './types';
import type { CommandResult, Good, GoodAmounts, Market, NationIx, Sim, TradePolicy } from './types';

const OK: CommandResult = { ok: true, armies: [] };
/** Bisection steps when solving a purchase for a Funds budget: far below a unit of any good. */
const BUDGET_STEPS = 60;

export function priceFactor(pressure: number, good: Good): number {
  return Math.min(MARKET.MAX_FACTOR, Math.max(MARKET.MIN_FACTOR, 1 + pressure / MARKET.DEPTH[good]));
}

/** Funds per unit at the current factor, before fees. */
export function unitPrice(market: Market, good: Good): number {
  return MARKET.BASE_PRICE[good] * priceFactor(market.pressure[good], good);
}

/** ∫ f over [lo, hi] (lo ≤ hi), in units of base price: the floor, the linear middle and the ceiling. */
function factorIntegral(lo: number, hi: number, depth: number): number {
  const floorEnd = (MARKET.MIN_FACTOR - 1) * depth;
  const ceilingStart = (MARKET.MAX_FACTOR - 1) * depth;
  let total = 0;
  if (lo < floorEnd) total += MARKET.MIN_FACTOR * (Math.min(hi, floorEnd) - lo);
  if (hi > ceilingStart) total += MARKET.MAX_FACTOR * (hi - Math.max(lo, ceilingStart));
  const a = Math.max(lo, floorEnd);
  const b = Math.min(hi, ceilingStart);
  // The mean of a linear f over [a, b] is f at the midpoint.
  if (b > a) total += (b - a) * (1 + (a + b) / (2 * depth));
  return total;
}

/** base × ∫ f from `pressure` to `pressure + amount`; negative for a negative amount. No fees. */
export function integratedCost(pressure: number, amount: number, good: Good): number {
  const end = pressure + amount;
  const value = MARKET.BASE_PRICE[good] * factorIntegral(Math.min(pressure, end), Math.max(pressure, end), MARKET.DEPTH[good]);
  return amount < 0 ? -value : value;
}

/**
 * `amount` is signed: positive buys, negative sells. `funds` is what the buyer
 * pays or the seller receives, always ≥ 0. One trade moves at most
 * MAX_TRADE_DEPTH_SHARE of depth, so the quoted amount may be smaller.
 */
export interface TradeQuote {
  amount: number;
  funds: number;
  factorAfter: number;
}

export function quote(market: Market, good: Good, amount: number): TradeQuote {
  const cap = MARKET.MAX_TRADE_DEPTH_SHARE * MARKET.DEPTH[good];
  const q = Math.min(cap, Math.max(-cap, amount));
  const pressure = market.pressure[good];
  const value = integratedCost(pressure, q, good);
  const funds = q >= 0 ? MARKET.BUY_FEE * value : -MARKET.SELL_FEE * value;
  return { amount: q, funds, factorAfter: priceFactor(pressure + q, good) };
}

/** How much can be sold before the factor falls to `minFactor`; 0 if it is already there. */
export function sellableToFactor(market: Market, good: Good, minFactor: number): number {
  return Math.max(0, market.pressure[good] - (minFactor - 1) * MARKET.DEPTH[good]);
}

/** Funds value of goods at current prices, before fees. */
export function goodsValue(market: Market, amounts: GoodAmounts): number {
  let total = 0;
  for (const good of GOODS) total += amounts[good] * unitPrice(market, good);
  return total;
}

/** The largest purchase (within the per-trade cap) whose price with fees fits `budget`. */
function buyableWith(market: Market, good: Good, budget: number): number {
  if (budget <= 0) return 0;
  const cap = MARKET.MAX_TRADE_DEPTH_SHARE * MARKET.DEPTH[good];
  if (quote(market, good, cap).funds <= budget) return cap;
  let lo = 0;
  let hi = cap;
  for (let i = 0; i < BUDGET_STEPS; i += 1) {
    const mid = (lo + hi) / 2;
    if (quote(market, good, mid).funds <= budget) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Applies an already validated quote. */
function execute(sim: Sim, n: NationIx, good: Good, q: TradeQuote): void {
  const nation = sim.state.nations[n]!;
  nation.stocks[good] += q.amount;
  nation.stocks.funds += q.amount > 0 ? -q.funds : q.funds;
  sim.state.market.pressure[good] += q.amount;
  if (nation.isPlayer) recordStat(sim, 'tradeVolume', q.funds);
}

/** Buys (amount > 0) or sells (amount < 0) at once, capped at MAX_TRADE_DEPTH_SHARE of depth. */
export function trade(sim: Sim, n: NationIx, good: Good, amount: number): CommandResult {
  const nation = sim.state.nations[n];
  if (nation?.alive !== true) return { ok: false, reason: 'That nation is gone' };
  if (!Number.isFinite(amount) || amount === 0) return { ok: false, reason: 'Nothing to trade' };
  const q = quote(sim.state.market, good, amount);
  if (q.amount > 0) {
    const reason = shortfallReason(nation.stocks, { funds: q.funds });
    if (reason !== null) return { ok: false, reason };
  } else if (nation.stocks[good] < -q.amount) {
    return { ok: false, reason: `Only ${Math.floor(nation.stocks[good])} ${STOCK_LABELS[good]} in stock` };
  }
  execute(sim, n, good, q);
  return OK;
}

function validDays(days: GoodAmounts): boolean {
  return GOODS.every((good) => Number.isFinite(days[good]) && days[good] >= 0);
}

export function setTradePolicy(sim: Sim, n: NationIx, policy: TradePolicy): CommandResult {
  const nation = sim.state.nations[n];
  if (nation?.alive !== true) return { ok: false, reason: 'That nation is gone' };
  if (!validDays(policy.keepDays) || !validDays(policy.sellAboveDays)) return { ok: false, reason: 'Days must be 0 or more' };
  nation.trade = { keepDays: { ...policy.keepDays }, sellAboveDays: { ...policy.sellAboveDays } };
  return OK;
}

/** Pressure relaxes toward 0 by DECAY_PER_HOUR every game hour. */
export function decayHour(sim: Sim): void {
  const { pressure } = sim.state.market;
  for (const good of GOODS) pressure[good] *= MARKET.DECAY_PER_HOUR;
}

/** Records today's factors for the sparklines, keeping the last HISTORY_DAYS. */
export function dailyMarket(sim: Sim): void {
  const { market } = sim.state;
  const factors: GoodAmounts = { food: 0, steel: 0, oil: 0 };
  for (const good of GOODS) factors[good] = priceFactor(market.pressure[good], good);
  market.history.push(factors);
  while (market.history.length > MARKET.HISTORY_DAYS) market.history.shift();
}

/**
 * A nation's TradePolicy, per good in GOODS order (the player's, every
 * AUTO_TRADE_HOURS). Keep stocked buys up to max(keepDays × upkeep, GOODS_MIN),
 * only one day's upkeep above AUTO_BUY_MAX_FACTOR, and never spends Funds below
 * AUTO_FUNDS_RESERVE_DAYS of Funds upkeep. Sell above sells the stock above
 * max(sellAboveDays × upkeep, GOODS_MIN), never below AUTO_SELL_MIN_FACTOR.
 * Trades smaller than MIN_AUTO_TRADE are skipped.
 */
export function autoTrade(sim: Sim, n: NationIx): void {
  const nation = sim.state.nations[n];
  if (nation?.alive !== true) return;
  const { market } = sim.state;
  const { upkeep } = nationRates(sim, n);
  for (const good of GOODS) {
    const perDay = upkeep[good];
    const keepDays = nation.trade.keepDays[good];
    const stock = nation.stocks[good];
    if (keepDays > 0 && stock < Math.max(keepDays * perDay, START.GOODS_MIN[good])) {
      let want = Math.max(keepDays * perDay, START.GOODS_MIN[good]) - stock;
      if (priceFactor(market.pressure[good], good) > MARKET.AUTO_BUY_MAX_FACTOR) want = Math.min(want, perDay);
      const budget = nation.stocks.funds - MARKET.AUTO_FUNDS_RESERVE_DAYS * upkeep.funds;
      const q = quote(market, good, Math.min(want, buyableWith(market, good, budget)));
      if (q.amount >= MARKET.MIN_AUTO_TRADE) execute(sim, n, good, q);
      continue;
    }
    const sellAbove = nation.trade.sellAboveDays[good];
    if (sellAbove <= 0) continue;
    const excess = Math.min(stock - Math.max(sellAbove * perDay, START.GOODS_MIN[good]), sellableToFactor(market, good, MARKET.AUTO_SELL_MIN_FACTOR));
    const q = quote(market, good, -excess);
    if (-q.amount >= MARKET.MIN_AUTO_TRADE) execute(sim, n, good, q);
  }
}
