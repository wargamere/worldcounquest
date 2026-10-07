/**
 * Every tunable number in Hegemon v5. Nothing else hard-codes a rule constant:
 * if a rule, the AI, the loop or the renderer needs a number, it reads it here.
 * Owned by E1; other lanes request changes through E1 with a harness report.
 *
 * Unless stated, rates are per game day and are applied hourly at 1/24.
 */
import type {
  BuildingSpec,
  BuildingType,
  Difficulty,
  DifficultySpec,
  Good,
  GoodAmounts,
  RunSpeed,
  Speed,
  Terrain,
  TerrainSpec,
  UnitType,
  UnitSpec,
} from './types';

/** Game clock and the real-time loop. */
export const TIME = {
  TICK_MINUTES: 15, // game minutes per simulation tick
  TICKS_PER_HOUR: 4, // combat, economy and construction run on ticks where tick % 4 === 0
  TICKS_PER_DAY: 96, // daily systems run on ticks where tick % 96 === 0
  REAL_MS_PER_TICK_AT_1X: 250, // 1x = one game hour per real second, 24 s per game day
  SPEEDS: [0, 1, 2, 4, 8] as readonly Speed[], // the speed control's steps
  DEFAULT_RUN_SPEED: 1 as RunSpeed, // speed Space resumes to in a new game
  MAX_FRAME_MS: 250, // a longer frame gap is dropped, never caught up
  MAX_TICKS_PER_FRAME: 8, // hard cap on ticks run in one animation frame
  SIM_BUDGET_MS_FINE: 6, // sim time budget per frame with a mouse (fine pointer)
  SIM_BUDGET_MS_COARSE: 4, // sim time budget per frame on touch devices
  THROTTLE_NOTICE_MS: 2000, // show "running at 5.2x" after this long below 90% of target speed
  THROTTLE_SHOW_BELOW: 0.9, // effective/target speed ratio below which the notice shows
} as const;

/** Store, autosave and view publication cadence (real milliseconds). */
export const RUNTIME = {
  VIEW_PUBLISH_MS: 250, // reactive UI snapshot at most 4 times a second while running
  HEAVY_VIEW_MS: 1000, // open Economy/Production/Powers panels refresh at 1 Hz
  AUTOSAVE_MS: 30_000, // autosave cadence while running, if the tick advanced
  PATH_PREVIEW_THROTTLE_MS: 50, // at most one hover route preview per 50 ms
  ODDS_PREVIEW_THROTTLE_MS: 150, // at most one Monte Carlo odds run per 150 ms of hover
  TOAST_MS: 6000, // toast lifetime
  MAX_TOASTS_DESKTOP: 3, // simultaneous toasts on desktop
  MAX_TOASTS_PHONE: 2, // simultaneous toasts on phones
  SESSION_HEARTBEAT_MS: 5000, // two-tab guard heartbeat into localStorage
} as const;

/** Values the build pipeline and world.ts use to derive static province facts. */
export const MAP = {
  MAJOR_CITY: 1_000_000, // city population for +2 VP, +20% garrison
  MEDIUM_CITY: 250_000, // city population for +1 VP
  VP_BASE: 1, // every province
  VP_MAJOR_CITY: 2, // added for a major city
  VP_MEDIUM_CITY: 1, // added for a medium city
  VP_CAPITAL: 3, // added for an original national capital
  GOODS_AREA_REF_KM2: 40_000, // area giving goods scale 1
  GOODS_POP_REF: 4_000_000, // population giving goods scale 1
  GOODS_SCALE_MIN: 0.5, // floor on max(area scale, population scale)
  GOODS_SCALE_MAX: 2.5, // ceiling on the same
  HILLS_STEEL_SHARE: 0.5, // hills yield steel when fnv1a(id)/2^32 < this, else food
  EARTH_RADIUS_KM: 6371, // chord to km conversion for the A* heuristic
  TERRAIN_SAMPLES: 9, // pipeline samples a 9x9 grid per province bbox
  URBAN_DENSITY: 350, // people/km2 for urban (with area below URBAN_MAX_AREA_KM2)
  URBAN_MAX_AREA_KM2: 40_000, // largest province that can be urban by density
  URBAN_BIG_CITY: 4_000_000, // a city this big makes a province urban at URBAN_BIG_CITY_DENSITY
  URBAN_BIG_CITY_DENSITY: 150, // density needed with a big city
  MOUNTAIN_SHARE: 0.55, // Range/mtn sample share for mountains
  DESERT_SHARE: 0.4, // Desert sample share for desert
  ARCTIC_LAT: 60, // |lat| from which sparse provinces are arctic
  ARCTIC_MAX_DENSITY: 3, // people/km2 below which a high-latitude province is arctic
  TUNDRA_SHARE: 0.4, // Tundra sample share for arctic
  HILLS_SHARE: 0.4, // Plateau+Foothills share for hills
  HILLS_MOUNTAIN_SHARE: 0.25, // a lower Range/mtn share that still makes hills
  JUNGLE_LAT: 9, // |lat| up to which sparse provinces are jungle
  JUNGLE_MAX_DENSITY: 80, // people/km2 below which an equatorial province is jungle
} as const;

/** The seven terrain classes. */
export const TERRAIN: Readonly<Record<Terrain, TerrainSpec>> = {
  plains: { label: 'Plains', defence: 1.0, frontage: 30, tanks: 1.15, speed: 1.0, goodsYield: 1.0 }, // open ground: tank country, wide fronts
  hills: { label: 'Hills', defence: 1.2, frontage: 24, tanks: 0.9, speed: 0.8, goodsYield: 0.9 }, // modest defence and slower marches
  mountains: { label: 'Mountains', defence: 1.45, frontage: 16, tanks: 0.65, speed: 0.6, goodsYield: 0.9 }, // the strongest defence; narrow fronts
  jungle: { label: 'Jungle', defence: 1.3, frontage: 18, tanks: 0.7, speed: 0.6, goodsYield: 0.7 }, // slow, poor for tanks
  desert: { label: 'Desert', defence: 1.0, frontage: 30, tanks: 1.15, speed: 0.85, goodsYield: 0.7 }, // open like plains, yields oil
  arctic: { label: 'Arctic', defence: 1.2, frontage: 16, tanks: 0.8, speed: 0.6, goodsYield: 0.5 }, // sparse, slow, thin oil
  urban: { label: 'City', defence: 1.3, frontage: 20, tanks: 0.75, speed: 1.0, goodsYield: 1.0 }, // dense cities: sieges, steel from population
};

/** Province production. Funds and Recruits come from people; goods come from land. */
export const ECONOMY = {
  TIER_FUNDS: { 1: 20, 2: 30, 3: 50, 4: 80, 5: 120 } as Readonly<Record<number, number>>, // Funds/day per sqrt(country pop in millions), split by population share
  GOODS_BASE: { food: 14, steel: 12, oil: 8 } as Readonly<GoodAmounts>, // units/day at goods scale 1, yield 1, tier 3
  GOODS_TIER: { 1: 0.8, 2: 0.9, 3: 1.0, 4: 1.1, 5: 1.2 } as Readonly<Record<number, number>>, // goods multiplier by economy tier
  OIL_FIELD_YIELD: 3, // replaces the terrain yield in an authored oil field
  RECRUITS_PER_PERSON: 0.000044, // Recruits per resident per day
  RECRUIT_CAP_DAYS: 20, // Recruits bank at most this many days of regeneration
  RECRUIT_CAP_MIN: 2000, // minimum Recruits cap
  CAPITAL_FUNDS_BONUS: 0.25, // +25% Funds in the owner's current capital
  UNPAID_ATTRITION_PER_DAY: 0.03, // share of every army's HP lost per day while Funds are at 0 with negative net
  HUNGER_ATTRITION_PER_DAY: 0.03, // same, while Food is at 0 with negative net
  OIL_SHORT_SPEED: 0.5, // speed of Oil-using units while Oil is at 0 with negative net
  OIL_SHORT_DAMAGE: 0.7, // damage of Oil-using units in the same state
  SHORTAGE_CLEARS_AT_DAYS: 0.5, // a shortage flag clears when stock covers this many days of consumption
} as const;

/** Home, integrated and occupied provinces, stability and revolts. */
export const PROVINCE = {
  OUTPUT: { home: 1, integrated: 0.8, occupied: 0.5 }, // Funds and goods multiplier by status
  RECRUITS: { home: 1, integrated: 0.5, occupied: 0 }, // Recruits multiplier by status
  GARRISON: { home: 1, integrated: 0.8, occupied: 0.5 }, // garrison cap multiplier by status
  TRAINING: { home: 1, integrated: 0.8, occupied: 0.5 }, // training speed multiplier by status
  STABILITY_TARGET: { home: 100, integrated: 85, occupied: 60 }, // stability drifts toward this
  STABILITY_DRIFT_PER_DAY: 5, // points per day toward the target, applied hourly
  STABILITY_PER_BATTLE_HOUR: -3, // each combat hour in the province
  STABILITY_HUNGER_PER_DAY: -2, // every owned province while the owner has a Food shortage
  STABILITY_ON_CAPTURE: 25, // set on capture by a non-original owner
  STABILITY_ON_SURRENDER: 40, // set on provinces handed over by capitulation
  STABILITY_ON_LIBERATION: 60, // set when the original nation retakes a province
  STABILITY_RELOCATION: -10, // every player home province when the player's capital moves
  STABILITY_OUTPUT_FLOOR: 0.4, // output x (floor + (1 - floor) x stability/100)
  INTEGRATION_DAYS: 45, // held this long, with its original nation dead, an occupied province integrates
} as const;

/** Occupied provinces can return to a living original nation. */
export const REVOLT = {
  STABILITY_BELOW: 20, // only below this stability
  CHANCE_PER_HOUR: 0.002, // rolled on the game RNG in province order, about 4.7% a day
  SURRENDER_GRACE_DAYS: 5, // no revolt for this long after a capitulation hand-over
  GARRISON_SHARE: 0.5, // a returned province starts with this share of its garrison cap
  STABILITY_AFTER: 50, // and this stability
} as const;

/** Province militia. */
export const GARRISON = {
  BASE_HP: 15, // every province
  HP_PER_SQRT_MILLION: 10, // + 25 x sqrt(population in millions)
  MAX_BASE_HP: 120, // cap before multipliers
  CAPITAL_MULT: 1.5, // original national capitals
  CITY_MULT: 1.2, // provinces with a major city
  REGEN_SHARE_PER_DAY: 0.2, // share of cap regained per day while uncontested, x stability factor
  HP_PER_UNIT: 20, // HP counted as one unit-equivalent for frontage and damage
  DEFENCE: { soft: 3.0, hard: 1.0 }, // damage per hour per unit-equivalent
  EMPTY_BELOW: 0.5, // a garrison below this HP no longer defends
} as const;

/** Land units. Damage is HP per hour per full-strength unit, before COMBAT.DAMAGE_SCALE. */
export const UNITS: Readonly<Record<UnitType, UnitSpec>> = {
  rifles: { name: 'Rifles', short: 'RIF', armour: 'soft', hp: 20, speedKmh: 20, attack: { soft: 3.0, hard: 1.0 }, defence: { soft: 4.0, hard: 1.5 }, exposure: 1, vsGarrison: 1, ignoresRamparts: false, usesOil: false, cost: { funds: 120, recruits: 1000, food: 20 }, hours: 6, trainingLevel: 1, upkeep: { funds: 4, food: 2 } }, // cheap backbone and the best defenders
  hunters: { name: 'Tank Hunters', short: 'HUN', armour: 'soft', hp: 18, speedKmh: 18, attack: { soft: 1.5, hard: 5.0 }, defence: { soft: 2.0, hard: 7.0 }, exposure: 1, vsGarrison: 1, ignoresRamparts: false, usesOil: false, cost: { funds: 180, recruits: 600, food: 15, steel: 20 }, hours: 8, trainingLevel: 1, upkeep: { funds: 5, food: 2 } }, // counter Tanks; weak against infantry
  motor: { name: 'Motor Rifles', short: 'MOT', armour: 'soft', hp: 20, speedKmh: 36, attack: { soft: 3.2, hard: 1.2 }, defence: { soft: 3.6, hard: 1.5 }, exposure: 1, vsGarrison: 1, ignoresRamparts: false, usesOil: true, cost: { funds: 220, recruits: 1000, food: 20, steel: 15, oil: 10 }, hours: 9, trainingLevel: 2, upkeep: { funds: 6, food: 2, oil: 2 } }, // fast infantry; burns Oil
  guns: { name: 'Field Guns', short: 'GUN', armour: 'soft', hp: 14, speedKmh: 16, attack: { soft: 6.0, hard: 2.0 }, defence: { soft: 2.0, hard: 1.0 }, exposure: 0.5, vsGarrison: 1.5, ignoresRamparts: true, usesOil: false, cost: { funds: 240, recruits: 600, food: 10, steel: 30 }, hours: 10, trainingLevel: 2, upkeep: { funds: 6, food: 2 } }, // siege arm: x1.5 on garrisons, ignore Ramparts, shielded (exposure 0.5)
  tanks: { name: 'Tanks', short: 'TNK', armour: 'hard', hp: 36, speedKmh: 30, attack: { soft: 6.0, hard: 4.5 }, defence: { soft: 4.5, hard: 4.0 }, exposure: 1, vsGarrison: 1, ignoresRamparts: false, usesOil: true, cost: { funds: 420, recruits: 400, food: 10, steel: 60, oil: 20 }, hours: 16, trainingLevel: 3, upkeep: { funds: 10, food: 2, oil: 4 } }, // hard target that shrugs off Rifles; burns Oil
};

/** Province buildings; index 0 of `levels` is level 1. */
export const BUILDINGS: Readonly<Record<BuildingType, BuildingSpec>> = {
  works: { name: 'Works', homeOnly: false, levels: [{ cost: { funds: 400, steel: 30 }, hours: 12 }, { cost: { funds: 900, steel: 60 }, hours: 24 }, { cost: { funds: 1800, steel: 120 }, hours: 48 }] }, // extraction: more of the province good (named Farms, Mines or Oil Wells)
  training: { name: 'Training Ground', homeOnly: false, levels: [{ cost: { funds: 250, steel: 20 }, hours: 12 }, { cost: { funds: 700, steel: 60 }, hours: 24 }, { cost: { funds: 1500, steel: 150 }, hours: 36 }] }, // unit production; level gates unit types and speed
  ramparts: { name: 'Ramparts', homeOnly: false, levels: [{ cost: { funds: 250, steel: 40 }, hours: 12 }, { cost: { funds: 500, steel: 80 }, hours: 24 }, { cost: { funds: 1000, steel: 160 }, hours: 48 }] }, // defence and garrison size
  roads: { name: 'Roads', homeOnly: false, levels: [{ cost: { funds: 300, steel: 40 }, hours: 18 }, { cost: { funds: 700, steel: 100 }, hours: 36 }] }, // faster legs through the province
  draft: { name: 'Draft Office', homeOnly: true, levels: [{ cost: { funds: 400, steel: 20 }, hours: 12 }, { cost: { funds: 900, steel: 60 }, hours: 24 }] }, // more Recruits; home or integrated only
};

/** What each building level does. */
export const EFFECTS = {
  WORKS_LABEL: { food: 'Farms', steel: 'Mines', oil: 'Oil Wells' } as Readonly<Record<Good, string>>, // UI name of Works by the province's good
  WORKS_GOODS_PER_LEVEL: 0.4, // +40% of the province's good per level
  WORKS_FUNDS_PER_LEVEL: 0.05, // +5% province Funds per level
  TRAINING_SPEED: [1, 1.25, 1.5] as readonly number[], // training speed by Training Ground level 1..3; a unit needs UNITS[u].trainingLevel
  RAMPARTS_DAMAGE_PER_LEVEL: 0.2, // owner side deals +20% per level
  RAMPARTS_PROTECTION_PER_LEVEL: 0.12, // owner side takes 12% less per level (Field Guns ignore this)
  RAMPARTS_GARRISON_PER_LEVEL: 0.25, // garrison cap +25% per level
  ROADS_SPEED_PER_LEVEL: 0.25, // land legs touching the province: +25% per level, mean of both ends
  DRAFT_RECRUITS_PER_LEVEL: 0.5, // +50% province Recruits per level
  CONSTRUCTION_CANCEL_REFUND: 0.5, // share of cost refunded when a construction is cancelled
  CAPTURE_LEVEL_LOSS: { works: 1, training: 0, ramparts: 1, roads: 0, draft: 0 } as Readonly<Record<BuildingType, number>>, // levels lost on capture (not on capitulation)
} as const;

/** Per-province training queues. */
export const TRAINING = {
  QUEUE_MAX: 5, // items per province, including the one in training
  MAX_PER_ORDER: 5, // units one train command may queue
  CANCEL_QUEUED_REFUND: 1, // refund for an item not yet started
  CANCEL_STARTED_REFUND: 0.5, // refund for the item in training
} as const;

/** The global Exchange. Price factor = clamp(1 + pressure/depth, MIN_FACTOR, MAX_FACTOR); linear, so cost integrals are closed-form. */
export const MARKET = {
  BASE_PRICE: { food: 2, steel: 5, oil: 6 } as Readonly<GoodAmounts>, // Funds per unit at factor 1
  DEPTH: { food: 12_000, steel: 8_000, oil: 4_000 } as Readonly<GoodAmounts>, // pressure that doubles the price, about one day of world output
  BUY_FEE: 1.1, // buyer pays the integral x 1.10
  SELL_FEE: 0.9, // seller receives the integral x 0.90
  MIN_FACTOR: 0.4, // price floor as a share of base
  MAX_FACTOR: 2.5, // price ceiling as a share of base
  DECAY_PER_HOUR: 0.9907, // pressure x this each hour: about 20% per day back toward 0
  MAX_TRADE_DEPTH_SHARE: 0.25, // one trade moves at most 25% of depth
  HISTORY_DAYS: 14, // daily price factors kept for sparklines
  TRADE_STEPS: [100, 1000] as readonly number[], // Exchange panel buttons (and Max)
  DEFAULT_KEEP_DAYS: { food: 2, steel: 0, oil: 2 } as Readonly<GoodAmounts>, // player auto-buy defaults (0 = off)
  DEFAULT_SELL_ABOVE_DAYS: { food: 0, steel: 0, oil: 0 } as Readonly<GoodAmounts>, // player auto-sell is off by default
  AUTO_SELL_MIN_FACTOR: 0.9, // auto-sell (player or AI) never sells below 90% of base
  AUTO_BUY_MAX_FACTOR: 2.0, // above this factor auto-buy only covers one day
  AUTO_FUNDS_RESERVE_DAYS: 2, // auto-buy never spends Funds below 2 days of Funds upkeep
  AUTO_TRADE_HOURS: 6, // auto-trade cadence for the player and the AI's market step
  MIN_AUTO_TRADE: 25, // smallest automatic trade
} as const;

/** Legs, routes and sea crossings. */
export const MOVEMENT = {
  SEA_KMH: 20, // every unit crosses sea at this speed
  SEA_EMBARK_KM: 120, // embarkation as extra km at sea speed (6 h)
  SEA_MAX_KM: 1440, // sea legs cost at most 72 h
  MAX_SPEED_FACTOR: 1.5, // best land multiplier (Roads 2 at both ends); keeps the A* heuristic admissible
  HOSTILE_PATH_PENALTY_HOURS: 24, // route cost for each hostile province before the target
  LANDING_HOURS: 12, // attack penalty lasts this long after a sea crossing into hostile land
  DISENGAGE_HP_LOSS: 0.1, // leaving a contested province costs 10% of current HP
  SURRENDER_FREEZE_HOURS: 12, // armies handed over by capitulation cannot move for this long
  ARRIVE_TOGETHER_DEFAULT: true, // multi-army orders default to arriving in the same tick
} as const;

/** Supply, healing and the player's vision. */
export const SUPPLY = {
  HALO_HOPS: 2, // an army within 2 hops of connected territory is supplied
  UNSUPPLIED_DAMAGE: 0.85, // damage multiplier out of supply
  ATTRITION_PER_HOUR: 0.005, // HP share lost per hour out of supply
  HEAL_HOME_PER_HOUR: 0.015, // HP share of max healed per hour in an own connected uncontested province
  HEAL_FIELD_PER_HOUR: 0.005, // same, supplied and not in battle elsewhere
  VISION_HOPS: 2, // hostile armies are visible within 2 hops of own provinces or armies
} as const;

/** The hourly round. */
export const COMBAT = {
  DAMAGE_SCALE: 0.5, // global battle-length lever: all damage x this
  ROLL_MIN: 0.85, // per side per round, uniform
  ROLL_MAX: 1.15, // per side per round, uniform
  FLANK_FRONTAGE_PER_DIRECTION: 0.5, // attacker frontage +50% per extra direction
  FLANK_FRONTAGE_MAX: 2, // attacker frontage at most x2
  FLANK_DAMAGE_PER_DIRECTION: 0.1, // attacker damage +10% per extra direction
  FLANK_DAMAGE_MAX: 0.2, // at most +20%
  DEFENDER_FRONTAGE_PER_DIRECTION: 0.25, // defender frontage +25% per extra attacking direction
  DEFENDER_FRONTAGE_MAX: 1.5, // at most x1.5
  LANDING_ATTACK: 0.75, // output of landed units while the landing penalty lasts
  DEAD_HP: 0.5, // a pool or army below this HP is gone
  PLAYER_RETREAT_AT: 0.25, // default auto-retreat threshold for player armies
  AI_RETREAT_AT: 0.35, // auto-retreat threshold for AI armies (capital guards use 0)
  RETREAT_OPTIONS: [0, 0.25, 0.5] as readonly number[], // the Army panel choices
  PREDICT_MAX_HOURS: 96, // forecasts stop here and report 'undecided'
  WIN_CHANCE_SAMPLES: 64, // Monte Carlo samples of the real round, local RNG
  VERDICT: { decisive: 0.9, likely: 0.7, close: 0.4, unlikely: 0.1 }, // lower bounds; below unlikely is hopeless
  LOG_ROUNDS: 48, // rounds kept per battle for the Battle panel sparkline (not saved)
} as const;

/** Capitals and capitulation. */
export const CAPITAL = {
  ARMY_KEPT: 0.5, // share of each HP pool of a surrendering army that changes sides
  GARRISON_KEPT: 0.5, // share of each surrendered province's garrison kept
  STOCK_SHARE: 0.5, // share of the loser's Funds and goods the winner takes
  EMPIRE_PROVINCES: 8, // nations this big: world news, capital star at every zoom
  GUARD_NEED: 0.8, // AI keeps capital defence at 2x the threat
} as const;

/** The opening world. */
export const START = {
  UNITS_BASE: 1, // units = round(base + perSqrtFunds x sqrt(Funds/day))
  UNITS_PER_SQRT_FUNDS: 0.8, // France 14, USA 20, China 18, Luxembourg 5; world about 1,130
  CAPITAL_ARMY_SHARE: 0.5, // share standing in the capital
  MAX_BORDER_ARMIES: 3, // the rest split over up to 3 home provinces with the most foreign neighbours
  MIX_BY_TIER: {
    1: { rifles: 0.85, hunters: 0.15, motor: 0, guns: 0, tanks: 0 }, // tier 1: militia-grade armies
    2: { rifles: 0.75, hunters: 0.15, motor: 0, guns: 0.1, tanks: 0 }, // tier 2: a few guns
    3: { rifles: 0.6, hunters: 0.15, motor: 0.05, guns: 0.15, tanks: 0.05 }, // tier 3: first tanks
    4: { rifles: 0.5, hunters: 0.1, motor: 0.1, guns: 0.15, tanks: 0.15 }, // tier 4: combined arms
    5: { rifles: 0.5, hunters: 0.1, motor: 0.1, guns: 0.15, tanks: 0.15 }, // tier 5: combined arms
  } as Readonly<Record<number, Readonly<Record<UnitType, number>>>>, // starting composition, largest remainder
  TRAINING_LEVEL_BY_TIER: { 1: 1, 2: 1, 3: 2, 4: 2, 5: 3 } as Readonly<Record<number, number>>, // capital Training Ground
  CAPITAL_RAMPARTS: 1, // every capital starts with Ramparts 1
  CAPITAL_WORKS_MIN_TIER: 3, // capital Works 1 from this tier
  SECOND_TRAINING_AT_PROVINCES: 8, // nations this big get Training Ground 1 in their most populous other home province
  AI_FUNDS_DAYS: 5, // AI Funds stock in days of gross Funds
  GOODS_DAYS: 3, // goods stock in days of production...
  GOODS_CONSUMPTION_DAYS: 5, // ...but at least this many days of starting consumption...
  GOODS_MIN: { food: 100, steel: 150, oil: 60 } as Readonly<GoodAmounts>, // ...plus this floor, so no nation opens at 0
  RECRUIT_DAYS: 10, // Recruits stock in days of regeneration
} as const;

/** Winning and losing. */
export const VICTORY = {
  VP_SHARE: 0.5, // hold 50% of world VP (1,534 of 3,068 on the committed map)
  RIVAL_DEFEATS: true, // an AI reaching the goal first defeats the player
  MILESTONES: [0.1, 0.2, 0.3, 0.4] as readonly number[], // world-news entries when any nation crosses these shares
  RIVAL_WARNING: 0.35, // critical warning when an AI crosses this share
} as const;

/** AI tiers and scheduling. Majors think often and plan operations; minors think daily. */
export const AI_TIERS = {
  MAX_MAJORS: 32, // hard cap after promotions, keeps at most 3 major thinks per tick
  PROMOTE_PROVINCES: 20, // a minor with this many provinces becomes a major
  PROMOTE_FUNDS_PER_DAY: 1500, // or this much gross Funds
  DEMOTE_RANK_FACTOR: 1.5, // demoted below rank 1.5 x majorCount and under both thresholds
  REVIEW_DAYS: 5, // tier review cadence
  MINOR_THINK_HOURS: 24, // minor cadence
  POWER_PER_UNIT: 40, // tier ranking: power = Funds/day + goods value/day + 40 x units
  ALERT_DELAY_HOURS: 1, // a battle starting in an AI province pulls its next think to +1 h
  MAX_ALERTS_PER_TICK: 2, // further alerts wait a tick, in NationIx order
} as const;

/** AI planning. Budgets are operation counts, never wall-clock time. */
export const AI = {
  MAX_PREDICTIONS: 64, // predictBattle calls per major think
  MAX_PATHS: 24, // A* searches per major think
  MAX_FIELDS: 9, // travel fields per major think (1 frontier + up to 8 targets)
  MAX_FRONTIER: 40, // frontier provinces considered
  MAX_TARGETS: 8, // attack candidates kept after screening
  MAX_ORDERS: 12, // armies ordered per think
  MAX_STAGING_ORDERS: 6, // of which staging moves
  THREAT_HOPS: 2, // threat counts hostile forces within 2 hops
  THREAT_NEAR_WEIGHT: 1, // weight at 1 hop (or inbound)
  THREAT_FAR_WEIGHT: 0.25, // weight at 2 hops
  THREAT_QUEUED_SHARE: 0.5, // units in hostile training queues within 1 hop count at 50%
  FRONT_GUARD: 0.35, // frontier province defence need, x threat
  HOLD_GUARD: 0.9, // survivors must reach 0.9 x hostile force within 2 hops of the prize
  DEFENCE_ETA_HOURS: 24, // defenders are pulled from at most 24 h away
  ATTACK_ETA_HOURS: 48, // attackers are gathered from at most 48 h away
  STAGING_RADIUS_HOURS: 72, // idle interior armies stage within 72 h
  FLANK_PREFERENCE_HOURS: 6, // prefer an army adding a new direction if at most 6 h slower
  REFERENCE_SPEED_KMH: 20, // speed for the frontier travel field
  VALUE_PER_VP: 100, // province value: 100 x VP...
  VALUE_OUTPUT_DAYS: 5, // ...+ 5 days of its Funds and goods (at market price)
  VALUE_CAPITULATION_SHARE: 0.8, // a capital that capitulates adds 0.8 x the rest of the nation's value
  VALUE_ENGAGED_BONUS: 1.3, // x1.3 for a nation we are already fighting
  LEADER_FEAR_SHARE: 0.3, // once any nation holds 30% of VP...
  LEADER_FEAR_BONUS: 1.5, // ...its provinces are worth x1.5 to every AI major
  SCORE_ETA_HOUR_COST: 12, // score = value / (expected HP loss + 12 x mean ETA h + 50)
  SCORE_BASE_COST: 50, // see above
  RETREAT_BELOW_HP: 0.6, // attackers below 60% of startHp in a losing prediction retreat
  REASSIGN_AFTER_HOURS: 12, // an army ordered within 12 h is not reassigned (anti-oscillation)
  MERGE_BELOW_UNITS: 6, // merge co-located idle armies smaller than this
  MERGE_MAX_UNITS: 24, // never merge above this
  SPLIT_ABOVE_UNITS: 36, // split one army above this per think
  SPEND_RESERVE_DAYS: 2, // keep 2 days of Funds upkeep
  BUILD_SHARE_EARLY: 0.45, // share of free Funds for buildings before EARLY_DAYS
  BUILD_SHARE_LATE: 0.3, // after
  EARLY_DAYS: 20, // see above
  MAX_BUILDS_PER_THINK: 2, // constructions started per think
  MAX_TRADES_PER_THINK: 2, // explicit purchases per think
  WORKS_MAX_PAYBACK_DAYS: 25, // Works only if payback at market prices is at most 25 days
  TRAINING_L2_DAY: 3, // capital Training Ground to 2 from day 3
  TRAINING_L3_DAY: 10, // and to 3 from day 10...
  TRAINING_L3_MIN_STEEL_PER_DAY: 30, // ...if Steel income is at least 30/day
  EXTRA_TRAINING_AT_PROVINCES: 8, // second Training Ground from 8 provinces
  MAX_TRAINING_GROUNDS: 4, // at most 4
  CAPITAL_RAMPARTS_THREAT: 0.5, // capital Ramparts up to 2 (3 on ruthless) when threat/defence >= 0.5
  FRONT_RAMPARTS_THREAT: 1.0, // Ramparts 1 on frontier provinces at threat/defence >= 1
  CAPITAL_RAMPARTS_MAX: 2, // relaxed and standard
  CAPITAL_RAMPARTS_MAX_RUTHLESS: 3, // ruthless
  DRAFT_BELOW_TRAINING_DAYS: 2, // Draft Office when Recruits cover under 2 days of queued training
  QUEUE_TARGET: 2, // keep each Training Ground queue at 2 items
  UPKEEP_CEILING: 0.65, // stop queueing while projected Funds upkeep exceeds 65% of gross Funds
  COMPOSITION: { rifles: 0.45, hunters: 0.15, motor: 0.1, guns: 0.15, tanks: 0.15 } as Readonly<Record<UnitType, number>>, // major target mix
  HUNTER_TRIGGER_HARD_SHARE: 0.25, // enemy hard HP share above this...
  HUNTER_EXTRA: 0.1, // ...moves 10% from Rifles to Tank Hunters
  OIL_UNITS_NEED_DAYS: 5, // Motor Rifles and Tanks only if Oil net >= 0 or stock covers 5 days
  MARKET_BUY_BELOW_DAYS: 3, // buy a good below 3 days of consumption...
  MARKET_BUY_TO_DAYS: 5, // ...up to 5 days
  MARKET_SELL_ABOVE_DAYS: 15, // sell above 15 days of consumption...
  MARKET_SELL_TO_DAYS: 10, // ...down to 10, never below AUTO_SELL_MIN_FACTOR
  MARKET_MAX_FUNDS_SHARE: 0.3, // spend at most 30% of free Funds per market step
  MINOR_KEEP: 0.7, // minors attack only keeping 70%...
  MINOR_KEEP_VS_MAJOR: 0.85, // ...or 85% against a major's province
  MINOR_MAX_PREDICTIONS: 4, // prediction budget per minor think
  MINOR_ARMY_BASE: 2, // minor army target = 2 + 1.2 x sqrt(population in millions) units
  MINOR_ARMY_PER_SQRT_MILLION: 1.2, // see above
  MINOR_HUNTER_SHARE: 0.2, // minors train 80% Rifles, 20% Tank Hunters
  MINOR_WORKS_FUNDS_DAYS: 3, // minors build capital Works when Funds exceed 3 days of income plus cost
} as const;

/** The three difficulties. Rules are symmetric; only the AI and the opening change. */
export const DIFFICULTY: Readonly<Record<Difficulty, DifficultySpec>> = {
  relaxed: { label: 'Relaxed', blurb: 'Slower, cautious rivals and a bigger war chest.', aiOutput: 0.85, majorCount: 16, majorThinkHours: 6, attackKeep: 0.45, maxOperations: 3, openingCalmHours: 96, playerGraceDays: 10, playerOperations: 1, playerFundsDays: 12, playerArmyMultiplier: 1.5 }, // learning the game (spec target: the advisor player wins 16-20 of 24; not yet met)
  standard: { label: 'Standard', blurb: 'A fair world. Rivals grow into empires and come for you once you look weak.', aiOutput: 1.0, majorCount: 20, majorThinkHours: 4, attackKeep: 0.3, maxOperations: 6, openingCalmHours: 48, playerGraceDays: 5, playerOperations: 2, playerFundsDays: 8, playerArmyMultiplier: 1.2 }, // the benchmark (spec target 10-14 of 24; not yet met)
  ruthless: { label: 'Ruthless', blurb: 'Richer, bolder rivals who come for you early.', aiOutput: 1.2, majorCount: 24, majorThinkHours: 3, attackKeep: 0.2, maxOperations: 8, openingCalmHours: 24, playerGraceDays: 2, playerOperations: 4, playerFundsDays: 4, playerArmyMultiplier: 1.0 }, // for experts (spec target 3-7 of 24; not yet met)
};

/** The advisor, Suggest (A), Attack with..., and Staff (Delegate/Defend stances). */
export const ADVISOR = {
  ATTACK_KEEP: 0.35, // suggestions keep at least 35% in the mean prediction
  MIN_WIN_CHANCE: 0.7, // and win at least 70% of Monte Carlo samples
  MAX_OPERATIONS: 6, // concurrent Staff operations
  GUARD_SHARE: 0.3, // the advisor holds provinces to this share of the AI's guard need: the player watches the map and can react
  THINK_HOURS: 4, // Staff thinks for Delegate/Defend armies every 4 h
  SUGGESTIONS: 3, // cards shown per Suggest
  DEFEND_RADIUS_HOURS: 24, // Defend stance moves at most 24 h from its post
  ATTACK_WITH_MAX_HOURS: 72, // Attack with... lists armies within 72 h
  FIRST_TARGET_MAX_HOURS: 30, // onboarding's first target must be reachable within 30 h
  DANGER_THREAT_RATIO: 0.8, // own provinces at threat/defence >= 0.8 get a red dashed outline
} as const;

/** Notifications feed. */
export const FEED = {
  MAX_ENTRIES: 300, // kept in the state
  SAVED_ENTRIES: 150, // kept in a save
  MERGE_WINDOW_TICKS: 4, // same-kind entries within 1 h coalesce
  UNITS_READY_MERGE_TICKS: 24, // unitsReady coalesces per province per 6 h
  SIGHTED_COOLDOWN_HOURS: 12, // enemySighted at most once per province per 12 h
} as const;

/** The history chart. */
export const HISTORY = {
  TRACKED_NATIONS: 10, // the player plus the top 10 by VP each midnight
  MAX_POINTS: 400, // downsample to every 2nd day beyond this
} as const;

/** localStorage saves. */
export const SAVE = {
  FORMAT: 5, // save format version
  SOFT_MAX_BYTES: 400_000, // tested budget at day 150
  HARD_MAX_BYTES: 900_000, // above this the feed, then history, are trimmed
} as const;

/** Canvas map level of detail and hit targets (CSS px unless stated). */
export const RENDER = {
  WORLD_WIDTH: 2000, // projected base space width
  WORLD_HEIGHT: 1000, // projected base space height
  MAX_ZOOM: 64, // d3-zoom scale extent upper bound
  MAX_CANVAS_PIXELS: 4_000_000, // DPR is capped so no canvas exceeds 4 megapixels...
  MAX_BASE_CANVAS_PIXELS: 10_000_000, // ...except the base map, which carries gesture margins (2.25x the view): borders and labels at native resolution on a 1440 px Retina screen
  MAX_DPR: 2, // and never above 2
  STAR_PROVINCES: 20, // below city-dot zoom, only your capital and those of nations this big get a star (78 nations start with 8+ provinces)
  BATCH_FILLS_BELOW_ZOOM: 3, // below this zoom fills are batched by colour
  PROVINCE_BORDERS_FROM_ZOOM: 2, // internal province borders drawn from this zoom
  CITY_DOTS_FROM_ZOOM: 3, // city dots from this zoom
  PROVINCE_NAMES_FROM_ZOOM: 5, // province names from this zoom
  NATION_LABELS_BELOW_ZOOM: 2.5, // nation names below this zoom
  AGGREGATE_MARKERS_BELOW_ZOOM: 2.5, // one chip per (province, nation) below this zoom
  GLYPH_MARKERS_FROM_ZOOM: 5, // unit glyph and health bar from this zoom
  FAN_MAX: 4, // armies fanned around an anchor before "+N"
  HIDE_SMALL_ENEMY_UNITS: 10, // below AGGREGATE zoom, hostile stacks under 10 units...
  HIDE_SMALL_ENEMY_HOPS: 2, // ...more than 2 hops from own land are hidden
  MAX_MARKERS_FINE: 600, // marker cap per frame, mouse
  MAX_MARKERS_COARSE: 300, // marker cap per frame, touch
  MARKER_W: 28, // chip width, mouse
  MARKER_H: 18, // chip height, mouse
  MARKER_W_TOUCH: 32, // chip width, touch
  MARKER_H_TOUCH: 22, // chip height, touch
  HIT_RADIUS_FINE: 14, // marker hit radius, mouse
  HIT_RADIUS_COARSE: 22, // marker hit radius, touch
  TINY_PROVINCE_PX2: 400, // a province this small on screen...
  TINY_ANCHOR_PX: 16, // ...wins a tap whose point is within 16 px of its anchor
  LONG_PRESS_MS: 450, // long-press duration
  LONG_PRESS_SLOP_PX: 6, // mouse movement that cancels a long-press and starts a drag
  TOUCH_SLOP_PX: 12, // the same for a finger, which jitters 8-10 px in a plain tap
  GESTURE_SETTLE_MS: 150, // re-raster the base layer this long after a gesture ends
  GESTURE_RERASTER_SCALE: 1.5, // or when a long gesture drifts this far in scale
  GESTURE_MARGIN: 0.25, // base raster margin on each side during gestures
  DIRTY_RECT_MAX: 12, // more changed provinces than this triggers a full repaint
  BASE_REPAINT_MAX_HZ: 4, // ownership repaints are coalesced to 4 per second
  HIT_GRID_CELL: 16, // hit-test grid cell in base units
} as const;
