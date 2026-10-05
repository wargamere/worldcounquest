/**
 * View models for the UI (§11.5). Every function here reads the Sim and returns
 * plain data for a panel, a chip or a screen; none writes the GameState, so the
 * views run on deep-frozen state (views.test.ts). The forecasts and the advisor
 * they reuse count their work in cache.counters, and two per-tick memos below
 * live in a WeakMap; nothing else is touched.
 *
 * Components never read the Sim themselves: they ask the store's useSimView for
 * one of these, and every change goes back through store.command.
 */
import { ADVISOR, BUILDINGS, COMBAT, EFFECTS, GARRISON, MARKET, PROVINCE, TIME, UNITS, VICTORY } from './balance';
import { suggestForce, type Suggestion } from './ai/advisor';
import { threatAt } from './ai/assess';
import { armyStatus, isIdle } from './armies';
import { bestProvincesFor, buildingLabel, buildingPreview, type BuildingPreview } from './buildings';
import { armiesAt, armiesOf, armyById, inboundTo, isContested, ownedProvinces } from './cache';
import { dayOf, formatClock, formatDuration, hoursToTicks } from './clock';
import { battleInputAt, battleModifiers } from './combat';
import { daysLeft, nationRates, provinceOutput, recruitCap, STOCK_LABELS, type NationRates } from './economy';
import { predictBattle, verdictOf, winChance } from './forecast';
import { zeroUnits } from './keys';
import { priceFactor, quote, unitPrice } from './market';
import { etaTicks, planEta, planOrder } from './movement';
import { previewOrder } from './orders';
import { garrisonCap, stabilityFactor, statusOf } from './province';
import { isArmyVisible, isConnected, isSuppliedAt } from './supply';
import { canTrain, trainHours } from './training';
import { armySpeedKmh } from './travel';
import { BUILDING_TYPES, GOODS, STOCK_KEYS, UNIT_TYPES } from './types';
import type {
  Army,
  ArmyId,
  BuildingLevels,
  BuildingType,
  Construction,
  Cost,
  Difficulty,
  Forecast,
  Good,
  HistoryPoint,
  Modifier,
  NationIx,
  OrderPreview,
  PlayerStats,
  ProvinceIx,
  ProvinceStatus,
  Role,
  RoundReport,
  Sim,
  SimCache,
  Stance,
  StockKey,
  SurrenderRecord,
  Terrain,
  TrainingItem,
  UnitType,
  Units,
} from './types';
import { addUnits, maxHp, pacedBy, totalCount, totalHp, upkeepOf } from './units';
import { leadingRival, vpOf, vpShare } from './victory';

// ------------------------------------------------------------------ helpers

function provinceName(sim: Sim, p: ProvinceIx): string {
  return sim.map.provinces[p]?.name ?? '';
}

function nationName(sim: Sim, n: NationIx): string {
  return sim.map.nations[n]?.name ?? '';
}

function isHostile(sim: Sim, army: Army): boolean {
  return army.owner !== sim.state.player;
}

function visible(sim: Sim, army: Army, showAll: boolean): boolean {
  return showAll || isArmyVisible(sim, army);
}

/** Where an army's route ends: the last province of its path, or its current leg's end. */
function destinationOf(army: Army): ProvinceIx | null {
  const last = army.path[army.path.length - 1];
  if (last !== undefined) return last;
  return army.leg?.to ?? null;
}

/** Live forecasts and Attack with… suggestions, memoised per tick and army change (they are the costly reads). */
interface Memo {
  key: string;
  forecasts: Map<ProvinceIx, Forecast | null>;
  suggested: Map<ProvinceIx, ReadonlySet<ArmyId>>;
}
const memos = new WeakMap<SimCache, Memo>();

function memoOf(sim: Sim): Memo {
  const key = `${sim.state.tick}:${sim.cache.armyVersion}:${sim.cache.ownershipVersion}`;
  const known = memos.get(sim.cache);
  if (known !== undefined && known.key === key) return known;
  const fresh: Memo = { key, forecasts: new Map(), suggested: new Map() };
  memos.set(sim.cache, fresh);
  return fresh;
}

/** The forecast of the running battle at `p`, for the player if involved, else for its first attacker. */
function liveForecast(sim: Sim, p: ProvinceIx): Forecast | null {
  const memo = memoOf(sim);
  if (memo.forecasts.has(p)) return memo.forecasts.get(p) ?? null;
  const input = battleInputAt(sim, p);
  let forecast: Forecast | null = null;
  if (input !== null) {
    const player = sim.state.player;
    const involved = input.defender.nation === player || input.attackers.some((s) => s.nation === player);
    const forNation = involved ? player : (input.attackers[0]?.nation ?? input.defender.nation);
    const prediction = predictBattle(input, forNation, [], COMBAT.PREDICT_MAX_HOURS);
    const chance = winChance(input, forNation, [], COMBAT.WIN_CHANCE_SAMPLES);
    forecast = { ...prediction, winChance: chance, verdict: verdictOf(chance), modifiers: battleModifiers(input), fogged: false };
  }
  memo.forecasts.set(p, forecast);
  return forecast;
}

export const VERDICT_LABEL: Readonly<Record<Forecast['verdict'], string>> = {
  decisive: 'Decisive',
  likely: 'Likely',
  close: 'Close',
  unlikely: 'Unlikely',
  hopeless: 'Hopeless',
};

// ---------------------------------------------------------------------- HUD

export interface StockChip {
  key: StockKey;
  amount: number;
  netPerDay: number;
  daysLeft: number | null;
  short: boolean;
  cap: number | null;
  auto: boolean;
}
export interface HudView {
  nation: string;
  colour: string;
  clock: string;
  chips: StockChip[];
  vp: number;
  vpShare: number;
  goalVp: number;
  rival: { name: string; colour: string; vp: number } | null;
  incoming: number;
  battles: number;
  idle: number;
}

function isGood(key: StockKey): key is Good {
  return (GOODS as readonly string[]).includes(key);
}

export function hudView(sim: Sim, showAll: boolean): HudView {
  const { state, map } = sim;
  const n = state.player;
  const nation = state.nations[n]!;
  const rates = nationRates(sim, n);
  const chips: StockChip[] = STOCK_KEYS.map((key) => {
    const amount = nation.stocks[key];
    const net = rates.net[key];
    return {
      key,
      amount,
      netPerDay: net,
      daysLeft: key === 'recruits' ? null : daysLeft(amount, net),
      short: key === 'recruits' ? false : nation.shortage[key],
      cap: key === 'recruits' ? recruitCap(sim, n) : null,
      auto: isGood(key) && (nation.trade.keepDays[key] > 0 || nation.trade.sellAboveDays[key] > 0),
    };
  });
  const rival = leadingRival(sim);
  return {
    nation: nationName(sim, n),
    colour: nation.colour,
    clock: formatClock(state.tick),
    chips,
    vp: vpOf(sim, n),
    vpShare: vpShare(sim, n),
    goalVp: map.goalVp,
    rival: rival === null ? null : { name: nationName(sim, rival.nation), colour: state.nations[rival.nation]!.colour, vp: rival.vp },
    incoming: incomingArmies(sim, showAll).length,
    battles: playerBattles(sim).length,
    idle: idleArmies(sim).length,
  };
}

/** The breakdown behind one resource chip (§3.9). */
export interface StockView {
  key: StockKey;
  amount: number;
  cap: number | null;
  income: number;
  upkeep: number;
  net: number;
  daysLeft: number | null;
  short: boolean;
  byStatus: { status: ProvinceStatus; amount: number }[];
  worksBonus: number;
  top: { province: ProvinceIx; name: string; amount: number }[];
  upkeepByUnit: { unit: UnitType; amount: number }[];
  training: number;
  price: { buy: number; sell: number; factor: number; history: number[] } | null;
  effect: string;
}

const SHORTAGE_EFFECT: Readonly<Record<StockKey, string>> = {
  funds: 'Treasury empty: armies lose 3% a day, building and training pause.',
  recruits: 'No Recruits: no training until they regenerate.',
  food: 'Out of Food: armies lose 3% a day and every province loses 2 stability a day.',
  steel: 'Out of Steel: nothing that needs Steel can start.',
  oil: 'Out of Oil: tanks and motor rifles at half speed and 70% damage.',
};

function amountOf(key: StockKey, out: { funds: number; recruits: number; good: Good; goods: number }): number {
  if (key === 'funds') return out.funds;
  if (key === 'recruits') return out.recruits;
  return out.good === key ? out.goods : 0;
}

export function stockView(sim: Sim, key: StockKey): StockView {
  const { state, map } = sim;
  const n = state.player;
  const nation = state.nations[n]!;
  const rates = nationRates(sim, n);
  const byStatus = new Map<ProvinceStatus, number>();
  let worksBonus = 0;
  const producers: { province: ProvinceIx; name: string; amount: number }[] = [];
  for (const p of ownedProvinces(sim, n)) {
    const out = provinceOutput(sim, p);
    const amount = amountOf(key, out);
    if (amount <= 0) continue;
    const status = statusOf(sim, p);
    byStatus.set(status, (byStatus.get(status) ?? 0) + amount);
    const works = state.provinces[p]!.buildings.works;
    if (works > 0 && (key === 'funds' || key === out.good)) {
      const share = (key === 'funds' ? EFFECTS.WORKS_FUNDS_PER_LEVEL : EFFECTS.WORKS_GOODS_PER_LEVEL) * works;
      worksBonus += amount - amount / (1 + share);
    }
    producers.push({ province: p, name: map.provinces[p]!.name, amount });
  }
  producers.sort((a, b) => b.amount - a.amount || a.province - b.province);
  const upkeepByUnit: { unit: UnitType; amount: number }[] = [];
  for (const unit of UNIT_TYPES) {
    const per = UNITS[unit].upkeep[key] ?? 0;
    if (per === 0) continue;
    let count = 0;
    for (const army of armiesOf(sim, n)) if (army.alive) count += army.units[unit].count;
    if (count > 0) upkeepByUnit.push({ unit, amount: per * count });
  }
  let training = 0;
  for (const p of ownedProvinces(sim, n)) for (const item of state.provinces[p]!.queue) training += item.paid[key] ?? 0;
  const market = state.market;
  const price = isGood(key)
    ? {
        buy: unitPrice(market, key) * MARKET.BUY_FEE,
        sell: unitPrice(market, key) * MARKET.SELL_FEE,
        factor: priceFactor(market.pressure[key], key),
        history: market.history.map((h) => h[key]),
      }
    : null;
  const statuses: ProvinceStatus[] = ['home', 'integrated', 'occupied'];
  return {
    key,
    amount: nation.stocks[key],
    cap: key === 'recruits' ? recruitCap(sim, n) : null,
    income: rates.income[key],
    upkeep: rates.upkeep[key],
    net: rates.net[key],
    daysLeft: key === 'recruits' ? null : daysLeft(nation.stocks[key], rates.net[key]),
    short: key === 'recruits' ? false : nation.shortage[key],
    byStatus: statuses.filter((s) => byStatus.has(s)).map((status) => ({ status, amount: byStatus.get(status) ?? 0 })),
    worksBonus,
    top: producers.slice(0, 5),
    upkeepByUnit,
    training,
    price,
    effect: SHORTAGE_EFFECT[key],
  };
}

// ---------------------------------------------------------------- province

export interface BuildingRow {
  type: BuildingType;
  label: string;
  level: number;
  maxLevel: number;
  preview: BuildingPreview;
}
export interface TrainOption {
  unit: UnitType;
  hours: number;
  cost: Cost;
  reason: string | null;
}
export interface ProvinceView {
  id: ProvinceIx;
  name: string;
  owner: NationIx;
  status: ProvinceStatus;
  integratesInDays: number | null;
  blockedBy: string | null;
  output: { funds: number; good: Good; goods: number; recruits: number };
  stability: number;
  stabilityTarget: number;
  garrison: number;
  garrisonCap: number;
  supplied: boolean;
  buildings: BuildingRow[];
  queue: TrainingItem[];
  trainable: UnitType[];
  keepTraining: boolean;
  rally: ProvinceIx | null;
  armies: ArmyId[];
  battle: boolean;
  foreign: boolean;
  /** Header and detail beyond the §11.5 core. */
  city: string | null;
  ownerName: string;
  ownerColour: string;
  country: NationIx;
  countryName: string;
  terrain: Terrain;
  oilField: boolean;
  vp: number;
  /** The owner's current seat. */
  seat: boolean;
  originalCapital: boolean;
  connected: boolean;
  garrisonRegenPerDay: number;
  stabilityNotes: string[];
  construction: Construction | null;
  trainingLevel: number;
  trainOptions: TrainOption[];
  rallyName: string | null;
  /** The keep-training repeat waiting for a stock, e.g. "Steel". */
  waitingFor: string | null;
  ramparts: number;
  visibleUnits: number;
}

function integration(sim: Sim, p: ProvinceIx, status: ProvinceStatus): { days: number | null; blockedBy: string | null } {
  if (status !== 'occupied') return { days: null, blockedBy: null };
  const { map, state } = sim;
  const country = map.provinces[p]!.country;
  if (state.nations[country]!.alive) return { days: null, blockedBy: `${nationName(sim, country)} fights on — cannot integrate` };
  const due = state.provinces[p]!.heldSince + PROVINCE.INTEGRATION_DAYS * TIME.TICKS_PER_DAY;
  return { days: Math.max(0, Math.ceil((due - state.tick) / TIME.TICKS_PER_DAY)), blockedBy: null };
}

function stabilityNotes(sim: Sim, p: ProvinceIx, status: ProvinceStatus): string[] {
  const { state } = sim;
  const province = state.provinces[p]!;
  const target = PROVINCE.STABILITY_TARGET[status];
  const notes = [`${status === 'home' ? 'Home' : status === 'integrated' ? 'Integrated' : 'Occupied'} land drifts toward ${target}, ${PROVINCE.STABILITY_DRIFT_PER_DAY} points a day.`];
  if (isContested(sim, p)) notes.push(`${PROVINCE.STABILITY_PER_BATTLE_HOUR} for every hour of battle here.`);
  if (state.nations[province.owner]!.shortage.food) notes.push(`${PROVINCE.STABILITY_HUNGER_PER_DAY} a day while Food is short.`);
  notes.push(`Output ×${stabilityFactor(province.stability).toFixed(2)} at this stability.`);
  return notes;
}

function waitingFor(sim: Sim, p: ProvinceIx): string | null {
  const province = sim.state.provinces[p]!;
  const head = province.queue[0];
  if (head === undefined || head.started || Object.keys(head.paid).length > 0) return null;
  const stocks = sim.state.nations[province.owner]!.stocks;
  const cost = UNITS[head.unit].cost;
  for (const key of STOCK_KEYS) if ((cost[key] ?? 0) > stocks[key]) return STOCK_LABELS[key];
  return null;
}

/** Everything the Province panel shows; `showAll` lifts the fog on the armies listed. */
export function provinceView(sim: Sim, p: ProvinceIx, showAll = false): ProvinceView {
  const { map, state } = sim;
  const fact = map.provinces[p]!;
  const province = state.provinces[p]!;
  const player = state.player;
  const owner = province.owner;
  const status = statusOf(sim, p);
  const contested = isContested(sim, p);
  const cap = garrisonCap(sim, p);
  const { days, blockedBy } = integration(sim, p, status);
  const output = provinceOutput(sim, p);
  const armies = armiesAt(sim, p).filter((a) => a.alive && a.leg === null && visible(sim, a, showAll));
  const level = province.buildings.training;
  const trainable = level > 0 ? UNIT_TYPES.filter((u) => UNITS[u].trainingLevel <= level) : [];
  const regen = contested ? 0 : Math.min(Math.max(0, cap - province.garrison), cap * GARRISON.REGEN_SHARE_PER_DAY * stabilityFactor(province.stability));
  return {
    id: p,
    name: fact.name,
    owner,
    status,
    integratesInDays: days,
    blockedBy,
    output: { funds: output.funds, good: output.good, goods: output.goods, recruits: output.recruits },
    stability: province.stability,
    stabilityTarget: PROVINCE.STABILITY_TARGET[status],
    garrison: province.garrison,
    garrisonCap: cap,
    supplied: isSuppliedAt(sim, owner, p),
    buildings: BUILDING_TYPES.map((type) => ({
      type,
      label: buildingLabel(type, fact.good),
      level: province.buildings[type],
      maxLevel: BUILDINGS[type].levels.length,
      preview: buildingPreview(sim, player, p, type),
    })),
    queue: province.queue,
    trainable,
    keepTraining: province.keepTraining,
    rally: province.rally,
    armies: armies.map((a) => a.id),
    battle: contested,
    foreign: owner !== player,
    city: fact.city?.name ?? null,
    ownerName: nationName(sim, owner),
    ownerColour: state.nations[owner]!.colour,
    country: fact.country,
    countryName: nationName(sim, fact.country),
    terrain: fact.terrain,
    oilField: fact.oilField,
    vp: fact.vp,
    seat: state.nations[owner]!.capital === p,
    originalCapital: fact.isCapital,
    connected: isConnected(sim, owner, p),
    garrisonRegenPerDay: regen,
    stabilityNotes: stabilityNotes(sim, p, status),
    construction: province.construction,
    trainingLevel: level,
    trainOptions: trainable.map((unit) => {
      const check = canTrain(sim, player, p, unit, 1);
      return { unit, hours: trainHours(sim, p, unit), cost: UNITS[unit].cost, reason: check.ok ? null : check.reason };
    }),
    rallyName: province.rally === null ? null : provinceName(sim, province.rally),
    waitingFor: waitingFor(sim, p),
    ramparts: province.buildings.ramparts,
    visibleUnits: armies.reduce((sum, a) => sum + totalCount(a.units), 0),
  };
}

// -------------------------------------------------------------------- armies

export interface ArmyView {
  ids: ArmyId[];
  name: string;
  units: Units;
  totalUnits: number;
  hp: number;
  maxHp: number;
  speedKmh: number;
  pacedBy: UnitType | null;
  upkeep: Cost;
  supplied: boolean;
  stance: Stance;
  retreatAt: number;
  status: string;
  etaTicks: number | null;
  canMerge: boolean;
  inBattle: boolean;
  /** Beyond the §11.5 core: what the panel's buttons need. */
  ours: boolean;
  owner: NationIx;
  ownerName: string;
  at: ProvinceIx;
  atName: string;
  moving: boolean;
  idle: boolean;
  canSplit: boolean;
  /** Own idle armies standing with this one (itself included) that a merge would join; empty below 2. */
  mergeable: ArmyId[];
  rows: { id: ArmyId; name: string; units: number; eta: number | null; status: string; at: ProvinceIx }[];
}

/** One army's status line (§8.3). */
function statusLine(sim: Sim, army: Army): string {
  const { state } = sim;
  const status = armyStatus(sim, army);
  const here = provinceName(sim, army.at);
  if (status === 'fighting') {
    const forecast = army.owner === state.player ? liveForecast(sim, army.at) : null;
    if (forecast === null) return `Fighting in ${here}`;
    const hours = forecast.winner === 'undecided' ? '' : `, about ${formatDuration(hoursToTicks(forecast.hours))}`;
    return `Fighting in ${here} — ${VERDICT_LABEL[forecast.verdict]}${hours}`;
  }
  if (status === 'frozen') return `Handed over — free to move in ${formatDuration(army.departAt - state.tick)}`;
  if (status === 'waiting') return `Waiting ${formatDuration(army.departAt - state.tick)} to arrive together`;
  if (status === 'idle') return `Idle in ${here}`;
  const to = destinationOf(army);
  const where = to === null ? here : provinceName(sim, to);
  if (army.intent === 'retreat') return `Falling back to ${where}`;
  const eta = etaTicks(sim, army);
  const verb = army.intent === 'attack' ? 'Attacking' : 'Marching to';
  return eta === null ? `${verb} ${where}` : `${verb} ${where} — arrives in ${formatDuration(eta)}`;
}

/** Own idle armies standing where `army` stands, ascending id; empty unless at least two. */
function mergeableAt(sim: Sim, army: Army): ArmyId[] {
  const ids = armiesAt(sim, army.at)
    .filter((a) => a.alive && a.owner === army.owner && isIdle(sim, a))
    .map((a) => a.id);
  return ids.length >= 2 ? ids : [];
}

/** Where an army is, for framing it: the end of its leg while moving. */
export function armyLocation(sim: Sim, id: ArmyId): ProvinceIx | null {
  const army = armyById(sim, id);
  if (army === undefined || !army.alive) return null;
  return army.leg?.to ?? army.at;
}

export function armyView(sim: Sim, ids: readonly ArmyId[]): ArmyView | null {
  const { state } = sim;
  const armies = ids.map((id) => armyById(sim, id)).filter((a): a is Army => a !== undefined && a.alive);
  const first = armies[0];
  if (first === undefined) return null;
  const units = zeroUnits();
  for (const army of armies) addUnits(units, army.units);
  let speed = Number.POSITIVE_INFINITY;
  let slowest = first;
  for (const army of armies) {
    const s = armySpeedKmh(sim, army);
    if (s < speed) {
      speed = s;
      slowest = army;
    }
  }
  const etas = armies.map((a) => etaTicks(sim, a)).filter((e): e is number => e !== null);
  const ours = first.owner === state.player;
  const standing = armies.every((a) => a.leg === null && a.battle === null);
  const together = armies.every((a) => a.at === first.at);
  const statuses = armies.map((a) => armyStatus(sim, a));
  let status: string;
  if (armies.length === 1) status = statusLine(sim, first);
  else {
    const counts = new Map<string, number>();
    for (const s of statuses) counts.set(s, (counts.get(s) ?? 0) + 1);
    status = [...counts].map(([s, c]) => `${c} ${s}`).join(' · ');
  }
  return {
    ids: armies.map((a) => a.id),
    name: armies.length === 1 ? first.name : `${armies.length} armies`,
    units,
    totalUnits: totalCount(units),
    hp: totalHp(units),
    maxHp: maxHp(units),
    speedKmh: speed === Number.POSITIVE_INFINITY ? 0 : speed,
    pacedBy: pacedBy(slowest.units, state.nations[slowest.owner]!.shortage.oil),
    upkeep: upkeepOf(units),
    supplied: armies.every((a) => isSuppliedAt(sim, a.owner, a.at)),
    stance: first.stance,
    retreatAt: first.retreatAt,
    status,
    etaTicks: etas.length > 0 ? Math.max(...etas) : null,
    canMerge: ours && armies.length >= 2 && standing && together,
    inBattle: armies.some((a) => a.battle !== null),
    ours,
    owner: first.owner,
    ownerName: nationName(sim, first.owner),
    at: first.at,
    atName: provinceName(sim, first.at),
    moving: armies.some((a) => a.leg !== null || a.path.length > 0),
    idle: statuses.every((s) => s === 'idle'),
    canSplit: ours && armies.length === 1 && statuses[0] === 'idle' && totalCount(first.units) >= 2,
    mergeable: ours && together && standing ? mergeableAt(sim, first) : [],
    rows: armies.map((a) => ({ id: a.id, name: a.name, units: totalCount(a.units), eta: etaTicks(sim, a), status: statusLine(sim, a), at: a.at })),
  };
}

/** Compact rows for lists of armies ("Armies here", reinforcements), in the order given. */
export function armyRows(sim: Sim, ids: readonly ArmyId[]): { id: ArmyId; name: string; owner: NationIx; ownerName: string; colour: string; units: number; ours: boolean; status: string }[] {
  const { state } = sim;
  const out: { id: ArmyId; name: string; owner: NationIx; ownerName: string; colour: string; units: number; ours: boolean; status: string }[] = [];
  for (const id of ids) {
    const army = armyById(sim, id);
    if (army === undefined || !army.alive) continue;
    out.push({
      id,
      name: army.name,
      owner: army.owner,
      ownerName: nationName(sim, army.owner),
      colour: state.nations[army.owner]!.colour,
      units: totalCount(army.units),
      ours: army.owner === state.player,
      status: army.owner === state.player ? statusLine(sim, army) : armyStatus(sim, army),
    });
  }
  return out;
}

// -------------------------------------------------------------------- battle

export interface BattleView {
  province: ProvinceIx;
  hours: number;
  sides: { nation: NationIx; role: Role; hp: number; startHp: number; dealt: number; taken: number; directions: number }[];
  garrison: number;
  modifiers: Modifier[];
  log: RoundReport[];
  forecast: Forecast | null;
  reinforcements: { army: ArmyId; nation: NationIx; inTicks: number }[];
  /** Beyond the §11.5 core. */
  name: string;
  names: Record<number, { name: string; colour: string }>;
  mine: ArmyId[];
}

/** Reinforcements due within this many hours are listed. */
const REINFORCEMENT_HOURS = 12;

export function battleView(sim: Sim, p: ProvinceIx): BattleView | null {
  const { state } = sim;
  const input = battleInputAt(sim, p);
  if (input === null) return null;
  const province = state.provinces[p]!;
  const log = sim.cache.battleLog.get(p) ?? [];
  const lastRound = log[log.length - 1];
  const standing = armiesAt(sim, p).filter((a) => a.alive && a.leg === null);
  const sides = [input.defender, ...input.attackers].map((side) => {
    const armies = standing.filter((a) => a.owner === side.nation);
    const hp = totalHp(side.units) + side.garrison;
    const started = armies.reduce((sum, a) => sum + (a.battle?.startHp ?? totalHp(a.units)), 0) + side.garrison;
    const round = lastRound?.sides.find((s) => s.nation === side.nation);
    return { nation: side.nation, role: side.role, hp, startHp: Math.max(hp, started), dealt: round?.dealt ?? 0, taken: round?.taken ?? 0, directions: side.directions };
  });
  const names: Record<number, { name: string; colour: string }> = {};
  for (const side of sides) names[side.nation] = { name: nationName(sim, side.nation), colour: state.nations[side.nation]!.colour };
  const horizon = hoursToTicks(REINFORCEMENT_HOURS);
  const reinforcements: { army: ArmyId; nation: NationIx; inTicks: number }[] = [];
  for (const army of inboundTo(sim, p)) {
    if (!army.alive || army.leg === null || !isArmyVisible(sim, army)) continue;
    const inTicks = army.leg.ticks - army.leg.done;
    if (inTicks <= horizon) reinforcements.push({ army: army.id, nation: army.owner, inTicks });
  }
  reinforcements.sort((a, b) => a.inTicks - b.inTicks || a.army - b.army);
  return {
    province: p,
    hours: province.battleSince === null ? 0 : Math.floor((state.tick - province.battleSince) / TIME.TICKS_PER_HOUR),
    sides,
    garrison: input.defender.garrison,
    modifiers: battleModifiers(input),
    log,
    forecast: liveForecast(sim, p),
    reinforcements,
    name: provinceName(sim, p),
    names,
    mine: standing.filter((a) => a.owner === state.player).map((a) => a.id),
  };
}

// ------------------------------------------------------------ Attack with…

export interface AttackWithRow {
  army: ArmyId;
  etaTicks: number;
  units: number;
  direction: ProvinceIx | null;
  suggested: boolean;
  /** Beyond the §11.5 core. */
  name: string;
  directionName: string | null;
}

/** The player's armies that reach `target` within ADVISOR.ATTACK_WITH_MAX_HOURS, nearest first, suggestForce's picks ticked. */
export function attackWithView(sim: Sim, target: ProvinceIx): AttackWithRow[] {
  const { state } = sim;
  const n = state.player;
  if (state.provinces[target]!.owner === n) return [];
  const memo = memoOf(sim);
  let suggested = memo.suggested.get(target);
  if (suggested === undefined) {
    suggested = new Set(suggestForce(sim, target)?.armies ?? []);
    memo.suggested.set(target, suggested);
  }
  const limit = hoursToTicks(ADVISOR.ATTACK_WITH_MAX_HOURS);
  const rows: AttackWithRow[] = [];
  for (const army of armiesOf(sim, n)) {
    if (!army.alive || army.battle !== null || armyStatus(sim, army) === 'frozen') continue;
    const plans = planOrder(sim, n, [army.id], target, false);
    if (typeof plans === 'string') continue;
    const plan = plans.find((x) => x.army === army.id);
    if (plan === undefined || plan.path.nodes.length === 0) continue;
    const eta = planEta(sim, plan);
    if (eta > limit) continue;
    rows.push({
      army: army.id,
      etaTicks: eta,
      units: totalCount(army.units),
      direction: plan.approach,
      suggested: suggested.has(army.id),
      name: army.name,
      directionName: plan.approach === null ? null : provinceName(sim, plan.approach),
    });
  }
  rows.sort((a, b) => a.etaTicks - b.etaTicks || a.army - b.army);
  return rows;
}

/** Names and verbs the Order sheet shows for a preview. */
export interface OrderView {
  targetName: string;
  ownerName: string;
  ownerColour: string;
  verb: 'Attack' | 'Move';
  routes: { army: ArmyId; name: string; etaTicks: number; departInTicks: number; hostile: number; approachName: string | null; groupSize: number }[];
  approaches: string[];
}

export function orderView(sim: Sim, preview: OrderPreview): OrderView {
  const { state } = sim;
  const owner = state.provinces[preview.to]!.owner;
  // Members of an implicit merge share one route from the same place and leave together.
  const groupKey = (r: OrderPreview['routes'][number]): string => `${armyById(sim, r.army)?.at ?? -1}|${r.nodes.join(',')}|${r.departInTicks}`;
  const groups = new Map<string, number>();
  for (const route of preview.routes) groups.set(groupKey(route), (groups.get(groupKey(route)) ?? 0) + 1);
  const approaches = new Set<string>();
  for (const route of preview.routes) if (route.approach !== null) approaches.add(provinceName(sim, route.approach));
  return {
    targetName: provinceName(sim, preview.to),
    ownerName: nationName(sim, owner),
    ownerColour: state.nations[owner]!.colour,
    verb: preview.intent === 'attack' ? 'Attack' : 'Move',
    routes: preview.routes.map((route) => ({
      army: route.army,
      name: armyById(sim, route.army)?.name ?? '',
      etaTicks: route.departInTicks + route.ticks,
      departInTicks: route.departInTicks,
      hostile: route.hostileCrossings,
      approachName: route.approach === null ? null : provinceName(sim, route.approach),
      groupSize: groups.get(groupKey(route)) ?? 1,
    })),
    approaches: [...approaches],
  };
}

// ----------------------------------------------------------------- economy

export function economyView(sim: Sim): {
  rates: NationRates;
  days: Partial<Record<StockKey, number | null>>;
  topProducers: { province: ProvinceIx; funds: number; goods: number; good: Good }[];
  buildingCounts: BuildingLevels;
} {
  const { state } = sim;
  const n = state.player;
  const rates = nationRates(sim, n);
  const stocks = state.nations[n]!.stocks;
  const days: Partial<Record<StockKey, number | null>> = {};
  for (const key of STOCK_KEYS) if (key !== 'recruits') days[key] = daysLeft(stocks[key], rates.net[key]);
  const producers = ownedProvinces(sim, n).map((p) => {
    const out = provinceOutput(sim, p);
    return { province: p, funds: out.funds, goods: out.goods, good: out.good };
  });
  producers.sort((a, b) => b.funds - a.funds || a.province - b.province);
  const buildingCounts = { works: 0, training: 0, ramparts: 0, roads: 0, draft: 0 };
  for (const p of ownedProvinces(sim, n)) for (const b of BUILDING_TYPES) buildingCounts[b] += state.provinces[p]!.buildings[b];
  return { rates, days, topProducers: producers.slice(0, 5), buildingCounts };
}

export function exchangeView(sim: Sim): {
  good: Good;
  stock: number;
  netPerDay: number;
  buy: number;
  sell: number;
  factor: number;
  history: number[];
  policy: { keepDays: number; sellAboveDays: number };
}[] {
  const { state } = sim;
  const n = state.player;
  const nation = state.nations[n]!;
  const rates = nationRates(sim, n);
  const market = state.market;
  return GOODS.map((good) => ({
    good,
    stock: nation.stocks[good],
    netPerDay: rates.net[good],
    buy: unitPrice(market, good) * MARKET.BUY_FEE,
    sell: unitPrice(market, good) * MARKET.SELL_FEE,
    factor: priceFactor(market.pressure[good], good),
    history: market.history.map((h) => h[good]),
    policy: { keepDays: nation.trade.keepDays[good], sellAboveDays: nation.trade.sellAboveDays[good] },
  }));
}

export function productionView(sim: Sim): { province: ProvinceIx; level: number; queue: TrainingItem[]; keepTraining: boolean; rally: ProvinceIx | null }[] {
  const { state } = sim;
  const out: { province: ProvinceIx; level: number; queue: TrainingItem[]; keepTraining: boolean; rally: ProvinceIx | null }[] = [];
  for (const p of ownedProvinces(sim, state.player)) {
    const province = state.provinces[p]!;
    if (province.buildings.training === 0) continue;
    out.push({ province: p, level: province.buildings.training, queue: province.queue, keepTraining: province.keepTraining, rally: province.rally });
  }
  return out;
}

/** Every construction in progress on the player's land, for the Production drawer. */
export function constructionsView(sim: Sim): { province: ProvinceIx; name: string; label: string; construction: Construction }[] {
  const { state, map } = sim;
  const out: { province: ProvinceIx; name: string; label: string; construction: Construction }[] = [];
  for (const p of ownedProvinces(sim, state.player)) {
    const construction = state.provinces[p]!.construction;
    if (construction !== null) out.push({ province: p, name: map.provinces[p]!.name, label: buildingLabel(construction.building, map.provinces[p]!.good), construction });
  }
  return out;
}

// --------------------------------------------------------------- standings

export function standingsView(
  sim: Sim,
  limit: number,
): { nation: NationIx; name: string; colour: string; vp: number; share: number; provinces: number; units: number; fundsPerDay: number }[] {
  const { state } = sim;
  const alive = state.nations.filter((n) => n.alive);
  alive.sort((a, b) => vpOf(sim, b.ix) - vpOf(sim, a.ix) || a.ix - b.ix);
  const top = alive.slice(0, Math.max(0, limit));
  const player = state.nations[state.player]!;
  if (player.alive && !top.includes(player)) top.push(player);
  return top.map((nation) => ({
    nation: nation.ix,
    name: nationName(sim, nation.ix),
    colour: nation.colour,
    vp: vpOf(sim, nation.ix),
    share: vpShare(sim, nation.ix),
    provinces: ownedProvinces(sim, nation.ix).length,
    units: armiesOf(sim, nation.ix).reduce((sum, a) => sum + (a.alive ? totalCount(a.units) : 0), 0),
    fundsPerDay: nationRates(sim, nation.ix).income.funds,
  }));
}

/** The history chart: VP share per day for the player and the 3 leading rivals of the latest point. */
export interface HistorySeries {
  nation: NationIx;
  name: string;
  colour: string;
  you: boolean;
  points: { day: number; share: number }[];
}
const CHART_RIVALS = 3;

export function historyView(sim: Sim): { goalShare: number; series: HistorySeries[] } {
  return historyFrom(sim, sim.state.history);
}

function historyFrom(sim: Sim, history: readonly HistoryPoint[]): { goalShare: number; series: HistorySeries[] } {
  const { state, map } = sim;
  const total = map.totalVp > 0 ? map.totalVp : 1;
  const latest = history[history.length - 1];
  const rivals = (latest?.vp ?? [])
    .filter(([n]) => n !== state.player)
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, CHART_RIVALS)
    .map(([n]) => n);
  const series = [state.player, ...rivals].map((n) => ({
    nation: n,
    name: n === state.player ? 'You' : nationName(sim, n),
    colour: state.nations[n]!.colour,
    you: n === state.player,
    points: history.flatMap((point) => {
      const entry = point.vp.find(([m]) => m === n);
      return entry === undefined ? [] : [{ day: point.day, share: entry[1] / total }];
    }),
  }));
  return { goalShare: VICTORY.VP_SHARE, series };
}

// ---------------------------------------------------------------- the map

export function tooltipView(
  sim: Sim,
  p: ProvinceIx,
  showAll: boolean,
): { name: string; owner: string; status: ProvinceStatus; terrain: Terrain; good: Good; garrison: number; visibleUnits: number } {
  const { map, state } = sim;
  const fact = map.provinces[p]!;
  let units = 0;
  for (const army of armiesAt(sim, p)) if (army.alive && army.leg === null && visible(sim, army, showAll)) units += totalCount(army.units);
  return {
    name: fact.name,
    owner: nationName(sim, state.provinces[p]!.owner),
    status: statusOf(sim, p),
    terrain: fact.terrain,
    good: fact.good,
    garrison: state.provinces[p]!.garrison,
    visibleUnits: units,
  };
}

/** The player's idle armies, the most threatened province first (ties to the lower id). */
export function idleArmies(sim: Sim): ArmyId[] {
  const n = sim.state.player;
  const threat = new Map<ProvinceIx, number>();
  const idle = armiesOf(sim, n).filter((a) => isIdle(sim, a));
  for (const army of idle) if (!threat.has(army.at)) threat.set(army.at, threatAt(sim, n, army.at).f);
  idle.sort((a, b) => (threat.get(b.at) ?? 0) - (threat.get(a.at) ?? 0) || a.id - b.id);
  return idle.map((a) => a.id);
}

/** Hostile armies on legs toward the player's land, soonest first. */
export function incomingArmies(sim: Sim, showAll: boolean): ArmyId[] {
  const { state } = sim;
  const out: { id: ArmyId; eta: number }[] = [];
  for (const army of state.armies) {
    if (!army.alive || army.leg === null || !isHostile(sim, army)) continue;
    const to = destinationOf(army);
    const towardUs = state.provinces[army.leg.to]!.owner === state.player || (to !== null && state.provinces[to]!.owner === state.player);
    if (!towardUs || !visible(sim, army, showAll)) continue;
    out.push({ id: army.id, eta: army.leg.ticks - army.leg.done });
  }
  out.sort((a, b) => a.eta - b.eta || a.id - b.id);
  return out.map((x) => x.id);
}

/** Running battles on the player's land or with the player's armies, ascending. */
export function playerBattles(sim: Sim): ProvinceIx[] {
  const { state } = sim;
  const player = state.player;
  return sim.cache.battles.filter((p) => state.provinces[p]!.owner === player || armiesAt(sim, p).some((a) => a.alive && a.owner === player));
}

// ------------------------------------------------------------------- the end

export function endView(
  sim: Sim,
  playedMs: number,
): { headline: string; day: number; playedMs: number; stats: PlayerStats; surrenders: SurrenderRecord[]; history: HistoryPoint[] } {
  const { state } = sim;
  let headline = 'The war goes on';
  if (state.status === 'won') headline = 'Hegemony achieved';
  else if (state.status === 'lost') {
    const rival = leadingRival(sim);
    if (rival !== null && rival.vp >= sim.map.goalVp) headline = `${nationName(sim, rival.nation)} rules the world`;
    else {
      const fell = state.feed.find((e) => e.kind === 'provinceLost' && e.province !== null);
      const where = fell?.province ?? null;
      headline = where === null ? 'Your nation has fallen' : `Your nation has fallen — the last stand was ${provinceName(sim, where)}`;
    }
  }
  return { headline, day: dayOf(state.endedAt ?? state.tick), playedMs, stats: state.stats, surrenders: state.surrenders, history: state.history };
}

/** The end screen's extras: hour, peaks and the five biggest surrenders with names. */
export function endDetails(sim: Sim): {
  clock: string;
  difficulty: Difficulty;
  seed: string;
  finalShare: number;
  peakShare: number;
  provinces: number;
  surrendered: { name: string; day: number; vp: number }[];
  largestBattle: { name: string; day: number; hp: number } | null;
  chart: { goalShare: number; series: HistorySeries[] };
} {
  const { state, map } = sim;
  const n = state.player;
  const total = map.totalVp > 0 ? map.totalVp : 1;
  const top = [...state.surrenders].sort((a, b) => b.vp - a.vp || a.tick - b.tick).slice(0, 5);
  const largest = state.stats.largestBattle;
  return {
    clock: formatClock(state.endedAt ?? state.tick),
    difficulty: state.difficulty,
    seed: state.seed,
    finalShare: vpShare(sim, n),
    peakShare: state.stats.peakVp / total,
    provinces: ownedProvinces(sim, n).length,
    surrendered: top.map((s) => ({ name: nationName(sim, s.loser), day: dayOf(s.tick), vp: s.vp })),
    largestBattle: largest === null ? null : { name: provinceName(sim, largest.province), day: dayOf(largest.tick), hp: largest.hp },
    chart: historyFrom(sim, state.history),
  };
}

// ------------------------------------------------------------ the Exchange

export interface TradeOption {
  /** Signed: positive buys, negative sells. */
  amount: number;
  funds: number;
  factorAfter: number;
  label: string;
  reason: string | null;
}

/** Bisection steps for the largest affordable purchase. */
const MAX_BUY_STEPS = 40;

/** The Exchange buttons for one good: Buy/Sell 100, 1,000 and Max, each with a live quote (§8.3). */
export function tradeOptions(sim: Sim, good: Good): { buy: TradeOption[]; sell: TradeOption[] } {
  const { state } = sim;
  const stocks = state.nations[state.player]!.stocks;
  const market = state.market;
  const cap = MARKET.MAX_TRADE_DEPTH_SHARE * MARKET.DEPTH[good];
  let lo = 0;
  let hi = cap;
  if (quote(market, good, hi).funds > stocks.funds) {
    for (let i = 0; i < MAX_BUY_STEPS; i += 1) {
      const mid = (lo + hi) / 2;
      if (quote(market, good, mid).funds <= stocks.funds) lo = mid;
      else hi = mid;
    }
    hi = lo;
  }
  const maxBuy = Math.floor(hi);
  const maxSell = Math.floor(Math.min(stocks[good], cap));
  const option = (amount: number, label: string, side: 'buy' | 'sell'): TradeOption => {
    const q = quote(market, good, amount);
    let reason: string | null = null;
    if (side === 'buy' && (amount === 0 || q.funds > stocks.funds)) reason = 'Not enough Funds';
    else if (side === 'sell' && (amount === 0 || -q.amount > stocks[good])) reason = `Not enough ${STOCK_LABELS[good]}`;
    return { amount: q.amount, funds: q.funds, factorAfter: q.factorAfter, label, reason };
  };
  return {
    buy: [...MARKET.TRADE_STEPS.map((a) => option(a, `Buy ${a.toLocaleString('en-US')}`, 'buy')), option(maxBuy, 'Buy max', 'buy')],
    sell: [...MARKET.TRADE_STEPS.map((a) => option(-a, `Sell ${a.toLocaleString('en-US')}`, 'sell')), option(-maxSell, 'Sell max', 'sell')],
  };
}

// ------------------------------------------------------- Build in best N

/** "Build in best N" (§8.3): the player's provinces ranked by bestProvincesFor, with names. */
export function bestBuildView(sim: Sim, b: BuildingType, count: number): { province: ProvinceIx; name: string; label: string; preview: BuildingPreview }[] {
  const { map, state } = sim;
  return bestProvincesFor(sim, state.player, b, count).map(({ province, preview }) => ({
    province,
    name: map.provinces[province]!.name,
    label: buildingLabel(b, map.provinces[province]!.good),
    preview,
  }));
}

// ------------------------------------------------------------- the coach

/** Names the onboarding cards fill in (§8.7). */
export function coachHints(sim: Sim): {
  nation: string;
  firstArmy: string | null;
  capital: string | null;
  works: { province: ProvinceIx; name: string; label: string; paybackDays: number | null } | null;
} {
  const { state, map } = sim;
  const n = state.player;
  const capital = state.nations[n]!.capital;
  const armies = armiesOf(sim, n).filter((a) => a.alive);
  const first = armies.find((a) => a.at === capital) ?? armies[0];
  const best = bestProvincesFor(sim, n, 'works', 1)[0];
  return {
    nation: nationName(sim, n),
    firstArmy: first?.name ?? null,
    capital: capital === null ? null : provinceName(sim, capital),
    works:
      best === undefined
        ? null
        : { province: best.province, name: map.provinces[best.province]!.name, label: buildingLabel('works', map.provinces[best.province]!.good), paybackDays: best.preview.paybackDays },
  };
}

// ---------------------------------------------------------------- Suggest

/** One card's sentence (§6.9), e.g. "Take Alsace with 2nd and 5th Army — Likely 85%, arrive together in 11 h, flank ×2". */
export function suggestionText(sim: Sim, card: Suggestion): string {
  const name = (p: ProvinceIx): string => sim.map.provinces[p]?.name ?? '';
  const armies = (ids: readonly ArmyId[]): string => {
    const names = armyRows(sim, ids).map((a) => a.name);
    return names.length <= 1 ? (names[0] ?? 'an army') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  };
  switch (card.kind) {
    case 'attack': {
      const f = card.forecast;
      const flank = card.plan.directions > 1 ? `, flank ×${card.plan.directions}` : '';
      const together = card.plan.armies.length > 1 ? 'arrive together in' : 'arrives in';
      return `Take ${name(card.plan.target)} with ${armies(card.plan.armies)} — ${VERDICT_LABEL[f.verdict]} ${Math.round(f.winChance * 20) * 5}%, ${together} ${formatDuration(card.plan.etaTicks)}${flank}`;
    }
    case 'defend': {
      const eta = previewOrder(sim, sim.state.player, card.armies, card.province, true).arriveInTicks;
      return `${name(card.province)} is threatened — send ${armies(card.armies)} (${formatDuration(eta)})`;
    }
    case 'build':
      return `${buildingLabel(card.building, sim.map.provinces[card.province]!.good)} in ${name(card.province)} pay back in ${Math.ceil(card.paybackDays)} days`;
    case 'train':
      return `Training Ground idle in ${name(card.province)} — train ${UNITS[card.unit].name}`;
    case 'market':
      return `${STOCK_LABELS[card.good]} is running low — buy ${Math.round(card.amount).toLocaleString('en-US')} for ${Math.round(card.funds).toLocaleString('en-US')}`;
  }
}

// --------------------------------------------------------------- the start

/** A recommended start's card on the Start screen, read from a fresh game for that nation. */
export function nationSummary(
  sim: Sim,
  n: NationIx,
): { name: string; provinces: number; vp: number; fundsPerDay: number; goods: Record<Good, number>; units: number; capital: string } {
  const rates = nationRates(sim, n);
  const capital = sim.state.nations[n]!.capital;
  return {
    name: nationName(sim, n),
    provinces: ownedProvinces(sim, n).length,
    vp: vpOf(sim, n),
    fundsPerDay: rates.income.funds,
    goods: { food: rates.income.food, steel: rates.income.steel, oil: rates.income.oil },
    units: armiesOf(sim, n).reduce((sum, a) => sum + (a.alive ? totalCount(a.units) : 0), 0),
    capital: capital === null ? '' : provinceName(sim, capital),
  };
}
