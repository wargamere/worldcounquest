import { AI_BUDGET, AI_TIERS, COMBAT, DEVELOPMENT, DIFFICULTY } from './balance';
import { attack, invest, moveTroops, recruit } from './actions';
import { grossIncome, investmentCost, maxAffordableTroops } from './economy';
import type { CountryId, Difficulty, GameState, NationId } from './types';

/**
 * Whether a nation should get the full AI heuristic this turn.
 * The strongest MAJOR_COUNT nations always do; everyone else promotes once they
 * hold enough ground or earn enough to matter.
 */
export function recomputeTiers(state: GameState): GameState {
  const scores = Object.values(state.nations).map((nation) => ({
    id: nation.id,
    income: grossIncome(state, nation.id),
    countries: Object.values(state.countries).filter((c) => c.ownerId === nation.id).length,
  }));

  const majorByRank = new Set(
    [...scores]
      .sort((a, b) => b.income - a.income)
      .slice(0, AI_TIERS.MAJOR_COUNT)
      .map((s) => s.id),
  );

  const nations = { ...state.nations };
  for (const score of scores) {
    const nation = nations[score.id];
    if (!nation) continue;
    const promoted =
      majorByRank.has(score.id) ||
      score.countries >= AI_TIERS.PROMOTE_AT_COUNTRY_COUNT ||
      score.income >= AI_TIERS.PROMOTE_AT_INCOME;
    if (nation.isMajor !== promoted) nations[score.id] = { ...nation, isMajor: promoted };
  }
  return { ...state, nations };
}

interface Border {
  fromId: CountryId;
  targetId: CountryId;
  attackerTroops: number;
  defenderTroops: number;
  /** Expected attack strength over expected defence strength, before the dice. */
  ratio: number;
}

/**
 * Expected combat strength, mirroring the formula in combat.ts with the random
 * roll left at its mean of 1.
 *
 * The AI compares these rather than raw troop counts. Raw counts deadlock the
 * world: once every border sits at parity no stack ever clears the threshold,
 * and because development never enters the comparison, nothing ever shifts it.
 */
function expectedStrength(troops: number, development: number, defending: boolean): number {
  const base = troops * (1 + COMBAT.DEV_BONUS_PER_LEVEL * development);
  return defending ? base * COMBAT.DEFENDER_ADVANTAGE : base;
}

/** Every enemy country a nation could attack, weakest defender first. */
function borders(state: GameState, nationId: NationId): Border[] {
  const found: Border[] = [];
  for (const country of Object.values(state.countries)) {
    if (country.ownerId !== nationId || country.hasMoved || country.troops < 2) continue;
    for (const neighbourId of state.adjacency[country.id] ?? []) {
      const target = state.countries[neighbourId];
      if (!target || target.ownerId === nationId) continue;
      const committed = Math.floor(country.troops * AI_BUDGET.COMMIT_SHARE);
      if (committed < 1) continue;
      const attackPower = expectedStrength(committed, country.development, false);
      const defencePower = Math.max(
        0.01,
        expectedStrength(target.troops, target.development, true),
      );
      found.push({
        fromId: country.id,
        targetId: neighbourId,
        attackerTroops: committed,
        defenderTroops: target.troops,
        ratio: attackPower / defencePower,
      });
    }
  }
  return found.sort((a, b) => b.ratio - a.ratio);
}

/**
 * Full heuristic, for major powers:
 *   1. invest in the weakest-developed country if the treasury allows
 *   2. recruit up to an affordability cap
 *   3. attack the weakest adjacent enemy once the troop ratio clears aggression
 */
function takeMajorTurn(state: GameState, nationId: NationId, difficulty: Difficulty): GameState {
  const settings = DIFFICULTY[difficulty];
  let current = state;

  const nation = current.nations[nationId];
  if (!nation) return current;

  if (nation.treasury > settings.investThreshold) {
    const weakest = Object.values(current.countries)
      .filter((c) => c.ownerId === nationId && c.development < DEVELOPMENT.MAX_LEVEL)
      .sort((a, b) => a.development - b.development)[0];
    if (weakest && nation.treasury >= investmentCost(weakest.development)) {
      current = invest(current, nationId, weakest.id).state;
    }
  }

  const budget = Math.floor(
    maxAffordableTroops(current, nationId) * AI_BUDGET.RECRUIT_TREASURY_SHARE,
  );
  if (budget > 0) {
    const frontline = Object.values(current.countries)
      .filter((c) => c.ownerId === nationId)
      .map((c) => ({
        country: c,
        exposure: (current.adjacency[c.id] ?? []).filter(
          (n) => current.countries[n] && current.countries[n]?.ownerId !== nationId,
        ).length,
      }))
      .sort((a, b) => b.exposure - a.exposure)[0];
    if (frontline) current = recruit(current, nationId, frontline.country.id, budget).state;
  }

  current = reinforceFront(current, nationId);

  for (const border of borders(current, nationId)) {
    if (border.ratio < settings.aggression) continue;
    const source = current.countries[border.fromId];
    if (!source || source.hasMoved) continue;
    current = attack(current, nationId, border.fromId, border.targetId, border.attackerTroops).state;
    break;
  }

  return current;
}

/**
 * Walks surplus troops out of safe interior countries and into the most
 * threatened border country.
 *
 * Without this the AI deadlocks: everyone recruits until upkeep eats their
 * income, every border sits at roughly parity, no stack ever reaches the
 * aggression ratio, and the map stops changing entirely.
 */
function reinforceFront(state: GameState, nationId: NationId): GameState {
  const owned = Object.values(state.countries).filter((c) => c.ownerId === nationId);
  if (owned.length < 2) return state;

  const exposure = (id: CountryId): number =>
    (state.adjacency[id] ?? []).filter((n) => {
      const neighbour = state.countries[n];
      return neighbour !== undefined && neighbour.ownerId !== nationId;
    }).length;

  const front = owned
    .map((c) => ({ country: c, exposure: exposure(c.id) }))
    .filter((c) => c.exposure > 0)
    .sort((a, b) => b.exposure - a.exposure)[0];
  if (!front) return state;

  const rear = owned
    .filter(
      (c) =>
        c.id !== front.country.id &&
        !c.hasMoved &&
        c.troops > AI_BUDGET.REAR_GARRISON &&
        exposure(c.id) < front.exposure &&
        (state.adjacency[c.id] ?? []).includes(front.country.id),
    )
    .sort((a, b) => b.troops - a.troops)[0];
  if (!rear) return state;

  const spare = rear.troops - AI_BUDGET.REAR_GARRISON;
  return moveTroops(state, nationId, rear.id, front.country.id, spare).state;
}

/**
 * Cheap heuristic, for everyone else: hold a garrison floor and only attack a
 * neighbour it badly outguns. Keeps 150+ minor nations from churning the map.
 */
function takeMinorTurn(state: GameState, nationId: NationId): GameState {
  let current = state;

  const owned = Object.values(current.countries).filter((c) => c.ownerId === nationId);
  const thin = owned.filter((c) => c.troops < AI_TIERS.MINOR_GARRISON_FLOOR)[0];
  if (thin) {
    const wanted = AI_TIERS.MINOR_GARRISON_FLOOR - thin.troops;
    const affordable = Math.min(wanted, maxAffordableTroops(current, nationId));
    if (affordable > 0) current = recruit(current, nationId, thin.id, affordable).state;
  }

  for (const border of borders(current, nationId)) {
    if (border.ratio < AI_TIERS.MINOR_ATTACK_RATIO) continue;
    const source = current.countries[border.fromId];
    if (!source || source.hasMoved) continue;
    current = attack(current, nationId, border.fromId, border.targetId, border.attackerTroops).state;
    break;
  }

  return current;
}

export function takeAITurn(state: GameState, nationId: NationId): GameState {
  const nation = state.nations[nationId];
  if (!nation || nation.isPlayer) return state;
  return nation.isMajor
    ? takeMajorTurn(state, nationId, state.difficulty)
    : takeMinorTurn(state, nationId);
}
