import { COMBAT } from './balance';
import { nextInRange } from './rng';
import type { CombatResult } from './types';

export interface CombatInput {
  attackerTroops: number;
  attackerDev: number;
  defenderTroops: number;
  defenderDev: number;
}

/**
 * Resolves one battle. Pure: takes the RNG state in and hands the advanced
 * state back, so a given seed always produces the same war.
 */
export function resolveCombat(
  input: CombatInput,
  rngState: number,
): { result: CombatResult; rngState: number } {
  const attackRoll = nextInRange(rngState, COMBAT.ROLL_MIN, COMBAT.ROLL_MAX);
  const defenceRoll = nextInRange(attackRoll.state, COMBAT.ROLL_MIN, COMBAT.ROLL_MAX);

  const attackPower =
    input.attackerTroops * (1 + COMBAT.DEV_BONUS_PER_LEVEL * input.attackerDev) * attackRoll.value;
  const defencePower =
    input.defenderTroops *
    (1 + COMBAT.DEV_BONUS_PER_LEVEL * input.defenderDev) *
    COMBAT.DEFENDER_ADVANTAGE *
    defenceRoll.value;

  if (attackPower > defencePower) {
    const survivors = Math.max(
      1,
      Math.round(input.attackerTroops * (1 - defencePower / attackPower) * COMBAT.ATTACKER_SURVIVAL),
    );
    return {
      result: {
        captured: true,
        attackPower,
        defencePower,
        attackerSurvivors: survivors,
        defenderSurvivors: 0,
      },
      rngState: defenceRoll.state,
    };
  }

  const defenderLosses = Math.round(
    input.attackerTroops * (attackPower / defencePower) * COMBAT.DEFENDER_LOSS_ON_HOLD,
  );
  return {
    result: {
      captured: false,
      attackPower,
      defencePower,
      attackerSurvivors: 0,
      defenderSurvivors: Math.max(0, input.defenderTroops - defenderLosses),
    },
    rngState: defenceRoll.state,
  };
}

/** The debug line written to the event log for every battle. */
export function describeCombat(
  attackerName: string,
  defenderName: string,
  input: CombatInput,
  result: CombatResult,
): string {
  const a = result.attackPower.toFixed(1);
  const d = result.defencePower.toFixed(1);
  if (result.captured) {
    return `${attackerName} took ${defenderName}: ${input.attackerTroops} troops (A ${a}) beat ${input.defenderTroops} (D ${d}); ${result.attackerSurvivors} survived.`;
  }
  return `${attackerName} failed against ${defenderName}: ${input.attackerTroops} troops (A ${a}) lost to ${input.defenderTroops} (D ${d}); defender left with ${result.defenderSurvivors}.`;
}

/** Deterministic strength before the dice: troops scaled by development. */
export function baseStrength(troops: number, development: number, defending: boolean): number {
  const base = troops * (1 + COMBAT.DEV_BONUS_PER_LEVEL * development);
  return defending ? base * COMBAT.DEFENDER_ADVANTAGE : base;
}

/**
 * Exact probability that an attack captures the territory.
 *
 * Both sides roll independently from U(ROLL_MIN, ROLL_MAX), and the attacker wins
 * when a * r1 > d * r2, i.e. r1 > k * r2 with k = d / a. Integrating over r2:
 *
 *   f(r2) = w              while k * r2 <= L   (every attacker roll wins)
 *         = H - k * r2     while L < k * r2 < H
 *         = 0              once  k * r2 >= H   (no attacker roll wins)
 *
 * which is piecewise linear, so the integral is closed-form. No sampling.
 */
export function captureProbability(input: CombatInput): number {
  if (input.attackerTroops <= 0) return 0;
  if (input.defenderTroops <= 0) return 1;

  const a = baseStrength(input.attackerTroops, input.attackerDev, false);
  const d = baseStrength(input.defenderTroops, input.defenderDev, true);
  const L = COMBAT.ROLL_MIN;
  const H = COMBAT.ROLL_MAX;
  const w = H - L;
  const k = d / a;

  const clamp = (x: number): number => Math.min(H, Math.max(L, x));
  const b1 = clamp(L / k);
  const b2 = clamp(H / k);
  const area = w * (b1 - L) + H * (b2 - b1) - (k * (b2 * b2 - b1 * b1)) / 2;
  return Math.min(1, Math.max(0, area / (w * w)));
}

/**
 * Fewest troops that reach `targetChance`, or null if even the whole stack falls
 * short. Capture probability rises monotonically with troops, so bisect.
 */
export function troopsForChance(
  input: Omit<CombatInput, 'attackerTroops'>,
  available: number,
  targetChance: number,
): number | null {
  const chance = (n: number): number => captureProbability({ ...input, attackerTroops: n });
  if (available < 1 || chance(available) < targetChance) return null;
  let low = 1;
  let high = available;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (chance(mid) >= targetChance) high = mid;
    else low = mid + 1;
  }
  return low;
}

/**
 * Survivors if the attack succeeds, using the mean roll. Shown as a preview so the
 * player knows roughly what they will hold the territory with.
 */
export function expectedSurvivors(input: CombatInput): number {
  const a = baseStrength(input.attackerTroops, input.attackerDev, false);
  const d = baseStrength(input.defenderTroops, input.defenderDev, true);
  if (a <= d) return 0;
  return Math.max(1, Math.round(input.attackerTroops * (1 - d / a) * COMBAT.ATTACKER_SURVIVAL));
}
