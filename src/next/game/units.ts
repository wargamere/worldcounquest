/**
 * Unit stacks (§4.1–4.2). An army holds a count and an HP pool per unit type.
 * Damage lowers the pool, and the count follows it down, never up: healing only
 * refills HP up to count × unit HP, so a lost unit comes back only by merging or
 * training.
 */
import { COMBAT, ECONOMY, UNITS } from './balance';
import { zeroUnits } from './keys';
import { STOCK_KEYS, UNIT_TYPES } from './types';
import type { Cost, UnitCounts, UnitHp, Units, UnitType } from './types';

/** Tolerance for the count rule, so HP that is a whole number of units after float noise keeps its count. */
const COUNT_EPSILON = 1e-9;

/** The whole units an HP pool still supports, never more than the count it had. */
function countFor(type: UnitType, count: number, hp: number): number {
  if (hp < COMBAT.DEAD_HP) return 0;
  return Math.min(count, Math.ceil(hp / UNITS[type].hp - COUNT_EPSILON));
}

/** Full-strength units. */
export function unitsFromCounts(counts: UnitCounts): Units {
  const units = zeroUnits();
  for (const type of UNIT_TYPES) {
    const count = Math.max(0, Math.floor(counts[type] ?? 0));
    units[type] = { count, hp: count * UNITS[type].hp };
  }
  return units;
}

export function totalHp(units: Units): number {
  let hp = 0;
  for (const type of UNIT_TYPES) hp += units[type].hp;
  return hp;
}

export function totalCount(units: Units): number {
  let count = 0;
  for (const type of UNIT_TYPES) count += units[type].count;
  return count;
}

/** HP at full health for the units still counted. */
export function maxHp(units: Units): number {
  let hp = 0;
  for (const type of UNIT_TYPES) hp += units[type].count * UNITS[type].hp;
  return hp;
}

/** HP expressed as full-strength units: damaged units weigh less in frontage and damage. */
export function unitEquivalents(units: Units): number {
  let ue = 0;
  for (const type of UNIT_TYPES) ue += units[type].hp / UNITS[type].hp;
  return ue;
}

/** The pace of the slowest type present; Oil users slow down during an Oil shortage. 0 for no units. */
export function slowestSpeed(units: Units, oilShort: boolean): number {
  return speedAtOilFactor(units, oilShort ? ECONOMY.OIL_SHORT_SPEED : 1);
}

/** Like slowestSpeed, with an explicit speed factor for Oil users (1 or ECONOMY.OIL_SHORT_SPEED). */
export function speedAtOilFactor(units: Units, oilFactor: number): number {
  let speed = 0;
  for (const type of UNIT_TYPES) {
    if (units[type].count === 0) continue;
    const spec = UNITS[type];
    const own = spec.speedKmh * (spec.usesOil ? oilFactor : 1);
    speed = speed === 0 ? own : Math.min(speed, own);
  }
  return speed;
}

/** The type that sets the pace, or null for no units; ties go to the earlier type. */
export function pacedBy(units: Units, oilShort: boolean): UnitType | null {
  const factor = oilShort ? ECONOMY.OIL_SHORT_SPEED : 1;
  let best: UnitType | null = null;
  let bestSpeed = 0;
  for (const type of UNIT_TYPES) {
    if (units[type].count === 0) continue;
    const spec = UNITS[type];
    const own = spec.speedKmh * (spec.usesOil ? factor : 1);
    if (best === null || own < bestSpeed) {
      best = type;
      bestSpeed = own;
    }
  }
  return best;
}

export function usesOil(units: Units): boolean {
  return UNIT_TYPES.some((type) => UNITS[type].usesOil && units[type].count > 0);
}

/** Share of HP in hard (armoured) pools. */
export function hardShare(units: Units): number {
  let hard = 0;
  let all = 0;
  for (const type of UNIT_TYPES) {
    all += units[type].hp;
    if (UNITS[type].armour === 'hard') hard += units[type].hp;
  }
  return all > 0 ? hard / all : 0;
}

export function addUnits(into: Units, from: Units): void {
  for (const type of UNIT_TYPES) {
    into[type].count += from[type].count;
    into[type].hp += from[type].hp;
  }
}

/**
 * Takes whole units per type (clamped to what is there). HP moves in proportion,
 * so 3 of 5 damaged Rifles take 3/5 of the pool and both parts keep their health.
 */
export function takeUnits(from: Units, take: UnitCounts): Units {
  const taken = zeroUnits();
  for (const type of UNIT_TYPES) {
    const stack = from[type];
    const count = Math.min(stack.count, Math.max(0, Math.floor(take[type] ?? 0)));
    if (count === 0) continue;
    const hp = count === stack.count ? stack.hp : (stack.hp * count) / stack.count;
    taken[type] = { count, hp };
    stack.count -= count;
    stack.hp = stack.count === 0 ? 0 : stack.hp - hp;
  }
  return taken;
}

/** A copy with every HP pool scaled by `share`; counts follow the count rule. */
export function scaleUnits(units: Units, share: number): Units {
  const out = zeroUnits();
  for (const type of UNIT_TYPES) {
    const hp = units[type].hp * share;
    const count = countFor(type, units[type].count, hp);
    out[type] = { count, hp: count === 0 ? 0 : hp };
  }
  return out;
}

/** Removes HP from one pool; below COMBAT.DEAD_HP it is gone, and the count drops to what the HP supports. */
export function losePoolHp(units: Units, type: UnitType, lost: number): void {
  const stack = units[type];
  if (lost <= 0 || stack.count === 0) return;
  const hp = Math.max(0, stack.hp - lost);
  stack.count = countFor(type, stack.count, hp);
  stack.hp = stack.count === 0 ? 0 : hp;
}

/** Removes HP per type; a pool below COMBAT.DEAD_HP is gone, and counts drop to what the HP supports. */
export function applyHpLoss(units: Units, loss: UnitHp): void {
  for (const type of UNIT_TYPES) losePoolHp(units, type, loss[type]);
}

/** Heals every pool by `share` of its full-strength HP, capped at count × unit HP. */
export function heal(units: Units, share: number): void {
  for (const type of UNIT_TYPES) {
    const stack = units[type];
    if (stack.count === 0) continue;
    const cap = stack.count * UNITS[type].hp;
    stack.hp = Math.min(cap, stack.hp + share * cap);
  }
}

/** Upkeep per day: charged by whole units, so a damaged unit costs the same. */
export function upkeepOf(units: Units): Cost {
  const cost: Cost = {};
  for (const type of UNIT_TYPES) {
    const count = units[type].count;
    const upkeep = UNITS[type].upkeep;
    for (const key of STOCK_KEYS) {
      const amount = upkeep[key];
      if (amount === undefined) continue;
      cost[key] = (cost[key] ?? 0) + amount * count;
    }
  }
  return cost;
}

export function isEmpty(units: Units): boolean {
  return UNIT_TYPES.every((type) => units[type].count === 0);
}

/** A deep copy, for forecasts that must not touch the live armies. */
export function copyUnits(units: Units): Units {
  const out = zeroUnits();
  for (const type of UNIT_TYPES) out[type] = { count: units[type].count, hp: units[type].hp };
  return out;
}
