/**
 * How an AI nation sees the board (§6.3): fighting strength by Lanchester's
 * square law for cheap screening, the threat to and the defence of each of its
 * provinces, what an enemy province is worth, and which armies are free.
 *
 * Strength is F = √(damage per hour × HP) against a given enemy soft share,
 * with terrain, Ramparts and frontage. Threat sums every hostile force within
 * AI.THREAT_HOPS of a province, from every nation (weight 1 at one hop or
 * inbound, THREAT_FAR_WEIGHT at two), plus a share of the units in hostile
 * training queues next door. The AI ignores fog (§6.1).
 */
import { AI, CAPITAL, COMBAT, EFFECTS, GARRISON, TERRAIN, UNITS } from '../balance';
import { armiesAt, armiesOf, armyById, inboundTo, ownedProvinces } from '../cache';
import { capitulatesOnCapture } from '../capture';
import { hoursToTicks } from '../clock';
import { baseOutput } from '../economy';
import { unitPrice } from '../market';
import { travelField, type TravelField } from '../pathfinding';
import { isIdle } from '../armies';
import { zeroUnits } from '../keys';
import { UNIT_TYPES } from '../types';
import type { Army, ArmyId, MapStatic, NationIx, Operation, ProvinceIx, Role, Sim, Terrain, Units } from '../types';
import { vpShare } from '../victory';

export interface Strength {
  damage: number;
  hp: number;
  f: number;
}

export interface NationView {
  nation: NationIx;
  /** Owned provinces with a hostile neighbour, the capital first, then by threat/defence; at most AI.MAX_FRONTIER. */
  frontier: ProvinceIx[];
  /** Per province: F of the hostile force around it (assessed provinces only, 0 elsewhere). */
  threat: Float64Array;
  /** Per province: F of the own armies standing there plus the garrison. */
  defence: Float64Array;
  /** Per province: the defence F it must keep (GUARD_NEED at the capital, FRONT_GUARD elsewhere, × threat). */
  need: Float64Array;
  /** Armies free for orders, ascending id (before the "keeps its province's need" check, which planners make). */
  available: ArmyId[];
  /** Own-territory travel field at AI.REFERENCE_SPEED_KMH from the frontier and the capital. */
  field: TravelField;
  operations: number;
}

/**
 * An operation ends this long after launch if none of its armies has made
 * contact. balance.ts has no constant for it; the spec (§6.4) gives 72 h.
 */
const OPERATION_TIMEOUT_HOURS = 72;

// ------------------------------------------------------------------ strength

/** Share of a force's HP (garrison included) that is soft; 1 for an empty force, which only a garrison could defend. */
export function softShare(units: Units, garrison: number): number {
  let soft = garrison;
  let all = garrison;
  for (const type of UNIT_TYPES) {
    all += units[type].hp;
    if (UNITS[type].armour === 'soft') soft += units[type].hp;
  }
  return all > 0 ? soft / all : 1;
}

/**
 * Fighting strength of a force in one battle: damage per hour against an enemy
 * with `enemySoftShare` soft HP, its HP, and F = √(damage × HP). The defender
 * gets the terrain and Ramparts bonuses; the Ramparts protection counts as extra
 * HP. Frontage caps how much of a big force fights.
 */
export function strength(units: Units, garrison: number, role: Role, enemySoftShare: number, terrain: Terrain, ramparts: number): Strength {
  const t = TERRAIN[terrain];
  const soft = Math.min(1, Math.max(0, enemySoftShare));
  const hard = 1 - soft;
  const defending = role === 'defender';
  const militia = defending && garrison >= GARRISON.EMPTY_BELOW ? garrison : 0;
  let ue = militia / GARRISON.HP_PER_UNIT;
  let raw = ue * (soft * GARRISON.DEFENCE.soft + hard * GARRISON.DEFENCE.hard);
  let hp = militia;
  for (const type of UNIT_TYPES) {
    const pool = units[type].hp;
    if (pool <= 0) continue;
    const spec = UNITS[type];
    const values = defending ? spec.defence : spec.attack;
    const each = pool / spec.hp;
    raw += each * (soft * values.soft + hard * values.hard) * (type === 'tanks' ? t.tanks : 1);
    ue += each;
    hp += pool;
  }
  const engage = ue > t.frontage ? t.frontage / ue : 1;
  let damage = raw * engage * COMBAT.DAMAGE_SCALE;
  if (defending) {
    damage *= t.defence * (1 + EFFECTS.RAMPARTS_DAMAGE_PER_LEVEL * ramparts);
    hp /= 1 - EFFECTS.RAMPARTS_PROTECTION_PER_LEVEL * ramparts;
  }
  return { damage, hp, f: Math.sqrt(damage * hp) };
}

/** atanh(x) for 0 ≤ x < 1 with only sqrt: halve the argument a few times, then a short series. */
function atanh(x: number): number {
  let y = Math.min(x, 1 - 1e-12);
  let scale = 1;
  for (let i = 0; i < 4; i += 1) {
    y /= 1 + Math.sqrt(1 - y * y);
    scale *= 2;
  }
  const y2 = y * y;
  return scale * y * (1 + y2 * (1 / 3 + y2 * (1 / 5 + y2 * (1 / 7 + y2 / 9))));
}

/**
 * The square law: A beats B when F_A > F_B and keeps √(1 − (F_B/F_A)²) of its
 * HP; `hours` is the time until the loser is gone (capped at the forecast cap).
 */
export function lanchester(a: Strength, b: Strength): { aWins: boolean; keep: number; hours: number } {
  if (b.f <= 0) return { aWins: a.f > 0, keep: a.f > 0 ? 1 : 0, hours: 0 };
  if (a.f <= 0) return { aWins: false, keep: 0, hours: 0 };
  const aWins = a.f > b.f;
  const ratio = aWins ? b.f / a.f : a.f / b.f;
  const omega = Math.sqrt((a.damage / a.hp) * (b.damage / b.hp));
  const hours = omega > 0 && ratio < 1 ? Math.min(COMBAT.PREDICT_MAX_HOURS, atanh(ratio) / omega) : COMBAT.PREDICT_MAX_HOURS;
  return { aWins, keep: aWins ? Math.sqrt(1 - ratio * ratio) : 0, hours };
}

// -------------------------------------------------------------- forces

/** Reused visit marks per map, so the many small searches here allocate nothing but their result. */
const visitMarks = new WeakMap<MapStatic, { seen: Int32Array; generation: number }>();

function marksFor(map: MapStatic): { seen: Int32Array; generation: number } {
  let marks = visitMarks.get(map);
  if (marks === undefined) {
    marks = { seen: new Int32Array(map.provinces.length), generation: 0 };
    visitMarks.set(map, marks);
  }
  return marks;
}

function addScaled(into: Units, from: Units, weight: number): void {
  for (const type of UNIT_TYPES) {
    into[type].count += from[type].count * weight;
    into[type].hp += from[type].hp * weight;
  }
}

/** The units of `n`'s live armies standing at `p` (not on a leg). */
export function ownUnitsAt(sim: Sim, n: NationIx, p: ProvinceIx): Units {
  const units = zeroUnits();
  for (const army of armiesAt(sim, p)) if (army.alive && army.owner === n && army.leg === null) addScaled(units, army.units, 1);
  return units;
}

/** Provinces within `hops` of `p` with their hop distance, nearest first then ascending. */
export function provincesWithin(sim: Sim, p: ProvinceIx, hops: number): { p: ProvinceIx; d: number }[] {
  const marks = marksFor(sim.map);
  marks.generation += 1;
  const gen = marks.generation;
  const out = [{ p, d: 0 }];
  marks.seen[p] = gen;
  for (let i = 0; i < out.length; i += 1) {
    const here = out[i]!;
    if (here.d >= hops) continue;
    for (const e of sim.map.edges[here.p]!) {
      if (marks.seen[e.to] === gen) continue;
      marks.seen[e.to] = gen;
      out.push({ p: e.to, d: here.d + 1 });
    }
  }
  return out;
}

/** Hop distance from `a` to `b` if at most two, else null. */
function hopsBetween(sim: Sim, a: ProvinceIx, b: ProvinceIx): number | null {
  if (a === b) return 0;
  const edges = sim.map.edges;
  if (edges[a]!.some((e) => e.to === b)) return 1;
  return edges[a]!.some((e) => edges[e.to]!.some((f) => f.to === b)) ? 2 : null;
}

/**
 * Hostile HP around `p` as `n` sees it: armies of every other nation standing
 * or arriving within THREAT_HOPS (weight 1 up to one hop, THREAT_FAR_WEIGHT
 * beyond), plus THREAT_QUEUED_SHARE of the units queued in hostile provinces
 * within one hop. `skip` leaves out the armies standing in one province: the
 * defenders of a province we are about to take, which the attack removes.
 */
export function threatUnitsAt(sim: Sim, n: NationIx, p: ProvinceIx, skip: ProvinceIx | null): Units {
  const { state } = sim;
  const units = zeroUnits();
  for (const { p: q, d } of provincesWithin(sim, p, AI.THREAT_HOPS)) {
    const weight = d <= 1 ? AI.THREAT_NEAR_WEIGHT : AI.THREAT_FAR_WEIGHT;
    if (q !== skip) {
      for (const army of armiesAt(sim, q)) if (army.alive && army.owner !== n && army.leg === null) addScaled(units, army.units, weight);
    }
    for (const army of inboundTo(sim, q)) if (army.alive && army.owner !== n && army.leg !== null) addScaled(units, army.units, weight);
    const province = state.provinces[q]!;
    if (d <= 1 && province.owner !== n) {
      for (const item of province.queue) {
        units[item.unit].count += AI.THREAT_QUEUED_SHARE;
        units[item.unit].hp += AI.THREAT_QUEUED_SHARE * UNITS[item.unit].hp;
      }
    }
  }
  return units;
}

function garrisonOf(sim: Sim, p: ProvinceIx): number {
  const garrison = sim.state.provinces[p]!.garrison;
  return garrison >= GARRISON.EMPTY_BELOW ? garrison : 0;
}

/** The combined hostile force around `p`, fighting into n's defence there. */
export function threatAt(sim: Sim, n: NationIx, p: ProvinceIx): Strength {
  const own = ownUnitsAt(sim, n, p);
  const garrison = sim.state.provinces[p]!.owner === n ? garrisonOf(sim, p) : 0;
  const threat = threatUnitsAt(sim, n, p, null);
  return strength(threat, 0, 'attacker', softShare(own, garrison), sim.map.provinces[p]!.terrain, sim.state.provinces[p]!.buildings.ramparts);
}

/**
 * The need at `p` if the hostile armies standing at `gone` were no longer
 * there (an attack on `gone` that wins removes them): the assessed threat less
 * their weighted share.
 */
export function needWithout(sim: Sim, view: NationView, p: ProvinceIx, gone: ProvinceIx): number {
  const n = view.nation;
  const d = hopsBetween(sim, p, gone);
  const assessed = extrasOf.get(view)?.hostile.get(p);
  if (d === null || assessed === undefined) return view.need[p] ?? 0;
  const hostile = zeroUnits();
  addScaled(hostile, assessed, 1);
  const weight = d <= 1 ? AI.THREAT_NEAR_WEIGHT : AI.THREAT_FAR_WEIGHT;
  for (const army of armiesAt(sim, gone)) {
    if (!army.alive || army.owner === n || army.leg !== null) continue;
    for (const type of UNIT_TYPES) hostile[type].hp = Math.max(0, hostile[type].hp - weight * army.units[type].hp);
  }
  const own = ownUnitsAt(sim, n, p);
  const threat = strength(hostile, 0, 'attacker', softShare(own, garrisonOf(sim, p)), sim.map.provinces[p]!.terrain, sim.state.provinces[p]!.buildings.ramparts).f;
  return needFactor(sim, n, p) * threat;
}

/** The defence F of `p` if `units` stood there with the garrison, against a threat with `threatSoft` soft HP. */
export function defenceF(sim: Sim, p: ProvinceIx, units: Units, threatSoft: number): number {
  const province = sim.state.provinces[p]!;
  return strength(units, garrisonOf(sim, p), 'defender', threatSoft, sim.map.provinces[p]!.terrain, province.buildings.ramparts).f;
}

// ------------------------------------------------------------------ value

/** 100 × VP + 5 days of the province's Funds and goods at market price. */
function ownValue(sim: Sim, p: ProvinceIx): number {
  const out = baseOutput(sim, p);
  return AI.VALUE_PER_VP * sim.map.provinces[p]!.vp + AI.VALUE_OUTPUT_DAYS * (out.funds + out.goods * unitPrice(sim.state.market, out.good));
}

/** Whether `a` and `b` are fighting: one's armies stand in a battle in the other's province. */
export function fighting(sim: Sim, a: NationIx, b: NationIx): boolean {
  for (const p of sim.cache.battles) {
    const owner = sim.state.provinces[p]!.owner;
    if (owner !== a && owner !== b) continue;
    const other = owner === a ? b : a;
    if (armiesAt(sim, p).some((army) => army.alive && army.owner === other && army.battle !== null)) return true;
  }
  return false;
}

/**
 * What taking `p` is worth to `attacker`: its own value; plus VALUE_CAPITULATION_SHARE
 * of the owner's other provinces when it would make the owner capitulate; × the
 * engaged bonus when we already fight the owner; × leader fear when the owner
 * holds LEADER_FEAR_SHARE of world VP.
 */
export function provinceValue(sim: Sim, p: ProvinceIx, attacker: NationIx): number {
  const owner = sim.state.provinces[p]!.owner;
  let value = ownValue(sim, p);
  if (capitulatesOnCapture(sim, p)) {
    let rest = 0;
    for (const q of ownedProvinces(sim, owner)) if (q !== p) rest += ownValue(sim, q);
    value += AI.VALUE_CAPITULATION_SHARE * rest;
  }
  if (fighting(sim, attacker, owner)) value *= AI.VALUE_ENGAGED_BONUS;
  if (vpShare(sim, owner) >= AI.LEADER_FEAR_SHARE) value *= AI.LEADER_FEAR_BONUS;
  return value;
}

// ------------------------------------------------------------- operations

/**
 * The operations still running: the target is not ours yet, at least one of its
 * armies is still on the way or fighting, and it has made contact or is younger
 * than the timeout.
 */
export function liveOperations(sim: Sim, n: NationIx): Operation[] {
  const { state } = sim;
  const timeout = hoursToTicks(OPERATION_TIMEOUT_HOURS);
  return state.nations[n]!.ai.operations.filter((op) => {
    if (state.provinces[op.target]?.owner === n) return false;
    const armies = op.armies.map((id) => armyById(sim, id)).filter((a): a is Army => a !== undefined && a.alive);
    const active = armies.filter((a) => !isIdle(sim, a) && a.intent !== 'retreat');
    if (active.length === 0) return false;
    const contact = active.some((a) => a.battle !== null && a.at === op.target);
    return contact || state.tick - op.launchedAt < timeout;
  });
}

// ------------------------------------------------------------------ the view

/** Ratio used to order the frontier: the most threatened relative to its defence first. */
function pressure(view: NationView, p: ProvinceIx): number {
  return view.threat[p]! / Math.max(view.defence[p]!, 1e-9);
}

/** Per view: the soft share of the threat and the hostile units at each assessed province, for re-scoring. */
interface ViewExtras {
  soft: Float64Array;
  hostile: Map<ProvinceIx, Units>;
}
const extrasOf = new WeakMap<NationView, ViewExtras>();

export function threatSoft(view: NationView, p: ProvinceIx): number {
  return extrasOf.get(view)?.soft[p] ?? 1;
}

/** The same view with a different list of available armies (the advisor plans for idle Manual armies). */
export function withAvailable(view: NationView, available: ArmyId[]): NationView {
  const copy: NationView = {
    nation: view.nation,
    frontier: view.frontier,
    threat: view.threat,
    defence: view.defence,
    need: view.need,
    available,
    operations: view.operations,
    get field() {
      return view.field;
    },
  };
  const extras = extrasOf.get(view);
  if (extras !== undefined) extrasOf.set(copy, extras);
  return copy;
}

/**
 * The need multiplier at `p`: the guard at the capital, the front guard
 * elsewhere. Minors keep only the capital guard (§6.6), so the rest of their
 * army is free to defend and strike.
 */
function needFactor(sim: Sim, n: NationIx, p: ProvinceIx): number {
  const nation = sim.state.nations[n]!;
  if (nation.capital === p) return CAPITAL.GUARD_NEED;
  return nation.tier === 'minor' && !nation.isPlayer ? 0 : AI.FRONT_GUARD;
}

/**
 * Assesses nation `n`: threat, defence and need at the frontier, the capital and
 * every province where its armies stand; the ordered frontier; one own-territory
 * travel field from the frontier and the capital; the armies free for orders
 * (idle, not frozen, not in an operation, not ordered within REASSIGN_AFTER_HOURS;
 * for the player, only the armies the Staff may command).
 */
export function assessNation(sim: Sim, n: NationIx): NationView {
  const { map, state } = sim;
  const nation = state.nations[n]!;
  const count = map.provinces.length;
  const threat = new Float64Array(count);
  const defence = new Float64Array(count);
  const need = new Float64Array(count);
  const soft = new Float64Array(count).fill(1);
  const hostileAt = new Map<ProvinceIx, Units>();
  const capital = nation.capital;
  const hostileNeighbour = (p: ProvinceIx): boolean => map.edges[p]!.some((e) => state.provinces[e.to]!.owner !== n);
  const border = ownedProvinces(sim, n).filter(hostileNeighbour);
  const assessed = new Set<ProvinceIx>(border);
  if (capital !== null) assessed.add(capital);
  for (const army of armiesOf(sim, n)) if (army.alive && army.leg === null && state.provinces[army.at]!.owner === n) assessed.add(army.at);
  for (const p of [...assessed].sort((x, y) => x - y)) {
    const own = ownUnitsAt(sim, n, p);
    const garrison = garrisonOf(sim, p);
    const hostile = threatUnitsAt(sim, n, p, null);
    hostileAt.set(p, hostile);
    const terrain = map.provinces[p]!.terrain;
    const ramparts = state.provinces[p]!.buildings.ramparts;
    soft[p] = softShare(hostile, 0);
    threat[p] = strength(hostile, 0, 'attacker', softShare(own, garrison), terrain, ramparts).f;
    defence[p] = strength(own, garrison, 'defender', soft[p], terrain, ramparts).f;
    need[p] = needFactor(sim, n, p) * threat[p];
  }

  const live = liveOperations(sim, n);
  const inOperation = new Set<ArmyId>();
  for (const op of live) for (const id of op.armies) inOperation.add(id);
  const settle = hoursToTicks(AI.REASSIGN_AFTER_HOURS);
  const available: ArmyId[] = [];
  for (const army of armiesOf(sim, n)) {
    if (!isIdle(sim, army) || inOperation.has(army.id) || state.tick - army.orderedAt < settle) continue;
    if (nation.isPlayer && army.stance === 'manual') continue;
    available.push(army.id);
  }

  // The field is built on first use: alert thinks and minors often never need it.
  let field: TravelField | null = null;
  const view: NationView = {
    nation: n,
    frontier: [],
    threat,
    defence,
    need,
    available,
    operations: live.length,
    get field() {
      field ??= travelField(sim, this.frontier, { nation: n, speedKmh: AI.REFERENCE_SPEED_KMH, mode: 'own', maxTicks: Number.POSITIVE_INFINITY });
      return field;
    },
  };
  const ordered = border.filter((p) => p !== capital).sort((x, y) => pressure(view, y) - pressure(view, x) || x - y);
  view.frontier = (capital !== null ? [capital, ...ordered] : ordered).slice(0, AI.MAX_FRONTIER);
  extrasOf.set(view, { soft, hostile: hostileAt });
  return view;
}
