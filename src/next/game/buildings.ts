/**
 * The five province buildings (§3.4): costs, construction, the preview every
 * building card shows, and the "Build in best N" ranking.
 *
 * One construction per province. The full cost is paid at the start and a
 * cancel refunds CONSTRUCTION_CANCEL_REFUND. Progress is one hour per game hour
 * and pauses while the province is contested or its owner is short of Funds.
 */
import { BUILDINGS, EFFECTS } from './balance';
import { isContested, markIncomeDirty, ownedProvinces } from './cache';
import { baseOutput, pay, refund, shortfallReason } from './economy';
import { pushFeed } from './feed';
import { asProvince } from './ids';
import { unitPrice } from './market';
import { zeroStocks } from './keys';
import { statusOf } from './province';
import { BUILDING_TYPES } from './types';
import type { BuildingLevels, BuildingType, CommandResult, Cost, Good, NationIx, ProvinceIx, Sim, Stocks } from './types';

const OK: CommandResult = { ok: true, armies: [] };

function levelSpec(b: BuildingType, level: number): (typeof BUILDINGS)[BuildingType]['levels'][number] {
  const spec = BUILDINGS[b].levels[level - 1];
  if (spec === undefined) throw new RangeError(`${BUILDINGS[b].name} has no level ${level}`);
  return spec;
}

/** Funds and Steel to build `level` (1-based). */
export function buildCost(b: BuildingType, level: number): Cost {
  return { ...levelSpec(b, level).cost };
}

export function buildHours(b: BuildingType, level: number): number {
  return levelSpec(b, level).hours;
}

/** Works is named after the province's good: Farms, Mines or Oil Wells. */
export function buildingLabel(b: BuildingType, good: Good): string {
  return b === 'works' ? EFFECTS.WORKS_LABEL[good] : BUILDINGS[b].name;
}

/** Everything that rules a building out except its price. */
function placementReason(sim: Sim, n: NationIx, p: ProvinceIx, b: BuildingType): string | null {
  const province = sim.state.provinces[p];
  if (province === undefined || province.owner !== n) return 'Not your province';
  const label = buildingLabel(b, sim.map.provinces[p]!.good);
  if (province.buildings[b] >= BUILDINGS[b].levels.length) return `${label} is fully built`;
  if (BUILDINGS[b].homeOnly && statusOf(sim, p) === 'occupied') return 'Home provinces only';
  if (isContested(sim, p)) return 'Cannot build during a battle';
  const current = province.construction;
  if (current !== null) return `Already building ${buildingLabel(current.building, sim.map.provinces[p]!.good)}`;
  return null;
}

export function canBuild(sim: Sim, n: NationIx, p: ProvinceIx, b: BuildingType): CommandResult {
  const placement = placementReason(sim, n, p, b);
  if (placement !== null) return { ok: false, reason: placement };
  const cost = buildCost(b, sim.state.provinces[p]!.buildings[b] + 1);
  const short = shortfallReason(sim.state.nations[n]!.stocks, cost);
  return short === null ? OK : { ok: false, reason: short };
}

export function startConstruction(sim: Sim, n: NationIx, p: ProvinceIx, b: BuildingType): CommandResult {
  const check = canBuild(sim, n, p, b);
  if (!check.ok) return check;
  const province = sim.state.provinces[p]!;
  const level = province.buildings[b] + 1;
  const cost = buildCost(b, level);
  pay(sim, n, cost);
  const hours = buildHours(b, level);
  province.construction = { building: b, level, hoursLeft: hours, hoursTotal: hours, paid: cost };
  return OK;
}

export function cancelConstruction(sim: Sim, n: NationIx, p: ProvinceIx): CommandResult {
  const province = sim.state.provinces[p];
  if (province === undefined || province.owner !== n) return { ok: false, reason: 'Not your province' };
  if (province.construction === null) return { ok: false, reason: 'Nothing is being built' };
  refund(sim, n, province.construction.paid, EFFECTS.CONSTRUCTION_CANCEL_REFUND);
  province.construction = null;
  return OK;
}

/** Hourly: one hour of progress per construction; completions raise the level. */
export function progressConstruction(sim: Sim): void {
  const { map, state } = sim;
  for (let i = 0; i < state.provinces.length; i += 1) {
    const province = state.provinces[i]!;
    const job = province.construction;
    if (job === null) continue;
    const p = asProvince(i);
    if (isContested(sim, p) || state.nations[province.owner]!.shortage.funds) continue;
    job.hoursLeft -= 1;
    if (job.hoursLeft > 0) continue;
    province.buildings[job.building] = job.level;
    province.construction = null;
    markIncomeDirty(sim, province.owner);
    // A Training Ground can become the supply root of a nation without a capital.
    if (job.building === 'training') sim.cache.supplyDirty[province.owner] = true;
    if (province.owner === state.player) {
      pushFeed(sim, {
        kind: 'constructionDone',
        severity: 'good',
        text: `${buildingLabel(job.building, map.provinces[i]!.good)} ${job.level} completed in ${map.provinces[i]!.name}`,
        nations: [province.owner],
        province: p,
        army: null,
      });
    }
  }
}

export interface BuildingPreview {
  level: number;
  cost: Cost;
  hours: number;
  deltaPerDay: Stocks;
  paybackDays: number | null;
  reason: string | null;
}

/** Funds value per day of an output change, at current Exchange prices. */
function valuePerDay(sim: Sim, delta: Stocks): number {
  const { market } = sim.state;
  return delta.funds + delta.food * unitPrice(market, 'food') + delta.steel * unitPrice(market, 'steel') + delta.oil * unitPrice(market, 'oil');
}

function costValue(sim: Sim, cost: Cost): number {
  const { market } = sim.state;
  return (cost.funds ?? 0) + (cost.food ?? 0) * unitPrice(market, 'food') + (cost.steel ?? 0) * unitPrice(market, 'steel') + (cost.oil ?? 0) * unitPrice(market, 'oil');
}

/** The daily output one more level would add, ignoring a running battle. Only Works and Draft Office change output. */
function outputDelta(sim: Sim, p: ProvinceIx, b: BuildingType, level: number): Stocks {
  const delta = zeroStocks();
  if (b !== 'works' && b !== 'draft') return delta;
  const current = sim.state.provinces[p]!.buildings;
  const next: BuildingLevels = { ...current, [b]: level };
  const before = baseOutput(sim, p, current);
  const after = baseOutput(sim, p, next);
  delta.funds = after.funds - before.funds;
  delta.recruits = after.recruits - before.recruits;
  delta[after.good] = after.goods - before.goods;
  return delta;
}

function canBuildReason(sim: Sim, n: NationIx, p: ProvinceIx, b: BuildingType): string | null {
  const result = canBuild(sim, n, p, b);
  return result.ok ? null : result.reason;
}

/**
 * The next level's card: cost, hours, the daily gain, payback days at current
 * Exchange prices (Works only) and why it cannot be built now, if it cannot.
 * A fully built row shows its top level with no cost.
 */
export function buildingPreview(sim: Sim, n: NationIx, p: ProvinceIx, b: BuildingType): BuildingPreview {
  const current = sim.state.provinces[p]!.buildings[b];
  const max = BUILDINGS[b].levels.length;
  if (current >= max) {
    return { level: current, cost: {}, hours: 0, deltaPerDay: zeroStocks(), paybackDays: null, reason: canBuildReason(sim, n, p, b) };
  }
  const level = current + 1;
  const cost = buildCost(b, level);
  const deltaPerDay = outputDelta(sim, p, b, level);
  const gain = valuePerDay(sim, deltaPerDay);
  const paybackDays = b === 'works' && gain > 0 ? costValue(sim, cost) / gain : null;
  return { level, cost, hours: buildHours(b, level), deltaPerDay, paybackDays, reason: canBuildReason(sim, n, p, b) };
}

/**
 * Where `n` could build `b` now, best first: daily gain per Funds of cost (gain
 * valued at Exchange prices; Draft Office by Recruits per Funds), then the more
 * populous province, then the lower index. Price is not a filter, so the list
 * still shows options the nation cannot yet afford (their reason says why).
 */
export function bestProvincesFor(sim: Sim, n: NationIx, b: BuildingType, count: number): { province: ProvinceIx; preview: BuildingPreview }[] {
  const ranked: { province: ProvinceIx; preview: BuildingPreview; score: number }[] = [];
  for (const p of ownedProvinces(sim, n)) {
    if (placementReason(sim, n, p, b) !== null) continue;
    const preview = buildingPreview(sim, n, p, b);
    const gain = b === 'draft' ? preview.deltaPerDay.recruits : valuePerDay(sim, preview.deltaPerDay);
    const price = costValue(sim, preview.cost);
    ranked.push({ province: p, preview, score: price > 0 ? gain / price : 0 });
  }
  const population = (p: ProvinceIx): number => sim.map.provinces[p]!.population;
  ranked.sort((x, y) => y.score - x.score || population(y.province) - population(x.province) || x.province - y.province);
  return ranked.slice(0, Math.max(0, count)).map(({ province, preview }) => ({ province, preview }));
}

/** On capture (not capitulation): Works and Ramparts lose CAPTURE_LEVEL_LOSS levels. */
export function damageOnCapture(sim: Sim, p: ProvinceIx): void {
  const province = sim.state.provinces[p]!;
  let changed = false;
  for (const b of BUILDING_TYPES) {
    const loss = EFFECTS.CAPTURE_LEVEL_LOSS[b];
    if (loss === 0 || province.buildings[b] === 0) continue;
    province.buildings[b] = Math.max(0, province.buildings[b] - loss);
    changed = true;
  }
  if (changed) markIncomeDirty(sim, province.owner);
}
