/**
 * The AI's economy, training and market step for majors (§6.5), also used by
 * the harness's advisor player. Spending comes out of `free` = Funds − 2 days of
 * Funds upkeep: buildings get BUILD_SHARE_EARLY/LATE of it, training the rest,
 * and threshold trades at most MARKET_MAX_FUNDS_SHARE.
 *
 * Every plan runs against a wallet: a copy of the nation's stocks and of the
 * market pressure that each planned command updates exactly as the command will
 * when applied in order. So a plan never issues a command that the state, by
 * the time it is applied, would refuse.
 */
import { AI, BUILDINGS, MARKET, START, TIME, UNITS } from '../balance';
import { bestProvincesFor, buildCost } from '../buildings';
import { armiesOf, isContested, ownedProvinces } from '../cache';
import { dayOf } from '../clock';
import { nationRates } from '../economy';
import { quote, sellableToFactor } from '../market';
import { statusOf } from '../province';
import { trainHours } from '../training';
import { GOODS, STOCK_KEYS, UNIT_TYPES } from '../types';
import type { BuildingType, Command, Cost, Good, GoodAmounts, Market, NationIx, ProvinceIx, Sim, Stocks, UnitType } from '../types';
import { hardShare } from '../units';
import { zeroUnits } from '../keys';
import type { NationView } from './assess';

const HOURS_PER_DAY = TIME.TICKS_PER_DAY / TIME.TICKS_PER_HOUR;
/** Bisection steps when sizing a purchase to a Funds budget: far below a unit of any good. */
const BUDGET_STEPS = 60;

export interface Wallet {
  n: NationIx;
  /** The nation's stocks after the commands planned so far. */
  stocks: Stocks;
  /** Market pressure after the trades planned so far. */
  pressure: GoodAmounts;
  /** Funds left for buildings, training and threshold trades this think. */
  build: number;
  train: number;
  market: number;
  trades: number;
  builds: number;
  /** Provinces with a planned construction, and items planned per training queue. */
  building: Set<ProvinceIx>;
  queued: Map<ProvinceIx, number>;
  upkeep: Stocks;
  income: Stocks;
  /** Funds never spent: SPEND_RESERVE_DAYS of Funds upkeep. */
  reserve: number;
  /** Funds upkeep per day once every queued and planned unit is in service. */
  projectedUpkeep: number;
}

const wallets = new WeakMap<NationView, Wallet>();

/** A wallet over the nation's current stocks and the market as it is now. */
export function freshWallet(sim: Sim, n: NationIx): Wallet {
  const { state } = sim;
  const nation = state.nations[n]!;
  const rates = nationRates(sim, n);
  const reserve = AI.SPEND_RESERVE_DAYS * rates.upkeep.funds;
  const free = Math.max(0, nation.stocks.funds - reserve);
  const share = dayOf(state.tick) < AI.EARLY_DAYS ? AI.BUILD_SHARE_EARLY : AI.BUILD_SHARE_LATE;
  let queuedUpkeep = 0;
  for (const p of ownedProvinces(sim, n)) for (const item of state.provinces[p]!.queue) queuedUpkeep += UNITS[item.unit].upkeep.funds ?? 0;
  return {
    n,
    stocks: { ...nation.stocks },
    pressure: { ...state.market.pressure },
    build: free * share,
    train: free * (1 - share),
    market: free * AI.MARKET_MAX_FUNDS_SHARE,
    trades: 0,
    builds: 0,
    building: new Set(),
    queued: new Map(),
    upkeep: rates.upkeep,
    income: rates.income,
    reserve,
    projectedUpkeep: rates.upkeep.funds + queuedUpkeep,
  };
}

/** The wallet shared by every economy step planned on this view. */
export function walletOf(sim: Sim, view: NationView): Wallet {
  let wallet = wallets.get(view);
  if (wallet === undefined) {
    wallet = freshWallet(sim, view.nation);
    wallets.set(view, wallet);
  }
  return wallet;
}

function marketOf(w: Wallet): Market {
  return { pressure: w.pressure, history: [] };
}

function payFrom(w: Wallet, cost: Cost, times: number): void {
  for (const key of STOCK_KEYS) w.stocks[key] -= (cost[key] ?? 0) * times;
}

function affords(w: Wallet, cost: Cost): boolean {
  return STOCK_KEYS.every((key) => (cost[key] ?? 0) <= w.stocks[key]);
}

/** The largest purchase (within the per-trade cap) whose price with fees fits `budget`. */
function buyable(w: Wallet, good: Good, want: number, budget: number): number {
  if (want <= 0 || budget <= 0) return 0;
  const market = marketOf(w);
  const top = quote(market, good, want).amount;
  if (quote(market, good, top).funds <= budget) return top;
  let lo = 0;
  let hi = top;
  for (let i = 0; i < BUDGET_STEPS; i += 1) {
    const mid = (lo + hi) / 2;
    if (quote(market, good, mid).funds <= budget) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Plans a trade (amount > 0 buys) and books it in the wallet; returns the Funds it moves. */
function book(w: Wallet, good: Good, amount: number, out: Command[]): number {
  const q = quote(marketOf(w), good, amount);
  w.stocks[good] += q.amount;
  w.stocks.funds += q.amount > 0 ? -q.funds : q.funds;
  w.pressure[good] += q.amount;
  w.trades += 1;
  out.push({ kind: 'trade', nation: w.n, good, amount: q.amount });
  return q.funds;
}

/**
 * Buys whatever goods `cost` still lacks, within `budget` Funds together with the
 * cost's own Funds, and only while explicit trades remain. Returns the Funds the
 * purchases took, or null when the cost cannot be covered (nothing is booked).
 */
function coverGoods(w: Wallet, cost: Cost, budget: number, out: Command[]): number | null {
  const gaps: { good: Good; amount: number }[] = [];
  for (const good of GOODS) {
    const gap = (cost[good] ?? 0) - w.stocks[good];
    if (gap > 0) gaps.push({ good, amount: Math.ceil(gap) });
  }
  if ((cost.recruits ?? 0) > w.stocks.recruits) return null;
  if (gaps.length === 0) return 0;
  if (w.trades + gaps.length > AI.MAX_TRADES_PER_THINK) return null;
  const market = marketOf(w);
  let price = 0;
  for (const gap of gaps) {
    const q = quote(market, gap.good, gap.amount);
    if (q.amount < gap.amount) return null;
    price += q.funds;
  }
  if (price + (cost.funds ?? 0) > Math.min(budget, w.stocks.funds)) return null;
  let spent = 0;
  for (const gap of gaps) spent += book(w, gap.good, gap.amount, out);
  return spent;
}

// ------------------------------------------------------------------ builds

/** Every rule that rules a building out except its price (mirrors buildings.canBuild). */
function placeable(sim: Sim, n: NationIx, p: ProvinceIx, b: BuildingType): boolean {
  const province = sim.state.provinces[p]!;
  if (province.owner !== n || province.construction !== null || isContested(sim, p)) return false;
  if (province.buildings[b] >= BUILDINGS[b].levels.length) return false;
  return !(BUILDINGS[b].homeOnly && statusOf(sim, p) === 'occupied');
}

/**
 * Where a plan's Funds come from: the think's building or training share, or
 * (for minors, whose rules are about the whole treasury) everything above the
 * reserve, or (emergency Rifles) everything.
 */
export type Pool = 'build' | 'train' | 'free' | 'all';

function poolLimit(w: Wallet, pool: Pool): number {
  if (pool === 'build') return w.build;
  if (pool === 'train') return w.train;
  return pool === 'free' ? w.stocks.funds - w.reserve : w.stocks.funds;
}

function drawPool(w: Wallet, pool: Pool, funds: number): void {
  if (pool === 'build') w.build -= funds;
  else if (pool === 'train') w.train -= funds;
}

/** Plans a construction (buying missing goods first) if the pool covers it; false otherwise. */
export function tryBuild(sim: Sim, w: Wallet, p: ProvinceIx, b: BuildingType, pool: Pool, out: Command[]): boolean {
  if (w.builds >= AI.MAX_BUILDS_PER_THINK || w.building.has(p) || !placeable(sim, w.n, p, b)) return false;
  const cost = buildCost(b, sim.state.provinces[p]!.buildings[b] + 1);
  const limit = poolLimit(w, pool);
  const trades: Command[] = [];
  const snapshot = { stocks: { ...w.stocks }, pressure: { ...w.pressure }, trades: w.trades };
  const spent = coverGoods(w, cost, limit, trades);
  if (spent === null || !affords(w, cost) || spent + (cost.funds ?? 0) > limit) {
    w.stocks = snapshot.stocks;
    w.pressure = snapshot.pressure;
    w.trades = snapshot.trades;
    return false;
  }
  out.push(...trades);
  payFrom(w, cost, 1);
  drawPool(w, pool, spent + (cost.funds ?? 0));
  w.builds += 1;
  w.building.add(p);
  out.push({ kind: 'build', nation: w.n, province: p, building: b });
  return true;
}

/** Recruits a day the nation's Training Grounds would use training Rifles without pause. */
function recruitDemand(sim: Sim, n: NationIx): number {
  let demand = 0;
  for (const p of ownedProvinces(sim, n)) {
    if (sim.state.provinces[p]!.buildings.training === 0) continue;
    demand += (HOURS_PER_DAY / trainHours(sim, p, 'rifles')) * (UNITS.rifles.cost.recruits ?? 0);
  }
  return demand;
}

/**
 * At most MAX_BUILDS_PER_THINK constructions, in priority order: capital
 * Ramparts while the capital is threatened; the capital Training Ground to 2
 * (from TRAINING_L2_DAY) and 3 (from TRAINING_L3_DAY with enough Steel income);
 * more Training Grounds once the nation is big; the best-payback Works in Home
 * or Integrated land; a Draft Office when Recruits run low for training; and
 * Ramparts 1 on threatened frontier provinces. Never Roads.
 */
export function planEconomy(sim: Sim, view: NationView): Command[] {
  const { map, state } = sim;
  const w = walletOf(sim, view);
  const n = view.nation;
  const nation = state.nations[n]!;
  const out: Command[] = [];
  const capital = nation.capital;
  const day = dayOf(state.tick);
  const ratio = (p: ProvinceIx): number => view.threat[p]! / Math.max(view.defence[p]!, 1e-9);

  if (capital !== null) {
    const levels = state.provinces[capital]!.buildings;
    const rampartsMax = state.difficulty === 'ruthless' ? AI.CAPITAL_RAMPARTS_MAX_RUTHLESS : AI.CAPITAL_RAMPARTS_MAX;
    if (levels.ramparts < rampartsMax && ratio(capital) >= AI.CAPITAL_RAMPARTS_THREAT) tryBuild(sim, w, capital, 'ramparts', 'build', out);
    const toTwo = day >= AI.TRAINING_L2_DAY && levels.training < 2;
    const toThree = day >= AI.TRAINING_L3_DAY && levels.training === 2 && w.income.steel >= AI.TRAINING_L3_MIN_STEEL_PER_DAY;
    if (toTwo || toThree) tryBuild(sim, w, capital, 'training', 'build', out);
  }

  const owned = ownedProvinces(sim, n);
  const grounds = owned.filter((p) => state.provinces[p]!.buildings.training > 0).length;
  if (owned.length >= AI.EXTRA_TRAINING_AT_PROVINCES && grounds < AI.MAX_TRAINING_GROUNDS) {
    const distance = (p: ProvinceIx): number => {
      const ticks = view.field.ticks[p] ?? -1;
      return ticks < 0 ? Number.POSITIVE_INFINITY : ticks;
    };
    const site = owned
      .filter((p) => statusOf(sim, p) === 'home' && state.provinces[p]!.buildings.training === 0 && placeable(sim, n, p, 'training'))
      .sort((a, b) => map.provinces[b]!.population - map.provinces[a]!.population || distance(a) - distance(b) || a - b)[0];
    if (site !== undefined) tryBuild(sim, w, site, 'training', 'build', out);
  }

  for (const { province, preview } of bestProvincesFor(sim, n, 'works', AI.MAX_TARGETS)) {
    if (statusOf(sim, province) === 'occupied' || preview.paybackDays === null || preview.paybackDays > AI.WORKS_MAX_PAYBACK_DAYS) continue;
    if (tryBuild(sim, w, province, 'works', 'build', out)) break;
  }

  if (w.stocks.recruits < AI.DRAFT_BELOW_TRAINING_DAYS * recruitDemand(sim, n)) {
    for (const { province } of bestProvincesFor(sim, n, 'draft', AI.MAX_TARGETS)) if (tryBuild(sim, w, province, 'draft', 'build', out)) break;
  }

  for (const p of view.frontier) {
    if (p === capital || state.provinces[p]!.buildings.ramparts > 0 || ratio(p) < AI.FRONT_RAMPARTS_THREAT) continue;
    if (tryBuild(sim, w, p, 'ramparts', 'build', out)) break;
  }
  return out;
}

// ------------------------------------------------------------------ training

/** HP share of hard units in the armies of the nations holding land next to our frontier. */
function enemyHardShare(sim: Sim, view: NationView): number {
  const { map, state } = sim;
  const enemies = new Set<NationIx>();
  for (const p of view.frontier) {
    for (const e of map.edges[p]!) {
      const owner = state.provinces[e.to]!.owner;
      if (owner !== view.nation) enemies.add(owner);
    }
  }
  const units = zeroUnits();
  for (const n of [...enemies].sort((a, b) => a - b)) {
    for (const army of armiesOf(sim, n)) {
      if (!army.alive) continue;
      for (const type of UNIT_TYPES) units[type].hp += army.units[type].hp;
    }
  }
  return hardShare(units);
}

/**
 * The target mix for a Training Ground of `level`: COMPOSITION, with HUNTER_EXTRA
 * moved from Rifles to Tank Hunters against armoured enemies; Oil users only
 * while Oil is not falling or covers OIL_UNITS_NEED_DAYS; anything this level
 * cannot train goes to Rifles.
 */
export function targetMix(level: number, hardEnemy: boolean, oilOk: boolean): Record<UnitType, number> {
  const mix: Record<UnitType, number> = { ...AI.COMPOSITION };
  if (hardEnemy) {
    mix.hunters += AI.HUNTER_EXTRA;
    mix.rifles -= AI.HUNTER_EXTRA;
  }
  for (const type of UNIT_TYPES) {
    if (type === 'rifles') continue;
    if (UNITS[type].trainingLevel > level || (UNITS[type].usesOil && !oilOk)) {
      mix.rifles += mix[type];
      mix[type] = 0;
    }
  }
  return mix;
}

/** The type furthest below its share of the force, ties to the canonical order. */
export function pickUnit(mix: Readonly<Record<UnitType, number>>, counts: Readonly<Record<UnitType, number>>): UnitType {
  let total = 1;
  for (const type of UNIT_TYPES) total += counts[type];
  let best: UnitType = 'rifles';
  let gap = Number.NEGATIVE_INFINITY;
  for (const type of UNIT_TYPES) {
    if (mix[type] <= 0) continue;
    const shortfall = mix[type] * total - counts[type];
    if (shortfall > gap) {
      best = type;
      gap = shortfall;
    }
  }
  return best;
}

/** Units in service and queued per type for nation `n`. */
export function forceCounts(sim: Sim, n: NationIx): Record<UnitType, number> {
  const counts: Record<UnitType, number> = { rifles: 0, hunters: 0, motor: 0, guns: 0, tanks: 0 };
  for (const army of armiesOf(sim, n)) if (army.alive) for (const type of UNIT_TYPES) counts[type] += army.units[type].count;
  for (const p of ownedProvinces(sim, n)) for (const item of sim.state.provinces[p]!.queue) counts[item.unit] += 1;
  return counts;
}

/** Plans one unit into `p`'s queue from the training budget, buying missing goods; false when it cannot. */
export function planUnit(sim: Sim, w: Wallet, p: ProvinceIx, unit: UnitType, pool: Pool, out: Command[]): boolean {
  const cost = UNITS[unit].cost;
  const limit = poolLimit(w, pool);
  const trades: Command[] = [];
  const snapshot = { stocks: { ...w.stocks }, pressure: { ...w.pressure }, trades: w.trades };
  const spent = coverGoods(w, cost, limit, trades);
  if (spent === null || !affords(w, cost) || spent + (cost.funds ?? 0) > limit) {
    w.stocks = snapshot.stocks;
    w.pressure = snapshot.pressure;
    w.trades = snapshot.trades;
    return false;
  }
  out.push(...trades);
  payFrom(w, cost, 1);
  drawPool(w, pool, spent + (cost.funds ?? 0));
  w.queued.set(p, (w.queued.get(p) ?? 0) + 1);
  w.projectedUpkeep += UNITS[unit].upkeep.funds ?? 0;
  out.push({ kind: 'train', nation: w.n, province: p, unit, count: 1 });
  return true;
}

/** Items a queue holds once this think's plans apply. */
export function queueLength(sim: Sim, w: Wallet, p: ProvinceIx): number {
  return sim.state.provinces[p]!.queue.length + (w.queued.get(p) ?? 0);
}

/**
 * Tops every Training Ground queue up to QUEUE_TARGET items, each the unit
 * furthest below the target mix, until the training budget or a stock runs out,
 * or projected Funds upkeep would pass UPKEEP_CEILING of gross Funds.
 */
export function planTraining(sim: Sim, view: NationView): Command[] {
  const { state } = sim;
  const w = walletOf(sim, view);
  const n = view.nation;
  const capital = state.nations[n]!.capital;
  const out: Command[] = [];
  const counts = forceCounts(sim, n);
  const hardEnemy = enemyHardShare(sim, view) > AI.HUNTER_TRIGGER_HARD_SHARE;
  const oilNeed = AI.OIL_UNITS_NEED_DAYS * w.upkeep.oil;
  const oilOk = w.income.oil - w.upkeep.oil >= 0 || w.stocks.oil >= oilNeed;
  const sites = ownedProvinces(sim, n)
    .filter((p) => state.provinces[p]!.buildings.training > 0 && !isContested(sim, p))
    .sort((a, b) => (a === capital ? -1 : b === capital ? 1 : a - b));
  for (const p of sites) {
    const mix = targetMix(state.provinces[p]!.buildings.training, hardEnemy, oilOk);
    while (queueLength(sim, w, p) < AI.QUEUE_TARGET) {
      const unit = pickUnit(mix, counts);
      if (w.projectedUpkeep + (UNITS[unit].upkeep.funds ?? 0) > AI.UPKEEP_CEILING * w.income.funds) return out;
      if (!planUnit(sim, w, p, unit, 'train', out)) return out;
      counts[unit] += 1;
    }
  }
  return out;
}

// ------------------------------------------------------------------ market

/**
 * Threshold trades from the wallet: buy a good below MARKET_BUY_BELOW_DAYS of
 * consumption up to MARKET_BUY_TO_DAYS; sell above MARKET_SELL_ABOVE_DAYS down
 * to MARKET_SELL_TO_DAYS (never under the opening floor of the good) and never
 * below AUTO_SELL_MIN_FACTOR. At most MAX_TRADES_PER_THINK trades and
 * MARKET_MAX_FUNDS_SHARE of free Funds per think.
 */
export function marketStep(sim: Sim, w: Wallet): Command[] {
  const out: Command[] = [];
  // Purchases first: running out hurts more than holding too much.
  for (const good of GOODS) {
    const perDay = w.upkeep[good];
    if (w.trades >= AI.MAX_TRADES_PER_THINK || perDay <= 0 || w.stocks[good] >= AI.MARKET_BUY_BELOW_DAYS * perDay) continue;
    const budget = Math.min(w.market, w.stocks.funds - w.reserve);
    const amount = buyable(w, good, AI.MARKET_BUY_TO_DAYS * perDay - w.stocks[good], budget);
    if (amount >= MARKET.MIN_AUTO_TRADE) w.market -= book(w, good, amount, out);
  }
  for (const good of GOODS) {
    if (w.trades >= AI.MAX_TRADES_PER_THINK) break;
    const perDay = w.upkeep[good];
    const stock = w.stocks[good];
    if (stock <= Math.max(AI.MARKET_SELL_ABOVE_DAYS * perDay, START.GOODS_MIN[good])) continue;
    const keep = Math.max(AI.MARKET_SELL_TO_DAYS * perDay, START.GOODS_MIN[good]);
    const excess = Math.min(stock - keep, sellableToFactor(marketOf(w), good, MARKET.AUTO_SELL_MIN_FACTOR), MARKET.MAX_TRADE_DEPTH_SHARE * MARKET.DEPTH[good]);
    if (excess >= MARKET.MIN_AUTO_TRADE) book(w, good, -excess, out);
  }
  return out;
}

/** The market step for nation `n` on its own, against its current stocks. */
export function planMarket(sim: Sim, n: NationIx): Command[] {
  return marketStep(sim, freshWallet(sim, n));
}

/** The market step after this view's economy and training plans. */
export function planMarketAfter(sim: Sim, view: NationView): Command[] {
  return marketStep(sim, walletOf(sim, view));
}
