import { describe, expect, it } from 'vitest';
import { armyById, rebuildArmyIndex } from '../cache';
import { orderMove } from '../movement';
import { previewOrder } from '../orders';
import { refreshSupply, refreshVision } from '../supply';
import { tinySim } from './helpers';

/**
 * cap (my capital) and two fronts, n and s, facing the foe's t; t has a port
 * across the sea from my harbour; deep lies far behind t.
 */
function front() {
  return tinySim({
    provinces: {
      cap: { owner: 'me', capitalOf: 'me' },
      n: { owner: 'me' },
      s: { owner: 'me' },
      harbour: { owner: 'me' },
      island: { owner: 'me' },
      t: { owner: 'foe', garrison: 60 },
      fc: { owner: 'foe', capitalOf: 'foe' },
      d1: { owner: 'foe' },
      d2: { owner: 'foe' },
      deep: { owner: 'foe' },
    },
    edges: [
      ['cap', 'n', 100],
      ['cap', 's', 300],
      ['cap', 'harbour', 100],
      ['n', 't', 100],
      ['s', 't', 250],
      ['harbour', 't', 20, 'sea'],
      ['t', 'fc'],
      ['fc', 'd1'],
      ['d1', 'd2'],
      ['d2', 'deep'],
    ],
    armies: [
      { owner: 'me', at: 'n', units: { rifles: 8 } },
      { owner: 'me', at: 's', units: { rifles: 6, tanks: 2 } },
      { owner: 'me', at: 'cap', units: { rifles: 3 } },
      { owner: 'me', at: 'harbour', units: { rifles: 4 } },
      { owner: 'foe', at: 'fc', units: { rifles: 2 } },
    ],
    player: 'me',
  });
}

describe('previewOrder', () => {
  it('shows routes, arrival, directions and a forecast, and changes nothing', () => {
    const { sim, a, p, n } = front();
    refreshSupply(sim);
    const before = JSON.stringify(sim.state);
    const preview = previewOrder(sim, n('me'), [a(0), a(1)], p('t'), true);
    expect(JSON.stringify(sim.state)).toBe(before);
    expect(preview.intent).toBe('attack');
    expect(preview.routes.map((r) => r.approach)).toEqual([p('n'), p('s')]);
    expect(preview.directions).toBe(2);
    const arrivals = preview.routes.map((r) => r.departInTicks + r.ticks);
    expect(arrivals[0]).toBe(arrivals[1]);
    expect(preview.arriveInTicks).toBe(arrivals[0]);
    expect(preview.forecast).not.toBeNull();
    expect(preview.forecast!.winner).toBe('attacker');
    expect(preview.forecast!.modifiers.some((m) => m.code === 'flank')).toBe(true);
    expect(preview.warnings).toEqual([]);
  });

  it('a move to own land has no forecast', () => {
    const { sim, a, p, n } = front();
    const preview = previewOrder(sim, n('me'), [a(0)], p('s'), false);
    expect(preview.intent).toBe('move');
    expect(preview.forecast).toBeNull();
    expect(preview.routes[0]!.nodes).toEqual([p('cap'), p('s')]);
  });

  it('warns about staggered arrivals when not arriving together', () => {
    const { sim, a, p, n } = front();
    const preview = previewOrder(sim, n('me'), [a(0), a(1)], p('t'), false);
    expect(preview.warnings).toContain('staggered');
    expect(preview.routes.every((r) => r.departInTicks === 0)).toBe(true);
  });

  it('warns about no route, hostile crossings, landings and missing supply', () => {
    const { sim, a, p, n } = front();
    refreshSupply(sim);
    expect(previewOrder(sim, n('me'), [a(0)], p('island'), false)).toMatchObject({ warnings: ['noRoute'], routes: [], forecast: null });
    const far = previewOrder(sim, n('me'), [a(0)], p('deep'), false);
    expect(far.warnings).toContain('crossesHostile');
    expect(far.warnings).toContain('unsupplied');
    const landing = previewOrder(sim, n('me'), [a(3)], p('t'), false);
    expect(landing.routes[0]!.approach).toBe(p('harbour'));
    expect(landing.warnings).toContain('landing');
  });

  it('warns when the capital is left empty or Oil is short', () => {
    const { sim, a, p, n } = front();
    expect(previewOrder(sim, n('me'), [a(2)], p('n'), false).warnings).toContain('capitalExposed');
    sim.state.nations[n('me')]!.shortage.oil = true;
    expect(previewOrder(sim, n('me'), [a(1)], p('t'), false).warnings).toContain('oilShort');
    expect(previewOrder(sim, n('me'), [a(0)], p('t'), false).warnings).not.toContain('oilShort');
  });

  it('warns about defenders on their way and about leaving a battle', () => {
    const { sim, a, p, n } = front();
    // The foe's army marches into t.
    const result = orderMove(sim, n('foe'), [a(4)], p('t'), false, false);
    expect(result.ok).toBe(true);
    const foe = armyById(sim, a(4))!;
    foe.leg = { from: p('fc'), to: p('t'), ticks: 20, done: 1, sea: false };
    foe.path = [];
    rebuildArmyIndex(sim);
    refreshVision(sim);
    expect(previewOrder(sim, n('me'), [a(0)], p('t'), false).warnings).toContain('reinforcementsInbound');
    const mine = armyById(sim, a(0))!;
    mine.at = p('t');
    mine.battle = { joinedAt: 0, startHp: 160, direction: p('n') };
    rebuildArmyIndex(sim);
    expect(previewOrder(sim, n('me'), [a(0)], p('n'), false).warnings).toContain('leavesBattle');
  });
});
