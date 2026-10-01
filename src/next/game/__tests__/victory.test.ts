import { describe, expect, it } from 'vitest';
import { HISTORY, TIME } from '../balance';
import { createCache, setOwner } from '../cache';
import { recordDay } from '../history';
import { recordBattleSize, recordPeaks, recordStat, recordSurrender, recordUnits } from '../stats';
import { asProvince } from '../ids';
import type { NationIx, Sim } from '../types';
import { evaluateStatus, leadingRival, vpOf, vpShare } from '../victory';
import { tinySim } from './helpers';

/** A world of one-VP provinces with a fixed VP total of 20 (goal 10). */
function onePointWorld(owners: readonly string[]) {
  const provinces: Record<string, { owner: string }> = {};
  owners.forEach((owner, i) => {
    provinces[`p${i}`] = { owner };
  });
  const tiny = tinySim({ provinces, edges: [] });
  const map = { ...tiny.sim.map, provinces: tiny.sim.map.provinces.map((p) => ({ ...p, vp: 1 })), totalVp: 20, goalVp: 10 };
  const sim: Sim = { map, state: tiny.sim.state, cache: createCache(map, tiny.sim.state, false) };
  return { ...tiny, sim };
}

const repeat = (owner: string, count: number): string[] => Array<string>(count).fill(owner);

/** me 2, ai 6, far 6, zz 6: nobody at the goal. */
const race = () => onePointWorld([...repeat('me', 2), ...repeat('ai', 6), ...repeat('far', 6), ...repeat('zz', 6)]);

function give(sim: Sim, to: NationIx, from: NationIx, count: number): void {
  let moved = 0;
  sim.state.provinces.forEach((province, i) => {
    if (moved < count && province.owner === from) {
      setOwner(sim, asProvince(i), to);
      moved += 1;
    }
  });
}

describe('VP and the race', () => {
  it('reads VP, shares and the leading rival', () => {
    const { sim, n } = race();
    expect(vpOf(sim, n('me'))).toBe(2);
    expect(vpShare(sim, n('far'))).toBeCloseTo(0.3, 12);
    expect(leadingRival(sim)).toEqual({ nation: n('ai'), vp: 6, share: 0.3 });
    give(sim, n('far'), n('zz'), 1);
    expect(leadingRival(sim)?.nation).toBe(n('far'));
    sim.state.nations[n('far')]!.alive = false;
    expect(leadingRival(sim)?.nation).toBe(n('ai'));
  });

  it('keeps playing below the goal', () => {
    const { sim } = race();
    expect(evaluateStatus(sim)).toBe('playing');
    expect(sim.state.status).toBe('playing');
    expect(sim.state.feed).toEqual([]);
  });

  it('wins at the goal and records the result once', () => {
    const { sim, n } = race();
    give(sim, n('me'), n('zz'), 6);
    give(sim, n('me'), n('ai'), 2);
    expect(vpOf(sim, n('me'))).toBe(10);
    sim.state.tick = 200;
    expect(evaluateStatus(sim)).toBe('won');
    expect(sim.state.status).toBe('won');
    expect(sim.state.endedAt).toBe(200);
    expect(sim.cache.events.statusChanged).toBe(true);
    expect(sim.state.feed[0]).toMatchObject({ kind: 'victory', text: 'Hegemony achieved', severity: 'good' });
    const entries = sim.state.feed.length;
    sim.state.tick = 204;
    expect(evaluateStatus(sim)).toBe('won');
    expect(sim.state.feed.length).toBe(entries);
    expect(sim.state.endedAt).toBe(200);
  });

  it('loses when a rival reaches the goal first', () => {
    const { sim, n } = race();
    give(sim, n('ai'), n('zz'), 4);
    expect(evaluateStatus(sim)).toBe('lost');
    expect(sim.state.feed[0]).toMatchObject({ kind: 'defeat', text: 'AI rules the world', severity: 'critical' });
  });

  it('loses with the last province', () => {
    const { sim, n } = race();
    give(sim, n('zz'), n('me'), 2);
    expect(evaluateStatus(sim)).toBe('lost');
    expect(sim.state.feed[0]!.text).toBe('Your nation has fallen');
  });

  it('checks nothing in the sandbox', () => {
    const { sim, n } = race();
    sim.state.sandbox = true;
    give(sim, n('ai'), n('zz'), 6);
    expect(evaluateStatus(sim)).toBe('playing');
    expect(sim.state.feed).toEqual([]);
  });
});

describe('milestones', () => {
  /** me 1, ai 1, far 1 and a pool of 7 to hand out: every racer starts at 5%. */
  const balanced = () => onePointWorld(['me', 'ai', 'far', ...repeat('pool', 7)]);

  it('announces each share once, when it is crossed', () => {
    const { sim, n } = balanced();
    evaluateStatus(sim);
    expect(sim.state.feed).toEqual([]);
    give(sim, n('ai'), n('pool'), 1); // 10%
    evaluateStatus(sim);
    expect(sim.state.feed.map((e) => e.text)).toEqual(['AI holds 10% of the world']);
    evaluateStatus(sim);
    expect(sim.state.feed).toHaveLength(1);
    sim.state.tick = 100;
    give(sim, n('ai'), n('pool'), 6); // 8 VP: 40%, crossing 20%, 30%, 35% and 40% at once
    evaluateStatus(sim);
    expect(sim.state.feed[0]).toMatchObject({ text: 'AI holds 35% of the world and is closing on the goal', severity: 'critical' });
    expect(sim.state.feed[0]!.nations).toContain(sim.state.player);
    // The three crossings in one hour coalesce into one entry.
    expect(sim.state.feed[1]).toMatchObject({ text: 'AI holds 40% of the world', count: 3 });
  });

  it('gives the player a good-news milestone and no rival warning', () => {
    const { sim, n } = balanced();
    give(sim, n('me'), n('pool'), 7); // 40%
    evaluateStatus(sim);
    expect(sim.state.feed.map((e) => [e.severity, e.text, e.count])).toEqual([['good', 'ME holds 40% of the world', 4]]);
  });

  it('does not repeat past milestones after a reload', () => {
    const { sim, n } = balanced();
    give(sim, n('ai'), n('pool'), 3);
    evaluateStatus(sim);
    const before = sim.state.feed.length;
    expect(before).toBe(1);
    const reloaded: Sim = { map: sim.map, state: sim.state, cache: createCache(sim.map, sim.state, false) };
    evaluateStatus(reloaded);
    expect(reloaded.state.feed.length).toBe(before);
  });
});

describe('stats', () => {
  it('counts events, units, the biggest battle, surrenders and peaks', () => {
    const { sim, n, p } = race();
    recordStat(sim, 'attacksWon', 1);
    recordStat(sim, 'fundsEarned', 250.5);
    recordUnits(sim, 'unitsTrained', 'tanks', 2);
    recordUnits(sim, 'unitsLost', 'rifles', 1);
    recordBattleSize(sim, p('p1'), 300);
    sim.state.tick = 9;
    recordBattleSize(sim, p('p2'), 200);
    recordBattleSize(sim, p('p3'), 400);
    recordSurrender(sim, { loser: n('ai'), winner: n('me'), tick: 9, provinces: 6, vp: 6, units: 10 });
    sim.cache.income[n('me')]!.funds = 1234;
    recordPeaks(sim);
    const s = sim.state.stats;
    expect(s.attacksWon).toBe(1);
    expect(s.fundsEarned).toBe(250.5);
    expect(s.unitsTrained.tanks).toBe(2);
    expect(s.unitsLost.rifles).toBe(1);
    expect(s.largestBattle).toEqual({ province: p('p3'), tick: 9, hp: 400 });
    expect(sim.state.surrenders).toHaveLength(1);
    expect([s.peakVp, s.peakProvinces, s.peakFundsPerDay]).toEqual([2, 2, 1234]);
    give(sim, n('far'), n('me'), 2);
    sim.cache.income[n('me')]!.funds = 0;
    recordPeaks(sim);
    expect([s.peakVp, s.peakProvinces, s.peakFundsPerDay]).toEqual([2, 2, 1234]);
  });
});

describe('history', () => {
  it('records the player first, then the leading rivals', () => {
    const provinces: Record<string, { owner: string }> = { me0: { owner: 'me' } };
    for (let k = 0; k < 13; k += 1) for (let i = 0; i <= k; i += 1) provinces[`r${k}-${i}`] = { owner: `r${String(k).padStart(2, '0')}` };
    const { sim, n } = tinySim({ provinces, edges: [] });
    sim.state.tick = 3 * TIME.TICKS_PER_DAY;
    recordDay(sim);
    const point = sim.state.history[0]!;
    expect(point.day).toBe(3);
    expect(point.vp).toHaveLength(1 + HISTORY.TRACKED_NATIONS);
    expect(point.vp[0]).toEqual([n('me'), sim.cache.vp[n('me')]]);
    expect(point.vp[1]![0]).toBe(n('r12'));
    expect(point.vp.slice(1).map(([, vp]) => vp)).toEqual([...point.vp.slice(1).map(([, vp]) => vp)].sort((a, b) => b - a));
    expect(sim.state.stats.peakProvinces).toBe(1);
    recordDay(sim);
    expect(sim.state.history).toHaveLength(1);
  });

  it('halves the history past HISTORY.MAX_POINTS, keeping the newest day', () => {
    const { sim } = race();
    for (let day = 0; day <= HISTORY.MAX_POINTS; day += 1) {
      sim.state.tick = day * TIME.TICKS_PER_DAY;
      recordDay(sim);
    }
    expect(sim.state.history.length).toBeLessThanOrEqual(HISTORY.MAX_POINTS / 2 + 1);
    expect(sim.state.history[0]!.day).toBe(0);
    expect(sim.state.history[1]!.day).toBe(2);
    expect(sim.state.history.at(-1)!.day).toBe(HISTORY.MAX_POINTS);
  });
});
