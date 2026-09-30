import { describe, expect, it } from 'vitest';
import { BUILDINGS, EFFECTS, MARKET } from '../balance';
import {
  bestProvincesFor,
  buildCost,
  buildHours,
  buildingLabel,
  buildingPreview,
  canBuild,
  cancelConstruction,
  damageOnCapture,
  progressConstruction,
  startConstruction,
} from '../buildings';
import { unitPrice } from '../market';
import { BUILDING_TYPES } from '../types';
import type { Stocks } from '../types';
import type { TinyArmy, TinyProvince } from './helpers';
import { tinySim } from './helpers';

const RICH: Partial<Stocks> = { funds: 100_000, steel: 10_000 };

function world(options: { stocks?: Partial<Stocks>; armies?: TinyArmy[]; extra?: Record<string, TinyProvince> } = {}) {
  return tinySim({
    provinces: {
      mc: { owner: 'me', capitalOf: 'me', terrain: 'mountains' },
      big: { owner: 'me', terrain: 'urban', population: 6_000_000 },
      farm: { owner: 'me' },
      occ: { owner: 'me', country: 'foe' },
      fc: { owner: 'foe', capitalOf: 'foe' },
      ...options.extra,
    },
    edges: [
      ['mc', 'big'],
      ['mc', 'farm'],
      ['mc', 'occ'],
      ['occ', 'fc'],
    ],
    armies: options.armies ?? [],
    stocks: { me: options.stocks ?? RICH },
  });
}

function hours(sim: Parameters<typeof progressConstruction>[0], count: number): void {
  for (let i = 0; i < count; i += 1) progressConstruction(sim);
}

describe('costs and hours', () => {
  it('follow the table per level', () => {
    expect([1, 2, 3].map((l) => buildCost('works', l))).toEqual([
      { funds: 400, steel: 30 },
      { funds: 900, steel: 60 },
      { funds: 1800, steel: 120 },
    ]);
    expect([1, 2, 3].map((l) => buildHours('works', l))).toEqual([12, 24, 48]);
    expect([1, 2].map((l) => buildCost('roads', l))).toEqual([
      { funds: 300, steel: 40 },
      { funds: 700, steel: 100 },
    ]);
    expect(buildHours('training', 3)).toBe(36);
    expect(() => buildCost('draft', 3)).toThrow(RangeError);
    // A copy: changing it does not change the table.
    buildCost('works', 1).funds = 1;
    expect(BUILDINGS.works.levels[0]!.cost.funds).toBe(400);
  });

  it('names Works after the good', () => {
    expect(buildingLabel('works', 'food')).toBe('Farms');
    expect(buildingLabel('works', 'steel')).toBe('Mines');
    expect(buildingLabel('works', 'oil')).toBe('Oil Wells');
    expect(buildingLabel('draft', 'oil')).toBe('Draft Office');
  });
});

describe('construction', () => {
  it('pays up front, takes its hours, then raises the level and marks income', () => {
    const { sim, p, n } = world();
    const me = sim.state.nations[n('me')]!;
    expect(startConstruction(sim, n('me'), p('farm'), 'works')).toEqual({ ok: true, armies: [] });
    expect(me.stocks).toMatchObject({ funds: 100_000 - 400, steel: 10_000 - 30 });
    expect(sim.state.provinces[p('farm')]!.construction).toMatchObject({ building: 'works', level: 1, hoursLeft: 12, hoursTotal: 12 });
    sim.cache.incomeDirty[n('me')] = false;
    hours(sim, 11);
    expect(sim.state.provinces[p('farm')]!.buildings.works).toBe(0);
    expect(sim.cache.incomeDirty[n('me')]).toBe(false);
    hours(sim, 1);
    expect(sim.state.provinces[p('farm')]!.buildings.works).toBe(1);
    expect(sim.state.provinces[p('farm')]!.construction).toBeNull();
    expect(sim.cache.incomeDirty[n('me')]).toBe(true);
    expect(sim.state.feed[0]).toMatchObject({ kind: 'constructionDone', text: 'Farms 1 completed in FARM', province: p('farm') });
  });

  it('allows one construction per province and stops at the top level', () => {
    const { sim, p, n } = world();
    startConstruction(sim, n('me'), p('farm'), 'works');
    expect(canBuild(sim, n('me'), p('farm'), 'ramparts')).toEqual({ ok: false, reason: 'Already building Farms' });
    expect(canBuild(sim, n('me'), p('big'), 'ramparts').ok).toBe(true);
    sim.state.provinces[p('big')]!.buildings.roads = 2;
    expect(canBuild(sim, n('me'), p('big'), 'roads')).toEqual({ ok: false, reason: 'Roads is fully built' });
  });

  it('keeps the Draft Office to home and integrated provinces', () => {
    const { sim, p, n } = world();
    expect(canBuild(sim, n('me'), p('occ'), 'draft')).toEqual({ ok: false, reason: 'Home provinces only' });
    expect(canBuild(sim, n('me'), p('occ'), 'works').ok).toBe(true);
    sim.state.provinces[p('occ')]!.integrated = true;
    expect(canBuild(sim, n('me'), p('occ'), 'draft').ok).toBe(true);
  });

  it('refuses foreign, contested and unaffordable builds', () => {
    const contested = world({ armies: [{ owner: 'foe', at: 'farm', units: { rifles: 1 } }] });
    expect(canBuild(contested.sim, contested.n('me'), contested.p('farm'), 'works')).toEqual({ ok: false, reason: 'Cannot build during a battle' });
    expect(canBuild(contested.sim, contested.n('me'), contested.p('fc'), 'works')).toEqual({ ok: false, reason: 'Not your province' });
    const poor = world({ stocks: { funds: 1000, steel: 10 } });
    expect(canBuild(poor.sim, poor.n('me'), poor.p('farm'), 'works')).toEqual({ ok: false, reason: 'Needs 20 more Steel' });
    expect(startConstruction(poor.sim, poor.n('me'), poor.p('farm'), 'works').ok).toBe(false);
    expect(poor.sim.state.nations[poor.n('me')]!.stocks.funds).toBe(1000);
  });

  it('refunds 50% on cancel', () => {
    const { sim, p, n } = world();
    startConstruction(sim, n('me'), p('farm'), 'ramparts');
    expect(cancelConstruction(sim, n('me'), p('farm')).ok).toBe(true);
    expect(sim.state.nations[n('me')]!.stocks).toMatchObject({ funds: 100_000 - 250 * EFFECTS.CONSTRUCTION_CANCEL_REFUND, steel: 10_000 - 40 * EFFECTS.CONSTRUCTION_CANCEL_REFUND });
    expect(sim.state.provinces[p('farm')]!.construction).toBeNull();
    expect(cancelConstruction(sim, n('me'), p('farm'))).toEqual({ ok: false, reason: 'Nothing is being built' });
  });

  it('pauses while contested or short of Funds', () => {
    const { sim, p, n } = world({ armies: [{ owner: 'foe', at: 'farm', units: { rifles: 1 } }] });
    // Started before the battle: put it in place directly.
    sim.state.provinces[p('farm')]!.construction = { building: 'works', level: 1, hoursLeft: 12, hoursTotal: 12, paid: buildCost('works', 1) };
    startConstruction(sim, n('me'), p('big'), 'works');
    hours(sim, 5);
    expect(sim.state.provinces[p('farm')]!.construction!.hoursLeft).toBe(12);
    expect(sim.state.provinces[p('big')]!.construction!.hoursLeft).toBe(7);
    sim.state.nations[n('me')]!.shortage.funds = true;
    hours(sim, 5);
    expect(sim.state.provinces[p('big')]!.construction!.hoursLeft).toBe(7);
  });
});

describe('capture damage', () => {
  it('takes one level of Works and Ramparts and nothing else', () => {
    const { sim, p } = world();
    const province = sim.state.provinces[p('big')]!;
    province.buildings = { works: 2, training: 2, ramparts: 1, roads: 1, draft: 1 };
    damageOnCapture(sim, p('big'));
    expect(province.buildings).toEqual({ works: 1, training: 2, ramparts: 0, roads: 1, draft: 1 });
    damageOnCapture(sim, p('big'));
    expect(province.buildings).toEqual({ works: 0, training: 2, ramparts: 0, roads: 1, draft: 1 });
  });
});

describe('preview and ranking', () => {
  it('shows the gain and payback at current Exchange prices for Works', () => {
    const { sim, p, n } = world();
    const fact = sim.map.provinces[p('farm')]!;
    const preview = buildingPreview(sim, n('me'), p('farm'), 'works');
    expect(preview.level).toBe(1);
    expect(preview.cost).toEqual({ funds: 400, steel: 30 });
    expect(preview.hours).toBe(12);
    expect(preview.deltaPerDay.funds).toBeCloseTo(fact.fundsBase * EFFECTS.WORKS_FUNDS_PER_LEVEL, 12);
    expect(preview.deltaPerDay.food).toBeCloseTo(fact.goodsBase * EFFECTS.WORKS_GOODS_PER_LEVEL, 12);
    const price = (good: 'food' | 'steel') => unitPrice(sim.state.market, good);
    const payback = (400 + 30 * price('steel')) / (preview.deltaPerDay.funds + preview.deltaPerDay.food * price('food'));
    expect(preview.paybackDays).toBeCloseTo(payback, 9);
    expect(preview.reason).toBeNull();
    // Dearer Food makes Farms pay back sooner.
    sim.state.market.pressure.food = MARKET.DEPTH.food;
    expect(buildingPreview(sim, n('me'), p('farm'), 'works').paybackDays!).toBeLessThan(payback);
  });

  it('shows Recruits for a Draft Office, no payback for other buildings, and the reason a build is blocked', () => {
    const { sim, p, n } = world({ stocks: { funds: 10, steel: 0 } });
    const draft = buildingPreview(sim, n('me'), p('farm'), 'draft');
    expect(draft.deltaPerDay.recruits).toBeCloseTo(sim.map.provinces[p('farm')]!.recruitsBase * EFFECTS.DRAFT_RECRUITS_PER_LEVEL, 9);
    expect(draft.paybackDays).toBeNull();
    expect(draft.reason).toBe('Needs 390 more Funds');
    const ramparts = buildingPreview(sim, n('me'), p('farm'), 'ramparts');
    expect(ramparts.deltaPerDay).toEqual({ funds: 0, recruits: 0, food: 0, steel: 0, oil: 0 });
    expect(ramparts.paybackDays).toBeNull();
    sim.state.provinces[p('farm')]!.buildings.ramparts = 3;
    expect(buildingPreview(sim, n('me'), p('farm'), 'ramparts')).toMatchObject({ level: 3, cost: {}, hours: 0, reason: 'Ramparts is fully built' });
  });

  it('ranks by daily gain per Funds, then population, then index, skipping provinces that cannot build', () => {
    const { sim, p, n } = world();
    const works = bestProvincesFor(sim, n('me'), 'works', 10);
    const scores = works.map(({ preview }) => {
      const gain = preview.deltaPerDay.funds + preview.deltaPerDay.food * 2 + preview.deltaPerDay.steel * 5;
      return gain / ((preview.cost.funds ?? 0) + (preview.cost.steel ?? 0) * 5);
    });
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    expect(works.map((w) => w.province)).toContain(p('occ'));
    expect(works[0]!.province).toBe(p('big'));
    expect(bestProvincesFor(sim, n('me'), 'works', 2)).toHaveLength(2);

    startConstruction(sim, n('me'), p('big'), 'ramparts');
    expect(bestProvincesFor(sim, n('me'), 'works', 10).map((w) => w.province)).not.toContain(p('big'));
    // Nothing to gain from Ramparts: the most populous first, then by index.
    expect(bestProvincesFor(sim, n('me'), 'ramparts', 10).map((w) => w.province)).toEqual([p('mc'), p('farm'), p('occ')]);
    expect(bestProvincesFor(sim, n('me'), 'draft', 10).map((w) => w.province)).not.toContain(p('occ'));
  });
});

describe('every building type', () => {
  it('can be built to its top level on home soil', () => {
    const { sim, p, n } = world();
    for (const b of BUILDING_TYPES) {
      for (let level = 1; level <= BUILDINGS[b].levels.length; level += 1) {
        expect(startConstruction(sim, n('me'), p('farm'), b).ok, `${b} ${level}`).toBe(true);
        hours(sim, buildHours(b, level));
        expect(sim.state.provinces[p('farm')]!.buildings[b]).toBe(level);
      }
    }
  });
});
