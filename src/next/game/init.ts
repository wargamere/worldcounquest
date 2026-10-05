/**
 * The opening world (§2.7, §3.8): every province Home at full stability and
 * garrison, the starting buildings, the starting armies and stocks, and the AI
 * tiers (ranked as the scheduler ranks them). createGame is a pure function of the map and the options, so a seed
 * and a nation always give the same first frame.
 *
 * Starting stocks and army sizes are sized on income *before* the starting
 * buildings, which is how the §3.3 calibration and the §3.8 worked opening
 * (France: Funds 8,544, Food 564, Steel 153, Oil 120) were computed.
 */
import { DIFFICULTY, START } from './balance';
import { reviewTiers } from './ai/scheduler';
import { createArmy, defaultStance } from './armies';
import { createCache } from './cache';
import { assignColours } from './colours';
import { nationRates } from './economy';
import { defaultTradePolicy, emptyStats, noBuildings, noShortage, zeroGoods, zeroStocks } from './keys';
import { garrisonCap } from './province';
import { seedFromString } from './rng';
import { GOODS, STOCK_KEYS, UNIT_TYPES } from './types';
import type { Difficulty, GameState, MapStatic, Nation, NationIx, Province, ProvinceIx, Sim, Stocks, UnitCounts, UnitType } from './types';
import { totalCount, unitsFromCounts, upkeepOf } from './units';
import { countryGraph } from './world';

export interface NewGameOptions {
  playerCountryId: string;
  difficulty: Difficulty;
  seed: string;
}

/** Whole units per type summing to `total`, by the largest-remainder rule (ties to the canonical type order). */
function composition(total: number, mix: Readonly<Record<UnitType, number>>): Record<UnitType, number> {
  const counts: Record<UnitType, number> = { rifles: 0, hunters: 0, motor: 0, guns: 0, tanks: 0 };
  const remainders: { type: UnitType; rest: number; order: number }[] = [];
  let assigned = 0;
  UNIT_TYPES.forEach((type, order) => {
    const exact = total * mix[type];
    counts[type] = Math.floor(exact);
    assigned += counts[type];
    remainders.push({ type, rest: exact - counts[type], order });
  });
  remainders.sort((a, b) => b.rest - a.rest || a.order - b.order);
  for (let i = 0; i < total - assigned; i += 1) counts[remainders[i % remainders.length]!.type] += 1;
  return counts;
}

/** Half of each type (rounded half up) stands in the capital; the rest is the field force. */
function capitalShare(counts: Record<UnitType, number>): { capital: UnitCounts; rest: UnitCounts } {
  const capital: UnitCounts = {};
  const rest: UnitCounts = {};
  for (const type of UNIT_TYPES) {
    const here = Math.round(counts[type] * START.CAPITAL_ARMY_SHARE);
    capital[type] = here;
    rest[type] = counts[type] - here;
  }
  return { capital, rest };
}

/** Deals the field force out one unit at a time, type by type, over `armies` armies. */
function dealOut(rest: UnitCounts, armies: number): UnitCounts[] {
  const out: UnitCounts[] = [];
  for (let i = 0; i < armies; i += 1) out.push({});
  let next = 0;
  for (const type of UNIT_TYPES) {
    for (let k = 0; k < (rest[type] ?? 0); k += 1) {
      const army = out[next % armies]!;
      army[type] = (army[type] ?? 0) + 1;
      next += 1;
    }
  }
  return out;
}

/** Home provinces other than the capital, most foreign neighbours first (ties to the lower index). */
function borderProvinces(map: MapStatic, n: NationIx): ProvinceIx[] {
  const nation = map.nations[n]!;
  const foreign = (p: ProvinceIx): number => map.edges[p]!.filter((e) => map.provinces[e.to]!.country !== n).length;
  return nation.home.filter((p) => p !== nation.capital).sort((a, b) => foreign(b) - foreign(a) || a - b);
}

function startingProvinces(map: MapStatic): Province[] {
  return map.provinces.map((fact) => ({
    owner: fact.country,
    garrison: 0,
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
  }));
}

function startingNations(map: MapStatic, player: NationIx): Nation[] {
  const colours = assignColours(
    map.nations.map((nation) => nation.id),
    countryGraph(map),
    map.nations[player]!.id,
  );
  return map.nations.map((ns) => ({
    ix: ns.ix,
    alive: true,
    isPlayer: ns.ix === player,
    tier: 'minor',
    colour: colours[ns.id]!,
    stocks: zeroStocks(),
    capital: ns.capital,
    shortage: noShortage(),
    trade: defaultTradePolicy(ns.ix === player),
    armySerial: 0,
    ai: { nextThink: 0, alertAt: null, provoked: false, operations: [] },
    eliminatedAt: null,
  }));
}

/** The §2.7 / §3.8 starting buildings. */
function placeBuildings(map: MapStatic, state: GameState): void {
  for (const ns of map.nations) {
    const capital = state.provinces[ns.capital]!.buildings;
    capital.ramparts = START.CAPITAL_RAMPARTS;
    capital.training = START.TRAINING_LEVEL_BY_TIER[ns.tier] ?? 1;
    if (ns.tier >= START.CAPITAL_WORKS_MIN_TIER) capital.works = 1;
    if (ns.home.length < START.SECOND_TRAINING_AT_PROVINCES) continue;
    let best: ProvinceIx | null = null;
    for (const p of ns.home) {
      if (p === ns.capital) continue;
      if (best === null || map.provinces[p]!.population > map.provinces[best]!.population) best = p;
    }
    if (best !== null) state.provinces[best]!.buildings.training = Math.max(1, state.provinces[best]!.buildings.training);
  }
}

/** Stocks per §3.8 from the pre-building income and the starting army's upkeep. */
function startingStocks(isPlayer: boolean, difficulty: Difficulty, income: Stocks, upkeep: Stocks): Stocks {
  const fundsDays = isPlayer ? DIFFICULTY[difficulty].playerFundsDays : START.AI_FUNDS_DAYS;
  const stocks = zeroStocks();
  stocks.funds = fundsDays * income.funds;
  stocks.recruits = START.RECRUIT_DAYS * income.recruits;
  for (const good of GOODS) {
    stocks[good] = Math.max(START.GOODS_DAYS * income[good], START.GOODS_CONSUMPTION_DAYS * upkeep[good] + START.GOODS_MIN[good]);
  }
  return stocks;
}

function upkeepPerDay(counts: Record<UnitType, number>): Stocks {
  const total = zeroStocks();
  const cost = upkeepOf(unitsFromCounts(counts));
  for (const key of STOCK_KEYS) total[key] = cost[key] ?? 0;
  return total;
}

/** A new game: the player's nation, difficulty and seed decide everything else. */
export function createGame(map: MapStatic, options: NewGameOptions): GameState {
  const player = map.nationById.get(options.playerCountryId);
  if (player === undefined) throw new Error(`createGame: no nation with id ${options.playerCountryId}`);
  const { difficulty } = options;
  const state: GameState = {
    format: 5,
    seed: options.seed,
    tick: 0,
    rng: seedFromString(options.seed),
    difficulty,
    player,
    status: 'playing',
    endedAt: null,
    sandbox: false,
    provinces: startingProvinces(map),
    nations: startingNations(map, player),
    armies: [],
    nextArmyId: 1,
    market: { pressure: zeroGoods(), history: [] },
    feed: [],
    nextFeedId: 1,
    stats: emptyStats(),
    history: [],
    surrenders: [],
  };
  const sim: Sim = { map, state, cache: createCache(map, state, false) };

  // Income before any building, as the calibration assumes.
  const income = map.nations.map((ns) => ({ ...nationRates(sim, ns.ix).income }));
  placeBuildings(map, state);
  for (let p = 0; p < map.provinces.length; p += 1) state.provinces[p]!.garrison = garrisonCap(sim, map.provinces[p]!.ix);

  for (const ns of map.nations) {
    const n = ns.ix;
    const isPlayer = n === player;
    const base = Math.round(START.UNITS_BASE + START.UNITS_PER_SQRT_FUNDS * Math.sqrt(Math.max(0, income[n]!.funds)));
    const total = isPlayer ? Math.round(base * DIFFICULTY[difficulty].playerArmyMultiplier) : base;
    const counts = composition(total, START.MIX_BY_TIER[ns.tier] ?? START.MIX_BY_TIER[1]!);
    state.nations[n]!.stocks = startingStocks(isPlayer, difficulty, income[n]!, upkeepPerDay(counts));

    const { capital, rest } = capitalShare(counts);
    const field = UNIT_TYPES.reduce((sum, type) => sum + (rest[type] ?? 0), 0);
    const borders = borderProvinces(map, n);
    const armies = Math.min(START.MAX_BORDER_ARMIES, borders.length, field);
    const capitalUnits = armies === 0 ? counts : capital;
    const stance = defaultStance(sim, n);
    const guard = unitsFromCounts(capitalUnits);
    if (totalCount(guard) > 0) {
      const army = createArmy(sim, n, ns.capital, guard, stance);
      // An AI capital guard fights to the end (§6.7); the player's keeps the player default.
      if (!isPlayer) army.retreatAt = 0;
    }
    if (armies === 0) continue;
    dealOut(rest, armies).forEach((units, i) => createArmy(sim, n, borders[i]!, unitsFromCounts(units), stance));
  }
  // The same ranking and stagger the scheduler's tick-0 review applies, so the opening state is already consistent.
  reviewTiers(sim);
  return state;
}

