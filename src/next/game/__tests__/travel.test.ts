import { describe, expect, it } from 'vitest';
import { MOVEMENT, UNITS } from '../balance';
import { armyById } from '../cache';
import { armySpeedKmh, edgeTicks, legProgress, legTicks, retimeLeg } from '../travel';
import type { Edge, Leg, Terrain } from '../types';
import { tinySim } from './helpers';

function road(terrain: Terrain, roadsFrom = 0, roadsTo = 0, km = 100) {
  return tinySim({
    provinces: {
      a: { owner: 'me', buildings: { roads: roadsFrom } },
      b: { owner: 'me', terrain, buildings: { roads: roadsTo } },
      c: { owner: 'me' },
    },
    edges: [
      ['a', 'b', km],
      ['b', 'c', km, 'sea'],
    ],
    armies: [{ owner: 'me', at: 'a', units: { rifles: 1, tanks: 1 } }],
  });
}

describe('edgeTicks', () => {
  it('uses the terrain entered: km / (speed × terrain) in whole ticks, rounded up', () => {
    const cases: [Terrain, number][] = [
      ['plains', 20],
      ['urban', 20],
      ['desert', Math.ceil((100 * 4) / (20 * 0.85))],
      ['hills', 25],
      ['mountains', 34],
      ['jungle', 34],
      ['arctic', 34],
    ];
    for (const [terrain, ticks] of cases) {
      const { sim, p } = road(terrain);
      const edge = sim.map.edges[p('a')]!.find((e) => e.to === p('b'))!;
      expect(edgeTicks(sim, p('a'), edge, UNITS.rifles.speedKmh), terrain).toBe(ticks);
    }
  });

  it('adds 25% per Roads level, as the mean of both ends', () => {
    const at = (from: number, to: number): number => {
      const { sim, p } = road('plains', from, to);
      return legTicks(sim, p('a'), p('b'), 100, false, 20);
    };
    expect(at(1, 0)).toBe(Math.ceil(400 / (20 * 1.125)));
    expect(at(0, 1)).toBe(at(1, 0));
    expect(at(1, 1)).toBe(Math.ceil(400 / 25));
    expect(at(2, 2)).toBe(Math.ceil(400 / 30));
  });

  it('crosses the sea at 20 km/h for everyone, with 120 km to embark, capped at 1,440 km', () => {
    const { sim, p } = road('plains', 2, 2);
    const sea: Edge = { to: p('c'), km: 100, sea: true };
    const hours = (100 + MOVEMENT.SEA_EMBARK_KM) / MOVEMENT.SEA_KMH;
    expect(edgeTicks(sim, p('b'), sea, 20)).toBe(hours * 4);
    expect(edgeTicks(sim, p('b'), sea, 36)).toBe(hours * 4);
    expect(edgeTicks(sim, p('b'), { ...sea, km: 3000 }, 20)).toBe((MOVEMENT.SEA_MAX_KM / MOVEMENT.SEA_KMH) * 4);
  });

  it('takes at least one tick', () => {
    const { sim, p } = road('plains');
    expect(legTicks(sim, p('a'), p('b'), 0.1, false, 36)).toBe(1);
  });

  it('follows the Oil shortage through the army speed', () => {
    const { sim, a, n } = road('plains');
    const army = armyById(sim, a(0))!;
    expect(armySpeedKmh(sim, army)).toBe(UNITS.rifles.speedKmh);
    sim.state.nations[n('me')]!.shortage.oil = true;
    expect(armySpeedKmh(sim, army)).toBe(UNITS.tanks.speedKmh / 2);
  });
});

describe('legs', () => {
  it('interpolates without overshooting', () => {
    const leg: Leg = { from: 0 as Leg['from'], to: 1 as Leg['to'], ticks: 4, done: 1, sea: false };
    expect(legProgress(leg, 0)).toBe(0.25);
    expect(legProgress(leg, 0.5)).toBe(0.375);
    expect(legProgress({ ...leg, done: 4 }, 0.9)).toBe(1);
  });

  it('re-times a leg keeping its share covered: done × k, then + ceil(rest × k)', () => {
    const leg: Leg = { from: 0 as Leg['from'], to: 1 as Leg['to'], ticks: 20, done: 5, sea: false };
    retimeLeg(leg, 30, 15);
    expect(leg).toMatchObject({ done: 10, ticks: 10 + 30 });
    retimeLeg(leg, 15, 30);
    expect(leg).toMatchObject({ done: 5, ticks: 5 + 15 });
    expect(leg.done / leg.ticks).toBeCloseTo(5 / 20, 9);
    const odd: Leg = { ...leg, ticks: 12, done: 5 };
    retimeLeg(odd, 30, 15);
    expect(odd).toMatchObject({ done: 10, ticks: 10 + 14 });
    retimeLeg(odd, 30, 30);
    expect(odd).toMatchObject({ done: 10, ticks: 24 });
  });
});
