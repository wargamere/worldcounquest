import { describe, expect, it } from 'vitest';
import { EFFECTS, PROVINCE, TRAINING, UNITS } from '../balance';
import { armiesAt, setOwner } from '../cache';
import {
  canTrain,
  cancelQueued,
  enqueue,
  progressTraining,
  queuedAt,
  setKeepTraining,
  setRally,
  trainHours,
} from '../training';
import type { Sim, Stocks } from '../types';
import type { TinyArmy, TinyProvince } from './helpers';
import { tinySim } from './helpers';

const RICH: Partial<Stocks> = { funds: 100_000, recruits: 100_000, food: 10_000, steel: 10_000, oil: 10_000 };

function world(options: { stocks?: Partial<Stocks>; armies?: TinyArmy[]; tg?: number; extra?: Record<string, TinyProvince> } = {}) {
  return tinySim({
    provinces: {
      base: { owner: 'me', buildings: { training: options.tg ?? 1 } },
      side: { owner: 'me' },
      occ: { owner: 'me', country: 'foe', buildings: { training: 1 } },
      fc: { owner: 'foe' },
      ...options.extra,
    },
    edges: [
      ['base', 'side'],
      ['base', 'occ'],
      ['occ', 'fc'],
    ],
    armies: options.armies ?? [],
    stocks: { me: options.stocks ?? RICH },
  });
}

function hours(sim: Sim, count: number): void {
  for (let i = 0; i < count; i += 1) progressTraining(sim);
}

describe('training time', () => {
  it('is UNITS hours / Training Ground speed / status speed', () => {
    for (const level of [1, 2, 3]) {
      const { sim, p } = world({ tg: level });
      expect(trainHours(sim, p('base'), 'rifles')).toBeCloseTo(UNITS.rifles.hours / EFFECTS.TRAINING_SPEED[level - 1]!, 12);
    }
    const { sim, p } = world();
    expect(trainHours(sim, p('occ'), 'rifles')).toBe(UNITS.rifles.hours / PROVINCE.TRAINING.occupied);
    sim.state.provinces[p('occ')]!.integrated = true;
    expect(trainHours(sim, p('occ'), 'rifles')).toBe(UNITS.rifles.hours / PROVINCE.TRAINING.integrated);
  });
});

describe('queueing', () => {
  it('gates units by Training Ground level', () => {
    const { sim, p, n } = world();
    const me = n('me');
    expect(canTrain(sim, me, p('side'), 'rifles', 1)).toEqual({ ok: false, reason: 'Needs a Training Ground' });
    expect(canTrain(sim, me, p('base'), 'hunters', 1).ok).toBe(true);
    expect(canTrain(sim, me, p('base'), 'motor', 1)).toEqual({ ok: false, reason: 'Needs Training Ground 2' });
    sim.state.provinces[p('base')]!.buildings.training = 2;
    expect(canTrain(sim, me, p('base'), 'guns', 1).ok).toBe(true);
    expect(canTrain(sim, me, p('base'), 'tanks', 1)).toEqual({ ok: false, reason: 'Needs Training Ground 3' });
    sim.state.provinces[p('base')]!.buildings.training = 3;
    expect(canTrain(sim, me, p('base'), 'tanks', 1).ok).toBe(true);
  });

  it('refuses bad counts, full queues, foreign or contested provinces and what cannot be paid', () => {
    const { sim, p, n } = world({ stocks: { funds: 1000, recruits: 3000, food: 100 } });
    const me = n('me');
    expect(canTrain(sim, me, p('base'), 'rifles', 0).ok).toBe(false);
    expect(canTrain(sim, me, p('base'), 'rifles', TRAINING.MAX_PER_ORDER + 1)).toEqual({ ok: false, reason: 'Train 1 to 5 units at a time' });
    expect(canTrain(sim, me, p('base'), 'rifles', 1.5).ok).toBe(false);
    expect(canTrain(sim, me, p('fc'), 'rifles', 1)).toEqual({ ok: false, reason: 'Not your province' });
    expect(canTrain(sim, me, p('base'), 'rifles', 4)).toEqual({ ok: false, reason: 'Needs 1,000 more Recruits' });
    expect(canTrain(sim, me, p('base'), 'hunters', 1)).toEqual({ ok: false, reason: 'Needs 20 more Steel' });
    expect(enqueue(sim, me, p('base'), 'rifles', 3).ok).toBe(true);
    sim.state.nations[me]!.stocks = { ...sim.state.nations[me]!.stocks, ...RICH };
    expect(canTrain(sim, me, p('base'), 'rifles', 3)).toEqual({ ok: false, reason: 'Only 2 queue slots free' });
    enqueue(sim, me, p('base'), 'rifles', 2);
    expect(canTrain(sim, me, p('base'), 'rifles', 1)).toEqual({ ok: false, reason: 'The queue is full' });

    const contested = world({ armies: [{ owner: 'foe', at: 'base', units: { rifles: 1 } }] });
    expect(canTrain(contested.sim, contested.n('me'), contested.p('base'), 'rifles', 1)).toEqual({ ok: false, reason: 'Cannot train during a battle' });
  });

  it('pays the whole cost when queued, and cancelling refunds 100% queued and 50% in training', () => {
    const { sim, p, n } = world();
    const me = sim.state.nations[n('me')]!;
    enqueue(sim, n('me'), p('base'), 'hunters', 3);
    expect(me.stocks).toMatchObject({ funds: 100_000 - 540, recruits: 100_000 - 1800, food: 10_000 - 45, steel: 10_000 - 60 });
    expect(queuedAt(sim, p('base'))).toEqual({ hunters: 3 });
    hours(sim, 1);
    expect(sim.state.provinces[p('base')]!.queue.map((q) => q.started)).toEqual([true, false, false]);
    expect(cancelQueued(sim, n('me'), p('base'), 2).ok).toBe(true);
    expect(me.stocks.funds).toBe(100_000 - 360);
    expect(cancelQueued(sim, n('me'), p('base'), 0).ok).toBe(true);
    expect(me.stocks.funds).toBe(100_000 - 180 - 180 * TRAINING.CANCEL_STARTED_REFUND);
    expect(me.stocks.recruits).toBe(100_000 - 600 - 600 * TRAINING.CANCEL_STARTED_REFUND);
    expect(cancelQueued(sim, n('me'), p('base'), 5)).toEqual({ ok: false, reason: 'No such item in the queue' });
    expect(queuedAt(sim, p('base'))).toEqual({ hunters: 1 });
  });
});

describe('progress', () => {
  it('trains one unit at a time and merges it into the idle army standing there', () => {
    const { sim, p, n, a } = world({ armies: [{ owner: 'me', at: 'base', units: { rifles: 2 } }] });
    enqueue(sim, n('me'), p('base'), 'rifles', 2);
    hours(sim, UNITS.rifles.hours - 1);
    expect(sim.state.armies[0]!.units.rifles.count).toBe(2);
    hours(sim, 1);
    expect(sim.state.armies[0]!.units.rifles).toEqual({ count: 3, hp: 60 });
    expect(sim.state.armies[0]!.id).toBe(a(0));
    expect(sim.state.provinces[p('base')]!.queue).toHaveLength(1);
    expect(sim.state.stats.unitsTrained.rifles).toBe(1);
    expect(sim.state.feed[0]).toMatchObject({ kind: 'unitsReady', text: 'Rifles ready in BASE', province: p('base'), army: a(0) });
    hours(sim, UNITS.rifles.hours);
    expect(sim.state.armies[0]!.units.rifles.count).toBe(4);
    // The second one coalesced into the first entry.
    expect(sim.state.feed[0]!.count).toBe(2);
  });

  it('forms a new army when no idle army stands there', () => {
    const { sim, p, n } = world();
    enqueue(sim, n('me'), p('base'), 'rifles', 1);
    hours(sim, UNITS.rifles.hours);
    const here = armiesAt(sim, p('base'));
    expect(here).toHaveLength(1);
    expect(here[0]!.units.rifles).toEqual({ count: 1, hp: UNITS.rifles.hp });
    expect(here[0]!.owner).toBe(n('me'));
  });

  it('pauses while contested or short of Funds', () => {
    const { sim, p, n } = world({ armies: [{ owner: 'foe', at: 'occ', units: { rifles: 1 } }] });
    enqueue(sim, n('me'), p('base'), 'rifles', 1);
    sim.state.provinces[p('occ')]!.queue.push({ unit: 'rifles', hoursLeft: 12, hoursTotal: 12, paid: { ...UNITS.rifles.cost }, started: false });
    hours(sim, 3);
    expect(sim.state.provinces[p('occ')]!.queue[0]).toMatchObject({ hoursLeft: 12, started: false });
    expect(sim.state.provinces[p('base')]!.queue[0]!.hoursLeft).toBe(3);
    sim.state.nations[n('me')]!.shortage.funds = true;
    hours(sim, 3);
    expect(sim.state.provinces[p('base')]!.queue[0]!.hoursLeft).toBe(3);
  });

  it('times an item when it starts, so a Training Ground finished meanwhile counts', () => {
    const { sim, p, n } = world();
    enqueue(sim, n('me'), p('base'), 'rifles', 1);
    sim.state.provinces[p('base')]!.buildings.training = 3;
    hours(sim, 1);
    expect(sim.state.provinces[p('base')]!.queue[0]).toMatchObject({ hoursTotal: UNITS.rifles.hours / EFFECTS.TRAINING_SPEED[2]!, started: true });
  });
});

describe('keep training', () => {
  it('re-queues the last unit when affordable', () => {
    const { sim, p, n } = world();
    expect(setKeepTraining(sim, n('me'), p('base'), true).ok).toBe(true);
    enqueue(sim, n('me'), p('base'), 'rifles', 1);
    hours(sim, UNITS.rifles.hours);
    const queue = sim.state.provinces[p('base')]!.queue;
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ unit: 'rifles', paid: UNITS.rifles.cost, started: false });
    expect(sim.state.nations[n('me')]!.stocks.funds).toBe(100_000 - 2 * UNITS.rifles.cost.funds!);
  });

  it('waits for resources, retrying every hour, then trains again', () => {
    const cost = UNITS.hunters.cost;
    const { sim, p, n } = world({ stocks: { funds: 1000, recruits: 5000, food: 100, steel: cost.steel! } });
    setKeepTraining(sim, n('me'), p('base'), true);
    enqueue(sim, n('me'), p('base'), 'hunters', 1);
    hours(sim, UNITS.hunters.hours);
    const queue = sim.state.provinces[p('base')]!.queue;
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ unit: 'hunters', paid: {}, started: false });
    const me = sim.state.nations[n('me')]!;
    const funds = me.stocks.funds;
    hours(sim, 5);
    expect(me.stocks.funds).toBe(funds);
    expect(queue[0]!.started).toBe(false);
    // Nothing refunded for an item that was never paid for.
    me.stocks.steel = cost.steel!;
    hours(sim, 1);
    expect(queue[0]).toMatchObject({ paid: cost, started: true });
    expect(me.stocks.funds).toBe(funds - cost.funds!);
    expect(me.stocks.steel).toBe(0);
  });

  it('drops the waiting repeat when switched off', () => {
    const { sim, p, n } = world({ stocks: { funds: 150, recruits: 5000, food: 100 } });
    setKeepTraining(sim, n('me'), p('base'), true);
    enqueue(sim, n('me'), p('base'), 'rifles', 1);
    hours(sim, UNITS.rifles.hours);
    expect(sim.state.provinces[p('base')]!.queue).toHaveLength(1);
    setKeepTraining(sim, n('me'), p('base'), false);
    expect(sim.state.provinces[p('base')]!.queue).toEqual([]);
    expect(setKeepTraining(sim, n('me'), p('side'), true)).toEqual({ ok: false, reason: 'Needs a Training Ground' });
  });
});

describe('rally point', () => {
  it('sends each new unit as its own army to the rally province', () => {
    const { sim, p, n } = world({ armies: [{ owner: 'me', at: 'base', units: { rifles: 2 } }] });
    expect(setRally(sim, n('me'), p('base'), p('side')).ok).toBe(true);
    enqueue(sim, n('me'), p('base'), 'rifles', 1);
    hours(sim, UNITS.rifles.hours);
    expect(sim.state.armies[0]!.units.rifles.count).toBe(2);
    const rallied = sim.state.armies[1]!;
    expect(rallied.units.rifles.count).toBe(1);
    expect(rallied.intent).toBe('rally');
    expect([...rallied.path, rallied.leg?.to]).toContain(p('side'));
  });

  it('must be an own province; the province itself clears it; a lost one is forgotten', () => {
    const { sim, p, n } = world();
    expect(setRally(sim, n('me'), p('base'), p('fc'))).toEqual({ ok: false, reason: 'The rally point must be your province' });
    setRally(sim, n('me'), p('base'), p('side'));
    setRally(sim, n('me'), p('base'), p('base'));
    expect(sim.state.provinces[p('base')]!.rally).toBeNull();
    setRally(sim, n('me'), p('base'), p('occ'));
    setOwner(sim, p('occ'), n('foe'));
    enqueue(sim, n('me'), p('base'), 'rifles', 1);
    hours(sim, UNITS.rifles.hours);
    expect(sim.state.provinces[p('base')]!.rally).toBeNull();
    expect(armiesAt(sim, p('base'))).toHaveLength(1);
  });
});
