import { describe, expect, it } from 'vitest';
import { AI_TIERS, DIFFICULTY } from '../../balance';
import { hoursToTicks } from '../../clock';
import { dueNations, initialThinkTicks, periodTicks, reviewTiers, scheduleAlert } from '../../ai/scheduler';
import { aiPhase } from '../../ai/think';
import { tinySim } from '../helpers';

/** A row of `count` one-province nations n00..n(count-1), each with `units` Rifles, plus the player. */
function row(count: number, units: (i: number) => number) {
  const provinces: Record<string, { owner: string; population?: number }> = { me: { owner: 'me' } };
  const armies: { owner: string; at: string; units: { rifles: number } }[] = [];
  const edges: [string, string][] = [];
  for (let i = 0; i < count; i += 1) {
    const id = `n${String(i).padStart(2, '0')}`;
    provinces[id] = { owner: id };
    if (units(i) > 0) armies.push({ owner: id, at: id, units: { rifles: units(i) } });
    if (i > 0) edges.push([`n${String(i - 1).padStart(2, '0')}`, id]);
  }
  return tinySim({ provinces, edges, armies });
}

describe('initialThinkTicks', () => {
  it('spreads a tier evenly over one period after the review', () => {
    expect(initialThinkTicks(4, 16, 100)).toEqual([101, 105, 109, 113]);
    expect(initialThinkTicks(3, 12, 0)).toEqual([1, 5, 9]);
    expect(initialThinkTicks(0, 16, 5)).toEqual([]);
  });
});

describe('reviewTiers', () => {
  it('makes the strongest majorCount nations majors and staggers both tiers', () => {
    const count = 30;
    const { sim, n } = row(count, (i) => i);
    for (const nation of sim.state.nations) nation.tier = 'minor';
    sim.state.tick = 960;
    reviewTiers(sim);
    const majors = sim.state.nations.filter((x) => !x.isPlayer && x.tier === 'major').map((x) => x.ix);
    expect(majors).toHaveLength(DIFFICULTY.standard.majorCount);
    // Power grows with the army, so the majors are the last majorCount nations of the row.
    expect(majors).toContain(n('n29'));
    expect(majors).not.toContain(n('n00'));
    const firstThinks = majors.map((m) => sim.state.nations[m]!.ai.nextThink);
    expect(firstThinks).toEqual(initialThinkTicks(majors.length, periodTicks(sim, true), 960));
    expect(sim.state.nations[sim.state.player]!.ai.nextThink).toBe(0);
  });

  it('keeps a sitting major ranked within DEMOTE_RANK_FACTOR × majorCount', () => {
    const count = 40;
    const { sim, n } = row(count, (i) => i);
    // n15 ranks 25th: outside majorCount (20) but inside 1.5 × 20.
    for (const nation of sim.state.nations) nation.tier = 'minor';
    sim.state.nations[n('n15')]!.tier = 'major';
    sim.state.nations[n('n05')]!.tier = 'major';
    reviewTiers(sim);
    expect(sim.state.nations[n('n15')]!.tier).toBe('major');
    expect(sim.state.nations[n('n05')]!.tier).toBe('minor');
  });

  it('never makes more than MAX_MAJORS majors', () => {
    const { sim } = row(50, () => 3);
    for (const nation of sim.state.nations) nation.tier = 'major';
    reviewTiers(sim);
    expect(sim.state.nations.filter((x) => !x.isPlayer && x.tier === 'major').length).toBeLessThanOrEqual(AI_TIERS.MAX_MAJORS);
  });
});

describe('dueNations and the alert think', () => {
  it('runs at most the per-tick caps even when every nation falls due together', () => {
    const { sim } = row(60, () => 1);
    for (const nation of sim.state.nations) nation.tier = nation.ix % 2 === 0 ? 'major' : 'minor';
    const { regular } = dueNations(sim);
    const majors = regular.filter((m) => sim.state.nations[m]!.tier === 'major').length;
    expect(majors).toBeLessThanOrEqual(Math.ceil(AI_TIERS.MAX_MAJORS / periodTicks(sim, true)));
    expect(regular.length - majors).toBeLessThanOrEqual(Math.ceil(sim.state.nations.length / periodTicks(sim, false)));
  });

  it('pulls an alert think an hour later, at most MAX_ALERTS_PER_TICK per tick, and leaves the schedule alone', () => {
    const { sim, n } = row(6, () => 1);
    reviewTiers(sim);
    const ids = ['n00', 'n01', 'n02', 'n03'].map(n);
    const before = ids.map((m) => sim.state.nations[m]!.ai.nextThink);
    for (const m of ids) scheduleAlert(sim, m);
    expect(sim.state.nations[ids[0]!]!.ai.alertAt).toBe(hoursToTicks(AI_TIERS.ALERT_DELAY_HOURS));
    sim.state.tick = hoursToTicks(AI_TIERS.ALERT_DELAY_HOURS);
    // Keep regular thinks out of the way for this tick.
    for (const nation of sim.state.nations) nation.ai.nextThink = Math.max(nation.ai.nextThink, sim.state.tick + 1);
    expect(dueNations(sim).alerts).toEqual(ids.slice(0, AI_TIERS.MAX_ALERTS_PER_TICK));
    aiPhase(sim);
    expect(sim.state.nations[ids[0]!]!.ai.alertAt).toBeNull();
    expect(sim.state.nations[ids[2]!]!.ai.alertAt).not.toBeNull();
    sim.state.tick += 1;
    expect(dueNations(sim).alerts).toEqual(ids.slice(2, 4));
    expect(ids.map((m) => sim.state.nations[m]!.ai.nextThink)).toEqual(before.map((t) => Math.max(t, hoursToTicks(AI_TIERS.ALERT_DELAY_HOURS) + 1)));
  });
});
