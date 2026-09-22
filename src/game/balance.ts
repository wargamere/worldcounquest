/**
 * Every tunable number in the game lives here. Nothing else should hard-code a
 * magic constant — if a rule needs a number, it reads it from this file.
 *
 * Values grouped by system. Anything marked "starting guess" has not been
 * playtested and is expected to move.
 */

/** One turn is one month; every rate below is per turn unless stated. */
export const TURN = {
  START_YEAR: 1936,
  /** 1 = January. */
  START_MONTH: 1,
} as const;

/**
 * A = attackerTroops * (1 + DEV_BONUS_PER_LEVEL * attackerDev) * roll
 * D = defenderTroops * (1 + DEV_BONUS_PER_LEVEL * defenderDev) * DEFENDER_ADVANTAGE * roll
 *
 * A > D  -> attacker captures; survivors = attackerTroops * (1 - D/A) * ATTACKER_SURVIVAL,
 *           defender is wiped.
 * A <= D -> attack fails; attacker loses everything committed,
 *           defender loses attackerTroops * (A/D) * DEFENDER_LOSS_ON_HOLD.
 */
export const COMBAT = {
  DEV_BONUS_PER_LEVEL: 0.1,
  DEFENDER_ADVANTAGE: 1.25,
  ROLL_MIN: 0.85,
  ROLL_MAX: 1.15,
  ATTACKER_SURVIVAL: 0.8,
  DEFENDER_LOSS_ON_HOLD: 0.6,
} as const;

/**
 * Income per country per turn:
 *   sqrt(population / 1e6) * TIER_FACTOR[tier] * (1 + DEV_INCOME_PER_LEVEL * development)
 *
 * The square root on population deliberately compresses the spread — without it
 * India and China out-earn everyone by two orders of magnitude and nothing else
 * on the map can act.
 */
export const ECONOMY = {
  TIER_FACTOR: { 1: 2, 2: 3, 3: 5, 4: 8, 5: 12 } as Record<number, number>,
  DEV_INCOME_PER_LEVEL: 0.15,
  /** Money per troop per turn. */
  TROOP_UPKEEP: 0.4,
  /** Treasury at game start, as a multiple of the nation's opening gross income. */
  STARTING_TREASURY_MONTHS: 3,
  /**
   * Treasury below zero means troops desert: this fraction of every stack is
   * lost and the treasury is floored back to zero.
   */
  BANKRUPTCY_DESERTION_RATE: 0.1,
} as const;

/** Development runs 1..10. Investing raises it by one level. */
export const DEVELOPMENT = {
  MIN_LEVEL: 1,
  MAX_LEVEL: 10,
  /** Cost to go from `level` to `level + 1` is BASE_COST * level ** COST_EXPONENT. */
  BASE_COST: 25,
  COST_EXPONENT: 1.6,
  /** Opening development is tier * 2 - 1, giving 1/3/5/7/9 across the five tiers. */
  START_FROM_TIER: (tier: number): number => tier * 2 - 1,
} as const;

/**
 * Manpower is a single national pool, not per-country.
 * Losing territory cuts regen immediately (recomputed from current holdings)
 * but never touches the banked stock.
 */
export const MANPOWER = {
  /** Fraction of owned population added to the pool each turn. */
  REGEN_RATE: 0.002,
  /** Pool ceiling, in months of regen banked. */
  CAP_MONTHS: 12,
  /** Manpower drawn per troop recruited. */
  COST_PER_TROOP: 5000,
  /** Pool at game start, in months of regen. */
  STARTING_MONTHS: 6,
} as const;

export const RECRUITMENT = {
  /** Money per troop, on top of the manpower cost. */
  MONEY_PER_TROOP: 8,
} as const;

/** Opening garrison: 5 + sqrt(population / 1e6) * 3, so size matters but does not dominate. */
export const GARRISON = {
  BASE: 10,
  PER_ROOT_MILLION: 2,
} as const;

export const VICTORY = {
  /** Share of all countries the player must control to win. */
  CONTROL_FRACTION: 0.6,
} as const;

/**
 * AI runs in two tiers so ~175 nations do not scramble the map or flood the log.
 * Tier A ("major") gets the full heuristic. Tier B gets cheap defensive logic and
 * only attacks badly outmatched neighbours. Tier B promotes on either threshold.
 * All of these are starting guesses.
 */
export const AI_TIERS = {
  /** Strongest nations that get full AI logic from turn one. */
  MAJOR_COUNT: 20,
  /** Tier B attacks only when its expected strength exceeds the defender's by this factor. */
  MINOR_ATTACK_RATIO: 2.2,
  /** Tier B garrison floor it will recruit towards, in troops. */
  MINOR_GARRISON_FLOOR: 22,
  /** Tier B promotes to Tier A at or above this many owned countries. */
  PROMOTE_AT_COUNTRY_COUNT: 4,
  /** Tier B promotes to Tier A at or above this gross income per turn. */
  PROMOTE_AT_INCOME: 500,
} as const;

/**
 * Per-difficulty AI behaviour.
 *
 * `aggression` is the expected-strength ratio a major AI needs before it
 * attacks — lower is braver. It is already normalised by the defender advantage,
 * so 1.0 means "an even fight on paper".
 *
 * `incomeMultiplier` is applied to AI income only, never the player's.
 */
export const DIFFICULTY = {
  relaxed: { aggression: 2.1, incomeMultiplier: 0.85, investThreshold: 400 },
  standard: { aggression: 1.6, incomeMultiplier: 1, investThreshold: 300 },
  ruthless: { aggression: 1.2, incomeMultiplier: 1.25, investThreshold: 200 },
} as const;

export const AI_BUDGET = {
  /** Fraction of treasury a major AI will spend on troops in one turn. */
  RECRUIT_TREASURY_SHARE: 0.5,
  /** Troops held back in a country that is not on a hostile border. */
  REAR_GARRISON: 4,
  /** Fraction of a stack committed to an attack. */
  COMMIT_SHARE: 0.8,
} as const;

export const LOG = {
  /** Entries kept before the oldest are dropped. */
  MAX_ENTRIES: 400,
} as const;
