/**
 * The save codec: GameState to a compact JSON document and back.
 *
 * Provinces are stored struct-of-arrays and armies as positional tuples; the
 * rest is written as plain objects in a fixed key order, so two states that are
 * equal serialize to the same bytes whatever order their objects were built in.
 * JSON doubles round-trip exactly, which makes load-then-continue identical to
 * never having saved. The derived SimCache is never saved.
 *
 * `deserialize` validates the format, the map hash, array lengths, index ranges
 * and enum codes, and returns null for anything it cannot trust.
 */
import { BUILDINGS, FEED, SAVE } from './balance';
import { asArmy, asNation, asProvince } from './ids';
import { noBuildings, zeroUnits } from './keys';
import { BUILDING_TYPES, STOCK_KEYS, UNIT_TYPES } from './types';
import type {
  AiMemory,
  AiTier,
  Army,
  ArmyBattle,
  ArmyId,
  Construction,
  Cost,
  Difficulty,
  FeedEntry,
  FeedKind,
  GameState,
  GameStatus,
  GoodAmounts,
  HistoryPoint,
  Intent,
  Leg,
  MapStatic,
  Market,
  Nation,
  NationIx,
  PlayerStats,
  Province,
  ProvinceIx,
  Severity,
  ShortageFlags,
  Stance,
  Stocks,
  SurrenderRecord,
  TrainingItem,
  UnitType,
} from './types';

export interface SaveMeta {
  savedAt: number;
  playedMs: number;
}

/** Feed entries kept when a save exceeds SAVE.HARD_MAX_BYTES (spec §10). */
const TRIMMED_FEED_ENTRIES = 50;

// Enum code tables: the index is the saved code, so their order is part of the format.
const INTENTS: readonly Intent[] = ['move', 'attack', 'retreat', 'rally'];
const STANCES: readonly Stance[] = ['manual', 'defend', 'delegate'];
const DIFFICULTIES: readonly Difficulty[] = ['relaxed', 'standard', 'ruthless'];
const STATUSES: readonly GameStatus[] = ['playing', 'won', 'lost'];
const TIERS: readonly AiTier[] = ['major', 'minor'];
const SEVERITIES: readonly Severity[] = ['info', 'good', 'bad', 'critical'];
/** Exhaustive by construction: the compiler rejects a missing or unknown kind. */
const FEED_KIND_TABLE: Record<FeedKind, true> = {
  battleStarted: true,
  battleWon: true,
  battleLost: true,
  defenceHeld: true,
  provinceCaptured: true,
  provinceLost: true,
  capitalLost: true,
  capitalMoved: true,
  capitulation: true,
  eliminated: true,
  enemySighted: true,
  armyDestroyed: true,
  retreated: true,
  routeBlocked: true,
  unitsReady: true,
  constructionDone: true,
  shortage: true,
  shortageEnded: true,
  revolt: true,
  integrated: true,
  milestone: true,
  digest: true,
  victory: true,
  defeat: true,
};
const FEED_KINDS = Object.keys(FEED_KIND_TABLE) as FeedKind[];

const FLAG_INTEGRATED = 1;
const FLAG_KEEP_TRAINING = 2;
const NONE = -1;

// ------------------------------------------------------------------ encoding

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function costTuple(cost: Cost): (number | null)[] {
  return STOCK_KEYS.map((k) => cost[k] ?? null);
}

function stocksObject(s: Stocks): Json {
  return { funds: s.funds, recruits: s.recruits, food: s.food, steel: s.steel, oil: s.oil };
}

function goodsObject(g: GoodAmounts): Json {
  return { food: g.food, steel: g.steel, oil: g.oil };
}

function perUnitObject(r: Record<UnitType, number>): Json {
  return { rifles: r.rifles, hunters: r.hunters, motor: r.motor, guns: r.guns, tanks: r.tanks };
}

function encodeProvinces(provinces: readonly Province[]): Json {
  const construction: Record<string, Json> = {};
  const queue: Record<string, Json> = {};
  let flags = '';
  let buildings = '';
  provinces.forEach((p, i) => {
    flags += String((p.integrated ? FLAG_INTEGRATED : 0) + (p.keepTraining ? FLAG_KEEP_TRAINING : 0));
    for (const b of BUILDING_TYPES) buildings += String(p.buildings[b]);
    const c = p.construction;
    if (c !== null) {
      construction[i] = [BUILDING_TYPES.indexOf(c.building), c.level, c.hoursLeft, c.hoursTotal, costTuple(c.paid)];
    }
    if (p.queue.length > 0) {
      queue[i] = p.queue.map((q) => [UNIT_TYPES.indexOf(q.unit), q.hoursLeft, q.hoursTotal, costTuple(q.paid), q.started ? 1 : 0]);
    }
  });
  return {
    owner: provinces.map((p) => p.owner),
    garrison: provinces.map((p) => p.garrison),
    stability: provinces.map((p) => p.stability),
    heldSince: provinces.map((p) => p.heldSince),
    battleSince: provinces.map((p) => p.battleSince ?? NONE),
    graceUntil: provinces.map((p) => p.graceUntil),
    rally: provinces.map((p) => p.rally ?? NONE),
    flags,
    buildings,
    construction,
    queue,
  };
}

function encodeArmy(a: Army): Json {
  const units: number[] = [];
  for (const t of UNIT_TYPES) units.push(a.units[t].count, a.units[t].hp);
  const leg = a.leg === null ? 0 : [a.leg.from, a.leg.to, a.leg.ticks, a.leg.done, a.leg.sea ? 1 : 0];
  const battle = a.battle === null ? 0 : [a.battle.joinedAt, a.battle.startHp, a.battle.direction ?? NONE];
  return [
    a.id,
    a.owner,
    a.name,
    ...units,
    a.at,
    leg,
    [...a.path],
    a.departAt,
    INTENTS.indexOf(a.intent),
    STANCES.indexOf(a.stance),
    a.post ?? NONE,
    a.retreatAt,
    battle,
    a.cameFrom ?? NONE,
    a.landingUntil,
    a.orderedAt,
  ];
}

function encodeNation(n: Nation): Json {
  return {
    ix: n.ix,
    alive: n.alive,
    isPlayer: n.isPlayer,
    tier: n.tier,
    colour: n.colour,
    stocks: stocksObject(n.stocks),
    capital: n.capital,
    shortage: { funds: n.shortage.funds, food: n.shortage.food, steel: n.shortage.steel, oil: n.shortage.oil },
    trade: { keepDays: goodsObject(n.trade.keepDays), sellAboveDays: goodsObject(n.trade.sellAboveDays) },
    armySerial: n.armySerial,
    ai: {
      nextThink: n.ai.nextThink,
      alertAt: n.ai.alertAt,
      provoked: n.ai.provoked,
      operations: n.ai.operations.map((o) => ({ target: o.target, armies: [...o.armies], launchedAt: o.launchedAt })),
    },
    eliminatedAt: n.eliminatedAt,
  };
}

function encodeFeedEntry(e: FeedEntry): Json {
  return {
    id: e.id,
    tick: e.tick,
    kind: e.kind,
    severity: e.severity,
    text: e.text,
    nations: [...e.nations],
    province: e.province,
    army: e.army,
    count: e.count,
  };
}

function encodeStats(s: PlayerStats): Json {
  const b = s.largestBattle;
  return {
    attacksWon: s.attacksWon,
    attacksLost: s.attacksLost,
    defencesHeld: s.defencesHeld,
    provincesCaptured: s.provincesCaptured,
    provincesLost: s.provincesLost,
    unitsTrained: perUnitObject(s.unitsTrained),
    unitsLost: perUnitObject(s.unitsLost),
    enemyUnitsDestroyed: s.enemyUnitsDestroyed,
    peakVp: s.peakVp,
    peakProvinces: s.peakProvinces,
    capitalMoves: s.capitalMoves,
    revoltsSuffered: s.revoltsSuffered,
    largestBattle: b === null ? null : { province: b.province, tick: b.tick, hp: b.hp },
    fundsEarned: s.fundsEarned,
    peakFundsPerDay: s.peakFundsPerDay,
    tradeVolume: s.tradeVolume,
    fogOff: s.fogOff,
  };
}

function encodeSurrender(r: SurrenderRecord): Json {
  return { loser: r.loser, winner: r.winner, tick: r.tick, provinces: r.provinces, vp: r.vp, units: r.units };
}

/** Every second point, always keeping the newest (the hard-cap fallback). */
function everySecondPoint(history: readonly HistoryPoint[]): HistoryPoint[] {
  const last = history.length - 1;
  return history.filter((_, i) => i % 2 === 0 || i === last);
}

function encodeState(state: GameState, feed: readonly FeedEntry[], history: readonly HistoryPoint[]): Json {
  return {
    seed: state.seed,
    tick: state.tick,
    rng: state.rng,
    difficulty: state.difficulty,
    player: state.player,
    status: state.status,
    endedAt: state.endedAt,
    sandbox: state.sandbox,
    nextArmyId: state.nextArmyId,
    nextFeedId: state.nextFeedId,
    provinces: encodeProvinces(state.provinces),
    // Dead armies are swept at the end of every tick; one that is still here is not worth keeping.
    armies: state.armies.filter((a) => a.alive).map(encodeArmy),
    nations: state.nations.map(encodeNation),
    market: { pressure: goodsObject(state.market.pressure), history: state.market.history.map(goodsObject) },
    feed: feed.map(encodeFeedEntry),
    stats: encodeStats(state.stats),
    history: history.map((h) => ({ day: h.day, vp: h.vp.map(([n, vp]) => [n, vp]) })),
    surrenders: state.surrenders.map(encodeSurrender),
  };
}

/**
 * The save document. Above SAVE.HARD_MAX_BYTES (measured in UTF-16 code units,
 * which is what localStorage quotas count) the feed is cut to 50 entries, then
 * the history is halved.
 */
export function serialize(state: GameState, map: MapStatic, meta: SaveMeta): string {
  const write = (feed: readonly FeedEntry[], history: readonly HistoryPoint[]): string =>
    JSON.stringify({
      format: SAVE.FORMAT,
      mapHash: map.hash,
      savedAt: meta.savedAt,
      playedMs: meta.playedMs,
      state: encodeState(state, feed, history),
    });
  let feed = state.feed.slice(0, FEED.SAVED_ENTRIES);
  let text = write(feed, state.history);
  if (text.length <= SAVE.HARD_MAX_BYTES) return text;
  feed = feed.slice(0, TRIMMED_FEED_ENTRIES);
  text = write(feed, state.history);
  if (text.length <= SAVE.HARD_MAX_BYTES) return text;
  return write(feed, everySecondPoint(state.history));
}

// ------------------------------------------------------------------ decoding

class SaveError extends Error {}

function fail(what: string): never {
  throw new SaveError(what);
}

function record(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(what);
  return v as Record<string, unknown>;
}

function list(v: unknown, what: string, length?: number): unknown[] {
  if (!Array.isArray(v)) fail(what);
  if (length !== undefined && v.length !== length) fail(`${what}: length`);
  return v;
}

function num(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(what);
  return v;
}

function int(v: unknown, what: string, min: number, max: number): number {
  const n = num(v, what);
  if (!Number.isInteger(n) || n < min || n > max) fail(what);
  return n;
}

function str(v: unknown, what: string): string {
  if (typeof v !== 'string') fail(what);
  return v;
}

function bool(v: unknown, what: string): boolean {
  if (typeof v !== 'boolean') fail(what);
  return v;
}

function oneOf<T extends string>(v: unknown, options: readonly T[], what: string): T {
  const found = options.find((o) => o === v);
  if (found === undefined) fail(what);
  return found;
}

function code<T>(v: unknown, options: readonly T[], what: string): T {
  return options[int(v, what, 0, options.length - 1)]!;
}

/** Array and object positions come from JSON, so every read goes through these guards. */
class Decoder {
  readonly provinces: number;
  readonly nations: number;
  constructor(map: MapStatic) {
    this.provinces = map.provinces.length;
    this.nations = map.nations.length;
  }
  tick(v: unknown, what: string): number {
    return int(v, what, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
  }
  province(v: unknown, what: string): ProvinceIx {
    return asProvince(int(v, what, 0, this.provinces - 1));
  }
  nation(v: unknown, what: string): NationIx {
    return asNation(int(v, what, 0, this.nations - 1));
  }
  army(v: unknown, what: string): ArmyId {
    return asArmy(int(v, what, 1, Number.MAX_SAFE_INTEGER));
  }
  optionalProvince(v: unknown, what: string): ProvinceIx | null {
    return v === NONE ? null : this.province(v, what);
  }
  nullableProvince(v: unknown, what: string): ProvinceIx | null {
    return v === null ? null : this.province(v, what);
  }
  nullableTick(v: unknown, what: string): number | null {
    return v === null ? null : this.tick(v, what);
  }
}

function cost(v: unknown, what: string): Cost {
  const t = list(v, what, STOCK_KEYS.length);
  const out: Cost = {};
  STOCK_KEYS.forEach((k, i) => {
    if (t[i] !== null) out[k] = num(t[i], what);
  });
  return out;
}

function stocks(v: unknown, what: string): Stocks {
  const r = record(v, what);
  return {
    funds: num(r.funds, what),
    recruits: num(r.recruits, what),
    food: num(r.food, what),
    steel: num(r.steel, what),
    oil: num(r.oil, what),
  };
}

function goods(v: unknown, what: string): GoodAmounts {
  const r = record(v, what);
  return { food: num(r.food, what), steel: num(r.steel, what), oil: num(r.oil, what) };
}

function perUnit(v: unknown, what: string): Record<UnitType, number> {
  const r = record(v, what);
  return {
    rifles: num(r.rifles, what),
    hunters: num(r.hunters, what),
    motor: num(r.motor, what),
    guns: num(r.guns, what),
    tanks: num(r.tanks, what),
  };
}

function shortage(v: unknown, what: string): ShortageFlags {
  const r = record(v, what);
  return { funds: bool(r.funds, what), food: bool(r.food, what), steel: bool(r.steel, what), oil: bool(r.oil, what) };
}

function sparse(v: unknown, what: string, provinces: number): Map<number, unknown> {
  const out = new Map<number, unknown>();
  for (const [key, value] of Object.entries(record(v, what))) {
    if (!/^\d+$/.test(key)) fail(what);
    out.set(int(Number(key), what, 0, provinces - 1), value);
  }
  return out;
}

function decodeConstruction(v: unknown): Construction {
  const t = list(v, 'construction', 5);
  const building = code(t[0], BUILDING_TYPES, 'construction.building');
  return {
    building,
    level: int(t[1], 'construction.level', 1, BUILDINGS[building].levels.length),
    hoursLeft: num(t[2], 'construction.hoursLeft'),
    hoursTotal: num(t[3], 'construction.hoursTotal'),
    paid: cost(t[4], 'construction.paid'),
  };
}

function decodeTraining(v: unknown): TrainingItem {
  const t = list(v, 'queue item', 5);
  return {
    unit: code(t[0], UNIT_TYPES, 'queue.unit'),
    hoursLeft: num(t[1], 'queue.hoursLeft'),
    hoursTotal: num(t[2], 'queue.hoursTotal'),
    paid: cost(t[3], 'queue.paid'),
    started: int(t[4], 'queue.started', 0, 1) === 1,
  };
}

function decodeProvinces(v: unknown, d: Decoder): Province[] {
  const r = record(v, 'provinces');
  const n = d.provinces;
  const owner = list(r.owner, 'owner', n);
  const garrison = list(r.garrison, 'garrison', n);
  const stability = list(r.stability, 'stability', n);
  const heldSince = list(r.heldSince, 'heldSince', n);
  const battleSince = list(r.battleSince, 'battleSince', n);
  const graceUntil = list(r.graceUntil, 'graceUntil', n);
  const rally = list(r.rally, 'rally', n);
  const flags = str(r.flags, 'flags');
  const buildings = str(r.buildings, 'buildings');
  if (flags.length !== n || buildings.length !== n * BUILDING_TYPES.length) fail('flags or buildings: length');
  const construction = sparse(r.construction, 'construction', n);
  const queue = sparse(r.queue, 'queue', n);
  const out: Province[] = [];
  for (let i = 0; i < n; i += 1) {
    const flag = int(Number(flags[i]), 'flags', 0, FLAG_INTEGRATED + FLAG_KEEP_TRAINING);
    const levels = noBuildings();
    BUILDING_TYPES.forEach((b, k) => {
      levels[b] = int(Number(buildings[i * BUILDING_TYPES.length + k]), 'buildings', 0, BUILDINGS[b].levels.length);
    });
    const c = construction.get(i);
    const q = queue.get(i);
    out.push({
      owner: d.nation(owner[i], 'owner'),
      garrison: num(garrison[i], 'garrison'),
      stability: num(stability[i], 'stability'),
      heldSince: d.tick(heldSince[i], 'heldSince'),
      integrated: (flag & FLAG_INTEGRATED) !== 0,
      buildings: levels,
      construction: c === undefined ? null : decodeConstruction(c),
      queue: q === undefined ? [] : list(q, 'queue').map(decodeTraining),
      keepTraining: (flag & FLAG_KEEP_TRAINING) !== 0,
      rally: d.optionalProvince(rally[i], 'rally'),
      battleSince: battleSince[i] === NONE ? null : d.tick(battleSince[i], 'battleSince'),
      graceUntil: d.tick(graceUntil[i], 'graceUntil'),
    });
  }
  return out;
}

const ARMY_FIELDS = 3 + 2 * UNIT_TYPES.length + 12;

function decodeArmy(v: unknown, d: Decoder): Army {
  const t = list(v, 'army', ARMY_FIELDS);
  const units = zeroUnits();
  UNIT_TYPES.forEach((type, k) => {
    units[type] = { count: int(t[3 + 2 * k], 'army.count', 0, Number.MAX_SAFE_INTEGER), hp: num(t[4 + 2 * k], 'army.hp') };
  });
  let i = 3 + 2 * UNIT_TYPES.length;
  const next = (): unknown => t[i++];
  const at = d.province(next(), 'army.at');
  const rawLeg = next();
  let leg: Leg | null = null;
  if (rawLeg !== 0) {
    const l = list(rawLeg, 'army.leg', 5);
    leg = {
      from: d.province(l[0], 'leg.from'),
      to: d.province(l[1], 'leg.to'),
      ticks: int(l[2], 'leg.ticks', 1, Number.MAX_SAFE_INTEGER),
      done: int(l[3], 'leg.done', 0, Number.MAX_SAFE_INTEGER),
      sea: int(l[4], 'leg.sea', 0, 1) === 1,
    };
  }
  const path = list(next(), 'army.path').map((p) => d.province(p, 'army.path'));
  const departAt = d.tick(next(), 'army.departAt');
  const intent = code(next(), INTENTS, 'army.intent');
  const stance = code(next(), STANCES, 'army.stance');
  const post = d.optionalProvince(next(), 'army.post');
  const retreatAt = num(next(), 'army.retreatAt');
  const rawBattle = next();
  let battle: ArmyBattle | null = null;
  if (rawBattle !== 0) {
    const b = list(rawBattle, 'army.battle', 3);
    battle = {
      joinedAt: d.tick(b[0], 'battle.joinedAt'),
      startHp: num(b[1], 'battle.startHp'),
      direction: d.optionalProvince(b[2], 'battle.direction'),
    };
  }
  return {
    id: d.army(t[0], 'army.id'),
    owner: d.nation(t[1], 'army.owner'),
    name: str(t[2], 'army.name'),
    units,
    at,
    leg,
    path,
    departAt,
    intent,
    stance,
    post,
    retreatAt,
    battle,
    cameFrom: d.optionalProvince(next(), 'army.cameFrom'),
    landingUntil: d.tick(next(), 'army.landingUntil'),
    orderedAt: d.tick(next(), 'army.orderedAt'),
    alive: true,
  };
}

function decodeAi(v: unknown, d: Decoder): AiMemory {
  const r = record(v, 'ai');
  return {
    nextThink: d.tick(r.nextThink, 'ai.nextThink'),
    alertAt: d.nullableTick(r.alertAt, 'ai.alertAt'),
    provoked: bool(r.provoked, 'ai.provoked'),
    operations: list(r.operations, 'ai.operations').map((o) => {
      const op = record(o, 'operation');
      return {
        target: d.province(op.target, 'operation.target'),
        armies: list(op.armies, 'operation.armies').map((a) => d.army(a, 'operation.armies')),
        launchedAt: d.tick(op.launchedAt, 'operation.launchedAt'),
      };
    }),
  };
}

function decodeNation(v: unknown, index: number, d: Decoder): Nation {
  const r = record(v, 'nation');
  const trade = record(r.trade, 'nation.trade');
  if (r.ix !== index) fail('nation.ix');
  return {
    ix: asNation(index),
    alive: bool(r.alive, 'nation.alive'),
    isPlayer: bool(r.isPlayer, 'nation.isPlayer'),
    tier: oneOf(r.tier, TIERS, 'nation.tier'),
    colour: str(r.colour, 'nation.colour'),
    stocks: stocks(r.stocks, 'nation.stocks'),
    capital: d.nullableProvince(r.capital, 'nation.capital'),
    shortage: shortage(r.shortage, 'nation.shortage'),
    trade: { keepDays: goods(trade.keepDays, 'trade.keepDays'), sellAboveDays: goods(trade.sellAboveDays, 'trade.sellAboveDays') },
    armySerial: int(r.armySerial, 'nation.armySerial', 0, Number.MAX_SAFE_INTEGER),
    ai: decodeAi(r.ai, d),
    eliminatedAt: d.nullableTick(r.eliminatedAt, 'nation.eliminatedAt'),
  };
}

function decodeMarket(v: unknown): Market {
  const r = record(v, 'market');
  return { pressure: goods(r.pressure, 'market.pressure'), history: list(r.history, 'market.history').map((h) => goods(h, 'market.history')) };
}

function decodeFeedEntry(v: unknown, d: Decoder): FeedEntry {
  const r = record(v, 'feed');
  return {
    id: int(r.id, 'feed.id', 0, Number.MAX_SAFE_INTEGER),
    tick: d.tick(r.tick, 'feed.tick'),
    kind: oneOf(r.kind, FEED_KINDS, 'feed.kind'),
    severity: oneOf(r.severity, SEVERITIES, 'feed.severity'),
    text: str(r.text, 'feed.text'),
    nations: list(r.nations, 'feed.nations').map((n) => d.nation(n, 'feed.nations')),
    province: d.nullableProvince(r.province, 'feed.province'),
    army: r.army === null ? null : d.army(r.army, 'feed.army'),
    count: int(r.count, 'feed.count', 1, Number.MAX_SAFE_INTEGER),
  };
}

function decodeStats(v: unknown, d: Decoder): PlayerStats {
  const r = record(v, 'stats');
  const b = r.largestBattle === null ? null : record(r.largestBattle, 'stats.largestBattle');
  return {
    attacksWon: num(r.attacksWon, 'stats'),
    attacksLost: num(r.attacksLost, 'stats'),
    defencesHeld: num(r.defencesHeld, 'stats'),
    provincesCaptured: num(r.provincesCaptured, 'stats'),
    provincesLost: num(r.provincesLost, 'stats'),
    unitsTrained: perUnit(r.unitsTrained, 'stats.unitsTrained'),
    unitsLost: perUnit(r.unitsLost, 'stats.unitsLost'),
    enemyUnitsDestroyed: num(r.enemyUnitsDestroyed, 'stats'),
    peakVp: num(r.peakVp, 'stats'),
    peakProvinces: num(r.peakProvinces, 'stats'),
    capitalMoves: num(r.capitalMoves, 'stats'),
    revoltsSuffered: num(r.revoltsSuffered, 'stats'),
    largestBattle:
      b === null ? null : { province: d.province(b.province, 'largestBattle.province'), tick: d.tick(b.tick, 'largestBattle.tick'), hp: num(b.hp, 'largestBattle.hp') },
    fundsEarned: num(r.fundsEarned, 'stats'),
    peakFundsPerDay: num(r.peakFundsPerDay, 'stats'),
    tradeVolume: num(r.tradeVolume, 'stats'),
    fogOff: bool(r.fogOff, 'stats.fogOff'),
  };
}

function decodeHistory(v: unknown, d: Decoder): HistoryPoint {
  const r = record(v, 'history');
  return {
    day: int(r.day, 'history.day', 0, Number.MAX_SAFE_INTEGER),
    vp: list(r.vp, 'history.vp').map((pair): [NationIx, number] => {
      const p = list(pair, 'history.vp', 2);
      return [d.nation(p[0], 'history.nation'), num(p[1], 'history.vp')];
    }),
  };
}

function decodeSurrender(v: unknown, d: Decoder): SurrenderRecord {
  const r = record(v, 'surrender');
  return {
    loser: d.nation(r.loser, 'surrender.loser'),
    winner: d.nation(r.winner, 'surrender.winner'),
    tick: d.tick(r.tick, 'surrender.tick'),
    provinces: num(r.provinces, 'surrender.provinces'),
    vp: num(r.vp, 'surrender.vp'),
    units: num(r.units, 'surrender.units'),
  };
}

function decodeState(v: unknown, map: MapStatic): GameState {
  const d = new Decoder(map);
  const r = record(v, 'state');
  const armies = list(r.armies, 'armies').map((a) => decodeArmy(a, d));
  for (let i = 1; i < armies.length; i += 1) if (armies[i]!.id <= armies[i - 1]!.id) fail('armies: order');
  const nextArmyId = int(r.nextArmyId, 'nextArmyId', 1, Number.MAX_SAFE_INTEGER);
  if (armies.length > 0 && armies[armies.length - 1]!.id >= nextArmyId) fail('nextArmyId');
  const nations = list(r.nations, 'nations', d.nations).map((n, i) => decodeNation(n, i, d));
  const player = d.nation(r.player, 'player');
  if (!nations[player]!.isPlayer) fail('player');
  return {
    format: 5,
    seed: str(r.seed, 'seed'),
    tick: int(r.tick, 'tick', 0, Number.MAX_SAFE_INTEGER),
    rng: int(r.rng, 'rng', -0x80000000, 0xffffffff),
    difficulty: oneOf(r.difficulty, DIFFICULTIES, 'difficulty'),
    player,
    status: oneOf(r.status, STATUSES, 'status'),
    endedAt: d.nullableTick(r.endedAt, 'endedAt'),
    sandbox: bool(r.sandbox, 'sandbox'),
    provinces: decodeProvinces(r.provinces, d),
    nations,
    armies,
    nextArmyId,
    market: decodeMarket(r.market),
    feed: list(r.feed, 'feed').map((e) => decodeFeedEntry(e, d)),
    nextFeedId: int(r.nextFeedId, 'nextFeedId', 0, Number.MAX_SAFE_INTEGER),
    stats: decodeStats(r.stats, d),
    history: list(r.history, 'history').map((h) => decodeHistory(h, d)),
    surrenders: list(r.surrenders, 'surrenders').map((s) => decodeSurrender(s, d)),
  };
}

/** The saved game, or null when the text is not a valid save for this map and format. */
export function deserialize(text: string, map: MapStatic): { state: GameState; meta: SaveMeta } | null {
  try {
    const file = record(JSON.parse(text), 'file');
    if (file.format !== SAVE.FORMAT || file.mapHash !== map.hash) return null;
    const meta: SaveMeta = { savedAt: num(file.savedAt, 'savedAt'), playedMs: num(file.playedMs, 'playedMs') };
    return { state: decodeState(file.state, map), meta };
  } catch (error) {
    if (error instanceof SaveError || error instanceof SyntaxError) return null;
    throw error;
  }
}
