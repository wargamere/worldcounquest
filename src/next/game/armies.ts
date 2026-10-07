/**
 * Army lifecycle and bookkeeping (§4.2–4.3): creation, merging, splitting,
 * disbanding, stances, status and the hourly healing and attrition pass.
 * Removal only marks an army dead; sweepDeadArmies drops it from the state and
 * the index, at the end of the tick or right after a command.
 */
import { AI, AI_TIERS, COMBAT, ECONOMY, GARRISON, MOVEMENT, SUPPLY, TIME } from './balance';
import { armyById, indexArmy, isContested, rebuildArmyIndex } from './cache';
import { hoursToTicks } from './clock';
import { pushFeed, raiseAlert } from './feed';
import { asArmy } from './ids';
import { recordUnits } from './stats';
import { isConnected, isSupplied } from './supply';
import { UNIT_TYPES } from './types';
import type { Army, ArmyId, CommandResult, NationIx, ProvinceIx, Sim, Stance, UnitCounts, UnitHp, Units, UnitType } from './types';
import { addUnits, applyHpLoss, heal, isEmpty, scaleUnits, takeUnits, totalCount, totalHp, unitsFromCounts } from './units';

const HOURS_PER_DAY = TIME.TICKS_PER_DAY / TIME.TICKS_PER_HOUR;

/** Stances from most to least cautious; a merge keeps the most cautious one. */
const CAUTION: Readonly<Record<Stance, number>> = { manual: 0, defend: 1, delegate: 2 };

const fail = (reason: string): CommandResult => ({ ok: false, reason });
const done = (armies: readonly ArmyId[]): CommandResult => ({ ok: true, armies });

/** "1st Army", "2nd Army", "11th Army", "23rd Army". */
export function armyName(serial: number): string {
  const tens = serial % 100;
  const last = serial % 10;
  let suffix = 'th';
  if (tens < 11 || tens > 13) {
    if (last === 1) suffix = 'st';
    else if (last === 2) suffix = 'nd';
    else if (last === 3) suffix = 'rd';
  }
  return `${serial}${suffix} Army`;
}

/** The auto-retreat threshold a new army of this nation starts with. */
export function defaultRetreatAt(sim: Sim, owner: NationIx): number {
  return sim.state.nations[owner]?.isPlayer === true ? COMBAT.PLAYER_RETREAT_AT : COMBAT.AI_RETREAT_AT;
}

/** The stance a new army of this nation starts with: the player's are Manual, the AI's Delegate. */
export function defaultStance(sim: Sim, owner: NationIx): Stance {
  return sim.state.nations[owner]?.isPlayer === true ? 'manual' : 'delegate';
}

/**
 * A new army standing at `at`. Its orderedAt lies a full reassignment window in
 * the past, since nobody has ordered it yet, so the AI may use it at once.
 */
export function createArmy(sim: Sim, owner: NationIx, at: ProvinceIx, units: Units, stance: Stance): Army {
  const { state } = sim;
  const nation = state.nations[owner]!;
  nation.armySerial += 1;
  const army: Army = {
    id: asArmy(state.nextArmyId),
    owner,
    name: armyName(nation.armySerial),
    units,
    at,
    leg: null,
    path: [],
    departAt: state.tick,
    intent: 'move',
    stance,
    post: stance === 'defend' ? at : null,
    retreatAt: defaultRetreatAt(sim, owner),
    battle: null,
    cameFrom: null,
    landingUntil: 0,
    orderedAt: state.tick - hoursToTicks(AI.REASSIGN_AFTER_HOURS),
    alive: true,
  };
  state.nextArmyId += 1;
  // Ids only grow, so pushing keeps state.armies sorted.
  state.armies.push(army);
  indexArmy(sim, army);
  return army;
}

/** Marks the army dead; it stays in the state and the index until the sweep. */
export function removeArmy(sim: Sim, army: Army): void {
  if (!army.alive) return;
  army.alive = false;
  army.path = [];
  army.battle = null;
  sim.cache.armyVersion += 1;
}

export type ArmyStatus = 'idle' | 'waiting' | 'moving' | 'fighting' | 'frozen';

/**
 * fighting: in a battle. moving: on a leg, or due to leave now. waiting: holding
 * for arrive-together. frozen: handed over by a capitulation and not yet free.
 */
export function armyStatus(sim: Sim, army: Army): ArmyStatus {
  // The surrender freeze holds even if the army is drawn into a battle meanwhile.
  if (army.leg === null && army.path.length === 0 && army.departAt > sim.state.tick) return 'frozen';
  if (army.battle !== null) return 'fighting';
  if (army.leg !== null) return 'moving';
  if (army.departAt > sim.state.tick) return 'waiting';
  return army.path.length > 0 ? 'moving' : 'idle';
}

export function isIdle(sim: Sim, army: Army): boolean {
  return army.alive && armyStatus(sim, army) === 'idle';
}

/** New units join the owner's lowest-id idle army in the province, or form a new army. */
export function spawnUnits(sim: Sim, owner: NationIx, at: ProvinceIx, unit: UnitType, count: number): Army {
  const units = unitsFromCounts({ [unit]: count });
  for (const army of sim.cache.armiesAt[at] ?? []) {
    if (army.owner !== owner || army.at !== at || !isIdle(sim, army)) continue;
    addUnits(army.units, units);
    sim.cache.armyVersion += 1;
    return army;
  }
  return createArmy(sim, owner, at, units, defaultStance(sim, owner));
}

/**
 * Hands an army to another nation with `keep` of every HP pool (capitulation).
 * It keeps its id, takes the new owner's next name, loses its orders and stays
 * frozen for MOVEMENT.SURRENDER_FREEZE_HOURS. Null when nothing survives the cut.
 * The caller rebuilds the index once it has moved every army.
 */
export function transferArmy(sim: Sim, army: Army, to: NationIx, keep: number): Army | null {
  const { state } = sim;
  const units = scaleUnits(army.units, keep);
  if (isEmpty(units)) {
    removeArmy(sim, army);
    return null;
  }
  const nation = state.nations[to]!;
  nation.armySerial += 1;
  army.owner = to;
  army.name = armyName(nation.armySerial);
  army.units = units;
  army.leg = null;
  army.path = [];
  army.departAt = state.tick + hoursToTicks(MOVEMENT.SURRENDER_FREEZE_HOURS);
  army.intent = 'move';
  army.stance = defaultStance(sim, to);
  army.post = null;
  army.retreatAt = defaultRetreatAt(sim, to);
  army.battle = null;
  army.cameFrom = null;
  army.landingUntil = 0;
  army.orderedAt = state.tick;
  sim.cache.armyVersion += 1;
  return army;
}

/** The live, own armies named by `ids` (deduplicated, ascending), or a reason to refuse. */
export function ownArmies(sim: Sim, n: NationIx, ids: readonly ArmyId[]): Army[] | string {
  if (ids.length === 0) return 'No armies selected';
  const out: Army[] = [];
  for (const id of [...new Set(ids)].sort((x, y) => x - y)) {
    const army = armyById(sim, id);
    if (army === undefined || !army.alive) return 'That army no longer exists';
    if (army.owner !== n) return 'Not your army';
    out.push(army);
  }
  return out;
}

/**
 * Two or more co-located armies, none on a leg or in a battle, become the lowest
 * id. Paths are cleared; the most cautious stance and the highest retreatAt win.
 */
export function mergeArmies(sim: Sim, n: NationIx, ids: readonly ArmyId[]): CommandResult {
  const armies = ownArmies(sim, n, ids);
  if (typeof armies === 'string') return fail(armies);
  if (armies.length < 2) return fail('Pick at least two armies to merge');
  const into = armies[0]!;
  for (const army of armies) {
    if (army.leg !== null) return fail(`${army.name} is on the move`);
    if (army.battle !== null) return fail(`${army.name} is in a battle`);
    if (armyStatus(sim, army) === 'frozen') return fail(`${army.name} cannot move yet`);
    if (army.at !== into.at) return fail('Only armies in the same province can merge');
  }
  let stance = into.stance;
  let post = into.post;
  for (const army of armies.slice(1)) {
    addUnits(into.units, army.units);
    into.retreatAt = Math.max(into.retreatAt, army.retreatAt);
    if (CAUTION[army.stance] < CAUTION[stance]) {
      stance = army.stance;
      post = army.post;
    } else if (army.stance === stance && post === null) {
      post = army.post;
    }
    removeArmy(sim, army);
  }
  into.stance = stance;
  into.post = stance === 'defend' ? (post ?? into.at) : null;
  into.path = [];
  into.departAt = sim.state.tick;
  into.intent = 'move';
  into.orderedAt = sim.state.tick;
  sweepDeadArmies(sim);
  return done([into.id]);
}

/** Splits whole units off an idle army into a new army in the same province. */
export function splitArmy(sim: Sim, n: NationIx, id: ArmyId, take: UnitCounts): CommandResult {
  const armies = ownArmies(sim, n, [id]);
  if (typeof armies === 'string') return fail(armies);
  const army = armies[0]!;
  if (!isIdle(sim, army)) return fail('Only an idle army can split');
  let taking = 0;
  for (const type of UNIT_TYPES) {
    const count = take[type] ?? 0;
    if (!Number.isInteger(count) || count < 0) return fail('Split whole units');
    if (count > army.units[type].count) return fail('Not that many units');
    taking += count;
  }
  if (taking === 0) return fail('Pick units to split off');
  if (taking === totalCount(army.units)) return fail('Leave at least one unit behind');
  const units = takeUnits(army.units, take);
  const split = createArmy(sim, n, army.at, units, army.stance);
  split.retreatAt = army.retreatAt;
  split.post = army.post;
  split.orderedAt = sim.state.tick;
  army.orderedAt = sim.state.tick;
  return done([army.id, split.id]);
}

/** Removes the army with no refund. */
export function disbandArmy(sim: Sim, n: NationIx, id: ArmyId): CommandResult {
  const armies = ownArmies(sim, n, [id]);
  if (typeof armies === 'string') return fail(armies);
  removeArmy(sim, armies[0]!);
  sweepDeadArmies(sim);
  return done([]);
}

/** Defend guards the province where it was set; the other stances have no post. */
export function setStance(sim: Sim, n: NationIx, ids: readonly ArmyId[], stance: Stance): CommandResult {
  const armies = ownArmies(sim, n, ids);
  if (typeof armies === 'string') return fail(armies);
  for (const army of armies) {
    army.stance = stance;
    army.post = stance === 'defend' ? army.at : null;
  }
  sim.cache.armyVersion += 1;
  return done(armies.map((a) => a.id));
}

/** Auto-retreat threshold as a share of the HP an army joined its battle with; 0 turns it off. */
export function setRetreatAt(sim: Sim, n: NationIx, ids: readonly ArmyId[], at: number): CommandResult {
  if (!Number.isFinite(at) || at < 0 || at >= 1) return fail('Retreat threshold must be between 0 and 1');
  const armies = ownArmies(sim, n, ids);
  if (typeof armies === 'string') return fail(armies);
  for (const army of armies) army.retreatAt = at;
  sim.cache.armyVersion += 1;
  return done(armies.map((a) => a.id));
}

/** Counts units lost from a change in counts, for the player's end-screen statistics. */
export function recordLosses(sim: Sim, army: Army, before: Readonly<Record<UnitType, number>>): void {
  if (army.owner !== sim.state.player) return;
  for (const type of UNIT_TYPES) {
    const lost = before[type] - army.units[type].count;
    if (lost > 0) recordUnits(sim, 'unitsLost', type, lost);
  }
}

/** Unit counts per type, to compare before and after damage. */
export function countsOf(units: Units): Record<UnitType, number> {
  return {
    rifles: units.rifles.count,
    hunters: units.hunters.count,
    motor: units.motor.count,
    guns: units.guns.count,
    tanks: units.tanks.count,
  };
}

/** Removes `share` of every HP pool (attrition, the disengage cost); counts follow. */
export function loseShare(sim: Sim, army: Army, share: number): void {
  const loss: UnitHp = { rifles: 0, hunters: 0, motor: 0, guns: 0, tanks: 0 };
  for (const type of UNIT_TYPES) loss[type] = army.units[type].hp * share;
  const before = countsOf(army.units);
  applyHpLoss(army.units, loss);
  recordLosses(sim, army, before);
}

/**
 * Hourly: attrition first (out of supply, unpaid, hungry), then healing, which is
 * faster at home. Armies that wither below COMBAT.DEAD_HP are removed.
 */
export function hourlyArmies(sim: Sim): void {
  const { state, map } = sim;
  let removed = false;
  for (const army of state.armies) {
    if (!army.alive) continue;
    const nation = state.nations[army.owner]!;
    const supplied = isSupplied(sim, army);
    let attrition = supplied ? 0 : SUPPLY.ATTRITION_PER_HOUR;
    if (nation.shortage.funds) attrition += ECONOMY.UNPAID_ATTRITION_PER_DAY / HOURS_PER_DAY;
    if (nation.shortage.food) attrition += ECONOMY.HUNGER_ATTRITION_PER_DAY / HOURS_PER_DAY;
    if (attrition > 0) loseShare(sim, army, Math.min(1, attrition));
    if (totalHp(army.units) < COMBAT.DEAD_HP || isEmpty(army.units)) {
      removeArmy(sim, army);
      removed = true;
      if (army.owner === state.player) {
        pushFeed(sim, {
          kind: 'armyDestroyed',
          severity: 'bad',
          text: `${army.name} withered away in ${map.provinces[army.at]!.name}`,
          nations: [army.owner],
          province: army.at,
          army: army.id,
        });
        raiseAlert(sim, { kind: 'armyDestroyed', province: army.at, nation: army.owner });
      }
      continue;
    }
    if (!supplied || army.battle !== null) continue;
    const home =
      army.leg === null &&
      state.provinces[army.at]!.owner === army.owner &&
      !isContested(sim, army.at) &&
      isConnected(sim, army.owner, army.at);
    heal(army.units, home ? SUPPLY.HEAL_HOME_PER_HOUR : SUPPLY.HEAL_FIELD_PER_HOUR);
  }
  // Later hourly phases (upkeep, training) must not see the withered.
  if (removed) rebuildArmyIndex(sim);
  sim.cache.armyVersion += 1;
}

// ------------------------------------------------------------------ battles

/**
 * Whether a battle runs at `p` right now, from the live standing lists: a
 * foreign army stands there and the owner side (armies or a garrison) is not
 * empty. Movement keeps the lists current while it runs, unlike cache.contested,
 * which is only rebuilt once per tick.
 */
export function isContestedNow(sim: Sim, p: ProvinceIx): boolean {
  const province = sim.state.provinces[p]!;
  let foreign = false;
  let ownerSide = province.garrison >= GARRISON.EMPTY_BELOW;
  for (const army of sim.cache.armiesAt[p] ?? []) {
    if (!army.alive || army.leg !== null || army.at !== p) continue;
    // An army falling back is leaving this tick; it no longer holds the province.
    if (army.intent === 'retreat' && army.path.length > 0 && army.battle === null) continue;
    if (army.owner === province.owner) ownerSide = true;
    else foreign = true;
  }
  return foreign && ownerSide;
}

/**
 * Puts every army standing at a contested `p` into the battle. A newcomer's
 * direction is the province it came from (attackers only; defenders have none).
 * The first contact sets battleSince and reports the battle.
 */
export function engage(sim: Sim, p: ProvinceIx): void {
  const { state } = sim;
  const province = state.provinces[p]!;
  const attackers: NationIx[] = [];
  for (const army of sim.cache.armiesAt[p] ?? []) {
    if (!army.alive || army.leg !== null || army.at !== p) continue;
    const attacking = army.owner !== province.owner;
    if (attacking && !attackers.includes(army.owner)) attackers.push(army.owner);
    if (army.battle !== null) continue;
    army.battle = { joinedAt: state.tick, startHp: totalHp(army.units), direction: attacking ? army.cameFrom : null };
  }
  if (province.battleSince !== null || attackers.length === 0) return;
  province.battleSince = state.tick;
  attackers.sort((x, y) => x - y);
  reportBattle(sim, p, attackers);
}

function reportBattle(sim: Sim, p: ProvinceIx, attackers: readonly NationIx[]): void {
  const { map, state } = sim;
  const owner = state.provinces[p]!.owner;
  const name = map.provinces[p]!.name;
  const who = attackers.map((n) => map.nations[n]!.name).join(' and ');
  pushFeed(sim, {
    kind: 'battleStarted',
    severity: owner === state.player ? 'bad' : 'info',
    text: `${who} attacks ${name}`,
    nations: [...attackers, owner],
    province: p,
    army: null,
  });
  const nation = state.nations[owner]!;
  if (nation.isPlayer) {
    raiseAlert(sim, { kind: nation.capital === p ? 'capitalAttacked' : 'provinceAttacked', province: p, nation: attackers[0] ?? null });
  } else if (nation.ai.alertAt === null) {
    // The defender's AI gets an alert think (§6.2); its scheduler runs it.
    nation.ai.alertAt = state.tick + hoursToTicks(AI_TIERS.ALERT_DELAY_HOURS);
  }
}

/** Drops dead armies from the state and rebuilds the index. */
export function sweepDeadArmies(sim: Sim): void {
  if (sim.state.armies.some((a) => !a.alive)) sim.state.armies = sim.state.armies.filter((a) => a.alive);
  rebuildArmyIndex(sim);
}
