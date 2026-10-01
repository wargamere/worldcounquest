/**
 * Production, upkeep, stocks and shortages (§3.1–3.3, §3.6).
 *
 * Gross income per nation is cached in cache.income and recomputed only by
 * accrueHour, for nations marked dirty (ownership, buildings, status, capital
 * and stability). Every input marks the owner dirty, so a clean entry always
 * equals a fresh computation from the state: a loaded game, whose cache starts
 * empty, continues exactly as if it had never been saved. Read-only callers
 * compute a dirty nation's income on the fly without storing it, so whether the
 * UI looked first can never change what the simulation does. The cache holds uncontested output; a running
 * battle's province is subtracted when rates are taken, because battles start
 * and end without marking anything dirty.
 */
import { DIFFICULTY, ECONOMY, EFFECTS, PROVINCE, TIME } from './balance';
import { armiesOf, isContested, ownedProvinces } from './cache';
import { pushFeed, raiseAlert } from './feed';
import { zeroStocks } from './keys';
import { stabilityFactor, statusOf } from './province';
import { recordStat } from './stats';
import { STOCK_KEYS } from './types';
import type { BuildingLevels, Cost, Good, NationIx, ProvinceIx, Sim, StockKey, Stocks } from './types';
import { upkeepOf } from './units';

const HOURS_PER_DAY = TIME.TICKS_PER_DAY / TIME.TICKS_PER_HOUR;
/** The stocks that can run short; Recruits are capped instead. */
const SHORTAGE_KEYS = ['funds', 'food', 'steel', 'oil'] as const;
type ShortageKey = (typeof SHORTAGE_KEYS)[number];

export const STOCK_LABELS: Readonly<Record<StockKey, string>> = {
  funds: 'Funds',
  recruits: 'Recruits',
  food: 'Food',
  steel: 'Steel',
  oil: 'Oil',
};

export interface ProvinceOutput {
  funds: number;
  recruits: number;
  good: Good;
  goods: number;
}

/**
 * Output per day as if the province were not contested, optionally with other
 * building levels (the building preview asks "what would one more level give").
 */
export function baseOutput(sim: Sim, p: ProvinceIx, buildings?: BuildingLevels): ProvinceOutput {
  const { state } = sim;
  const fact = sim.map.provinces[p]!;
  const province = state.provinces[p]!;
  const levels = buildings ?? province.buildings;
  const owner = state.nations[province.owner]!;
  const status = statusOf(sim, p);
  const sf = stabilityFactor(province.stability);
  const ai = owner.isPlayer ? 1 : DIFFICULTY[state.difficulty].aiOutput;
  const capital = owner.capital === p ? 1 + ECONOMY.CAPITAL_FUNDS_BONUS : 1;
  const output = PROVINCE.OUTPUT[status] * sf * ai;
  return {
    funds: fact.fundsBase * output * (1 + EFFECTS.WORKS_FUNDS_PER_LEVEL * levels.works) * capital,
    recruits: fact.recruitsBase * PROVINCE.RECRUITS[status] * sf * (1 + EFFECTS.DRAFT_RECRUITS_PER_LEVEL * levels.draft),
    good: fact.good,
    goods: fact.goodsBase * output * (1 + EFFECTS.WORKS_GOODS_PER_LEVEL * levels.works),
  };
}

/** Output per day; a contested province produces nothing. */
export function provinceOutput(sim: Sim, p: ProvinceIx): ProvinceOutput {
  if (isContested(sim, p)) return { funds: 0, recruits: 0, good: sim.map.provinces[p]!.good, goods: 0 };
  return baseOutput(sim, p);
}

function addOutput(into: Stocks, out: ProvinceOutput, sign: number): void {
  into.funds += sign * out.funds;
  into.recruits += sign * out.recruits;
  into[out.good] += sign * out.goods;
}

function grossIncome(sim: Sim, n: NationIx): Stocks {
  const income = zeroStocks();
  for (const p of ownedProvinces(sim, n)) addOutput(income, baseOutput(sim, p), 1);
  return income;
}

/** The cached gross income, or a fresh one (not stored) while the nation is dirty. */
function incomeOf(sim: Sim, n: NationIx): Stocks {
  const { cache } = sim;
  return cache.incomeDirty[n] === true ? grossIncome(sim, n) : cache.income[n]!;
}

/** Upkeep per day of every living army. */
function nationUpkeep(sim: Sim, n: NationIx): Stocks {
  const total = zeroStocks();
  for (const army of armiesOf(sim, n)) {
    if (!army.alive) continue;
    const cost = upkeepOf(army.units);
    for (const key of STOCK_KEYS) total[key] += cost[key] ?? 0;
  }
  return total;
}

export interface NationRates {
  income: Stocks;
  upkeep: Stocks;
  net: Stocks;
}

function ratesFrom(sim: Sim, n: NationIx, gross: Stocks): NationRates {
  const income = { ...gross };
  for (const p of sim.cache.battles) {
    if (sim.state.provinces[p]!.owner === n) addOutput(income, baseOutput(sim, p), -1);
  }
  const upkeep = nationUpkeep(sim, n);
  const net = zeroStocks();
  for (const key of STOCK_KEYS) net[key] = income[key] - upkeep[key];
  return { income, upkeep, net };
}

/** Income (contested provinces excluded), upkeep and net, per day. */
export function nationRates(sim: Sim, n: NationIx): NationRates {
  if (sim.state.nations[n]?.alive !== true) return { income: zeroStocks(), upkeep: zeroStocks(), net: zeroStocks() };
  return ratesFrom(sim, n, incomeOf(sim, n));
}

/** Recruits bank at most RECRUIT_CAP_DAYS of regeneration, and never less than RECRUIT_CAP_MIN. */
export function recruitCap(sim: Sim, n: NationIx): number {
  return Math.max(ECONOMY.RECRUIT_CAP_MIN, ECONOMY.RECRUIT_CAP_DAYS * incomeOf(sim, n).recruits);
}

function shortageText(key: ShortageKey): string {
  const pct = (share: number): string => `${Math.round(share * 100)}%`;
  if (key === 'funds') return `Treasury empty: armies lose ${pct(ECONOMY.UNPAID_ATTRITION_PER_DAY)} a day`;
  if (key === 'food') return `Out of Food: armies lose ${pct(ECONOMY.HUNGER_ATTRITION_PER_DAY)} a day and provinces grow restless`;
  if (key === 'oil') return `Out of Oil: tanks and motor rifles at ${pct(ECONOMY.OIL_SHORT_SPEED)} speed`;
  return 'Out of Steel: nothing that needs Steel can start';
}

function listed(words: readonly string[]): string {
  return words.length <= 1 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]!}`;
}

/** One entry per hour for the stocks that ran out, one for those restored: same-kind entries would coalesce anyway. */
function reportShortages(sim: Sim, n: NationIx, started: ShortageKey[], ended: ShortageKey[]): void {
  const entry = { province: null, army: null, nations: [n] };
  if (started.length > 0) {
    pushFeed(sim, { ...entry, kind: 'shortage', severity: 'critical', text: started.map(shortageText).join('; ') });
    raiseAlert(sim, { kind: 'shortage', province: null, nation: n });
  }
  if (ended.length > 0) {
    pushFeed(sim, { ...entry, kind: 'shortageEnded', severity: 'good', text: `${listed(ended.map((key) => STOCK_LABELS[key]))} supplies restored` });
  }
}

/**
 * One game hour of income and upkeep for every living nation, ascending: a stock
 * that would fall below 0 is clamped and flagged; the flag clears once the stock
 * covers SHORTAGE_CLEARS_AT_DAYS of consumption. Oil re-timing is left to the
 * caller, which compares the Oil flags before and after (economy.ts sits below
 * movement.ts in the import graph).
 */
export function accrueHour(sim: Sim): void {
  const { state, cache } = sim;
  for (let i = 0; i < state.nations.length; i += 1) {
    const nation = state.nations[i]!;
    if (!nation.alive) continue;
    const n = nation.ix;
    if (cache.incomeDirty[n] === true) {
      cache.income[n] = grossIncome(sim, n);
      cache.incomeDirty[n] = false;
    }
    const rates = ratesFrom(sim, n, cache.income[n]!);
    const { stocks, shortage } = nation;
    const started: ShortageKey[] = [];
    const ended: ShortageKey[] = [];
    for (const key of SHORTAGE_KEYS) {
      const next = stocks[key] + rates.net[key] / HOURS_PER_DAY;
      const was = shortage[key];
      if (next < 0) {
        stocks[key] = 0;
        shortage[key] = true;
      } else {
        stocks[key] = next;
        if (was && next >= ECONOMY.SHORTAGE_CLEARS_AT_DAYS * rates.upkeep[key]) shortage[key] = false;
      }
      if (shortage[key] !== was) (was ? ended : started).push(key);
    }
    if (nation.isPlayer) reportShortages(sim, n, started, ended);
    const cap = recruitCap(sim, n);
    if (stocks.recruits < cap) stocks.recruits = Math.min(cap, stocks.recruits + rates.income.recruits / HOURS_PER_DAY);
    if (nation.isPlayer) recordStat(sim, 'fundsEarned', rates.income.funds / HOURS_PER_DAY);
  }
}

export function canAfford(stocks: Stocks, cost: Cost): boolean {
  return STOCK_KEYS.every((key) => (cost[key] ?? 0) <= stocks[key]);
}

/** What is still needed to pay `cost`, by key; only keys that fall short appear. */
export function missing(stocks: Stocks, cost: Cost): Cost {
  const out: Cost = {};
  for (const key of STOCK_KEYS) {
    const gap = (cost[key] ?? 0) - stocks[key];
    if (gap > 0) out[key] = gap;
  }
  return out;
}

function groupThousands(value: number): string {
  return Math.ceil(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** "Needs 20 more Steel" for the first stock that falls short, or null when affordable. */
export function shortfallReason(stocks: Stocks, cost: Cost): string | null {
  const gap = missing(stocks, cost);
  for (const key of STOCK_KEYS) {
    const amount = gap[key];
    if (amount !== undefined) return `Needs ${groupThousands(amount)} more ${STOCK_LABELS[key]}`;
  }
  return null;
}

/** Pays the whole cost, or nothing when any part is short. */
export function pay(sim: Sim, n: NationIx, cost: Cost): boolean {
  const stocks = sim.state.nations[n]!.stocks;
  if (!canAfford(stocks, cost)) return false;
  for (const key of STOCK_KEYS) stocks[key] -= cost[key] ?? 0;
  return true;
}

export function refund(sim: Sim, n: NationIx, cost: Cost, share: number): void {
  const stocks = sim.state.nations[n]!.stocks;
  for (const key of STOCK_KEYS) stocks[key] += (cost[key] ?? 0) * share;
}

export function scaleCost(cost: Cost, k: number): Cost {
  const out: Cost = {};
  for (const key of STOCK_KEYS) {
    const amount = cost[key];
    if (amount !== undefined) out[key] = amount * k;
  }
  return out;
}

/** Days until the stock runs out at this net rate, or null when it is not falling. */
export function daysLeft(stock: number, netPerDay: number): number | null {
  if (netPerDay >= 0) return null;
  return Math.max(0, stock) / -netPerDay;
}
