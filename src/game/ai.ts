import { ADVISOR, AI_BUDGET, AI_TIERS, DEVELOPMENT, DIFFICULTY } from './balance';
import { attack, invest, moveTroops, recruit } from './actions';
import { baseStrength, troopsForChance } from './combat';
import { countryIncome, garrisonFor, grossIncome, investmentCost, maxAffordableTroops } from './economy';
import { combinedThreat, holdRisk } from './threat';
import type { CountryId, GameState, NationId } from './types';

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

export interface AttackPlan {
  fromId: CountryId;
  targetId: CountryId;
  /** Troops to commit: enough to win, plus enough spare to hold the prize. */
  troops: number;
  /** Target income per troop the win needs; higher is a better deal. */
  value: number;
}

/**
 * The best attack available to a nation, or null if none is worth taking.
 *
 * An attack is only considered if (a) the source can spare enough troops to
 * reach `winChance`, where (b) "spare" means whatever it holds above the garrison
 * that keeps its own risk of falling under `riskTolerance`.
 *
 * Rule (b) is the one that matters. Without it every AI committed most of its
 * home stack, left a hollow shell behind, and was eaten next turn by whoever
 * was adjacent — the Netherlands owned Germany in month one and Belgium owned
 * the United Kingdom in month two.
 */
export function planAttack(
  state: GameState,
  nationId: NationId,
  winChance: number,
  riskTolerance: number,
): AttackPlan | null {
  let best: AttackPlan | null = null;

  for (const source of Object.values(state.countries)) {
    if (source.ownerId !== nationId || source.hasMoved || source.troops < 2) continue;

    for (const targetId of state.adjacency[source.id] ?? []) {
      const target = state.countries[targetId];
      if (!target || target.ownerId === nationId) continue;

      // The target itself is excluded from the threat check: if we win it is
      // ours, if we lose it is weakened — either way it is not what endangers the
      // garrison we leave behind.
      const keep = safeGarrison(state, source.id, riskTolerance, targetId);
      const spare = source.troops - keep;
      if (spare < 1) continue;

      const needed = troopsForChance(
        {
          attackerDev: source.development,
          defenderDev: target.development,
          defenderTroops: target.troops,
        },
        spare,
        winChance,
      );
      if (needed === null) continue;

      const troops = holdableCommitment(state, nationId, source.development, target.id, needed, spare);
      if (troops === null) continue;

      const value = countryIncome(target) / needed;
      if (!best || value > best.value) {
        best = { fromId: source.id, targetId, troops, value };
      }
    }
  }

  return best;
}

/**
 * How many troops to send so the attack both wins and leaves survivors who can
 * hold the prize, or null if no force the source can spare manages both.
 *
 * Starts from OVERCOMMIT times the bare minimum — committing only `needed` left
 * conquests with one survivor and the frontier never advanced — and grows the
 * force from there until the capture is holdable. France once took Germany with
 * five survivors, lost it straight back, and had emptied its homeland to do it.
 * Sizing against the hold, rather than capping at a fixed multiple, is what lets
 * a large army actually be used: the US once sat 1,637 troops in Costa Rica,
 * refusing to take Panama because 48 of them could not hold it.
 */
export function holdableCommitment(
  state: GameState,
  nationId: NationId,
  attackerDev: number,
  targetId: CountryId,
  needed: number,
  spare: number,
): number | null {
  const holds = (troops: number): boolean =>
    holdRisk(state, nationId, attackerDev, targetId, troops) <= AI_BUDGET.HOLD_TOLERANCE;

  const minimum = Math.min(spare, Math.ceil(needed * AI_BUDGET.OVERCOMMIT));
  if (holds(minimum)) return minimum;
  if (!holds(spare)) return null;

  let low = minimum;
  let high = spare;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (holds(mid)) high = mid;
    else low = mid + 1;
  }
  return low;
}

/**
 * Fewest troops that keep `countryId`'s combined chance of falling at or under
 * `riskTolerance`. Threat only falls as the garrison grows, so bisect.
 */
export function safeGarrison(
  state: GameState,
  countryId: CountryId,
  riskTolerance: number,
  ignoreId?: CountryId,
): number {
  const country = state.countries[countryId];
  if (!country) return 0;
  const risky = (garrison: number): boolean =>
    combinedThreat(state, countryId, garrison, ignoreId) > riskTolerance;

  const floor = Math.min(AI_BUDGET.REAR_GARRISON, country.troops);
  if (!risky(floor)) return floor;
  if (risky(country.troops)) return country.troops;

  let low = floor;
  let high = country.troops;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (risky(mid)) low = mid + 1;
    else high = mid;
  }
  return low;
}

/**
 * The owned border country with the softest enemy next door — where fresh troops
 * are most likely to turn into a capture.
 */
function stagingCountry(state: GameState, nationId: NationId): CountryId | null {
  let best: { id: CountryId; softest: number } | null = null;
  for (const country of Object.values(state.countries)) {
    if (country.ownerId !== nationId) continue;
    for (const neighbourId of state.adjacency[country.id] ?? []) {
      const enemy = state.countries[neighbourId];
      if (!enemy || enemy.ownerId === nationId) continue;
      const softness = baseStrength(enemy.troops, enemy.development, true) / Math.max(1, countryIncome(enemy));
      if (!best || softness < best.softest) best = { id: country.id, softest: softness };
    }
  }
  return best?.id ?? null;
}

/**
 * Recruits where it matters: into a country at real risk of falling if there is
 * one, otherwise onto the border with the softest target, so the army that gets
 * raised is an army that can be used.
 */
function recruitWhereUseful(
  state: GameState,
  nationId: NationId,
  troops: number,
  riskTolerance: number,
): GameState {
  if (troops <= 0) return state;
  const owned = Object.values(state.countries).filter((c) => c.ownerId === nationId);
  const endangered = owned
    .map((c) => ({ id: c.id, chance: combinedThreat(state, c.id) }))
    .sort((a, b) => b.chance - a.chance)[0];
  const target =
    endangered && endangered.chance > riskTolerance
      ? endangered.id
      : (stagingCountry(state, nationId) ?? endangered?.id);
  return target ? recruit(state, nationId, target, troops).state : state;
}

/** Enemy countries bordering `id`. */
function enemyNeighbours(state: GameState, id: CountryId, nationId: NationId): number {
  return (state.adjacency[id] ?? []).filter((n) => {
    const neighbour = state.countries[n];
    return neighbour !== undefined && neighbour.ownerId !== nationId;
  }).length;
}

/**
 * Walks spare troops toward where they are needed.
 *
 * A threatened neighbour gets them first. Failing that, a country with no enemy
 * neighbours at all pushes its surplus one step toward the frontier — otherwise
 * interior garrisons pile up forever, borders sit at parity, and the map freezes.
 * Spare is whatever the source can give up while staying under the nation's risk
 * tolerance.
 */
function reinforce(state: GameState, nationId: NationId, riskTolerance: number): GameState {
  let current = state;
  const owned = Object.values(current.countries).filter((c) => c.ownerId === nationId);
  if (owned.length < 2) return current;

  for (const source of owned) {
    const fresh = current.countries[source.id];
    if (!fresh || fresh.hasMoved || fresh.troops <= AI_BUDGET.REAR_GARRISON) continue;

    const friendly = (current.adjacency[source.id] ?? [])
      .map((id) => current.countries[id])
      .filter((c): c is NonNullable<typeof c> => c !== undefined && c.ownerId === nationId);
    if (friendly.length === 0) continue;

    const threatened = friendly
      .map((c) => ({ id: c.id, chance: combinedThreat(current, c.id) }))
      .sort((a, b) => b.chance - a.chance)[0];

    let destination: CountryId | null = null;
    if (threatened && threatened.chance > riskTolerance) {
      destination = threatened.id;
    } else if (enemyNeighbours(current, source.id, nationId) === 0) {
      destination =
        friendly.sort(
          (a, b) => enemyNeighbours(current, b.id, nationId) - enemyNeighbours(current, a.id, nationId),
        )[0]?.id ?? null;
    }
    if (!destination) continue;

    const spare = fresh.troops - safeGarrison(current, source.id, riskTolerance);
    if (spare > 0) current = moveTroops(current, nationId, source.id, destination, spare).state;
  }
  return current;
}

/**
 * Full heuristic, for major powers:
 *   1. invest in the weakest-developed country if the treasury allows
 *   2. recruit up to an affordability cap, where the threat or the opportunity is
 *   3. attack, up to the difficulty's per-turn limit, only where it is safe
 *   4. move spare troops from countries that did not attack toward the front
 */
export interface MajorSettings {
  winChance: number;
  riskTolerance: number;
  attacksPerTurn: number;
  investThreshold: number;
}

export function takeMajorTurn(
  state: GameState,
  nationId: NationId,
  settings: MajorSettings,
): GameState {
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

  const budget = Math.floor(maxAffordableTroops(current, nationId) * AI_BUDGET.RECRUIT_TREASURY_SHARE);
  current = recruitWhereUseful(current, nationId, budget, settings.riskTolerance);

  // Attack before reinforcing. Moving troops out of a country uses up its action
  // for the turn, so reinforcing first meant a nation could never attack from
  // any country it had just drained — the US spent every turn shipping its army
  // to Russia and never once attacked from its own homeland.
  for (let i = 0; i < settings.attacksPerTurn; i += 1) {
    const plan = planAttack(current, nationId, settings.winChance, settings.riskTolerance);
    if (!plan) break;
    current = attack(current, nationId, plan.fromId, plan.targetId, plan.troops).state;
  }

  return reinforce(current, nationId, settings.riskTolerance);
}

/**
 * Cheap heuristic, for everyone else: hold a size-proportionate garrison and only take a
 * near-certain win that leaves home safe. Keeps 150+ minor nations from
 * churning the map.
 */
function takeMinorTurn(state: GameState, nationId: NationId): GameState {
  let current = state;

  const thin = Object.values(current.countries).find(
    (c) => c.ownerId === nationId && c.troops < garrisonFor(c.population),
  );
  if (thin) {
    const wanted = garrisonFor(thin.population) - thin.troops;
    const affordable = Math.min(wanted, maxAffordableTroops(current, nationId));
    if (affordable > 0) current = recruit(current, nationId, thin.id, affordable).state;
  }

  const plan = planAttack(
    current,
    nationId,
    AI_TIERS.MINOR_WIN_CHANCE,
    AI_TIERS.MINOR_RISK_TOLERANCE,
  );
  if (plan) current = attack(current, nationId, plan.fromId, plan.targetId, plan.troops).state;

  return current;
}

export function takeAITurn(state: GameState, nationId: NationId): GameState {
  const nation = state.nations[nationId];
  if (!nation || nation.isPlayer) return state;
  return nation.isMajor
    ? takeMajorTurn(state, nationId, DIFFICULTY[state.difficulty])
    : takeMinorTurn(state, nationId);
}

/**
 * The attack the advisor would suggest to the player: the AI's own planner, run on
 * the player's behalf with the advisor's appetite for risk. Suggestions therefore
 * obey the same rules the AI does — never leaving a source exposed, never taking
 * what cannot be held.
 */
export function adviseAttack(state: GameState): AttackPlan | null {
  return planAttack(state, state.playerId, ADVISOR.WIN_CHANCE, ADVISOR.RISK_TOLERANCE);
}

export interface MovePlan {
  fromId: CountryId;
  toId: CountryId;
  troops: number;
  reason: 'threatened' | 'forward';
}

/**
 * Hops from each owned country to the nearest owned country with an enemy
 * neighbour, travelling only through the nation's own territory. Frontier
 * countries are 0; countries cut off from any front are absent.
 */
export function distanceToFront(state: GameState, nationId: NationId): Map<CountryId, number> {
  const distance = new Map<CountryId, number>();
  const queue: CountryId[] = [];
  for (const country of Object.values(state.countries)) {
    if (country.ownerId === nationId && enemyNeighbours(state, country.id, nationId) > 0) {
      distance.set(country.id, 0);
      queue.push(country.id);
    }
  }
  for (let head = 0; head < queue.length; head += 1) {
    const id = queue[head]!;
    const d = distance.get(id)!;
    for (const n of state.adjacency[id] ?? []) {
      if (state.countries[n]?.ownerId === nationId && !distance.has(n)) {
        distance.set(n, d + 1);
        queue.push(n);
      }
    }
  }
  return distance;
}

/**
 * The move the advisor suggests when no attack is worth making: first, shore up
 * an owned country likely to fall; otherwise walk an idle interior garrison one
 * step closer to the front.
 *
 * Without this, a player following the advisor stalled for good once the
 * frontier moved away from where troops were raised — 22 countries at turn 30,
 * and still 22 at turn 60, with armies sitting idle in the interior.
 */
export function adviseMove(state: GameState): MovePlan | null {
  const me = state.playerId;
  const tolerance = ADVISOR.RISK_TOLERANCE;
  const front = distanceToFront(state, me);
  let best: (MovePlan & { score: number }) | null = null;

  for (const source of Object.values(state.countries)) {
    if (source.ownerId !== me || source.hasMoved) continue;
    const spare = source.troops - safeGarrison(state, source.id, tolerance);
    if (spare < ADVISOR.MIN_MOVE) continue;
    const here = front.get(source.id);

    for (const id of state.adjacency[source.id] ?? []) {
      const destination = state.countries[id];
      if (!destination || destination.ownerId !== me) continue;

      const risk = combinedThreat(state, id);
      let candidate: (MovePlan & { score: number }) | null = null;
      if (risk > tolerance) {
        candidate = { fromId: source.id, toId: id, troops: spare, reason: 'threatened', score: 2 + risk };
      } else if (here !== undefined && here > 0 && front.get(id) === here - 1) {
        candidate = { fromId: source.id, toId: id, troops: spare, reason: 'forward', score: 1 + spare / 1e6 };
      }
      if (candidate && (!best || candidate.score > best.score)) best = candidate;
    }
  }

  if (!best) return null;
  const { score: _score, ...plan } = best;
  return plan;
}
