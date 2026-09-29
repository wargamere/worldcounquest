import { holdableCommitment, safeGarrison } from './ai';
import { ADVISOR } from './balance';
import { captureProbability, expectedSurvivors, troopsForChance } from './combat';
import { combinedThreat, holdRisk, strongestThreat, type Threat } from './threat';
import type { CountryId, GameState } from './types';

export interface AttackPreview {
  winChance: number;
  /** Troops expected to hold the country afterwards, if the attack succeeds. */
  survivors: number;
  /** Chance the staging country falls next turn with what is left behind. */
  sourceRisk: number;
  /** Chance of losing the captured country straight back. */
  holdRisk: number;
}

/**
 * Everything the order panel shows before the player commits to an attack. The
 * numbers come from the same functions the AI decides with, so what the player
 * sees is what the game will actually do.
 */
export function previewAttack(
  state: GameState,
  fromId: CountryId,
  targetId: CountryId,
  troops: number,
): AttackPreview | null {
  const from = state.countries[fromId];
  const target = state.countries[targetId];
  if (!from || !target || troops < 1) return null;
  const input = {
    attackerTroops: troops,
    attackerDev: from.development,
    defenderTroops: target.troops,
    defenderDev: target.development,
  };
  return {
    winChance: captureProbability(input),
    survivors: expectedSurvivors(input),
    sourceRisk: combinedThreat(state, fromId, from.troops - troops, targetId),
    holdRisk: holdRisk(state, from.ownerId, from.development, targetId, troops),
  };
}

export interface AttackPresets {
  /** Fewest troops for a near-certain win, or null if out of reach. */
  safe: number | null;
  /** Fewest troops for a likely win, or null if out of reach. */
  likely: number | null;
  /**
   * Most troops that can go while the source stays under the advisor's risk
   * tolerance — what can be sent without inviting the neighbours in.
   */
  spare: number;
  /** Everything but one troop. */
  all: number;
  /**
   * The force the order panel starts on: one that wins, keeps home safe and can
   * hold the prize if such a force exists; otherwise everything home can spare;
   * otherwise the likely-win force even though it is unsafe — the panel then
   * shows exactly how unsafe. Never simply "all".
   */
  recommended: number;
}

export function attackPresets(state: GameState, fromId: CountryId, targetId: CountryId): AttackPresets {
  const from = state.countries[fromId];
  const target = state.countries[targetId];
  if (!from || !target) return { safe: null, likely: null, spare: 0, all: 0, recommended: 0 };
  const available = Math.max(0, from.troops - 1);
  const base = { attackerDev: from.development, defenderDev: target.development, defenderTroops: target.troops };
  const safe = troopsForChance(base, available, ADVISOR.SAFE_CHANCE);
  const likely = troopsForChance(base, available, ADVISOR.LIKELY_CHANCE);
  const spare = Math.max(0, Math.min(available, from.troops - safeGarrison(state, fromId, ADVISOR.RISK_TOLERANCE, targetId)));

  // Prefer a force that wins, keeps home safe, and leaves enough survivors to
  // hold the prize — the same sizing the AI uses. A force that merely won once
  // left Belgium 95% likely to be retaken the next month.
  const needed = safe !== null && safe <= spare ? safe : likely !== null && likely <= spare ? likely : null;
  const holdable =
    needed === null ? null : holdableCommitment(state, from.ownerId, from.development, targetId, needed, spare);

  let recommended: number;
  if (holdable !== null) recommended = holdable;
  else if (needed !== null) recommended = spare;
  else recommended = likely ?? safe ?? Math.max(1, Math.min(available, spare || available));

  return { safe, likely, spare, all: available, recommended: Math.max(1, Math.min(available, recommended)) };
}

export interface MovePreview {
  sourceRisk: number;
  destinationRisk: number;
}

export function previewMove(
  state: GameState,
  fromId: CountryId,
  toId: CountryId,
  troops: number,
): MovePreview | null {
  const from = state.countries[fromId];
  const to = state.countries[toId];
  if (!from || !to) return null;
  return {
    sourceRisk: combinedThreat(state, fromId, from.troops - troops),
    destinationRisk: combinedThreat(state, toId, to.troops + troops),
  };
}

export interface CountryRisk {
  chance: number;
  worst: Threat | null;
}

/** Risk summary for one country: overall chance of falling, and who is most to blame. */
export function countryRisk(state: GameState, countryId: CountryId): CountryRisk {
  return { chance: combinedThreat(state, countryId), worst: strongestThreat(state, countryId) };
}
