import { describe, expect, it } from 'vitest';
import { FEED, SAVE } from '../balance';
import { asNation } from '../ids';
import { deserialize, serialize } from '../save';
import type { GameState, MapStatic } from '../types';
import { tinySim } from './helpers';

const META = { savedAt: 1_760_000_000_000, playedMs: 123_456 };

/** A tiny game with every optional shape filled in. */
function busyGame(): { state: GameState; map: MapStatic } {
  const { sim, p, n, a } = tinySim({
    provinces: {
      paris: { owner: 'me', capitalOf: 'me', buildings: { works: 1, training: 3, ramparts: 1 } },
      lille: { owner: 'me', buildings: { roads: 2, draft: 1 } },
      brussels: { owner: 'be', capitalOf: 'be', terrain: 'urban' },
      bern: { owner: 'me', country: 'ch', stability: 17.25 },
    },
    edges: [
      ['paris', 'lille'],
      ['lille', 'brussels', 120.5],
      ['paris', 'bern', 400, 'sea'],
    ],
    armies: [
      { owner: 'me', at: 'lille', units: { rifles: 3, guns: 1 } },
      { owner: 'be', at: 'brussels', units: { rifles: 2, hunters: 1 }, stance: 'defend' },
      { owner: 'me', at: 'brussels', units: { tanks: 2, motor: 1 }, retreatAt: 0.5 },
    ],
    stocks: { me: { funds: 8544.123456789, recruits: 29_920, food: 564, steel: 153, oil: 120 } },
    seed: 'save-me',
  });
  const { state } = sim;
  state.tick = 1234;
  state.rng = -123_456_789;
  const paris = state.provinces[p('paris')]!;
  paris.construction = { building: 'works', level: 2, hoursLeft: 7.5, hoursTotal: 24, paid: { funds: 900, steel: 60 } };
  paris.queue = [
    { unit: 'tanks', hoursLeft: 3.2, hoursTotal: 10.666666666666666, paid: { funds: 420, recruits: 400, food: 10, steel: 60, oil: 20 }, started: true },
    { unit: 'rifles', hoursLeft: 6, hoursTotal: 6, paid: { funds: 120, recruits: 0 }, started: false },
  ];
  paris.keepTraining = true;
  paris.rally = p('lille');
  const bern = state.provinces[p('bern')]!;
  bern.integrated = true;
  bern.heldSince = 96;
  bern.graceUntil = 600;
  bern.garrison = 12.345;
  const mover = state.armies[0]!;
  mover.leg = { from: p('lille'), to: p('paris'), ticks: 20, done: 7, sea: false };
  mover.path = [p('bern')];
  mover.departAt = 1200;
  mover.intent = 'rally';
  mover.cameFrom = p('brussels');
  mover.units.rifles.hp = 51.123;
  const attacker = state.armies[2]!;
  attacker.battle = { joinedAt: 1100, startHp: 90, direction: p('lille') };
  attacker.landingUntil = 1150;
  attacker.intent = 'attack';
  attacker.stance = 'delegate';
  attacker.orderedAt = 1099;
  const me = state.nations[n('me')]!;
  me.shortage.oil = true;
  me.trade.sellAboveDays.steel = 12;
  me.ai = { nextThink: 1240, alertAt: 1236, provoked: true, operations: [{ target: p('brussels'), armies: [a(2)], launchedAt: 1000 }] };
  state.nations[n('ch')]!.eliminatedAt = 50;
  state.market = { pressure: { food: -1234.5, steel: 0, oil: 3000.25 }, history: [{ food: 0.95, steel: 1, oil: 1.7 }] };
  state.feed = [
    { id: 7, tick: 1230, kind: 'battleStarted', severity: 'bad', text: 'Battle for Brussels', nations: [n('me'), n('be')], province: p('brussels'), army: a(2), count: 2 },
    { id: 6, tick: 1000, kind: 'digest', severity: 'info', text: 'Day 11: +1 province', nations: [n('me')], province: null, army: null, count: 1 },
  ];
  state.nextFeedId = 8;
  state.stats.attacksWon = 3;
  state.stats.unitsTrained.tanks = 4;
  state.stats.largestBattle = { province: p('brussels'), tick: 1200, hp: 321.5 };
  state.stats.fogOff = true;
  state.history = [
    { day: 0, vp: [[n('me'), 5], [n('be'), 4]] },
    { day: 1, vp: [[n('me'), 9], [n('be'), 4]] },
  ];
  state.surrenders = [{ loser: n('ch'), winner: n('me'), tick: 50, provinces: 1, vp: 4, units: 0 }];
  state.status = 'won';
  state.endedAt = 1200;
  state.sandbox = true;
  state.difficulty = 'ruthless';
  return { state, map: sim.map };
}

describe('the save codec', () => {
  it('round-trips a game exactly', () => {
    const { state, map } = busyGame();
    const text = serialize(state, map, META);
    const loaded = deserialize(text, map);
    expect(loaded).not.toBeNull();
    expect(loaded!.meta).toEqual(META);
    expect(loaded!.state).toEqual(state);
    expect(serialize(loaded!.state, map, META)).toBe(text);
  });

  it('writes the same bytes whatever order objects were built in', () => {
    const { state, map } = busyGame();
    const text = serialize(state, map, META);
    const shuffled = structuredClone(state);
    shuffled.nations = shuffled.nations.map((nation) => Object.fromEntries(Object.entries(nation).reverse()) as typeof nation);
    shuffled.stats = Object.fromEntries(Object.entries(shuffled.stats).reverse()) as typeof shuffled.stats;
    expect(serialize(shuffled, map, META)).toBe(text);
  });

  it('stores the documented header and compact provinces', () => {
    const { state, map } = busyGame();
    const file = JSON.parse(serialize(state, map, META)) as { format: number; mapHash: string; state: { provinces: { flags: string; buildings: string } } };
    expect(file.format).toBe(SAVE.FORMAT);
    expect(file.mapHash).toBe(map.hash);
    expect(file.state.provinces.flags).toBe('2001');
    expect(file.state.provinces.buildings).toBe('13100' + '00021' + '00000' + '00000');
  });

  it('keeps FEED.SAVED_ENTRIES feed entries', () => {
    const { state, map } = busyGame();
    const entry = state.feed[1]!;
    state.feed = Array.from({ length: FEED.MAX_ENTRIES }, (_, i) => ({ ...entry, id: FEED.MAX_ENTRIES - i, nations: [...entry.nations] }));
    const loaded = deserialize(serialize(state, map, META), map)!;
    expect(loaded.state.feed).toHaveLength(FEED.SAVED_ENTRIES);
    expect(loaded.state.feed[0]!.id).toBe(FEED.MAX_ENTRIES);
  });

  it('trims the feed, then the history, above the hard cap', () => {
    const { state, map } = busyGame();
    const entry = state.feed[1]!;
    const long = 'x'.repeat(Math.ceil(SAVE.HARD_MAX_BYTES / 100));
    state.feed = Array.from({ length: FEED.SAVED_ENTRIES }, (_, i) => ({ ...entry, id: i + 1, text: long, nations: [...entry.nations] }));
    const trimmed = deserialize(serialize(state, map, META), map)!;
    expect(trimmed.state.feed).toHaveLength(50);
    expect(trimmed.state.history).toHaveLength(2);

    const huge = 'y'.repeat(Math.ceil(SAVE.HARD_MAX_BYTES / 40));
    state.feed = state.feed.map((e) => ({ ...e, text: huge }));
    state.history = Array.from({ length: 9 }, (_, day) => ({ day, vp: [[asNation(0), day]] }));
    const halved = deserialize(serialize(state, map, META), map)!;
    expect(halved.state.history.map((h) => h.day)).toEqual([0, 2, 4, 6, 8]);
  });

  it('rejects another map, another format and malformed text', () => {
    const { state, map } = busyGame();
    const text = serialize(state, map, META);
    expect(deserialize(text, { ...map, hash: 'other' })).toBeNull();
    expect(deserialize(text.replace('"format":5', '"format":4'), map)).toBeNull();
    expect(deserialize(text.slice(0, -10), map)).toBeNull();
    expect(deserialize('null', map)).toBeNull();
    expect(deserialize('[]', map)).toBeNull();
  });

  it('rejects out-of-range indices, bad enum codes and wrong lengths', () => {
    const { state, map } = busyGame();
    const text = serialize(state, map, META);
    const mutate = (edit: (s: Record<string, unknown>) => void): string => {
      const file = JSON.parse(text) as { state: Record<string, unknown> };
      edit(file.state);
      return JSON.stringify(file);
    };
    type Provinces = { owner: number[]; flags: string; rally: number[] };
    const cases: ((s: Record<string, unknown>) => void)[] = [
      (s) => ((s.provinces as Provinces).owner[0] = 99),
      (s) => ((s.provinces as Provinces).owner.length = 3),
      (s) => ((s.provinces as Provinces).flags = '9000'),
      (s) => ((s.provinces as Provinces).rally[1] = 4),
      (s) => ((s.armies as unknown[][])[0]![19] = 7), // post: no such province
      (s) => ((s.armies as unknown[][])[0]![13] = -3), // at
      (s) => ((s.armies as unknown[][])[0] = (s.armies as unknown[][])[0]!.slice(0, 20)),
      (s) => ((s.armies as unknown[][]).reverse()),
      (s) => ((s.feed as { kind: string }[])[0]!.kind = 'turnReport'),
      (s) => ((s.nations as unknown[]).pop()),
      (s) => (s.difficulty = 'easy'),
      (s) => (s.player = 0),
      (s) => (s.nextArmyId = 2),
      (s) => ((s.stats as Record<string, unknown>).attacksWon = 'many'),
    ];
    for (const edit of cases) expect(deserialize(mutate(edit), map), edit.toString()).toBeNull();
  });

  it('keeps a save of a fresh tiny game small', () => {
    const { sim } = tinySim({ provinces: { a: { owner: 'me' }, b: { owner: 'ai' } }, edges: [['a', 'b']] });
    const text = serialize(sim.state, sim.map, META);
    expect(text.length).toBeLessThan(3000);
    expect(deserialize(text, sim.map)!.state).toEqual(sim.state);
  });
});
