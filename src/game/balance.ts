/**
 * Every tunable number in the game lives here. Nothing else should hard-code a
 * magic constant — if a rule needs a number, it reads it from this file.
 *
 * Values are grouped by system. Anything marked "starting guess" has not been
 * playtested yet and is expected to move.
 */

/** One turn is one month; all rates below are per-turn unless stated. */
export const TURN = {
  START_YEAR: 1936,
  START_MONTH: 1,
} as const;

/**
 * A = attackerTroops * (1 + DEV_BONUS_PER_LEVEL * attackerDev) * rand
 * D = defenderTroops * (1 + DEV_BONUS_PER_LEVEL * defenderDev) * DEFENDER_ADVANTAGE * rand
 *
 * A > D  -> attacker captures; survivors = attackerTroops * (1 - D/A) * ATTACKER_SURVIVAL
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
 * Manpower is a single national pool, not per-country.
 * Losing territory cuts regen immediately (recomputed from current holdings)
 * but never touches the banked stock.
 */
export const MANPOWER = {
  /** Fraction of owned population added to the pool each turn. */
  REGEN_RATE: 0.002,
  /** Pool ceiling, expressed as months of regen banked. */
  CAP_MONTHS: 12,
  /** Manpower drawn per troop recruited. */
  COST_PER_TROOP: 1,
} as const;

/** Development runs 1..10; investing raises it by one level. */
export const DEVELOPMENT = {
  MIN_LEVEL: 1,
  MAX_LEVEL: 10,
} as const;

export const VICTORY = {
  /** Share of all countries the player must control to win. */
  CONTROL_FRACTION: 0.6,
} as const;

/**
 * AI runs in two tiers so ~175 nations do not scramble the map or flood the log.
 * Tier A gets the full heuristic; Tier B gets cheap defensive logic and only
 * attacks badly outmatched neighbours. Tier B promotes to Tier A on either
 * threshold below. All four values are starting guesses.
 */
export const AI_TIERS = {
  /** Number of strongest nations that get full AI logic from turn one. */
  TIER_A_SIZE: 20,
  /** Tier B attacks only when its troops exceed the defender's by this ratio. */
  TIER_B_ATTACK_RATIO: 2,
  /** Tier B promotes to Tier A at or above this many owned countries. */
  PROMOTE_AT_COUNTRY_COUNT: 4,
  /** Tier B promotes to Tier A at or above this gross income per turn. */
  PROMOTE_AT_INCOME: 500,
} as const;

/** Events are hidden unless they involve the player, a player neighbour, or a Tier A nation. */
export const LOG = {
  MAX_ENTRIES: 500,
} as const;
