/**
 * Per-province training queues (§3.5).
 *
 * A province with a Training Ground trains queue[0] while the rest wait; the
 * cost is paid when an item is queued. Progress is one hour per game hour and
 * pauses while contested or during a Funds shortage. Keep training re-queues
 * the last unit when the queue empties; if it cannot be paid for, the item
 * stays at the head unpaid (`paid` is empty) and payment is retried every hour.
 */
import { EFFECTS, PROVINCE, TRAINING, UNITS } from './balance';
import { createArmy, defaultStance, spawnUnits } from './armies';
import { isContested } from './cache';
import { pay, refund, scaleCost, shortfallReason } from './economy';
import { pushFeed } from './feed';
import { asProvince } from './ids';
import { canRally, orderRally } from './movement';
import { statusOf } from './province';
import { recordUnits } from './stats';
import { STOCK_KEYS } from './types';
import { unitsFromCounts } from './units';
import type { ArmyId, CommandResult, Cost, NationIx, ProvinceIx, Sim, TrainingItem, UnitCounts, UnitType } from './types';

const OK: CommandResult = { ok: true, armies: [] };

function ownerCheck(sim: Sim, n: NationIx, p: ProvinceIx): string | null {
  const province = sim.state.provinces[p];
  return province !== undefined && province.owner === n ? null : 'Not your province';
}

/** Game hours to train one unit here now: faster with a better Training Ground, slower off home soil. */
export function trainHours(sim: Sim, p: ProvinceIx, unit: UnitType): number {
  const level = Math.max(1, sim.state.provinces[p]!.buildings.training);
  return UNITS[unit].hours / EFFECTS.TRAINING_SPEED[level - 1]! / PROVINCE.TRAINING[statusOf(sim, p)];
}

export function canTrain(sim: Sim, n: NationIx, p: ProvinceIx, unit: UnitType, count: number): CommandResult {
  if (!Number.isInteger(count) || count < 1 || count > TRAINING.MAX_PER_ORDER) {
    return { ok: false, reason: `Train 1 to ${TRAINING.MAX_PER_ORDER} units at a time` };
  }
  const notOwner = ownerCheck(sim, n, p);
  if (notOwner !== null) return { ok: false, reason: notOwner };
  const province = sim.state.provinces[p]!;
  const level = province.buildings.training;
  if (level === 0) return { ok: false, reason: 'Needs a Training Ground' };
  if (level < UNITS[unit].trainingLevel) return { ok: false, reason: `Needs Training Ground ${UNITS[unit].trainingLevel}` };
  if (isContested(sim, p)) return { ok: false, reason: 'Cannot train during a battle' };
  const free = TRAINING.QUEUE_MAX - province.queue.length;
  if (count > free) return { ok: false, reason: free === 0 ? 'The queue is full' : `Only ${free} queue slots free` };
  const short = shortfallReason(sim.state.nations[n]!.stocks, scaleCost(UNITS[unit].cost, count));
  return short === null ? OK : { ok: false, reason: short };
}

function newItem(sim: Sim, p: ProvinceIx, unit: UnitType, paid: Cost): TrainingItem {
  const hours = trainHours(sim, p, unit);
  return { unit, hoursLeft: hours, hoursTotal: hours, paid, started: false };
}

export function enqueue(sim: Sim, n: NationIx, p: ProvinceIx, unit: UnitType, count: number): CommandResult {
  const check = canTrain(sim, n, p, unit, count);
  if (!check.ok) return check;
  pay(sim, n, scaleCost(UNITS[unit].cost, count));
  const province = sim.state.provinces[p]!;
  // A keep-training repeat still waiting for resources would hold up units just
  // paid for; it costs nothing to drop, and keep training queues it again later.
  province.queue = province.queue.filter((item) => !isUnpaid(item));
  for (let i = 0; i < count; i += 1) province.queue.push(newItem(sim, p, unit, { ...UNITS[unit].cost }));
  return OK;
}

/** Cancelling refunds all of a waiting item and half of the one in training. */
export function cancelQueued(sim: Sim, n: NationIx, p: ProvinceIx, index: number): CommandResult {
  const notOwner = ownerCheck(sim, n, p);
  if (notOwner !== null) return { ok: false, reason: notOwner };
  const queue = sim.state.provinces[p]!.queue;
  const item = Number.isInteger(index) ? queue[index] : undefined;
  if (item === undefined) return { ok: false, reason: 'No such item in the queue' };
  refund(sim, n, item.paid, item.started ? TRAINING.CANCEL_STARTED_REFUND : TRAINING.CANCEL_QUEUED_REFUND);
  queue.splice(index, 1);
  return OK;
}

/** A keep-training item that is still waiting for its resources. */
function isUnpaid(item: TrainingItem): boolean {
  return !item.started && STOCK_KEYS.every((key) => (item.paid[key] ?? 0) === 0);
}

export function setKeepTraining(sim: Sim, n: NationIx, p: ProvinceIx, on: boolean): CommandResult {
  const notOwner = ownerCheck(sim, n, p);
  if (notOwner !== null) return { ok: false, reason: notOwner };
  const province = sim.state.provinces[p]!;
  if (on && province.buildings.training === 0) return { ok: false, reason: 'Needs a Training Ground' };
  province.keepTraining = on;
  // Switching off drops a repeat that was only waiting to be paid for.
  if (!on) province.queue = province.queue.filter((item) => !isUnpaid(item));
  return OK;
}

/** New units from `p` march to `to` (an own province); null or `p` itself clears the rally point. */
export function setRally(sim: Sim, n: NationIx, p: ProvinceIx, to: ProvinceIx | null): CommandResult {
  const notOwner = ownerCheck(sim, n, p);
  if (notOwner !== null) return { ok: false, reason: notOwner };
  if (to !== null && sim.state.provinces[to]?.owner !== n) return { ok: false, reason: 'The rally point must be your province' };
  sim.state.provinces[p]!.rally = to === p ? null : to;
  return OK;
}

/** Units in the queue by type, the one in training included. */
export function queuedAt(sim: Sim, p: ProvinceIx): UnitCounts {
  const out: UnitCounts = {};
  for (const item of sim.state.provinces[p]!.queue) out[item.unit] = (out[item.unit] ?? 0) + 1;
  return out;
}

/** A finished unit joins the idle army here, or marches to the rally point as a new army. */
function deliver(sim: Sim, p: ProvinceIx, unit: UnitType): void {
  const { map, state } = sim;
  const province = state.provinces[p]!;
  const owner = province.owner;
  const nation = state.nations[owner]!;
  const rally = province.rally;
  let armyId: ArmyId;
  if (rally !== null && state.provinces[rally]!.owner === owner && canRally(sim, owner, p, rally)) {
    const army = createArmy(sim, owner, p, unitsFromCounts({ [unit]: 1 }), defaultStance(sim, owner));
    orderRally(sim, army, rally);
    armyId = army.id;
  } else {
    // A rally point lost to the enemy, or cut off from here, is forgotten: the
    // units join the army here instead of each standing alone.
    if (rally !== null && nation.isPlayer) {
      pushFeed(sim, {
        kind: 'routeBlocked',
        severity: 'bad',
        text: `Rally point ${map.provinces[rally]!.name} is cut off: new units stay in ${map.provinces[p]!.name}`,
        nations: [owner],
        province: p,
        army: null,
      });
    }
    province.rally = null;
    armyId = spawnUnits(sim, owner, p, unit, 1).id;
  }
  if (!nation.isPlayer) return;
  recordUnits(sim, 'unitsTrained', unit, 1);
  pushFeed(sim, {
    kind: 'unitsReady',
    severity: 'good',
    text: `${UNITS[unit].name} ready in ${map.provinces[p]!.name}`,
    nations: [owner],
    province: p,
    army: armyId,
  });
}

/** Hourly: advances queue[0] in every province, delivers finished units and repeats under keep training. */
export function progressTraining(sim: Sim): void {
  const { state } = sim;
  for (let i = 0; i < state.provinces.length; i += 1) {
    const province = state.provinces[i]!;
    const head = province.queue[0];
    if (head === undefined) continue;
    const p = asProvince(i);
    const owner = province.owner;
    if (isContested(sim, p) || state.nations[owner]!.shortage.funds) continue;
    if (isUnpaid(head)) {
      const cost = UNITS[head.unit].cost;
      if (!pay(sim, owner, cost)) continue;
      head.paid = { ...cost };
    }
    if (!head.started) {
      // Timed when it starts, so a Training Ground finished meanwhile already counts.
      head.started = true;
      head.hoursTotal = trainHours(sim, p, head.unit);
      head.hoursLeft = head.hoursTotal;
    }
    head.hoursLeft -= 1;
    if (head.hoursLeft > 0) continue;
    province.queue.shift();
    deliver(sim, p, head.unit);
    if (province.queue.length === 0 && province.keepTraining) {
      const cost = UNITS[head.unit].cost;
      province.queue.push(newItem(sim, p, head.unit, pay(sim, owner, cost) ? { ...cost } : {}));
    }
  }
}
