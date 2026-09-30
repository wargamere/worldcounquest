import { ADVISOR, AI_BUDGET, AI_TIERS, CAPITAL, DEVELOPMENT, DIFFICULTY } from './balance';
import { assault, attack, invest, moveTroops, recruit, type Contribution } from './actions';
import { captureIncome, capitulatesOnCapture } from './capitulation';
import { baseStrength, captureProbability, troopsForChance } from './combat';
import { garrisonFor, grossIncome, investmentCost, maxAffordableTroops } from './economy';
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
  /** Other countries joining the attack, for a combined assault. Empty for a single-country attack. */
  support: Contribution[];
  /**
   * Income the capture brings in — a whole nation's, for a capital that
   * capitulates — per troop the win needs. Higher is a better deal.
   */
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

      const value = captureIncome(state, target.id) / needed;
      if (!best || value > best.value) {
        best = { fromId: source.id, targetId, troops, support: [], value };
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
 * The best combined assault available: an enemy country that no single owned
 * country can safely take, but several bordering it can together. Each
 * contributor offers only what it can spare under `riskTolerance`; the largest
 * offers are added until the win chance is reached, then more are added if
 * needed until the survivors could hold the prize.
 */
export function planAssault(
  state: GameState,
  nationId: NationId,
  winChance: number,
  riskTolerance: number,
): AttackPlan | null {
  const targets = new Set<CountryId>();
  for (const country of Object.values(state.countries)) {
    if (country.ownerId !== nationId || country.hasMoved) continue;
    for (const n of state.adjacency[country.id] ?? []) {
      if (state.countries[n] && state.countries[n]?.ownerId !== nationId) targets.add(n);
    }
  }

  let best: AttackPlan | null = null;
  for (const targetId of targets) {
    const target = state.countries[targetId];
    if (!target) continue;
    const offers = (state.adjacency[targetId] ?? [])
      .map((id) => state.countries[id])
      .filter((c): c is NonNullable<typeof c> => c !== undefined && c.ownerId === nationId && !c.hasMoved)
      .map((c) => ({ c, spare: c.troops - safeGarrison(state, c.id, riskTolerance, targetId) }))
      .filter((o) => o.spare > 0)
      .sort((a, b) => b.spare - a.spare);
    if (offers.length < 2) continue;

    const chosen: { c: (typeof offers)[number]['c']; spare: number }[] = [];
    let troops = 0;
    let weighted = 0;
    const chanceOf = (): number =>
      captureProbability({
        attackerTroops: troops,
        attackerDev: weighted / Math.max(1, troops),
        defenderTroops: target.troops,
        defenderDev: target.development,
      });
    const holds = (): boolean =>
      holdRisk(state, nationId, weighted / Math.max(1, troops), targetId, troops) <= AI_BUDGET.HOLD_TOLERANCE;

    for (const offer of offers) {
      chosen.push(offer);
      troops += offer.spare;
      weighted += offer.spare * offer.c.development;
      if (chanceOf() >= winChance && holds()) break;
    }
    if (chosen.length < 2 || chanceOf() < winChance || !holds()) continue;

    const value = captureIncome(state, targetId) / troops;
    if (!best || value > best.value) {
      const [lead, ...rest] = chosen;
      if (!lead) continue;
      best = {
        fromId: lead.c.id,
        targetId,
        troops: lead.spare,
        support: rest.map((o) => ({ fromId: o.c.id, troops: o.spare })),
        value,
      };
    }
  }
  return best;
}

/** Carries out a plan, whether it has one source or several. */
export function executePlan(state: GameState, nationId: NationId, plan: AttackPlan): GameState {
  return plan.support.length === 0
    ? attack(state, nationId, plan.fromId, plan.targetId, plan.troops).state
    : assault(state, nationId, plan.targetId, [{ fromId: plan.fromId, troops: plan.troops }, ...plan.support]).state;
}

/**
 * The risk of falling a nation accepts for one of its countries. A capital whose
 * fall would lose the whole nation is held to a fraction of the usual tolerance.
 */
export function toleranceFor(state: GameState, countryId: CountryId, riskTolerance: number): number {
  return capitulatesOnCapture(state, countryId) ? riskTolerance * CAPITAL.GUARD_TOLERANCE_FACTOR : riskTolerance;
}

/**
 * How far a country's chance of falling exceeds what its owner accepts for it:
 * above 1 it needs troops.
 */
function exposure(state: GameState, countryId: CountryId, riskTolerance: number): number {
  return combinedThreat(state, countryId) / toleranceFor(state, countryId, riskTolerance);
}

/**
 * Fewest troops that keep `countryId`'s combined chance of falling at or under
 * `riskTolerance` — tightened for a capital, see toleranceFor. Threat only falls
 * as the garrison grows, so bisect.
 */
export function safeGarrison(
  state: GameState,
  countryId: CountryId,
  riskTolerance: number,
  ignoreId?: CountryId,
): number {
  const country = state.countries[countryId];
  if (!country) return 0;
  const tolerance = toleranceFor(state, countryId, riskTolerance);
  const risky = (garrison: number): boolean =>
    combinedThreat(state, countryId, garrison, ignoreId) > tolerance;

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
      const softness = baseStrength(enemy.troops, enemy.development, true) / Math.max(1, captureIncome(state, enemy.id));
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
    .map((c) => ({ id: c.id, excess: exposure(state, c.id, riskTolerance) }))
    .sort((a, b) => b.excess - a.excess)[0];
  const target =
    endangered && endangered.excess > 1
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
      .map((c) => ({ id: c.id, excess: exposure(current, c.id, riskTolerance) }))
      .sort((a, b) => b.excess - a.excess)[0];

    let destination: CountryId | null = null;
    if (threatened && threatened.excess > 1) {
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
    const plan =
      planAttack(current, nationId, settings.winChance, settings.riskTolerance) ??
      planAssault(current, nationId, settings.winChance, settings.riskTolerance);
    if (!plan) break;
    current = executePlan(current, nationId, plan);
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

  // The capital first: losing it loses everything else too.
  const thin = Object.values(current.countries)
    .filter((c) => c.ownerId === nationId && c.troops < garrisonFor(c.population))
    .sort((a, b) => Number(b.id === nationId) - Number(a.id === nationId))[0];
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
  return (
    planAttack(state, state.playerId, ADVISOR.WIN_CHANCE, ADVISOR.RISK_TOLERANCE) ??
    planAssault(state, state.playerId, ADVISOR.WIN_CHANCE, ADVISOR.RISK_TOLERANCE)
  );
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

export interface AdviceTaken {
  state: GameState;
  attacks: number;
  captured: CountryId[];
  moves: number;
}

/**
 * Carries out every order the advisor would suggest, one at a time, until it has
 * nothing left to suggest: attacks while any is safe and winnable, then troop
 * movements. Recruiting and investing stay with the player.
 *
 * This is the late-game mop-up in one click. Past about 40 countries a player
 * following the advisor spent 10–25 clicks a turn on orders they had no reason
 * to question. The advisor still never wins on its own — it will not break an
 * armed border, and it stalls a weak start — so judgement stays the player's.
 */
export function followAdvice(state: GameState): AdviceTaken {
  const me = state.playerId;
  let current = state;
  let attacks = 0;
  let moves = 0;
  const captured: CountryId[] = [];
  // Every order spends at least one country's action, so this ends on its own;
  // the bound only guards against a planner bug looping forever.
  const limit = Object.keys(state.countries).length * 2;
  for (let i = 0; i < limit; i += 1) {
    const plan = adviseAttack(current);
    if (plan) {
      current = executePlan(current, me, plan);
      attacks += 1;
      if (current.countries[plan.targetId]?.ownerId === me) captured.push(plan.targetId);
      continue;
    }
    const move = adviseMove(current);
    if (!move) break;
    current = moveTroops(current, me, move.fromId, move.toId, move.troops).state;
    moves += 1;
  }
  return { state: current, attacks, captured, moves };
}
