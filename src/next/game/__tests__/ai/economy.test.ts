import { describe, expect, it } from 'vitest';
import { AI, UNITS } from '../../balance';
import { bestProvincesFor } from '../../buildings';
import { nationRates } from '../../economy';
import { assessNation } from '../../ai/assess';
import { pickUnit, planEconomy, planMarket, planTraining, targetMix } from '../../ai/economy';
import { resetCounters } from '../../ai/think';
import { stepTick } from '../../sim';
import type { Command, NationIx, Sim } from '../../types';
import { tinySim } from '../helpers';

function plan(sim: Sim, n: NationIx, step: typeof planEconomy): Command[] {
  resetCounters(sim);
  return step(sim, assessNation(sim, n));
}

describe('economy-sanity', () => {
  it('builds the best-payback Works', () => {
    const { sim, n, p } = tinySim({
      provinces: {
        cap: { owner: 'aa', capitalOf: 'aa' },
        farm: { owner: 'aa' },
        city: { owner: 'aa', terrain: 'urban', population: 25_000_000 },
        me: { owner: 'me' },
      },
      edges: [
        ['cap', 'farm'],
        ['cap', 'city'],
      ],
      stocks: { aa: { funds: 20_000, steel: 500 } },
    });
    const aa = n('aa');
    const best = bestProvincesFor(sim, aa, 'works', 1)[0]!;
    expect(best.province).toBe(p('city'));
    expect(best.preview.paybackDays).toBeLessThanOrEqual(AI.WORKS_MAX_PAYBACK_DAYS);
    const commands = plan(sim, aa, planEconomy);
    expect(commands).toContainEqual({ kind: 'build', nation: aa, province: p('city'), building: 'works' });
  });

  it('buys Oil when it has none and its units burn it', () => {
    const { sim, n } = tinySim({
      provinces: { cap: { owner: 'aa', capitalOf: 'aa' }, me: { owner: 'me' } },
      edges: [],
      armies: [{ owner: 'aa', at: 'cap', units: { tanks: 4 } }],
      stocks: { aa: { funds: 5000, food: 500, steel: 200, oil: 0 } },
    });
    const commands = planMarket(sim, n('aa'));
    const buy = commands.find((c) => c.kind === 'trade' && c.good === 'oil');
    expect(buy).toBeDefined();
    expect(buy!.kind === 'trade' && buy.amount).toBeGreaterThan(0);
  });

  it('fixes a Food deficit within 3 days when Funds allow', () => {
    const { sim, n } = tinySim({
      provinces: { cap: { owner: 'aa', capitalOf: 'aa', terrain: 'mountains' }, me: { owner: 'me' } },
      edges: [],
      armies: [{ owner: 'aa', at: 'cap', units: { rifles: 30 } }],
      stocks: { aa: { funds: 20_000, food: 60, steel: 200 } },
    });
    const aa = n('aa');
    // Two nations: either holds half the world, so play on as a sandbox with no victory check.
    sim.state.sandbox = true;
    const rates = nationRates(sim, aa);
    expect(rates.net.food).toBeLessThan(0);
    for (let tick = 0; tick < 3 * 96; tick += 1) stepTick(sim);
    const nation = sim.state.nations[aa]!;
    expect(nation.shortage.food).toBe(false);
    expect(nation.stocks.food).toBeGreaterThan(-nationRates(sim, aa).net.food);
  });

  it('stops queueing at the upkeep ceiling', () => {
    const world = (rifles: number) =>
      tinySim({
        provinces: { cap: { owner: 'aa', capitalOf: 'aa', buildings: { training: 1 } }, me: { owner: 'me' } },
        edges: [],
        armies: [{ owner: 'aa', at: 'cap', units: { rifles } }],
        stocks: { aa: { funds: 50_000, recruits: 50_000, food: 5000, steel: 5000, oil: 500 } },
      });
    const gross = (sim: Sim, aa: NationIx): number => nationRates(sim, aa).income.funds;
    const perRifle = UNITS.rifles.upkeep.funds ?? 0;
    const room = world(0);
    const ceiling = AI.UPKEEP_CEILING * gross(room.sim, room.n('aa'));
    // Room for several units: it trains.
    expect(plan(room.sim, room.n('aa'), planTraining).filter((c) => c.kind === 'train').length).toBeGreaterThan(0);
    // One unit below the ceiling: it trains at most what still fits.
    const full = world(Math.floor(ceiling / perRifle));
    const commands = plan(full.sim, full.n('aa'), planTraining).filter((c) => c.kind === 'train');
    let upkeep = nationRates(full.sim, full.n('aa')).upkeep.funds;
    for (const c of commands) if (c.kind === 'train') upkeep += (UNITS[c.unit].upkeep.funds ?? 0) * c.count;
    expect(upkeep).toBeLessThanOrEqual(ceiling);
  });

  it('trains toward the target mix, shifting Rifles to Tank Hunters against armour', () => {
    const counts = { rifles: 10, hunters: 0, motor: 0, guns: 0, tanks: 0 };
    expect(pickUnit(targetMix(1, false, true), counts)).toBe('hunters');
    expect(targetMix(1, false, true).tanks).toBe(0);
    expect(targetMix(3, false, false).motor).toBe(0);
    expect(targetMix(3, true, true).hunters).toBeCloseTo(AI.COMPOSITION.hunters + AI.HUNTER_EXTRA, 12);
    expect(pickUnit(targetMix(3, false, true), { rifles: 9, hunters: 3, motor: 2, guns: 3, tanks: 3 })).toBe('rifles');
  });
});
