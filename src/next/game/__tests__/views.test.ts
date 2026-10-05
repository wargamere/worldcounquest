import { describe, expect, it } from 'vitest';
import { armiesOf, ownedProvinces } from '../cache';
import { advise } from '../ai/advisor';
import { previewOrder } from '../orders';
import { STOCK_KEYS } from '../types';
import type { ProvinceIx, Sim } from '../types';
import {
  armyLocation,
  armyRows,
  armyView,
  bestBuildView,
  coachHints,
  attackWithView,
  battleView,
  constructionsView,
  economyView,
  endDetails,
  endView,
  exchangeView,
  historyView,
  hudView,
  idleArmies,
  incomingArmies,
  nationSummary,
  orderView,
  playerBattles,
  productionView,
  provinceView,
  standingsView,
  stockView,
  suggestionText,
  tooltipView,
  tradeOptions,
} from '../views';
import { deepFreeze, realSim, runHours, stateHash, tinySim } from './helpers';

/** Hostile provinces next to the player's land, ascending. */
function frontier(sim: Sim): ProvinceIx[] {
  const { map, state } = sim;
  const out = new Set<ProvinceIx>();
  for (const p of ownedProvinces(sim, state.player)) for (const e of map.edges[p]!) if (state.provinces[e.to]!.owner !== state.player) out.add(e.to);
  return [...out].sort((a, b) => a - b);
}

/** Runs every view over the whole world; the state is frozen, so any write throws. */
function everyView(sim: Sim): void {
  const before = stateHash(sim);
  deepFreeze(sim.state);
  const { map, state } = sim;
  const hud = hudView(sim, false);
  expect(hud.chips.map((c) => c.key)).toEqual([...STOCK_KEYS]);
  expect(hud.goalVp).toBe(map.goalVp);
  expect(hudView(sim, true).incoming).toBeGreaterThanOrEqual(hud.incoming);
  for (const key of STOCK_KEYS) expect(stockView(sim, key).key).toBe(key);
  for (let i = 0; i < map.provinces.length; i += 1) {
    const p = map.provinces[i]!.ix;
    const view = provinceView(sim, p);
    expect(view.buildings).toHaveLength(5);
    expect(view.garrison).toBeLessThanOrEqual(view.garrisonCap + 1e-9);
    expect(tooltipView(sim, p, true).visibleUnits).toBeGreaterThanOrEqual(tooltipView(sim, p, false).visibleUnits);
  }
  for (const army of state.armies) expect(armyView(sim, [army.id])?.ids).toEqual([army.id]);
  const mine = armiesOf(sim, state.player).map((a) => a.id);
  expect(armyView(sim, mine)?.ids).toEqual(mine);
  for (const p of sim.cache.battles) expect(battleView(sim, p)?.province).toBe(p);
  for (const target of frontier(sim).slice(0, 3)) {
    const rows = attackWithView(sim, target);
    for (const row of rows) expect(row.etaTicks).toBeGreaterThan(0);
    if (rows.length > 0) {
      const preview = previewOrder(sim, state.player, rows.map((r) => r.army), target, true);
      expect(orderView(sim, preview).routes.length).toBe(preview.routes.length);
    }
  }
  const economy = economyView(sim);
  expect(economy.topProducers.length).toBeLessThanOrEqual(5);
  expect(exchangeView(sim).map((g) => g.good)).toEqual(['food', 'steel', 'oil']);
  for (const good of ['food', 'steel', 'oil'] as const) {
    const options = tradeOptions(sim, good);
    for (const o of options.buy) expect(o.reason !== null || o.funds <= state.nations[state.player]!.stocks.funds + 1e-9).toBe(true);
    for (const o of options.sell) expect(o.amount).toBeLessThanOrEqual(0);
  }
  for (const b of ['works', 'training', 'draft'] as const) expect(bestBuildView(sim, b, 5).length).toBeLessThanOrEqual(5);
  expect(coachHints(sim).nation).toBe(map.nations[state.player]!.name);
  for (const army of state.armies.slice(0, 50)) expect(armyLocation(sim, army.id)).not.toBeNull();
  expect(armyRows(sim, state.armies.map((a) => a.id))).toHaveLength(state.armies.filter((a) => a.alive).length);
  productionView(sim);
  constructionsView(sim);
  const standings = standingsView(sim, 12);
  expect(standings.some((row) => row.nation === state.player)).toBe(true);
  historyView(sim);
  idleArmies(sim);
  incomingArmies(sim, true);
  playerBattles(sim);
  expect(endView(sim, 1000).day).toBeGreaterThanOrEqual(1);
  endDetails(sim);
  nationSummary(sim, state.player);
  for (const card of advise(sim, 3)) expect(suggestionText(sim, card).length).toBeGreaterThan(0);
  expect(stateHash(sim)).toBe(before);
}

describe('views', () => {
  it('runs over a deep-frozen real state at day 1 and day 30 without writing it', () => {
    const day1 = realSim({ seed: 'views' });
    everyView(day1);

    const day30 = realSim({ seed: 'views' });
    runHours(day30, 29 * 24);
    expect(day30.cache.battles.length + day30.state.feed.length).toBeGreaterThan(0);
    everyView(day30);
  }, 60_000);

  it('describes a battle, its forecast and the army fighting it', () => {
    const { sim, p, n, a } = tinySim({
      provinces: { A: { owner: 'FR' }, B: { owner: 'BE' } },
      edges: [['A', 'B']],
      armies: [
        { owner: 'FR', at: 'B', units: { rifles: 8, guns: 2 } },
        { owner: 'BE', at: 'B', units: { rifles: 2 } },
      ],
      player: 'FR',
    });
    deepFreeze(sim.state);
    expect(playerBattles(sim)).toEqual([p('B')]);
    const battle = battleView(sim, p('B'))!;
    expect(battle.sides.map((s) => s.role)).toEqual(['defender', 'attacker']);
    expect(battle.sides[1]!.nation).toBe(n('FR'));
    expect(battle.forecast?.verdict).toBeDefined();
    expect(battle.mine).toEqual([a(0)]);
    const army = armyView(sim, [a(0)])!;
    expect(army.inBattle).toBe(true);
    expect(army.status).toMatch(/^Fighting in B — /);
    const province = provinceView(sim, p('B'));
    expect(province.battle).toBe(true);
    expect(province.foreign).toBe(true);
    expect(province.blockedBy).toBeNull();
  });

  it('lists armies for Attack with… and names an order', () => {
    const { sim, p, a } = tinySim({
      provinces: { A: { owner: 'FR' }, C: { owner: 'FR' }, B: { owner: 'BE', garrison: 10 } },
      edges: [
        ['A', 'B'],
        ['C', 'B'],
        ['A', 'C'],
      ],
      armies: [
        { owner: 'FR', at: 'A', units: { rifles: 6 } },
        { owner: 'FR', at: 'C', units: { rifles: 6 } },
      ],
      player: 'FR',
    });
    deepFreeze(sim.state);
    const rows = attackWithView(sim, p('B'));
    expect(rows.map((r) => r.army).sort((x, y) => x - y)).toEqual([a(0), a(1)]);
    expect(new Set(rows.map((r) => r.direction)).size).toBe(2);
    expect(rows.some((r) => r.suggested)).toBe(true);
    const preview = previewOrder(sim, sim.state.player, [a(0), a(1)], p('B'), true);
    const order = orderView(sim, preview);
    expect(order.verb).toBe('Attack');
    expect(order.approaches.sort()).toEqual(['A', 'C']);
    expect(order.routes.every((r) => r.groupSize === 1)).toBe(true);
    expect(idleArmies(sim)).toHaveLength(2);
    const multi = armyView(sim, [a(0), a(1)])!;
    expect(multi.name).toBe('2 armies');
    expect(multi.canMerge).toBe(false);
    expect(armyView(sim, [a(0)])!.mergeable).toEqual([]);
  });

  it('offers merges of co-located idle armies and Exchange quotes within the Funds', () => {
    const { sim, a } = tinySim({
      provinces: { A: { owner: 'FR' }, B: { owner: 'BE' } },
      edges: [['A', 'B']],
      armies: [
        { owner: 'FR', at: 'A', units: { rifles: 3 } },
        { owner: 'FR', at: 'A', units: { rifles: 2 } },
      ],
      player: 'FR',
      stocks: { FR: { funds: 500, food: 40 } },
    });
    deepFreeze(sim.state);
    expect(armyView(sim, [a(1)])!.mergeable).toEqual([a(0), a(1)]);
    const food = tradeOptions(sim, 'food');
    const max = food.buy[food.buy.length - 1]!;
    expect(max.funds).toBeLessThanOrEqual(500);
    expect(max.reason).toBeNull();
    expect(food.sell[food.sell.length - 1]!.amount).toBe(-40);
    expect(food.sell[1]!.reason).toMatch(/Not enough Food/);
  });

  it('shows integration countdowns and the original nation fighting on', () => {
    const { sim, p } = tinySim({
      provinces: { A: { owner: 'FR' }, B: { owner: 'FR', country: 'BE' }, C: { owner: 'BE' } },
      edges: [
        ['A', 'B'],
        ['B', 'C'],
      ],
      player: 'FR',
    });
    deepFreeze(sim.state);
    const view = provinceView(sim, p('B'));
    expect(view.status).toBe('occupied');
    expect(view.blockedBy).toMatch(/fights on/);
    expect(view.integratesInDays).toBeNull();
    expect(provinceView(sim, p('A')).status).toBe('home');
  });
});
