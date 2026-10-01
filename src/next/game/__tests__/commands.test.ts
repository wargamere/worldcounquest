import { describe, expect, it } from 'vitest';
import { armyById } from '../cache';
import { applyCommand, validateCommand } from '../commands';
import { asArmy, asNation, asProvince } from '../ids';
import type { Command, CommandResult, Sim } from '../types';
import { stateHash, tinySim, type TinySim } from './helpers';

/**
 * me: m0 (capital, Training Ground 3) - m1 - m2 - f1 - f0 (foe's capital), plus m0 - m2.
 * Armies: #0 and #1 in m0, #2 in m1, #3 the foe's in f0, #4 a Delegate army in m2.
 */
function world(): TinySim {
  const rich = { funds: 50_000, recruits: 50_000, food: 5_000, steel: 5_000, oil: 5_000 };
  return tinySim({
    provinces: {
      m0: { owner: 'me', capitalOf: 'me', buildings: { training: 3 } },
      m1: { owner: 'me' },
      m2: { owner: 'me' },
      f1: { owner: 'foe' },
      f0: { owner: 'foe', capitalOf: 'foe' },
    },
    edges: [
      ['m0', 'm1'],
      ['m1', 'm2'],
      ['m0', 'm2'],
      ['m2', 'f1'],
      ['f1', 'f0'],
    ],
    armies: [
      { owner: 'me', at: 'm0', units: { rifles: 4 } },
      { owner: 'me', at: 'm0', units: { rifles: 2, guns: 1 } },
      { owner: 'me', at: 'm1', units: { rifles: 3 } },
      { owner: 'foe', at: 'f0', units: { rifles: 3 } },
      { owner: 'me', at: 'm2', units: { rifles: 2 }, stance: 'delegate' },
    ],
    player: 'me',
    stocks: { me: rich, foe: rich },
  });
}

function rejected(result: CommandResult): string {
  expect(result.ok).toBe(false);
  return result.ok ? '' : result.reason;
}

function accepted(result: CommandResult): readonly number[] {
  expect(result, result.ok ? '' : result.reason).toMatchObject({ ok: true });
  return result.ok ? result.armies : [];
}

describe('who may command', () => {
  it('the player commands only the player nation, the AI never commands it', () => {
    const { sim, n, a, p } = world();
    const move = (nation: number, source: 'player' | 'ai'): CommandResult =>
      applyCommand(sim, { kind: 'move', nation: asNation(nation), armies: [a(3)], to: p('f1'), together: false, append: false }, source);
    expect(rejected(move(n('foe'), 'player'))).toBe('Not your nation');
    expect(rejected(applyCommand(sim, { kind: 'stop', nation: n('me'), armies: [a(0)] }, 'ai'))).toBe('The AI cannot command your nation');
    accepted(move(n('foe'), 'ai'));
  });

  it('the Staff commands only Defend and Delegate armies, and only armies', () => {
    const { sim, n, a, p } = world();
    const me = n('me');
    expect(rejected(applyCommand(sim, { kind: 'stop', nation: me, armies: [a(0)] }, 'staff'))).toBe("1st Army is under your command, not the Staff's");
    expect(rejected(applyCommand(sim, { kind: 'build', nation: me, province: p('m1'), building: 'works' }, 'staff'))).toBe('The Staff only commands armies');
    expect(rejected(applyCommand(sim, { kind: 'stance', nation: me, armies: [a(4)], stance: 'manual' }, 'staff'))).toBe('The Staff only commands armies');
    expect(rejected(applyCommand(sim, { kind: 'stop', nation: n('foe'), armies: [a(3)] }, 'staff'))).toBe('Not your nation');
    accepted(applyCommand(sim, { kind: 'move', nation: me, armies: [a(4)], to: p('m1'), together: false, append: false }, 'staff'));
    // A Staff order leaves the stance alone.
    expect(armyById(sim, a(4))!.stance).toBe('delegate');
  });

  it('a manual order takes a Delegate or Defend army back under the player', () => {
    const { sim, n, a, p } = world();
    const me = n('me');
    accepted(applyCommand(sim, { kind: 'stance', nation: me, armies: [a(2)], stance: 'defend' }, 'player'));
    expect(armyById(sim, a(2))).toMatchObject({ stance: 'defend', post: p('m1') });
    accepted(applyCommand(sim, { kind: 'move', nation: me, armies: [a(2), a(4)], to: p('m0'), together: true, append: false }, 'player'));
    expect(armyById(sim, a(2))).toMatchObject({ stance: 'manual', post: null });
    expect(armyById(sim, a(4))!.stance).toBe('manual');
  });

  it('refuses unknown and dead nations, and everything once the game is over', () => {
    const { sim, n, a } = world();
    expect(rejected(applyCommand(sim, { kind: 'stop', nation: asNation(99), armies: [a(3)] }, 'ai'))).toBe('No such nation');
    sim.state.nations[n('foe')]!.alive = false;
    expect(rejected(applyCommand(sim, { kind: 'stop', nation: n('foe'), armies: [a(3)] }, 'ai'))).toBe('FOE is no longer in the game');
    sim.state.status = 'won';
    expect(rejected(applyCommand(sim, { kind: 'stop', nation: n('me'), armies: [a(0)] }, 'player'))).toBe('The game is over');
    sim.state.sandbox = true;
    accepted(applyCommand(sim, { kind: 'stop', nation: n('me'), armies: [a(0)] }, 'player'));
  });
});

describe('army commands', () => {
  it('move: plans a route, and refuses empty, foreign, missing, frozen and off-map orders', () => {
    const { sim, n, a, p } = world();
    const me = n('me');
    const move = (armies: number[], to: number): CommandResult =>
      applyCommand(sim, { kind: 'move', nation: me, armies: armies.map(asArmy), to: asProvince(to), together: false, append: false }, 'player');
    expect(rejected(move([], p('m1')))).toBe('No armies selected');
    expect(rejected(move([a(3)], p('m1')))).toBe('Not your army');
    expect(rejected(move([999], p('m1')))).toBe('That army no longer exists');
    expect(rejected(move([a(0)], 99))).toBe('No such province');
    armyById(sim, a(2))!.departAt = sim.state.tick + 48;
    expect(rejected(move([a(2)], p('m0')))).toBe('3rd Army cannot move yet');
    expect(accepted(move([a(0)], p('f1')))).toEqual([a(0)]);
    expect(armyById(sim, a(0))!.path).toEqual([p('m2'), p('f1')]);
    expect(armyById(sim, a(0))!.intent).toBe('attack');
  });

  it('move with append adds a waypoint after the current route', () => {
    const { sim, n, a, p } = world();
    const me = n('me');
    accepted(applyCommand(sim, { kind: 'move', nation: me, armies: [a(2)], to: p('m2'), together: false, append: false }, 'player'));
    accepted(applyCommand(sim, { kind: 'move', nation: me, armies: [a(2)], to: p('m0'), together: false, append: true }, 'player'));
    expect(armyById(sim, a(2))!.path).toEqual([p('m2'), p('m0')]);
  });

  it('stop clears the route', () => {
    const { sim, n, a, p } = world();
    const me = n('me');
    accepted(applyCommand(sim, { kind: 'move', nation: me, armies: [a(2)], to: p('m2'), together: false, append: false }, 'player'));
    accepted(applyCommand(sim, { kind: 'stop', nation: me, armies: [a(2)] }, 'player'));
    expect(armyById(sim, a(2))!.path).toEqual([]);
  });

  it('retreat: refused on the move or off the map, otherwise falls back', () => {
    const { sim, n, a, p } = world();
    const me = n('me');
    expect(rejected(applyCommand(sim, { kind: 'retreat', nation: me, armies: [a(2)], to: asProvince(77) }, 'player'))).toBe('No such province');
    armyById(sim, a(2))!.leg = { from: p('m1'), to: p('m2'), ticks: 10, done: 2, sea: false };
    expect(rejected(applyCommand(sim, { kind: 'retreat', nation: me, armies: [a(2)], to: null }, 'player'))).toBe('3rd Army is on the move');
    accepted(applyCommand(sim, { kind: 'retreat', nation: me, armies: [a(0)], to: p('m1') }, 'player'));
    expect(armyById(sim, a(0))).toMatchObject({ path: [p('m1')], intent: 'retreat' });
  });

  it('split: whole units off an idle army only', () => {
    const { sim, n, a, p } = world();
    const me = n('me');
    const split = (army: number, take: Record<string, number>): CommandResult =>
      applyCommand(sim, { kind: 'split', nation: me, army: asArmy(army), take }, 'player');
    expect(rejected(split(a(0), { rifles: 1.5 }))).toBe('Split whole units');
    expect(rejected(split(a(0), { rifles: 5 }))).toBe('Not that many units');
    expect(rejected(split(a(0), {}))).toBe('Pick units to split off');
    expect(rejected(split(a(0), { rifles: 4 }))).toBe('Leave at least one unit behind');
    accepted(applyCommand(sim, { kind: 'move', nation: me, armies: [a(2)], to: p('m2'), together: false, append: false }, 'player'));
    expect(rejected(split(a(2), { rifles: 1 }))).toBe('Only an idle army can split');
    const [kept, created] = accepted(split(a(0), { rifles: 1 }));
    expect(kept).toBe(a(0));
    expect(armyById(sim, asArmy(created!))!.units.rifles.count).toBe(1);
    expect(armyById(sim, a(0))!.units.rifles.count).toBe(3);
  });

  it('merge: two or more idle armies in one province', () => {
    const { sim, n, a } = world();
    const me = n('me');
    const merge = (armies: number[]): CommandResult => applyCommand(sim, { kind: 'merge', nation: me, armies: armies.map(asArmy) }, 'player');
    expect(rejected(merge([a(0)]))).toBe('Pick at least two armies to merge');
    expect(rejected(merge([a(0), a(2)]))).toBe('Only armies in the same province can merge');
    const moving = armyById(sim, a(1))!;
    moving.leg = { from: moving.at, to: asProvince(1), ticks: 8, done: 1, sea: false };
    expect(rejected(merge([a(0), a(1)]))).toBe('2nd Army is on the move');
    moving.leg = null;
    moving.battle = { joinedAt: 0, startHp: 54, direction: null };
    expect(rejected(merge([a(0), a(1)]))).toBe('2nd Army is in a battle');
    moving.battle = null;
    expect(accepted(merge([a(1), a(0)]))).toEqual([a(0)]);
    expect(armyById(sim, a(0))!.units.rifles.count).toBe(6);
    expect(armyById(sim, a(1))).toBeUndefined();
  });

  it('disband, stance and retreat threshold', () => {
    const { sim, n, a } = world();
    const me = n('me');
    accepted(applyCommand(sim, { kind: 'disband', nation: me, army: a(1) }, 'player'));
    expect(armyById(sim, a(1))).toBeUndefined();
    const bad = { kind: 'stance', nation: me, armies: [a(0)], stance: 'berserk' } as unknown as Command;
    expect(rejected(applyCommand(sim, bad, 'player'))).toBe('Unknown stance');
    accepted(applyCommand(sim, { kind: 'stance', nation: me, armies: [a(0)], stance: 'delegate' }, 'player'));
    expect(armyById(sim, a(0))!.stance).toBe('delegate');
    expect(rejected(applyCommand(sim, { kind: 'retreatAt', nation: me, armies: [a(0)], at: 1.2 }, 'player'))).toBe('Retreat threshold must be between 0 and 1');
    accepted(applyCommand(sim, { kind: 'retreatAt', nation: me, armies: [a(0)], at: 0.5 }, 'player'));
    expect(armyById(sim, a(0))!.retreatAt).toBe(0.5);
  });
});

describe('province, economy and market commands', () => {
  it('build and cancel', () => {
    const { sim, n, p } = world();
    const me = n('me');
    expect(rejected(applyCommand(sim, { kind: 'build', nation: me, province: p('f1'), building: 'works' }, 'player'))).toBe('Not your province');
    const unknown = { kind: 'build', nation: me, province: p('m1'), building: 'castle' } as unknown as Command;
    expect(rejected(applyCommand(sim, unknown, 'player'))).toBe('Unknown building');
    expect(rejected(applyCommand(sim, { kind: 'cancelBuild', nation: me, province: p('m1') }, 'player'))).toBe('Nothing is being built');
    accepted(applyCommand(sim, { kind: 'build', nation: me, province: p('m1'), building: 'works' }, 'player'));
    expect(sim.state.provinces[p('m1')]!.construction).toMatchObject({ building: 'works', level: 1 });
    expect(rejected(applyCommand(sim, { kind: 'build', nation: me, province: p('m1'), building: 'roads' }, 'player'))).toBe('Already building Farms');
    accepted(applyCommand(sim, { kind: 'cancelBuild', nation: me, province: p('m1') }, 'player'));
    expect(sim.state.provinces[p('m1')]!.construction).toBeNull();
  });

  it('train, cancel, keep training and rally', () => {
    const { sim, n, p } = world();
    const me = n('me');
    expect(rejected(applyCommand(sim, { kind: 'train', nation: me, province: p('m1'), unit: 'rifles', count: 1 }, 'player'))).toBe('Needs a Training Ground');
    expect(rejected(applyCommand(sim, { kind: 'train', nation: me, province: p('m0'), unit: 'rifles', count: 6 }, 'player'))).toBe('Train 1 to 5 units at a time');
    accepted(applyCommand(sim, { kind: 'train', nation: me, province: p('m0'), unit: 'tanks', count: 2 }, 'player'));
    expect(sim.state.provinces[p('m0')]!.queue).toHaveLength(2);
    expect(rejected(applyCommand(sim, { kind: 'cancelTrain', nation: me, province: p('m0'), index: 4 }, 'player'))).toBe('No such item in the queue');
    accepted(applyCommand(sim, { kind: 'cancelTrain', nation: me, province: p('m0'), index: 1 }, 'player'));
    expect(sim.state.provinces[p('m0')]!.queue).toHaveLength(1);
    expect(rejected(applyCommand(sim, { kind: 'keepTraining', nation: me, province: p('m1'), on: true }, 'player'))).toBe('Needs a Training Ground');
    accepted(applyCommand(sim, { kind: 'keepTraining', nation: me, province: p('m0'), on: true }, 'player'));
    expect(sim.state.provinces[p('m0')]!.keepTraining).toBe(true);
    expect(rejected(applyCommand(sim, { kind: 'rally', nation: me, province: p('m0'), to: p('f1') }, 'player'))).toBe('The rally point must be your province');
    expect(rejected(applyCommand(sim, { kind: 'rally', nation: me, province: p('f1'), to: null }, 'player'))).toBe('Not your province');
    accepted(applyCommand(sim, { kind: 'rally', nation: me, province: p('m0'), to: p('m2') }, 'player'));
    expect(sim.state.provinces[p('m0')]!.rally).toBe(p('m2'));
  });

  it('trade and trade policy', () => {
    const { sim, n } = world();
    const me = n('me');
    const stocks = sim.state.nations[me]!.stocks;
    expect(rejected(applyCommand(sim, { kind: 'trade', nation: me, good: 'oil', amount: 0 }, 'player'))).toBe('Nothing to trade');
    stocks.oil = 300.5;
    expect(rejected(applyCommand(sim, { kind: 'trade', nation: me, good: 'oil', amount: -500 }, 'player'))).toBe('Only 300 Oil in stock');
    stocks.oil = 5_000;
    stocks.funds = 10;
    expect(rejected(applyCommand(sim, { kind: 'trade', nation: me, good: 'oil', amount: 100 }, 'player'))).toMatch(/^Needs .* more Funds$/);
    stocks.funds = 50_000;
    accepted(applyCommand(sim, { kind: 'trade', nation: me, good: 'oil', amount: 100 }, 'player'));
    expect(stocks.oil).toBe(5_100);
    expect(sim.state.market.pressure.oil).toBe(100);
    const policy = { keepDays: { food: 3, steel: 1, oil: 2 }, sellAboveDays: { food: 0, steel: 0, oil: -1 } };
    expect(rejected(applyCommand(sim, { kind: 'tradePolicy', nation: me, policy }, 'player'))).toBe('Days must be 0 or more');
    policy.sellAboveDays.oil = 20;
    accepted(applyCommand(sim, { kind: 'tradePolicy', nation: me, policy }, 'player'));
    expect(sim.state.nations[me]!.trade.sellAboveDays.oil).toBe(20);
  });
});

describe('validation and the command log', () => {
  const sample = (t: TinySim): Command[] => {
    const me = t.n('me');
    return [
      { kind: 'move', nation: me, armies: [t.a(0), t.a(1)], to: t.p('f1'), together: true, append: false },
      { kind: 'split', nation: me, army: t.a(0), take: { rifles: 2 } },
      { kind: 'merge', nation: me, armies: [t.a(0), t.a(1)] },
      { kind: 'build', nation: me, province: t.p('m1'), building: 'ramparts' },
      { kind: 'train', nation: me, province: t.p('m0'), unit: 'rifles', count: 3 },
      { kind: 'trade', nation: me, good: 'food', amount: 200 },
      { kind: 'disband', nation: me, army: t.a(2) },
    ];
  };

  it('validateCommand changes nothing', () => {
    const t = world();
    const before = stateHash(t.sim);
    for (const command of sample(t)) expect(validateCommand(t.sim, command, 'player').ok).toBe(true);
    expect(stateHash(t.sim)).toBe(before);
  });

  it('logs every accepted command, as a copy, with its tick and source; refusals are not logged', () => {
    const t = world();
    const { sim } = t;
    sim.state.tick = 12;
    const armies = [t.a(2)];
    const command: Command = { kind: 'stop', nation: t.n('me'), armies };
    accepted(applyCommand(sim, command, 'player'));
    armies.push(t.a(0));
    rejected(applyCommand(sim, { kind: 'stop', nation: t.n('foe'), armies: [t.a(3)] }, 'player'));
    accepted(applyCommand(sim, { kind: 'stop', nation: t.n('foe'), armies: [t.a(3)] }, 'ai'));
    expect(sim.cache.commandLog).toEqual([
      { tick: 12, source: 'player', command: { kind: 'stop', nation: t.n('me'), armies: [t.a(2)] } },
      { tick: 12, source: 'ai', command: { kind: 'stop', nation: t.n('foe'), armies: [t.a(3)] } },
    ]);
  });

  it('replaying the log on a copy of the start gives the same state', () => {
    const live = world();
    const replay = world();
    for (const command of sample(live)) applyCommand(live.sim, command, 'player');
    for (const entry of live.sim.cache.commandLog!) applyCommand(replay.sim, entry.command, entry.source);
    expect(stateHash(replay.sim)).toBe(stateHash(live.sim));
  });

  it('a sim without recording keeps no log', () => {
    const t = world();
    const sim: Sim = { ...t.sim, cache: { ...t.sim.cache, commandLog: null } };
    accepted(applyCommand(sim, { kind: 'stop', nation: t.n('me'), armies: [t.a(2)] }, 'player'));
    expect(sim.cache.commandLog).toBeNull();
  });
});
