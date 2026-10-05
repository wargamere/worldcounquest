/**
 * Forecasts and odds (§5.10). `predictBattle` plays the real round with every
 * roll at 1, adding reinforcements at their hour, until one side is gone or the
 * hour cap; `winChance` plays the same loop with random rolls from a private
 * stream seeded by the input, so it never touches state.rng and does not flicker
 * while nothing changes. Retreats are modelled per side, at the HP-weighted mean
 * threshold of the side's armies, with the disengage cost.
 */
import { COMBAT, GARRISON, MOVEMENT, TIME } from './balance';
import { countsOf, defaultRetreatAt } from './armies';
import { armiesAt, armyById, inboundTo } from './cache';
import { battleModifiers, computeRound, provinceSupplied, retreatOfArmies, setSideRetreat, sideRetreat, type RoundLosses } from './combat';
import { planEta, type DeparturePlan } from './movement';
import { garrisonAt } from './province';
import { hashNumbers, localRng } from './rng';
import { isArmyVisible } from './supply';
import { TERRAINS, UNIT_TYPES } from './types';
import type {
  Army,
  BattleInput,
  BattlePrediction,
  BattleSide,
  Forecast,
  NationIx,
  ProvinceIx,
  Reinforcement,
  Sim,
  UnitCounts,
  Units,
  UnitType,
  Verdict,
} from './types';
import { addUnits, applyHpLoss, copyUnits, isEmpty, losePoolHp, totalHp } from './units';
import { zeroUnitHp, zeroUnits } from './keys';
import { edgeBetween } from './world';

export interface Arrival {
  nation: NationIx;
  units: Units;
  direction: ProvinceIx | null;
  landed: boolean;
  /** Hourly rounds after the next one before it fights (0 = the next round). */
  atHour: number;
}

// ---------------------------------------------------------------- the loop

type Counts = Record<UnitType, number>;

/** A side as the forecast plays it: a private copy plus what it brought and what left. */
interface Working {
  side: BattleSide;
  present: boolean;
  retreatAt: number;
  /** Army HP the retreat threshold is a share of. */
  startHp: number;
  /** HP brought into the battle (armies and garrison), the denominator of "keeps". */
  brought: number;
  broughtCounts: Counts;
  /** Army HP and units that left by retreating, after the disengage cost. */
  exitHp: number;
  exitCounts: Counts;
  /** The landing penalty ends before this hour's round. */
  landedUntil: number;
}

function working(side: BattleSide, hour: number): Working {
  const units = copyUnits(side.units);
  const note = sideRetreat(side);
  const armyHp = totalHp(units);
  const landed = { ...side.landed };
  return {
    side: { ...side, units, landed },
    present: true,
    retreatAt: note.retreatAt,
    startHp: note.startHp ?? armyHp,
    brought: armyHp + side.garrison,
    broughtCounts: countsOf(units),
    exitHp: 0,
    exitCounts: countsOf(zeroUnits()),
    landedUntil: UNIT_TYPES.some((t) => landed[t] > 0) ? hour + MOVEMENT.LANDING_HOURS : hour,
  };
}

function join(w: Working, side: BattleSide, hour: number): void {
  const hp = totalHp(side.units);
  if (!w.present) {
    w.side.units = copyUnits(side.units);
    w.side.landed = { ...side.landed };
    w.startHp = hp;
    w.present = true;
  } else {
    addUnits(w.side.units, side.units);
    for (const type of UNIT_TYPES) w.side.landed[type] += side.landed[type];
    w.startHp += sideRetreat(side).startHp ?? hp;
  }
  w.side.garrison += side.garrison;
  w.side.directions = Math.max(w.side.directions, side.directions);
  w.brought += hp + side.garrison;
  for (const type of UNIT_TYPES) w.broughtCounts[type] += side.units[type].count;
  if (UNIT_TYPES.some((t) => side.landed[t] > 0)) w.landedUntil = Math.max(w.landedUntil, hour + MOVEMENT.LANDING_HOURS);
}

/** Leaves the battle: the disengage cost, then the survivors count as kept. */
function withdraw(w: Working): void {
  const loss = zeroUnitHp();
  for (const type of UNIT_TYPES) loss[type] = w.side.units[type].hp * MOVEMENT.DISENGAGE_HP_LOSS;
  applyHpLoss(w.side.units, loss);
  w.exitHp += totalHp(w.side.units);
  for (const type of UNIT_TYPES) w.exitCounts[type] += w.side.units[type].count;
  w.side.units = zeroUnits();
  w.side.landed = zeroUnitHp();
}

/** Applies side `i`'s losses from the last computed round; landed HP shrinks with its pool. */
function applyLoss(w: Working, round: RoundLosses, i: number, garrison: number): void {
  for (let t = 0; t < UNIT_TYPES.length; t += 1) {
    const type = UNIT_TYPES[t]!;
    const lost = round.loss[i * UNIT_TYPES.length + t]!;
    if (lost <= 0) continue;
    const pool = w.side.units[type].hp;
    if (pool > 0 && w.side.landed[type] > 0) w.side.landed[type] *= Math.max(0, pool - lost) / pool;
    losePoolHp(w.side.units, type, lost);
  }
  if (garrison > 0) {
    w.side.garrison = Math.max(0, w.side.garrison - garrison);
    if (w.side.garrison < GARRISON.EMPTY_BELOW) w.side.garrison = 0;
  }
}

const armyHpOf = (w: Working): number => totalHp(w.side.units);
const defends = (w: Working): boolean => armyHpOf(w) >= COMBAT.DEAD_HP || w.side.garrison >= GARRISON.EMPTY_BELOW;

interface Outcome {
  winner: BattlePrediction['winner'];
  hours: number;
  captor: NationIx | null;
  defender: Working;
  attackers: Working[];
}

/** The attacker with the most HP (ties to the lower NationIx; `attackers` is ascending). */
function captorOf(attackers: readonly Working[]): NationIx | null {
  let best: Working | null = null;
  for (const w of attackers) if (w.present && (best === null || armyHpOf(w) > armyHpOf(best))) best = w;
  return best?.side.nation ?? null;
}

/**
 * Plays the battle round by round with `draw` for the rolls (null: every roll
 * is 1), following the sim's order: damage, destruction, retreats, outcome.
 */
function simulate(input: BattleInput, reinforcements: readonly Reinforcement[], maxHours: number, draw: (() => number) | null): Outcome {
  const defender = working(input.defender, 0);
  const attackers = input.attackers.map((side) => working(side, 0));
  const defenderNation = input.defender.nation;
  const joinsDefence = (side: BattleSide): boolean => side.nation === defenderNation || side.role === 'defender';
  const pending = reinforcements.map((r, i) => ({ r, i })).sort((x, y) => x.r.atHour - y.r.atHour || x.i - y.i);
  let lastAttacker = -1;
  pending.forEach(({ r }, i) => {
    if (!joinsDefence(r.side)) lastAttacker = i;
  });
  let next = 0;
  let hours = 0;
  const done = (winner: Outcome['winner'], captor: NationIx | null): Outcome => ({ winner, hours, captor, defender, attackers });
  // One round input, one list of fighting sides and one roll buffer serve every hour.
  const ctx = { ...input.ctx };
  const fighting: Working[] = [];
  const sides: BattleSide[] = [];
  const round: BattleInput = { ctx, defender: defender.side, attackers: sides };
  let rolls = new Float64Array(input.attackers.length + 1);

  for (let hour = 0; hour < maxHours; hour += 1) {
    for (; next < pending.length && pending[next]!.r.atHour <= hour; next += 1) {
      const side = pending[next]!.r.side;
      if (joinsDefence(side)) {
        join(defender, side, hour);
        continue;
      }
      const known = attackers.find((w) => w.side.nation === side.nation);
      if (known !== undefined) join(known, side, hour);
      else {
        attackers.push(working(side, hour));
        attackers.sort((x, y) => x.side.nation - y.side.nation);
      }
    }
    const attackersDue = next <= lastAttacker;
    fighting.length = 0;
    sides.length = 0;
    let directions = input.ctx.totalDirections;
    for (const w of attackers) {
      if (!w.present) continue;
      fighting.push(w);
      sides.push(w.side);
      if (w.side.directions > directions) directions = w.side.directions;
    }
    if (!defends(defender)) {
      if (fighting.length > 0) return done('attacker', captorOf(attackers));
      if (attackersDue) continue;
      return done('defender', null);
    }
    if (fighting.length === 0) {
      if (attackersDue) continue;
      return done('defender', null);
    }

    ctx.totalDirections = directions;
    round.defender = defender.side;
    if (draw !== null) {
      if (rolls.length < fighting.length + 1) rolls = new Float64Array(fighting.length + 1);
      for (let i = 0; i <= fighting.length; i += 1) rolls[i] = COMBAT.ROLL_MIN + draw() * (COMBAT.ROLL_MAX - COMBAT.ROLL_MIN);
    }
    const result = computeRound(round, draw === null ? null : rolls);
    applyLoss(defender, result, 0, result.garrisonLoss);
    for (let i = 0; i < fighting.length; i += 1) applyLoss(fighting[i]!, result, i + 1, 0);
    hours = hour + 1;

    expireLanding(defender, hours);
    for (const w of fighting) {
      expireLanding(w, hours);
      if (armyHpOf(w) < COMBAT.DEAD_HP || isEmpty(w.side.units)) w.present = false;
    }
    if (armyHpOf(defender) < COMBAT.DEAD_HP) defender.side.units = zeroUnits();
    retreatIfBroken(defender);
    let left = 0;
    for (const w of fighting) {
      if (w.present && retreatIfBroken(w)) w.present = false;
      if (w.present) left += 1;
    }
    if (!defends(defender) && left > 0) return done('attacker', captorOf(attackers));
    if (left === 0 && !attackersDue) return done('defender', null);
  }
  return done('undecided', null);
}

/** The landing penalty ends LANDING_HOURS after the landing. */
function expireLanding(w: Working, hours: number): void {
  if (hours < w.landedUntil) return;
  for (const type of UNIT_TYPES) w.side.landed[type] = 0;
}

/** A side below its threshold leaves (the garrison stays); true if it left. */
function retreatIfBroken(w: Working): boolean {
  const hp = armyHpOf(w);
  if (w.retreatAt <= 0 || hp < COMBAT.DEAD_HP || hp >= w.retreatAt * w.startHp) return false;
  withdraw(w);
  return true;
}

function keeps(ws: readonly Working[]): number {
  let kept = 0;
  let brought = 0;
  for (const w of ws) {
    kept += armyHpOf(w) + w.side.garrison + w.exitHp;
    brought += w.brought;
  }
  return brought > 0 ? kept / brought : 0;
}

/** The mean-roll forecast; "attacker" figures are forNation's side if it attacks, else all attackers. */
export function predictBattle(input: BattleInput, forNation: NationIx, reinforcements: readonly Reinforcement[], maxHours: number): BattlePrediction {
  const outcome = simulate(input, reinforcements, maxHours, null);
  const own = outcome.attackers.filter((w) => w.side.nation === forNation);
  const counted = own.length > 0 ? own : outcome.attackers;
  const attackerLosses: UnitCounts = {};
  for (const type of UNIT_TYPES) {
    let lost = 0;
    for (const w of counted) lost += w.broughtCounts[type] - w.side.units[type].count - w.exitCounts[type];
    if (lost > 0) attackerLosses[type] = lost;
  }
  return {
    winner: outcome.winner,
    hours: outcome.hours,
    attackerKeeps: keeps(counted),
    defenderKeeps: keeps([outcome.defender]),
    attackerLosses,
  };
}

function sideNumbers(side: BattleSide, out: number[]): void {
  const note = sideRetreat(side);
  out.push(side.nation, side.role === 'defender' ? 0 : 1, side.garrison, side.directions, side.supplied ? 1 : 0, side.oilShort ? 1 : 0);
  out.push(note.retreatAt, note.startHp ?? -1);
  for (const type of UNIT_TYPES) out.push(side.units[type].count, side.units[type].hp, side.landed[type]);
}

/**
 * Every battle input number in a fixed order: the seed of the forecast's private
 * stream. Who asks is not part of it, so the attacker's and the defender's odds
 * of the same battle are exact complements.
 */
function inputNumbers(input: BattleInput, reinforcements: readonly Reinforcement[]): number[] {
  const out: number[] = [input.ctx.province, TERRAINS.indexOf(input.ctx.terrain), input.ctx.ramparts, input.ctx.totalDirections];
  sideNumbers(input.defender, out);
  for (const side of input.attackers) sideNumbers(side, out);
  for (const r of reinforcements) {
    out.push(r.atHour);
    sideNumbers(r.side, out);
  }
  return out;
}

/** Share of `samples` random-roll plays that forNation wins (as captor, or by holding as the defender). */
export function winChance(input: BattleInput, forNation: NationIx, reinforcements: readonly Reinforcement[], samples: number): number {
  if (samples <= 0) return 0;
  const draw = localRng(hashNumbers(inputNumbers(input, reinforcements)));
  const defending = input.defender.nation === forNation;
  let wins = 0;
  for (let i = 0; i < samples; i += 1) {
    const outcome = simulate(input, reinforcements, COMBAT.PREDICT_MAX_HOURS, draw);
    if (defending ? outcome.winner !== 'attacker' : outcome.winner === 'attacker' && outcome.captor === forNation) wins += 1;
  }
  return wins / samples;
}

export function verdictOf(chance: number): Verdict {
  const bands = COMBAT.VERDICT;
  if (chance >= bands.decisive) return 'decisive';
  if (chance >= bands.likely) return 'likely';
  if (chance >= bands.close) return 'close';
  if (chance >= bands.unlikely) return 'unlikely';
  return 'hopeless';
}

// --------------------------------------------------------- hypothetical battles

/** The first hourly round tick at or after now. */
function nextRoundTick(sim: Sim): number {
  return Math.ceil(sim.state.tick / TIME.TICKS_PER_HOUR) * TIME.TICKS_PER_HOUR;
}

/**
 * Hourly rounds after the next one before an army arriving in `etaTicks` fights:
 * it arrives in the tick `now + eta − 1` and joins the first round at or after it.
 */
export function roundOffset(sim: Sim, etaTicks: number): number {
  const first = nextRoundTick(sim);
  const arrival = sim.state.tick + Math.max(0, etaTicks - 1);
  const round = Math.ceil(arrival / TIME.TICKS_PER_HOUR) * TIME.TICKS_PER_HOUR;
  return Math.max(0, (round - first) / TIME.TICKS_PER_HOUR);
}

interface Gathering {
  units: Units;
  landed: Record<UnitType, number>;
  directions: Set<ProvinceIx>;
  armies: Army[];
  arrivalHp: number;
}

function gathering(): Gathering {
  return { units: zeroUnits(), landed: zeroUnitHp(), directions: new Set(), armies: [], arrivalHp: 0 };
}

/**
 * The battle `arrivals` would fight at `target`: the owner's armies there and its
 * garrison regenerated to the first arrival, attackers already there, the owner's
 * armies inbound no later than our last arrival, and the arrivals themselves.
 * Arrivals and inbound armies after the first round come as reinforcements; an
 * attacking reinforcement's `directions` is its side's count once it has joined.
 * For the player (viewer), only visible armies count, and `fogged` says so.
 */
export function hypotheticalInput(
  sim: Sim,
  target: ProvinceIx,
  arrivals: readonly Arrival[],
  viewer: NationIx | null,
): { input: BattleInput; reinforcements: Reinforcement[]; fogged: boolean } {
  const { state } = sim;
  const province = state.provinces[target]!;
  const owner = province.owner;
  const fog = viewer !== null && viewer === state.player;
  let fogged = false;
  const seen = (army: Army): boolean => {
    if (!fog || army.owner === viewer || isArmyVisible(sim, army)) return true;
    fogged = true;
    return false;
  };
  const sorted = [...arrivals].sort((x, y) => x.atHour - y.atHour);
  const first = sorted[0]?.atHour ?? 0;
  const last = sorted[sorted.length - 1]?.atHour ?? 0;

  const initial = new Map<NationIx, Gathering>([[owner, gathering()]]);
  const gather = (n: NationIx): Gathering => {
    let g = initial.get(n);
    if (g === undefined) {
      g = gathering();
      initial.set(n, g);
    }
    return g;
  };
  for (const army of armiesAt(sim, target)) {
    if (!army.alive || army.leg !== null || army.at !== target || !seen(army)) continue;
    const g = gather(army.owner);
    addUnits(g.units, army.units);
    g.armies.push(army);
    const direction = army.battle?.direction ?? army.cameFrom;
    if (army.owner !== owner && direction !== null) g.directions.add(direction);
    if (state.tick < army.landingUntil) for (const type of UNIT_TYPES) g.landed[type] += army.units[type].hp;
  }

  const reinforcements: Reinforcement[] = [];
  const cumulative = new Map<NationIx, Set<ProvinceIx>>();
  const sideFor = (n: NationIx, units: Units, landed: Record<UnitType, number>, garrison: number, directions: number): BattleSide => ({
    nation: n,
    role: n === owner ? 'defender' : 'attacker',
    units,
    landed,
    garrison,
    directions: n === owner ? 1 : Math.max(1, directions),
    supplied: provinceSupplied(sim, n, target),
    oilShort: state.nations[n]!.shortage.oil,
  });
  const landedOf = (units: Units, landed: boolean): Record<UnitType, number> => {
    const out = zeroUnitHp();
    if (landed) for (const type of UNIT_TYPES) out[type] = units[type].hp;
    return out;
  };

  for (const a of sorted) {
    const hour = a.atHour - first;
    if (hour <= 0) {
      const g = gather(a.nation);
      addUnits(g.units, a.units);
      g.arrivalHp += totalHp(a.units);
      if (a.nation !== owner && a.direction !== null) g.directions.add(a.direction);
      if (a.landed) for (const type of UNIT_TYPES) g.landed[type] += a.units[type].hp;
      continue;
    }
    let dirs = cumulative.get(a.nation);
    if (dirs === undefined) {
      dirs = new Set(initial.get(a.nation)?.directions ?? []);
      cumulative.set(a.nation, dirs);
    }
    if (a.direction !== null) dirs.add(a.direction);
    const side = sideFor(a.nation, copyUnits(a.units), landedOf(a.units, a.landed), 0, dirs.size);
    setSideRetreat(side, { retreatAt: defaultRetreatAt(sim, a.nation), startHp: null });
    reinforcements.push({ atHour: hour, side });
  }

  for (const army of inboundTo(sim, target)) {
    if (!army.alive || army.owner !== owner || army.leg === null || !seen(army)) continue;
    const hour = roundOffset(sim, army.leg.ticks - army.leg.done) - first;
    if (hour > last - first) continue;
    if (hour <= 0) {
      const g = gather(owner);
      addUnits(g.units, army.units);
      g.armies.push(army);
      continue;
    }
    const side = sideFor(owner, copyUnits(army.units), zeroUnitHp(), 0, 1);
    setSideRetreat(side, { retreatAt: army.retreatAt, startHp: null });
    reinforcements.push({ atHour: hour, side });
  }

  const hoursAhead = (nextRoundTick(sim) + first * TIME.TICKS_PER_HOUR - state.tick) / TIME.TICKS_PER_HOUR;
  const garrisonNow = garrisonAt(sim, target, hoursAhead);
  const garrison = garrisonNow >= GARRISON.EMPTY_BELOW ? garrisonNow : 0;
  const note = (n: NationIx, g: Gathering): { retreatAt: number; startHp: number | null } => {
    const armies = retreatOfArmies(g.armies);
    const armyHp = g.armies.reduce((sum, army) => sum + totalHp(army.units), 0);
    const total = armyHp + g.arrivalHp;
    if (total <= 0) return { retreatAt: n === owner ? 0 : defaultRetreatAt(sim, n), startHp: null };
    const arrivalAt = n === owner ? 0 : defaultRetreatAt(sim, n);
    return { retreatAt: (armies.retreatAt * armyHp + arrivalAt * g.arrivalHp) / total, startHp: (armies.startHp ?? 0) + g.arrivalHp };
  };

  const home = initial.get(owner)!;
  const defender = sideFor(owner, home.units, home.landed, garrison, 1);
  setSideRetreat(defender, note(owner, home));
  const attackers: BattleSide[] = [];
  const allDirections = new Set<ProvinceIx>();
  for (const n of [...initial.keys()].sort((x, y) => x - y)) {
    if (n === owner) continue;
    const g = initial.get(n)!;
    if (isEmpty(g.units)) continue;
    for (const d of g.directions) allDirections.add(d);
    const side = sideFor(n, g.units, g.landed, 0, g.directions.size);
    setSideRetreat(side, note(n, g));
    attackers.push(side);
  }
  return {
    input: {
      ctx: { province: target, terrain: sim.map.provinces[target]!.terrain, ramparts: province.buildings.ramparts, totalDirections: Math.max(1, allDirections.size) },
      defender,
      attackers,
    },
    reinforcements,
    fogged,
  };
}

/**
 * The forecast for an order's plans against `target`, or null when there is no
 * battle to forecast (a move to own land, or no army that would arrive).
 */
export function forecastPlans(sim: Sim, viewer: NationIx, target: ProvinceIx, plans: readonly DeparturePlan[]): Forecast | null {
  const { map, state } = sim;
  const moving: { army: Army; plan: DeparturePlan }[] = [];
  for (const plan of plans) {
    const army = armyById(sim, plan.army);
    if (army !== undefined && army.alive && plan.path.nodes.length > 0) moving.push({ army, plan });
  }
  const lead = moving[0];
  if (lead === undefined) return null;
  const nation = lead.army.owner;
  if (state.provinces[target]!.owner === nation) return null;
  const arrivals: Arrival[] = moving.map(({ army, plan }) => {
    const from = plan.approach;
    const sea = from !== null && edgeBetween(map, from, target)?.sea === true;
    return { nation, units: copyUnits(army.units), direction: from, landed: sea, atHour: roundOffset(sim, planEta(sim, plan)) };
  });
  const { input, reinforcements, fogged } = hypotheticalInput(sim, target, arrivals, viewer);
  // The ordered armies retreat at their own thresholds, not the nation default.
  const retreatAt = retreatOfArmies(moving.map((m) => m.army)).retreatAt;
  for (const side of input.attackers) if (side.nation === nation) setSideRetreat(side, { ...sideRetreat(side), retreatAt });
  for (const r of reinforcements) if (r.side.nation === nation) setSideRetreat(r.side, { ...sideRetreat(r.side), retreatAt });
  const prediction = predictBattle(input, nation, reinforcements, COMBAT.PREDICT_MAX_HOURS);
  const chance = winChance(input, nation, reinforcements, COMBAT.WIN_CHANCE_SAMPLES);
  return { ...prediction, winChance: chance, verdict: verdictOf(chance), modifiers: battleModifiers(input), fogged };
}
