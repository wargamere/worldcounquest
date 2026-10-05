/**
 * Hegemon v5 shared contract: every type that crosses a module boundary.
 *
 * Owned by E1 (lead) and frozen at milestone M0. A change needs review from every
 * owner whose module imports the changed name. The only runtime values here are
 * the key tuples the unions derive from; they fix the canonical iteration order
 * that determinism, saves and the UI all rely on.
 */

// ------------------------------------------------------------------ key tuples

/** Land unit types, in canonical order. */
export const UNIT_TYPES = ['rifles', 'hunters', 'motor', 'guns', 'tanks'] as const;
/** The goods a province can yield. Every province yields exactly one. */
export const GOODS = ['food', 'steel', 'oil'] as const;
/** Every national stock, in HUD order. */
export const STOCK_KEYS = ['funds', 'recruits', 'food', 'steel', 'oil'] as const;
/** Province buildings, in panel order. */
export const BUILDING_TYPES = ['works', 'training', 'ramparts', 'roads', 'draft'] as const;
/** Terrain classes computed by the pipeline. */
export const TERRAINS = ['plains', 'hills', 'mountains', 'jungle', 'desert', 'arctic', 'urban'] as const;

export type UnitType = (typeof UNIT_TYPES)[number];
export type Good = (typeof GOODS)[number];
export type StockKey = (typeof STOCK_KEYS)[number];
export type BuildingType = (typeof BUILDING_TYPES)[number];
export type Terrain = (typeof TERRAINS)[number];

// ------------------------------------------------------------- branded indices

declare const BRAND: unique symbol;
/** A number the compiler will not confuse with another kind of index. */
export type Brand<T, B extends string> = T & { readonly [BRAND]: B };
/** Dense index into MapStatic.provinces and GameState.provinces. */
export type ProvinceIx = Brand<number, 'ProvinceIx'>;
/** Dense index into MapStatic.nations and GameState.nations; ascending country id order. */
export type NationIx = Brand<number, 'NationIx'>;
/** Never reused within a game. */
export type ArmyId = Brand<number, 'ArmyId'>;
/** Whole 15-minute steps since Day 1 00:00. */
export type Tick = number;

// --------------------------------------------------------------- small unions

export type Difficulty = 'relaxed' | 'standard' | 'ruthless';
export type GameStatus = 'playing' | 'won' | 'lost';
export type Speed = 0 | 1 | 2 | 4 | 8;
export type RunSpeed = Exclude<Speed, 0>;
export type ProvinceStatus = 'home' | 'integrated' | 'occupied';
export type Stance = 'manual' | 'defend' | 'delegate';
export type AiTier = 'major' | 'minor';
export type Armour = 'soft' | 'hard';
export type Role = 'attacker' | 'defender';
export type Verdict = 'decisive' | 'likely' | 'close' | 'unlikely' | 'hopeless';
export type Intent = 'move' | 'attack' | 'retreat' | 'rally';
export type FeedScope = 'mine' | 'nearby' | 'world';
export type MapMode = 'political' | 'terrain' | 'resources' | 'stability' | 'supply';

export type Stocks = Record<StockKey, number>;
export type Cost = Partial<Stocks>;
export type GoodAmounts = Record<Good, number>;
export type BuildingLevels = Record<BuildingType, number>;
export type ShortageFlags = Record<Exclude<StockKey, 'recruits'>, boolean>;

/** One unit type inside an army: `count` whole units sharing an HP pool. */
export interface UnitStack {
  count: number;
  hp: number;
}
/** Always a full record; absent types are { count: 0, hp: 0 }. */
export type Units = Record<UnitType, UnitStack>;
/** Whole units per type, for costs, splits and summaries. */
export type UnitCounts = Partial<Record<UnitType, number>>;
/** HP per type, for damage and losses. */
export type UnitHp = Record<UnitType, number>;

// ------------------------------------------------ authored and generated data

export interface CountrySeed {
  id: string;
  name: string;
  population: number;
  economyTier: number;
}
export interface CityFact {
  name: string;
  population: number;
  lon: number;
  lat: number;
}
/** One row of public/province-facts.json (pipeline output, committed). */
export interface ProvinceFact {
  id: string;
  name: string;
  countryId: string;
  population: number;
  areaKm2: number;
  city: CityFact | null;
  capital: boolean;
  /** lon, lat where armies stand and legs start and end. */
  anchor: [number, number];
  /** The anchor as a unit vector, 6 decimals; lets src/game avoid trigonometry. */
  xyz: [number, number, number];
  terrain: Terrain;
  good: Good;
  /** An authored oil field: oil yield uses ECONOMY.OIL_FIELD_YIELD instead of terrain. */
  oilField: boolean;
  /** Land and sea neighbours, sorted by id. */
  neighbours: string[];
  /** Parallel to neighbours: great-circle km between anchors, 0.1 km precision. */
  edgeKm: number[];
  /** Parallel to neighbours: true for a sea crossing. */
  sea: boolean[];
}
export interface ProvinceFacts {
  source: string;
  format: 2;
  /** FNV-1a over ids, neighbours, terrain and good; saves carry it as mapHash. */
  version: string;
  provinces: ProvinceFact[];
}
/** src/data/terrain-overrides.json rows: a whole country (optionally only `from` terrain) or one province. */
export interface TerrainOverride {
  country: string;
  province?: string;
  from?: Terrain;
  to: Terrain;
}
/** src/data/good-overrides.json rows. */
export interface GoodOverride {
  country: string;
  province: string;
  good: Good;
  oilField: boolean;
}

// ---------------------------------------- static world: built once, never saved

export interface Edge {
  readonly to: ProvinceIx;
  readonly km: number;
  readonly sea: boolean;
}
export interface ProvinceStatic {
  readonly ix: ProvinceIx;
  readonly id: string;
  readonly name: string;
  /** The nation this province started in; decides home status. */
  readonly country: NationIx;
  readonly population: number;
  readonly areaKm2: number;
  readonly city: Readonly<CityFact> | null;
  /** The original national capital. Exactly one per nation. */
  readonly isCapital: boolean;
  readonly terrain: Terrain;
  readonly good: Good;
  readonly oilField: boolean;
  /** Funds per day at home status, stability 100, no buildings, before aiOutput. */
  readonly fundsBase: number;
  /** Units of `good` per day on the same basis. */
  readonly goodsBase: number;
  /** Recruits per day on the same basis. */
  readonly recruitsBase: number;
  /** Garrison HP cap before status and Ramparts. */
  readonly garrisonBase: number;
  readonly vp: number;
  readonly anchor: readonly [number, number];
  readonly xyz: readonly [number, number, number];
}
export interface NationStatic {
  readonly ix: NationIx;
  readonly id: string;
  readonly name: string;
  readonly tier: number;
  readonly population: number;
  readonly capital: ProvinceIx;
  /** Provinces of the original country, ascending. */
  readonly home: readonly ProvinceIx[];
  /** Nations sharing a province edge at the start, ascending. */
  readonly neighbours: readonly NationIx[];
}
export interface MapStatic {
  readonly provinces: readonly ProvinceStatic[];
  /** By ProvinceIx, each list sorted by `to`. Symmetric. */
  readonly edges: readonly (readonly Edge[])[];
  readonly nations: readonly NationStatic[];
  readonly provinceById: ReadonlyMap<string, ProvinceIx>;
  readonly nationById: ReadonlyMap<string, NationIx>;
  readonly totalVp: number;
  /** ceil(VICTORY.VP_SHARE * totalVp). */
  readonly goalVp: number;
  readonly hash: string;
}

// --------------------------------------------- spec shapes; values in balance.ts

export interface CombatValues {
  readonly soft: number;
  readonly hard: number;
}
export interface UnitSpec {
  readonly name: string;
  /** Three-letter marker label. */
  readonly short: string;
  readonly armour: Armour;
  readonly hp: number;
  readonly speedKmh: number;
  /** HP damage per hour per full-strength unit when its side attacks. */
  readonly attack: CombatValues;
  /** HP damage per hour per full-strength unit when its side defends. */
  readonly defence: CombatValues;
  /** Weight when incoming damage is spread over a side; below 1 means shielded. */
  readonly exposure: number;
  /** Multiplier on this unit's damage that lands on a garrison. */
  readonly vsGarrison: number;
  readonly ignoresRamparts: boolean;
  readonly usesOil: boolean;
  readonly cost: Cost;
  readonly hours: number;
  readonly trainingLevel: 1 | 2 | 3;
  /** Per day. */
  readonly upkeep: Cost;
}
export interface TerrainSpec {
  readonly label: string;
  /** Owner-side damage multiplier. */
  readonly defence: number;
  /** Unit-equivalents per side that fight at full effect, per direction. */
  readonly frontage: number;
  /** Tank damage multiplier, both roles. */
  readonly tanks: number;
  /** Land-leg speed multiplier for legs entering this terrain. */
  readonly speed: number;
  readonly goodsYield: number;
}
export interface BuildingLevelSpec {
  readonly cost: Cost;
  readonly hours: number;
}
export interface BuildingSpec {
  readonly name: string;
  /** Only in home or integrated provinces. */
  readonly homeOnly: boolean;
  readonly levels: readonly BuildingLevelSpec[];
}
export interface DifficultySpec {
  readonly label: string;
  readonly blurb: string;
  /** AI Funds and goods multiplier; the player is never scaled. */
  readonly aiOutput: number;
  readonly majorCount: number;
  readonly majorThinkHours: number;
  /** HP share an AI attack must keep in the mean-roll prediction. */
  readonly attackKeep: number;
  readonly maxOperations: number;
  /** No AI offensive of any kind before this many game hours. */
  readonly openingCalmHours: number;
  /** AI nations do not target the player before this day unless provoked. */
  readonly playerGraceDays: number;
  readonly playerFundsDays: number;
  readonly playerArmyMultiplier: number;
}

// ------------------------------------------------------ dynamic state (saved)

export interface Construction {
  building: BuildingType;
  /** The level being built. */
  level: number;
  hoursLeft: number;
  hoursTotal: number;
  paid: Cost;
}
export interface TrainingItem {
  unit: UnitType;
  hoursLeft: number;
  hoursTotal: number;
  paid: Cost;
  /** Only queue[0] can be started. */
  started: boolean;
}
export interface Province {
  owner: NationIx;
  /** Militia HP; fights for the owner and never moves. */
  garrison: number;
  /** 0..100. */
  stability: number;
  heldSince: Tick;
  integrated: boolean;
  buildings: BuildingLevels;
  construction: Construction | null;
  queue: TrainingItem[];
  keepTraining: boolean;
  rally: ProvinceIx | null;
  battleSince: Tick | null;
  /** No revolt before this tick. */
  graceUntil: Tick;
}
export interface Leg {
  from: ProvinceIx;
  to: ProvinceIx;
  /** Whole ticks the leg takes, fixed at departure (re-timed only on an Oil shortage flip). */
  ticks: number;
  done: number;
  sea: boolean;
}
export interface ArmyBattle {
  joinedAt: Tick;
  /** Army HP when it joined; the retreat threshold is a share of it. */
  startHp: number;
  /** The province it entered from; null if it was already here. Distinct values are flank directions. */
  direction: ProvinceIx | null;
}
export interface Army {
  id: ArmyId;
  owner: NationIx;
  name: string;
  units: Units;
  /** Where it stands, or the province its current leg left. */
  at: ProvinceIx;
  leg: Leg | null;
  /** Provinces still to enter after the current leg. */
  path: ProvinceIx[];
  /** Does not depart before this tick (arrive-together, surrender freeze). */
  departAt: Tick;
  intent: Intent;
  stance: Stance;
  /** Defend stance: the province it guards and returns to. */
  post: ProvinceIx | null;
  /** Auto-retreat below this share of battle.startHp; 0 = never. */
  retreatAt: number;
  battle: ArmyBattle | null;
  cameFrom: ProvinceIx | null;
  /** Landing penalty applies while tick < landingUntil. */
  landingUntil: Tick;
  /** Last tick an order was given; AI hysteresis. */
  orderedAt: Tick;
  alive: boolean;
}
export interface TradePolicy {
  /** Auto-buy up to this many days of consumption; 0 = off. */
  keepDays: GoodAmounts;
  /** Auto-sell stock above this many days of consumption when the price factor >= MARKET.AUTO_SELL_MIN_FACTOR; 0 = off. */
  sellAboveDays: GoodAmounts;
}
export interface Operation {
  target: ProvinceIx;
  armies: ArmyId[];
  launchedAt: Tick;
}
export interface AiMemory {
  /** AI think, or Staff think for the player's delegated armies. */
  nextThink: Tick;
  alertAt: Tick | null;
  /** The player captured one of this nation's provinces; ends the player's grace for it. */
  provoked: boolean;
  operations: Operation[];
}
export interface Nation {
  ix: NationIx;
  alive: boolean;
  isPlayer: boolean;
  tier: AiTier;
  colour: string;
  stocks: Stocks;
  capital: ProvinceIx | null;
  shortage: ShortageFlags;
  trade: TradePolicy;
  armySerial: number;
  ai: AiMemory;
  eliminatedAt: Tick | null;
}
export interface Market {
  /** Signed; positive after net buying. Price factor = clamp(1 + pressure / depth). */
  pressure: GoodAmounts;
  /** Daily price factors, oldest first, at most MARKET.HISTORY_DAYS. */
  history: GoodAmounts[];
}
export type FeedKind =
  | 'battleStarted'
  | 'battleWon'
  | 'battleLost'
  | 'defenceHeld'
  | 'provinceCaptured'
  | 'provinceLost'
  | 'capitalLost'
  | 'capitalMoved'
  | 'capitulation'
  | 'eliminated'
  | 'enemySighted'
  | 'armyDestroyed'
  | 'retreated'
  | 'routeBlocked'
  | 'unitsReady'
  | 'constructionDone'
  | 'shortage'
  | 'shortageEnded'
  | 'revolt'
  | 'integrated'
  | 'milestone'
  | 'digest'
  | 'victory'
  | 'defeat';
export type Severity = 'info' | 'good' | 'bad' | 'critical';
export interface FeedEntry {
  id: number;
  tick: Tick;
  kind: FeedKind;
  severity: Severity;
  text: string;
  nations: NationIx[];
  province: ProvinceIx | null;
  army: ArmyId | null;
  /** Coalesced repeats (e.g. "Trained 3 Rifles"). */
  count: number;
}
export interface SurrenderRecord {
  loser: NationIx;
  winner: NationIx;
  tick: Tick;
  provinces: number;
  vp: number;
  units: number;
}
export interface PlayerStats {
  attacksWon: number;
  attacksLost: number;
  defencesHeld: number;
  provincesCaptured: number;
  provincesLost: number;
  unitsTrained: Record<UnitType, number>;
  unitsLost: Record<UnitType, number>;
  enemyUnitsDestroyed: number;
  peakVp: number;
  peakProvinces: number;
  capitalMoves: number;
  revoltsSuffered: number;
  largestBattle: { province: ProvinceIx; tick: Tick; hp: number } | null;
  fundsEarned: number;
  peakFundsPerDay: number;
  tradeVolume: number;
  /** "Show all armies" was switched on at some point; the end screen says so. */
  fogOff: boolean;
}
export interface HistoryPoint {
  day: number;
  vp: [NationIx, number][];
}
export interface GameState {
  format: 5;
  seed: string;
  tick: Tick;
  /** mulberry32 state; the only randomness in the simulation. */
  rng: number;
  difficulty: Difficulty;
  player: NationIx;
  status: GameStatus;
  endedAt: Tick | null;
  /** "Keep playing" after a result: no further victory checks. */
  sandbox: boolean;
  provinces: Province[];
  nations: Nation[];
  /** Ascending id; dead armies are swept at the end of each tick. */
  armies: Army[];
  nextArmyId: number;
  market: Market;
  /** Newest first, at most FEED.MAX_ENTRIES. */
  feed: FeedEntry[];
  nextFeedId: number;
  stats: PlayerStats;
  history: HistoryPoint[];
  surrenders: SurrenderRecord[];
}

// ----------------------------------------- the only write path besides the tick

export type Command =
  | { kind: 'move'; nation: NationIx; armies: readonly ArmyId[]; to: ProvinceIx; together: boolean; append: boolean }
  | { kind: 'stop'; nation: NationIx; armies: readonly ArmyId[] }
  | { kind: 'retreat'; nation: NationIx; armies: readonly ArmyId[]; to: ProvinceIx | null }
  | { kind: 'split'; nation: NationIx; army: ArmyId; take: UnitCounts }
  | { kind: 'merge'; nation: NationIx; armies: readonly ArmyId[] }
  | { kind: 'disband'; nation: NationIx; army: ArmyId }
  | { kind: 'stance'; nation: NationIx; armies: readonly ArmyId[]; stance: Stance }
  | { kind: 'retreatAt'; nation: NationIx; armies: readonly ArmyId[]; at: number }
  | { kind: 'build'; nation: NationIx; province: ProvinceIx; building: BuildingType }
  | { kind: 'cancelBuild'; nation: NationIx; province: ProvinceIx }
  | { kind: 'train'; nation: NationIx; province: ProvinceIx; unit: UnitType; count: number }
  | { kind: 'cancelTrain'; nation: NationIx; province: ProvinceIx; index: number }
  | { kind: 'keepTraining'; nation: NationIx; province: ProvinceIx; on: boolean }
  | { kind: 'rally'; nation: NationIx; province: ProvinceIx; to: ProvinceIx | null }
  | { kind: 'trade'; nation: NationIx; good: Good; amount: number }
  | { kind: 'tradePolicy'; nation: NationIx; policy: TradePolicy };
export type CommandKind = Command['kind'];
/** `armies` lists armies created or changed (split, merge), for the UI to select. */
export type CommandResult = { ok: true; armies: readonly ArmyId[] } | { ok: false; reason: string };
export type CommandSource = 'player' | 'ai' | 'staff';
export interface CommandLogEntry {
  tick: Tick;
  source: CommandSource;
  command: Command;
}

// ------------------------------------------------------------ tick outputs

export type AlertKind =
  | 'capitalAttacked'
  | 'provinceAttacked'
  | 'provinceLost'
  | 'armyDestroyed'
  | 'shortage'
  | 'capitulation'
  | 'firstContact';
export interface Alert {
  kind: AlertKind;
  province: ProvinceIx | null;
  nation: NationIx | null;
}
export interface TickEvents {
  ticks: number;
  feed: FeedEntry[];
  ownershipChanged: ProvinceIx[];
  alerts: Alert[];
  statusChanged: boolean;
}
export type SimPhase = 'movement' | 'combat' | 'economy' | 'provinces' | 'daily' | 'ai' | 'sweep';
/** Timing hooks for scripts/bench.mts; src/game itself never reads a clock. */
export interface SimHooks {
  phase(name: SimPhase, edge: 'start' | 'end'): void;
}

// ----------------------------------------------------------- combat & forecast

export interface BattleSide {
  nation: NationIx;
  role: Role;
  /** All units of this nation standing in the province. */
  units: Units;
  /** HP per type still under the landing penalty (a subset of `units`). */
  landed: UnitHp;
  /** Owner side only; 0 for attackers. */
  garrison: number;
  /** Distinct entry directions, at least 1. */
  directions: number;
  supplied: boolean;
  oilShort: boolean;
}
export interface BattleContext {
  province: ProvinceIx;
  terrain: Terrain;
  ramparts: number;
  /** Distinct directions across every attacker side, at least 1. */
  totalDirections: number;
}
export interface BattleInput {
  ctx: BattleContext;
  defender: BattleSide;
  /** Ascending NationIx. */
  attackers: readonly BattleSide[];
}
export interface SideLoss {
  nation: NationIx;
  /** HP lost per type. */
  hp: UnitHp;
  garrison: number;
  /** HP this side dealt. */
  dealt: number;
}
export interface RoundResult {
  /** Defender first, then attackers in input order. */
  losses: SideLoss[];
}
export interface Reinforcement {
  /** Joins before the round at this hour offset (0 = first round). */
  atHour: number;
  side: BattleSide;
}
export interface BattlePrediction {
  /** 'attacker' means the defender side is eliminated. */
  winner: 'attacker' | 'defender' | 'undecided';
  hours: number;
  /** HP share kept by the forecast nation's side (or the attackers combined). */
  attackerKeeps: number;
  defenderKeeps: number;
  attackerLosses: UnitCounts;
}
export type ModifierCode =
  | 'terrain'
  | 'ramparts'
  | 'flank'
  | 'frontage'
  | 'landing'
  | 'oilShort'
  | 'unsupplied'
  | 'tankTerrain'
  | 'gunsVsGarrison';
export interface Modifier {
  code: ModifierCode;
  side: Role;
  factor: number;
}
export interface Forecast extends BattlePrediction {
  winChance: number;
  verdict: Verdict;
  modifiers: readonly Modifier[];
  /** The forecast only counts armies the viewer can see. */
  fogged: boolean;
}
export interface RoundReport {
  tick: Tick;
  sides: { nation: NationIx; hp: number; dealt: number; taken: number }[];
}

// ------------------------------------------------------------- order preview

export type OrderWarning =
  | 'noRoute'
  | 'crossesHostile'
  | 'staggered'
  | 'capitalExposed'
  | 'oilShort'
  | 'unsupplied'
  | 'landing'
  | 'reinforcementsInbound'
  | 'leavesBattle';
export interface OrderRoute {
  army: ArmyId;
  nodes: ProvinceIx[];
  ticks: number;
  departInTicks: number;
  hostileCrossings: number;
  /** Final-approach province: the flank direction this army adds. */
  approach: ProvinceIx | null;
}
export interface OrderPreview {
  to: ProvinceIx;
  intent: 'move' | 'attack';
  routes: OrderRoute[];
  arriveInTicks: number;
  directions: number;
  forecast: Forecast | null;
  warnings: OrderWarning[];
}

// ------------------------------------------------------ derived cache & sim

export interface SupplyMap {
  /** 1 = owned and linked to the capital (or fallback root) through owned provinces. */
  connected: Uint8Array;
  /** 1 = within SUPPLY.HALO_HOPS of a connected province; armies here are supplied. */
  supplied: Uint8Array;
}
export interface OpCounters {
  predictions: number;
  paths: number;
  fields: number;
  orders: number;
}
export interface SimCache {
  armyById: Map<ArmyId, Army>;
  /** Standing (not on a leg) armies per province, ascending id. */
  armiesAt: Army[][];
  /** Alive armies per nation, ascending id. */
  armiesOf: Army[][];
  /** Armies on a leg ending at each province. */
  inbound: Army[][];
  /** Owned provinces per nation, ascending. Maintained by setOwner. */
  nationProvinces: ProvinceIx[][];
  /** VP per nation. Maintained by setOwner. */
  vp: number[];
  /** Contested provinces, ascending; rebuilt every tick. */
  battles: ProvinceIx[];
  /** 1 where a battle is running; rebuilt every tick with `battles`. */
  contested: Uint8Array;
  incomeDirty: boolean[];
  /** Gross production per day per nation, after status, stability and aiOutput. */
  income: Stocks[];
  supply: (SupplyMap | null)[];
  supplyDirty: boolean[];
  /** The player's vision, 1 per visible province; recomputed hourly. */
  vision: Uint8Array;
  /** Tick a hostile army was last reported next to the player, per province (enemySighted throttle). */
  sightedAt: Int32Array;
  /** The last COMBAT.LOG_ROUNDS rounds per battle province, for the Battle panel; not saved. */
  battleLog: Map<ProvinceIx, RoundReport[]>;
  ownershipVersion: number;
  territoryVersion: number[];
  armyVersion: number;
  events: TickEvents;
  commandLog: CommandLogEntry[] | null;
  counters: OpCounters;
}
export interface Sim {
  readonly map: MapStatic;
  state: GameState;
  readonly cache: SimCache;
}
