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

/**
 * Size-proportionate garrison: BASE + sqrt(population / 1e6) * PER_ROOT_MILLION.
 * Sets every country's opening garrison and the floor minor nations rebuild to.
 */
export const GARRISON = {
  BASE: 10,
  PER_ROOT_MILLION: 2,
} as const;

export const VICTORY = {
  /** Share of all countries a nation must control to achieve hegemony. */
  CONTROL_FRACTION: 0.6,
  /**
   * If an AI nation reaches CONTROL_FRACTION first, the player loses. Without
   * this, an AI could quietly own most of the world while the player kept
   * playing towards a win that was no longer reachable.
   */
  RIVAL_HEGEMONY_DEFEATS: true,
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
  /** Capture probability a Tier B nation wants before it attacks. */
  MINOR_WIN_CHANCE: 0.9,
  /** Highest risk to its own source country a Tier B nation will accept. */
  MINOR_RISK_TOLERANCE: 0.15,
  /** Tier B promotes to Tier A at or above this many owned countries. */
  PROMOTE_AT_COUNTRY_COUNT: 4,
  /** Tier B promotes to Tier A at or above this gross income per turn. */
  PROMOTE_AT_INCOME: 500,
} as const;

/**
 * Per-difficulty AI behaviour.
 *
 * `winChance` — the capture probability an AI wants before it attacks. Lower is
 *   braver.
 * `riskTolerance` — the highest chance of losing the source country an AI will
 *   accept for the garrison it leaves behind. This is what stops the AI from
 *   hollowing out its own home to go on the offensive.
 * `attacksPerTurn` — attacks a major power may launch in one turn.
 * `incomeMultiplier` — applied to AI income only, never the player's.
 * `playerTreasuryMonths` — the player's opening treasury, in months of their
 *   income. AI nations always start with ECONOMY.STARTING_TREASURY_MONTHS. A
 *   bigger war chest gives the player a real opening move in year one instead of
 *   several years of recruiting before the first safe attack.
 */
export const DIFFICULTY = {
  relaxed: { winChance: 0.85, riskTolerance: 0.1, attacksPerTurn: 2, incomeMultiplier: 0.8, investThreshold: 400, playerTreasuryMonths: 8 },
  standard: { winChance: 0.75, riskTolerance: 0.15, attacksPerTurn: 5, incomeMultiplier: 1.0, investThreshold: 300, playerTreasuryMonths: 6 },
  ruthless: { winChance: 0.65, riskTolerance: 0.25, attacksPerTurn: 10, incomeMultiplier: 1.25, investThreshold: 200, playerTreasuryMonths: 3 },
} as const;

export const AI_BUDGET = {
  /** Fraction of affordable troops a major AI recruits in one turn. */
  RECRUIT_TREASURY_SHARE: 0.5,
  /** Floor a country keeps when it sends troops elsewhere. */
  REAR_GARRISON: 4,
  /**
   * An attack sends this multiple of the troops the win needs, capped by what the
   * source can safely spare, so the survivors can hold the territory and keep
   * going. Raise to speed up conquest; lower to slow it.
   */
  OVERCOMMIT: 2,
  /**
   * Highest chance of losing a freshly captured country straight back that an
   * attack may accept. Stops captures that just hand the territory to a third
   * nation.
   */
  HOLD_TOLERANCE: 0.5,
  /**
   * Share of a neighbour's strike force — standing troops plus what it can
   * recruit first — assumed thrown at a country when estimating the threat to it.
   */
  THREAT_COMMIT_SHARE: 0.65,
  /**
   * Share of an enemy nation's affordable recruits assumed to land on any one of
   * its borders before it attacks. At 1 every border counts the whole budget, so
   * every country looks lethally threatened and the world freezes; at 0 threats
   * ignore recruitment entirely and homelands get emptied in month one.
   */
  THREAT_RESERVE_SHARE: 0.3,
} as const;

/**
 * The in-game advisor and the order panel's presets. The advisor runs the AI's
 * own planner on the player's behalf with these settings.
 */
export const ADVISOR = {
  WIN_CHANCE: 0.8,
  RISK_TOLERANCE: 0.2,
  /** "Safe" preset on the order panel. */
  SAFE_CHANCE: 0.9,
  /** "Likely" preset on the order panel. */
  LIKELY_CHANCE: 0.7,
  /** Own countries above this chance of falling next turn are flagged on the map. */
  DANGER_THRESHOLD: 0.35,
  /** Smallest troop movement the advisor bothers to suggest. */
  MIN_MOVE: 5,
} as const;

export const HISTORY = {
  /** Nations recorded each month besides the player: enough to chart the leaders. */
  TRACKED_NATIONS: 10,
} as const;

export const LOG = {
  /** Entries kept before the oldest are dropped. */
  MAX_ENTRIES: 400,
} as const;
