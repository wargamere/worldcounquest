/**
 * The hourly round (§5.2–5.5). `roundDamage` is pure and shared with the
 * forecast; `resolveBattles` runs one round in every contested province, in
 * ascending order, then writes the damage back to the armies and the garrison,
 * removes the destroyed, sends back those below their retreat threshold, and
 * hands the province to the strongest attacker once its defence is gone.
 *
 * Attackers fight only the owner, never each other: every non-owner nation
 * present is its own attacker side, and the owner's output is split over them
 * by HP.
 */
import { COMBAT, ECONOMY, EFFECTS, GARRISON, SUPPLY, TERRAIN, UNITS } from './balance';
import { countsOf, engage, isContestedNow, recordLosses, removeArmy } from './armies';
import { armiesAt, rebuildArmyIndex } from './cache';
import { captureProvince } from './capture';
import { pushFeed, raiseAlert } from './feed';
import { beginRetreat, retreatTarget } from './movement';
import { roll } from './rng';
import { recordBattleSize, recordStat } from './stats';
import { isSuppliedAt } from './supply';
import { UNIT_TYPES } from './types';
import type { Army, BattleInput, BattleSide, Modifier, NationIx, ProvinceIx, Role, RoundResult, Sim, SideLoss, UnitHp } from './types';
import { asProvince } from './ids';
import { zeroUnitHp, zeroUnits } from './keys';
import { addUnits, applyHpLoss, isEmpty, totalHp, usesOil } from './units';

// ------------------------------------------------------------ retreat notes

/**
 * How a side falls back in a forecast: the HP-weighted mean retreatAt of its
 * armies and the army HP that threshold is a share of (null: the HP the side
 * has when the forecast starts, or when it joins). BattleSide has no such
 * fields, so the sides built here and in forecast.ts carry a note; sides built
 * elsewhere get the defaults (attackers at COMBAT.AI_RETREAT_AT, defenders never).
 */
export interface SideRetreat {
  retreatAt: number;
  startHp: number | null;
}
const retreatNotes = new WeakMap<BattleSide, SideRetreat>();

export function setSideRetreat(side: BattleSide, note: SideRetreat): void {
  retreatNotes.set(side, note);
}

export function sideRetreat(side: BattleSide): SideRetreat {
  return retreatNotes.get(side) ?? { retreatAt: side.role === 'attacker' ? COMBAT.AI_RETREAT_AT : 0, startHp: null };
}

/** The HP-weighted mean retreatAt of some armies, and the HP they joined their battles with. */
export function retreatOfArmies(armies: readonly Army[]): SideRetreat {
  let hp = 0;
  let weighted = 0;
  let startHp = 0;
  for (const army of armies) {
    const own = totalHp(army.units);
    hp += own;
    weighted += own * army.retreatAt;
    startHp += army.battle?.startHp ?? own;
  }
  return { retreatAt: hp > 0 ? weighted / hp : 0, startHp };
}

// --------------------------------------------------------------- the round

/** Share of a side's unit-equivalents that fights at full effect. */
export function frontageFactor(unitEquivalents: number, frontage: number): number {
  return unitEquivalents > frontage ? frontage / unitEquivalents : 1;
}

/** Unit-equivalents a side can bring to bear: terrain frontage widened by flanking directions. */
function frontageOf(side: BattleSide, input: BattleInput): number {
  const base = TERRAIN[input.ctx.terrain].frontage;
  if (side.role === 'defender') {
    const extra = Math.max(0, input.ctx.totalDirections - 1);
    return base * Math.min(COMBAT.DEFENDER_FRONTAGE_MAX, 1 + COMBAT.DEFENDER_FRONTAGE_PER_DIRECTION * extra);
  }
  const extra = Math.max(0, side.directions - 1);
  return base * Math.min(COMBAT.FLANK_FRONTAGE_MAX, 1 + COMBAT.FLANK_FRONTAGE_PER_DIRECTION * extra);
}

// Unit constants in UNIT_TYPES order, so the round runs over plain arrays.
const TYPES = UNIT_TYPES.length;
const SPEC = UNIT_TYPES.map((type) => UNITS[type]);
const IS_TANKS = UNIT_TYPES.map((type) => type === 'tanks');

/**
 * Reused buffers for one round: per side the start-of-round figures, per side
 * and type the outgoing terms and the losses. Rounds never nest, so one set
 * serves every battle and forecast without allocating.
 */
class RoundScratch {
  capacity = 0;
  sides = 0;
  /** Side HP (the garrison included), its soft and hard parts and their exposure weights. */
  hp = new Float64Array(0);
  softHp = new Float64Array(0);
  hardHp = new Float64Array(0);
  softWeight = new Float64Array(0);
  hardWeight = new Float64Array(0);
  ue = new Float64Array(0);
  mult = new Float64Array(0);
  /** Outgoing soft and hard terms per side and type, before the side multiplier. */
  soft = new Float64Array(0);
  hard = new Float64Array(0);
  /** Losses per side and type, capped. */
  loss = new Float64Array(0);
  dealt = new Float64Array(0);
  rawFrom = new Float64Array(0);
  garrisonLoss = 0;

  ensure(sides: number): void {
    this.sides = sides;
    if (sides <= this.capacity) return;
    const n = Math.max(sides, this.capacity * 2, 4);
    this.capacity = n;
    this.hp = new Float64Array(n);
    this.softHp = new Float64Array(n);
    this.hardHp = new Float64Array(n);
    this.softWeight = new Float64Array(n);
    this.hardWeight = new Float64Array(n);
    this.ue = new Float64Array(n);
    this.mult = new Float64Array(n);
    this.soft = new Float64Array(n * TYPES);
    this.hard = new Float64Array(n * TYPES);
    this.loss = new Float64Array(n * TYPES);
    this.dealt = new Float64Array(n);
    this.rawFrom = new Float64Array(n);
  }
}
const scratch = new RoundScratch();

/** A side's unit-equivalents: damaged units count for less, the garrison at HP_PER_UNIT. */
function sideUnitEquivalents(side: BattleSide): number {
  let ue = side.garrison / GARRISON.HP_PER_UNIT;
  for (let t = 0; t < TYPES; t += 1) ue += side.units[UNIT_TYPES[t]!].hp / SPEC[t]!.hp;
  return ue;
}

/** The side multiplier M: damage scale, roll, frontage, supply, and the role's own factors. */
function multiplier(side: BattleSide, ue: number, input: BattleInput, rollValue: number): number {
  let m = COMBAT.DAMAGE_SCALE * rollValue * frontageFactor(ue, frontageOf(side, input));
  if (!side.supplied) m *= SUPPLY.UNSUPPLIED_DAMAGE;
  if (side.role === 'defender') {
    m *= TERRAIN[input.ctx.terrain].defence * (1 + EFFECTS.RAMPARTS_DAMAGE_PER_LEVEL * input.ctx.ramparts);
  } else {
    m *= 1 + Math.min(COMBAT.FLANK_DAMAGE_MAX, COMBAT.FLANK_DAMAGE_PER_DIRECTION * Math.max(0, side.directions - 1));
  }
  return m;
}

/** Fills side `i` of the scratch from start-of-round state. */
function load(s: RoundScratch, i: number, side: BattleSide, input: BattleInput, rollValue: number): void {
  const tanks = TERRAIN[input.ctx.terrain].tanks;
  const defending = side.role === 'defender';
  const g = side.garrison;
  let hp = g;
  let softHp = g;
  let hardHp = 0;
  let softWeight = g;
  let hardWeight = 0;
  let ue = g / GARRISON.HP_PER_UNIT;
  const base = i * TYPES;
  for (let t = 0; t < TYPES; t += 1) {
    const spec = SPEC[t]!;
    const type = UNIT_TYPES[t]!;
    const pool = side.units[type].hp;
    s.soft[base + t] = 0;
    s.hard[base + t] = 0;
    if (pool <= 0) continue;
    hp += pool;
    if (spec.armour === 'hard') {
      hardHp += pool;
      hardWeight += pool * spec.exposure;
    } else {
      softHp += pool;
      softWeight += pool * spec.exposure;
    }
    const unitEq = pool / spec.hp;
    ue += unitEq;
    // Landed units hit at LANDING_ATTACK while the landing window lasts.
    const effective = unitEq - ((1 - COMBAT.LANDING_ATTACK) * Math.min(side.landed[type], pool)) / spec.hp;
    const value = defending ? spec.defence : spec.attack;
    let mod = IS_TANKS[t] === true ? tanks : 1;
    if (spec.usesOil && side.oilShort) mod *= ECONOMY.OIL_SHORT_DAMAGE;
    s.soft[base + t] = effective * value.soft * mod;
    s.hard[base + t] = effective * value.hard * mod;
  }
  s.hp[i] = hp;
  s.softHp[i] = softHp;
  s.hardHp[i] = hardHp;
  s.softWeight[i] = softWeight;
  s.hardWeight[i] = hardWeight;
  s.ue[i] = ue;
  s.mult[i] = multiplier(side, ue, input, rollValue);
}

/** Caps a raw loss at the pool; a pool left below COMBAT.DEAD_HP is lost entirely. */
function capLoss(pool: number, raw: number): number {
  if (pool <= 0 || raw <= 0) return 0;
  const loss = Math.min(pool, raw);
  return pool - loss < COMBAT.DEAD_HP ? pool : loss;
}

/** Share of `incoming` that lands on pool `t` of side `i`: by HP × exposure within its armour class. */
function share(s: RoundScratch, i: number, side: BattleSide, t: number, softIn: number, hardIn: number): number {
  const spec = SPEC[t]!;
  const pool = side.units[UNIT_TYPES[t]!].hp;
  if (pool <= 0) return 0;
  const weight = pool * spec.exposure;
  if (spec.armour === 'hard') return s.hardWeight[i]! > 0 ? (hardIn * weight) / s.hardWeight[i]! : 0;
  return s.softWeight[i]! > 0 ? (softIn * weight) / s.softWeight[i]! : 0;
}

/** A round's results in the shared buffers; valid until the next round is computed. */
export interface RoundLosses {
  /** HP lost per side (defender first) and unit type, at `side * UNIT_TYPES.length + type`. */
  readonly loss: Float64Array;
  readonly garrisonLoss: number;
  /** HP each side caused, by side. */
  readonly dealt: Float64Array;
}

/**
 * The round into the shared buffers, allocation-free: losses per side and type
 * (defender at index 0), the garrison's loss and what each side dealt. `rolls`
 * holds one factor per side, defender first; missing rolls (or none) count as 1.
 */
export function computeRound(input: BattleInput, rolls: ArrayLike<number> | null): RoundLosses {
  const { defender, attackers } = input;
  const s = scratch;
  const count = attackers.length + 1;
  s.ensure(count);
  const rollOf = (i: number): number => (rolls !== null && i < rolls.length ? rolls[i]! : 1);
  load(s, 0, defender, input, rollOf(0));
  for (let i = 1; i < count; i += 1) load(s, i, attackers[i - 1]!, input, rollOf(i));
  s.loss.fill(0, 0, count * TYPES);

  // Into the defender, from each attacker. Ramparts reduce what they take, except from units that ignore them.
  const protection = 1 - EFFECTS.RAMPARTS_PROTECTION_PER_LEVEL * input.ctx.ramparts;
  const softShareD = s.hp[0]! > 0 ? s.softHp[0]! / s.hp[0]! : 0;
  const hardShareD = s.hp[0]! > 0 ? s.hardHp[0]! / s.hp[0]! : 0;
  let rawGarrison = 0;
  let rawTotal = 0;
  let attackerHp = 0;
  for (let i = 1; i < count; i += 1) {
    attackerHp += s.hp[i]!;
    const base = i * TYPES;
    let softIn = 0;
    let garrisonIn = 0;
    let hardIn = 0;
    for (let t = 0; t < TYPES; t += 1) {
      const spec = SPEC[t]!;
      const reduce = spec.ignoresRamparts ? 1 : protection;
      softIn += s.soft[base + t]! * reduce;
      garrisonIn += s.soft[base + t]! * reduce * spec.vsGarrison;
      hardIn += s.hard[base + t]! * reduce;
    }
    const m = s.mult[i]!;
    softIn *= m * softShareD;
    hardIn *= m * hardShareD;
    let total = 0;
    for (let t = 0; t < TYPES; t += 1) {
      const dmg = share(s, 0, defender, t, softIn, hardIn);
      s.loss[t] = s.loss[t]! + dmg;
      total += dmg;
    }
    if (defender.garrison > 0 && s.softWeight[0]! > 0) {
      const dmg = (m * softShareD * garrisonIn * defender.garrison) / s.softWeight[0]!;
      rawGarrison += dmg;
      total += dmg;
    }
    s.rawFrom[i] = total;
    rawTotal += total;
  }
  let lossD = 0;
  for (let t = 0; t < TYPES; t += 1) {
    s.loss[t] = capLoss(defender.units[UNIT_TYPES[t]!].hp, s.loss[t]!);
    lossD += s.loss[t]!;
  }
  s.garrisonLoss = capLoss(defender.garrison, rawGarrison);
  lossD += s.garrisonLoss;

  // Into each attacker, from the defender, whose output is split by the attackers' HP.
  let sOut = (defender.garrison / GARRISON.HP_PER_UNIT) * GARRISON.DEFENCE.soft;
  let hOut = (defender.garrison / GARRISON.HP_PER_UNIT) * GARRISON.DEFENCE.hard;
  for (let t = 0; t < TYPES; t += 1) {
    sOut += s.soft[t]!;
    hOut += s.hard[t]!;
  }
  const mD = s.mult[0]!;
  let dealtByD = 0;
  for (let i = 1; i < count; i += 1) {
    const side = attackers[i - 1]!;
    const hp = s.hp[i]!;
    s.dealt[i] = rawTotal > 0 ? (lossD * s.rawFrom[i]!) / rawTotal : 0;
    if (hp <= 0 || attackerHp <= 0) continue;
    const w = hp / attackerHp;
    const softIn = mD * sOut * w * (s.softHp[i]! / hp);
    const hardIn = mD * hOut * w * (s.hardHp[i]! / hp);
    const base = i * TYPES;
    for (let t = 0; t < TYPES; t += 1) {
      const lost = capLoss(side.units[UNIT_TYPES[t]!].hp, share(s, i, side, t, softIn, hardIn));
      s.loss[base + t] = lost;
      dealtByD += lost;
    }
  }
  s.dealt[0] = dealtByD;
  return s;
}

/** Side `i`'s losses from the last computeRound, as a UnitHp. */
function lossesOf(s: RoundLosses, i: number): UnitHp {
  const hp = zeroUnitHp();
  for (let t = 0; t < TYPES; t += 1) hp[UNIT_TYPES[t]!] = s.loss[i * TYPES + t]!;
  return hp;
}

/**
 * One hour of fighting from start-of-round state; nothing is mutated. `rolls`
 * holds one factor per side, defender first (a missing roll counts as 1).
 * Losses are capped at what each pool holds, and a pool left below
 * COMBAT.DEAD_HP counts as lost; `dealt` is each side's part of the losses it caused.
 */
export function roundDamage(input: BattleInput, rolls: readonly number[]): RoundResult {
  const s = computeRound(input, rolls);
  const losses: SideLoss[] = [{ nation: input.defender.nation, hp: lossesOf(s, 0), garrison: s.garrisonLoss, dealt: s.dealt[0]! }];
  input.attackers.forEach((side, i) => losses.push({ nation: side.nation, hp: lossesOf(s, i + 1), garrison: 0, dealt: s.dealt[i + 1]! }));
  return { losses };
}

/** Every factor that applies to this battle, labelled for the preview and the Battle panel. */
export function battleModifiers(input: BattleInput): Modifier[] {
  const { ctx, defender, attackers } = input;
  const terrain = TERRAIN[ctx.terrain];
  const out: Modifier[] = [];
  const push = (code: Modifier['code'], side: Role, factor: number): void => {
    if (factor !== 1) out.push({ code, side, factor });
  };
  push('terrain', 'defender', terrain.defence);
  push('ramparts', 'defender', 1 + EFFECTS.RAMPARTS_DAMAGE_PER_LEVEL * ctx.ramparts);
  const dirs = attackers.reduce((max, a) => Math.max(max, a.directions), 1);
  push('flank', 'attacker', 1 + Math.min(COMBAT.FLANK_DAMAGE_MAX, COMBAT.FLANK_DAMAGE_PER_DIRECTION * (dirs - 1)));
  const engaged = (side: BattleSide): number => frontageFactor(sideUnitEquivalents(side), frontageOf(side, input));
  if (attackers.length > 0) push('frontage', 'attacker', Math.min(...attackers.map(engaged)));
  push('frontage', 'defender', engaged(defender));
  if (attackers.some((a) => UNIT_TYPES.some((t) => a.landed[t] > 0))) push('landing', 'attacker', COMBAT.LANDING_ATTACK);
  const roles: [Role, readonly BattleSide[]][] = [
    ['defender', [defender]],
    ['attacker', attackers],
  ];
  for (const [role, list] of roles) {
    if (list.some((s) => s.oilShort && usesOil(s.units))) push('oilShort', role, ECONOMY.OIL_SHORT_DAMAGE);
    if (list.some((s) => !s.supplied)) push('unsupplied', role, SUPPLY.UNSUPPLIED_DAMAGE);
    if (list.some((s) => s.units.tanks.count > 0)) push('tankTerrain', role, terrain.tanks);
  }
  if (defender.garrison > 0) {
    let best = 1;
    for (const type of UNIT_TYPES) if (attackers.some((a) => a.units[type].count > 0)) best = Math.max(best, UNITS[type].vsGarrison);
    push('gunsVsGarrison', 'attacker', best);
  }
  return out;
}

// ------------------------------------------------------------ battle input

/** Whether nation `n`'s supply halo covers `p`. */
export function provinceSupplied(sim: Sim, n: NationIx, p: ProvinceIx): boolean {
  return isSuppliedAt(sim, n, p);
}

/** Armies of each side actually fighting at `p`: standing there, alive and in the battle. */
function fighting(sim: Sim, p: ProvinceIx): Army[] {
  return armiesAt(sim, p).filter((a) => a.alive && a.leg === null && a.at === p && a.battle !== null);
}

/** Distinct entry provinces among some armies' battle directions (at least 1). */
function directionsOf(armies: readonly Army[]): Set<ProvinceIx> {
  const set = new Set<ProvinceIx>();
  for (const army of armies) if (army.battle?.direction !== null && army.battle?.direction !== undefined) set.add(army.battle.direction);
  return set;
}

function sideOf(sim: Sim, p: ProvinceIx, nation: NationIx, role: Role, armies: readonly Army[], garrison: number): BattleSide {
  const units = zeroUnits();
  const landed = zeroUnitHp();
  for (const army of armies) {
    addUnits(units, army.units);
    if (sim.state.tick < army.landingUntil) for (const type of UNIT_TYPES) landed[type] += army.units[type].hp;
  }
  const side: BattleSide = {
    nation,
    role,
    units,
    landed,
    garrison,
    directions: role === 'attacker' ? Math.max(1, directionsOf(armies).size) : 1,
    // By the province, as the forecast does: a garrison standing alone in a cut-off pocket is unsupplied too.
    supplied: provinceSupplied(sim, nation, p),
    oilShort: sim.state.nations[nation]!.shortage.oil,
  };
  setSideRetreat(side, retreatOfArmies(armies));
  return side;
}

/** The running battle at `p` as round input, or null when there is none. */
export function battleInputAt(sim: Sim, p: ProvinceIx): BattleInput | null {
  if (!isContestedNow(sim, p)) return null;
  const province = sim.state.provinces[p]!;
  const owner = province.owner;
  const armies = fighting(sim, p);
  const garrison = province.garrison >= GARRISON.EMPTY_BELOW ? province.garrison : 0;
  const defenders = armies.filter((a) => a.owner === owner);
  if (defenders.length === 0 && garrison === 0) return null;
  const byNation = new Map<NationIx, Army[]>();
  for (const army of armies) {
    if (army.owner === owner) continue;
    const list = byNation.get(army.owner);
    if (list === undefined) byNation.set(army.owner, [army]);
    else list.push(army);
  }
  if (byNation.size === 0) return null;
  const nations = [...byNation.keys()].sort((x, y) => x - y);
  const attackers = nations.map((n) => sideOf(sim, p, n, 'attacker', byNation.get(n)!, 0));
  const allDirections = directionsOf(armies.filter((a) => a.owner !== owner));
  return {
    ctx: {
      province: p,
      terrain: sim.map.provinces[p]!.terrain,
      ramparts: province.buildings.ramparts,
      totalDirections: Math.max(1, allDirections.size),
    },
    defender: sideOf(sim, p, owner, 'defender', defenders, garrison),
    attackers,
  };
}

// ------------------------------------------------------------ the battle phase

function feedName(sim: Sim, p: ProvinceIx): string {
  return sim.map.provinces[p]!.name;
}

/** Applies one side's per-type losses to its armies, split by each army's HP of that type. */
function writeBack(sim: Sim, armies: readonly Army[], loss: SideLoss, opposesPlayer: boolean): void {
  const pools = zeroUnitHp();
  for (const army of armies) for (const type of UNIT_TYPES) pools[type] += army.units[type].hp;
  for (const army of armies) {
    const share = zeroUnitHp();
    for (const type of UNIT_TYPES) share[type] = pools[type] > 0 ? (loss.hp[type] * army.units[type].hp) / pools[type] : 0;
    const before = countsOf(army.units);
    applyHpLoss(army.units, share);
    recordLosses(sim, army, before);
    if (opposesPlayer) {
      let lost = 0;
      for (const type of UNIT_TYPES) lost += before[type] - army.units[type].count;
      if (lost > 0) recordStat(sim, 'enemyUnitsDestroyed', lost);
    }
  }
}

/** HP lost so far by the armies still in the battle, the round's destroyed included: the battle's size. */
function destroyedSoFar(armies: readonly Army[]): number {
  let hp = 0;
  for (const army of armies) hp += Math.max(0, (army.battle?.startHp ?? 0) - totalHp(army.units));
  return hp;
}

function reportDestroyed(sim: Sim, army: Army, p: ProvinceIx, playerInvolved: boolean): void {
  const { state, map } = sim;
  if (army.owner === state.player) {
    pushFeed(sim, {
      kind: 'armyDestroyed',
      severity: 'bad',
      text: `${army.name} was destroyed in ${feedName(sim, p)}`,
      nations: [army.owner, state.provinces[p]!.owner],
      province: p,
      army: army.id,
    });
    raiseAlert(sim, { kind: 'armyDestroyed', province: p, nation: army.owner });
  } else if (playerInvolved) {
    pushFeed(sim, {
      kind: 'armyDestroyed',
      severity: 'good',
      text: `Destroyed ${map.nations[army.owner]!.name}'s ${army.name} in ${feedName(sim, p)}`,
      nations: [state.player, army.owner],
      province: p,
      army: army.id,
    });
  }
}

/** One round at `p` and everything it settles: write-back, destruction, retreats, and the outcome. */
function fight(sim: Sim, p: ProvinceIx): void {
  const { state, cache } = sim;
  engage(sim, p);
  const input = battleInputAt(sim, p);
  if (input === null) return;
  const owner = input.defender.nation;
  const player = state.player;
  const attackerNations = input.attackers.map((a) => a.nation);
  const playerInvolved = owner === player || attackerNations.includes(player);

  const rolls = [roll(sim, COMBAT.ROLL_MIN, COMBAT.ROLL_MAX)];
  for (let i = 0; i < input.attackers.length; i += 1) rolls.push(roll(sim, COMBAT.ROLL_MIN, COMBAT.ROLL_MAX));
  const result = roundDamage(input, rolls);

  const armies = fighting(sim, p);
  result.losses.forEach((loss, i) => {
    const mine = armies.filter((a) => a.owner === loss.nation);
    const opposesPlayer = i === 0 ? attackerNations.includes(player) : owner === player;
    writeBack(sim, mine, loss, opposesPlayer);
  });
  const province = state.provinces[p]!;
  const garrisonLoss = result.losses[0]!.garrison;
  if (garrisonLoss > 0) {
    province.garrison = Math.max(0, province.garrison - garrisonLoss);
    if (province.garrison < GARRISON.EMPTY_BELOW) province.garrison = 0;
  }

  const report = {
    tick: state.tick,
    sides: result.losses.map((loss, i) => {
      const side = i === 0 ? input.defender : input.attackers[i - 1]!;
      let taken = loss.garrison;
      for (const type of UNIT_TYPES) taken += loss.hp[type];
      const hp = totalHp(side.units) + side.garrison - taken;
      return { nation: loss.nation, hp, dealt: loss.dealt, taken };
    }),
  };
  const log = cache.battleLog.get(p) ?? [];
  log.push(report);
  if (log.length > COMBAT.LOG_ROUNDS) log.splice(0, log.length - COMBAT.LOG_ROUNDS);
  cache.battleLog.set(p, log);
  if (playerInvolved) recordBattleSize(sim, p, destroyedSoFar(armies));

  for (const army of armies) {
    if (totalHp(army.units) >= COMBAT.DEAD_HP && !isEmpty(army.units)) continue;
    removeArmy(sim, army);
    reportDestroyed(sim, army, p, playerInvolved);
  }
  for (const army of armies) {
    if (!army.alive || army.battle === null || army.retreatAt <= 0) continue;
    if (totalHp(army.units) >= army.retreatAt * army.battle.startHp) continue;
    const target = retreatTarget(sim, army);
    if (target === null || !beginRetreat(sim, army, [target])) continue;
    pushFeed(sim, {
      kind: 'retreated',
      severity: army.owner === player ? 'bad' : owner === player ? 'good' : 'info',
      text: `${army.owner === player ? '' : `${sim.map.nations[army.owner]!.name}'s `}${army.name} fell back from ${feedName(sim, p)}`,
      nations: [army.owner, owner],
      province: p,
      army: army.id,
    });
  }
  settle(sim, p, owner, attackerNations);
}

/** After a round: the attackers are gone (the defence held), or the defence is gone (capture), or it goes on. */
function settle(sim: Sim, p: ProvinceIx, owner: NationIx, attackerNations: readonly NationIx[]): void {
  const { state, cache } = sim;
  const player = state.player;
  const province = state.provinces[p]!;
  const left = fighting(sim, p);
  const defenders = left.filter((a) => a.owner === owner);
  const attackers = left.filter((a) => a.owner !== owner);
  for (const n of attackerNations) {
    if (n !== player || attackers.some((a) => a.owner === n)) continue;
    recordStat(sim, 'attacksLost', 1);
    pushFeed(sim, {
      kind: 'battleLost',
      severity: 'bad',
      text: `The attack on ${feedName(sim, p)} failed`,
      nations: [player, owner],
      province: p,
      army: null,
    });
  }
  if (attackers.length === 0) {
    for (const army of defenders) army.battle = null;
    province.battleSince = null;
    cache.battleLog.delete(p);
    if (owner === player) {
      recordStat(sim, 'defencesHeld', 1);
      pushFeed(sim, {
        kind: 'defenceHeld',
        severity: 'good',
        text: `${feedName(sim, p)} held`,
        nations: [owner, ...attackerNations],
        province: p,
        army: null,
      });
    }
    return;
  }
  if (defenders.length > 0 || province.garrison >= GARRISON.EMPTY_BELOW) return;
  captureProvince(sim, p, strongest(attackers));
}

/** The attacking nation with the most HP present (ties to the lower NationIx). */
function strongest(armies: readonly Army[]): NationIx {
  const hp = new Map<NationIx, number>();
  for (const army of armies) hp.set(army.owner, (hp.get(army.owner) ?? 0) + totalHp(army.units));
  let best: NationIx | null = null;
  let bestHp = -1;
  for (const [n, total] of hp) {
    if (total > bestHp || (total === bestHp && best !== null && n < best)) {
      best = n;
      bestHp = total;
    }
  }
  return best!;
}

/**
 * Foreign armies standing on hostile land with nobody left to defend it (the
 * defenders marched away between rounds) take the province, strongest first.
 */
function occupyUndefended(sim: Sim): void {
  const { state } = sim;
  for (let i = 0; i < state.provinces.length; i += 1) {
    const here = sim.cache.armiesAt[i];
    if (here === undefined || here.length === 0) continue;
    const p = asProvince(i);
    const owner = state.provinces[p]!.owner;
    const foreign = here.filter((a) => a.alive && a.leg === null && a.at === p && a.owner !== owner);
    if (foreign.length === 0 || isContestedNow(sim, p)) continue;
    captureProvince(sim, p, strongest(foreign));
  }
}

/** Battles whose attackers left between rounds end quietly. */
function endStaleBattles(sim: Sim): void {
  const { state } = sim;
  for (let i = 0; i < state.provinces.length; i += 1) {
    const province = state.provinces[i]!;
    if (province.battleSince === null) continue;
    const p = asProvince(i);
    if (isContestedNow(sim, p)) continue;
    province.battleSince = null;
    for (const army of armiesAt(sim, p)) if (army.alive && army.leg === null) army.battle = null;
    sim.cache.battleLog.delete(p);
  }
}

/**
 * The hourly battle phase: undefended occupations, then one round per contested
 * province (ascending; the defender rolls first, then attackers in order), with
 * write-back, auto-retreats, captures and capitulations; the index is rebuilt at
 * the end so later phases see the result.
 */
export function resolveBattles(sim: Sim): void {
  occupyUndefended(sim);
  for (const p of [...sim.cache.battles]) {
    if (isContestedNow(sim, p)) fight(sim, p);
  }
  endStaleBattles(sim);
  rebuildArmyIndex(sim);
}
