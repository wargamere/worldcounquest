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
