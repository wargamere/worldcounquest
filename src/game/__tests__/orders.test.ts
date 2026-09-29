import { describe, expect, it } from 'vitest';
import topology from '../../../public/countries-110m.json';
import seeds from '@/data/countries.seed.json';
import seaLinks from '@/data/sea-links.json';
import { buildWorld, type CountriesTopology } from '@/lib/world';
import { adviseAttack } from '@/game/ai';
import { attack, recruit } from '@/game/actions';
import { ADVISOR } from '@/game/balance';
import { assignColours, borderCost, PALETTE, PLAYER_COLOUR } from '@/game/colours';
import { captureProbability } from '@/game/combat';
import { entriesSince } from '@/game/log';
import { attackPresets, countryRisk, previewAttack, previewMove } from '@/game/orders';
import { combinedThreat } from '@/game/threat';
import { endTurn } from '@/game/turn';
import { tinyWorld } from './helpers';

describe('previewAttack', () => {
  const state = tinyWorld(
    { home: { owner: 'me', troops: 100 }, prey: { owner: 'x', troops: 20 }, wolf: { owner: 'w', troops: 60 } },
    [['home', 'prey'], ['home', 'wolf']],
  );

  it('reports the same win chance combat will actually use', () => {
    const preview = previewAttack(state, 'home', 'prey', 40)!;
    expect(preview.winChance).toBe(
      captureProbability({ attackerTroops: 40, attackerDev: 5, defenderTroops: 20, defenderDev: 5 }),
    );
  });

  it('shows the source getting riskier the more is sent', () => {
    const light = previewAttack(state, 'home', 'prey', 20)!;
    const heavy = previewAttack(state, 'home', 'prey', 95)!;
    expect(heavy.sourceRisk).toBeGreaterThan(light.sourceRisk);
    expect(heavy.survivors).toBeGreaterThan(light.survivors);
  });

  it('returns nothing for an empty order', () => {
    expect(previewAttack(state, 'home', 'prey', 0)).toBeNull();
  });
});

describe('attackPresets', () => {
  it('orders safe >= likely, both reaching their target chance', () => {
    const state = tinyWorld(
      { home: { owner: 'me', troops: 200 }, prey: { owner: 'x', troops: 30 } },
      [['home', 'prey']],
    );
    const p = attackPresets(state, 'home', 'prey');
    expect(p.safe).not.toBeNull();
    expect(p.likely).not.toBeNull();
    expect(p.safe!).toBeGreaterThanOrEqual(p.likely!);
    const chance = (n: number) => captureProbability({ attackerTroops: n, attackerDev: 5, defenderTroops: 30, defenderDev: 5 });
    expect(chance(p.safe!)).toBeGreaterThanOrEqual(ADVISOR.SAFE_CHANCE);
    expect(chance(p.likely!)).toBeGreaterThanOrEqual(ADVISOR.LIKELY_CHANCE);
    expect(p.all).toBe(199);
  });

  it('reports out-of-reach presets as null', () => {
    const state = tinyWorld(
      { home: { owner: 'me', troops: 10 }, fort: { owner: 'x', troops: 100 } },
      [['home', 'fort']],
    );
    expect(attackPresets(state, 'home', 'fort').safe).toBeNull();
  });
});

describe('previewMove and countryRisk', () => {
  it('moving troops forward makes the destination safer and the source riskier', () => {
    const state = tinyWorld(
      {
        rear: { owner: 'me', troops: 100 },
        front: { owner: 'me', troops: 5 },
        enemy: { owner: 'x', troops: 60 },
        other: { owner: 'y', troops: 60 },
      },
      [['rear', 'front'], ['front', 'enemy'], ['rear', 'other']],
    );
    const preview = previewMove(state, 'rear', 'front', 80)!;
    expect(preview.destinationRisk).toBeLessThan(countryRisk(state, 'front').chance);
    expect(preview.sourceRisk).toBeGreaterThan(countryRisk(state, 'rear').chance);
  });
});

describe('adviseAttack', () => {
  it('suggests a safe capture and nothing when none exists', () => {
    const good = tinyWorld(
      { home: { owner: 'me', troops: 100 }, prey: { owner: 'x', troops: 10 } },
      [['home', 'prey']],
    );
    const plan = adviseAttack(good)!;
    expect(plan.targetId).toBe('prey');
    expect(combinedThreat(good, 'home', 100 - plan.troops, 'prey')).toBeLessThanOrEqual(ADVISOR.RISK_TOLERANCE);

    const bad = tinyWorld(
      { home: { owner: 'me', troops: 10 }, fort: { owner: 'x', troops: 100 } },
      [['home', 'fort']],
    );
    expect(adviseAttack(bad)).toBeNull();
  });
});

describe('assignColours', () => {
  const world = buildWorld(topology as unknown as CountriesTopology, seeds, seaLinks);
  const ids = seeds.map((s) => s.id);

  it('never gives two neighbours the same colour on the real map', () => {
    for (const player of ['250', '643', '156', '840', '036']) {
      const colours = assignColours(ids, world.adjacency, player);
      expect(colours[player]).toBe(PLAYER_COLOUR);
      for (const id of ids) {
        if (id !== player) expect(PALETTE).toContain(colours[id]);
        for (const n of world.adjacency[id] ?? []) {
          expect(colours[n], `${id} and ${n} share a colour`).not.toBe(colours[id]);
        }
      }
    }
  });

  it('keeps validator-failing pairs on a small share of borders', () => {
    // Seven hues cannot pass all-pairs, and no colouring of this map keeps every
    // failing pair apart; this bounds how many borders are left with one.
    let borders = 0;
    for (const id of ids) for (const n of world.adjacency[id] ?? []) if (id < n) borders += 1;
    const colours = assignColours(ids, world.adjacency, '250');
    let weak = 0;
    for (const id of ids) for (const n of world.adjacency[id] ?? []) {
      if (id < n && borderCost(colours[id]!, colours[n]!) >= 10) weak += 1;
    }
    let cost = 0;
    for (const id of ids) for (const n of world.adjacency[id] ?? []) if (id < n) cost += borderCost(colours[id]!, colours[n]!);
    expect(weak / borders).toBeLessThan(0.08);
    expect(cost).toBeLessThan(260);
  });

  it('scores identical colours as impossible and validated pairs as free', () => {
    expect(borderCost('#3987e5', '#3987e5')).toBe(Number.POSITIVE_INFINITY);
    expect(borderCost('#3987e5', '#9085e9')).toBe(10);
    expect(borderCost('#3987e5', '#d95926')).toBe(0);
  });

  it('is deterministic', () => {
    expect(assignColours(ids, world.adjacency, '250')).toEqual(assignColours(ids, world.adjacency, '250'));
  });
});

describe('battle records and turn reports', () => {
  it('tallies a win for the player and records it structurally in the log', () => {
    const state = tinyWorld(
      { home: { owner: 'me', troops: 500 }, prey: { owner: 'x', troops: 5 } },
      [['home', 'prey']],
    );
    const after = attack(state, 'me', 'home', 'prey', 400).state;
    expect(after.stats.battlesWon).toBe(1);
    expect(after.stats.peakCountries).toBe(2);
    const [entry] = entriesSince(state, after);
    expect(entry?.combat).toEqual({ attackerId: 'me', defenderId: 'x', countryId: 'prey', captured: true });
  });

  it('reports a country lost during the AI turn, and who took it', () => {
    const state = tinyWorld(
      {
        home: { owner: 'me', troops: 400 },
        outpost: { owner: 'me', troops: 1 },
        bully: { owner: 'b', troops: 300 },
      },
      [['home', 'outpost'], ['outpost', 'bully']],
    );
    state.nations['b'] = { ...state.nations['b']!, isMajor: true };
    const after = endTurn(state);
    expect(after.lastReport?.lost).toEqual([{ countryId: 'outpost', name: 'OUTPOST', byId: 'b' }]);
    expect(after.stats.countriesLost).toBe(1);
  });
});

describe('the recommended attack', () => {
  it('never defaults to stripping home when a safe force can win', () => {
    // Regression guard: the panel once defaulted to 23 of France's 26 troops —
    // a likely win that left France at a 100% chance of falling next turn.
    const state = tinyWorld(
      {
        home: { owner: 'me', troops: 200 },
        prey: { owner: 'x', troops: 15 },
        wolf: { owner: 'w', troops: 120 },
      },
      [['home', 'prey'], ['home', 'wolf']],
    );
    const p = attackPresets(state, 'home', 'prey');
    expect(p.recommended).toBeLessThanOrEqual(p.spare);
    const preview = previewAttack(state, 'home', 'prey', p.recommended)!;
    expect(preview.sourceRisk).toBeLessThanOrEqual(ADVISOR.RISK_TOLERANCE);
    expect(preview.winChance).toBeGreaterThanOrEqual(ADVISOR.LIKELY_CHANCE);
  });

  it('falls back to a winning force, not everything, when home cannot spare one', () => {
    const state = tinyWorld(
      {
        home: { owner: 'me', troops: 40 },
        prey: { owner: 'x', troops: 15 },
        wolf: { owner: 'w', troops: 120 },
      },
      [['home', 'prey'], ['home', 'wolf']],
    );
    const p = attackPresets(state, 'home', 'prey');
    expect(p.recommended).toBeLessThan(p.all);
  });
});

describe('the event log', () => {
  it("logs the player's purchases but not the AI's, so battles are not crowded out", () => {
    // Regression guard: every AI recruitment was logged, and the 400-entry log
    // held barely two turns of history — mostly "Sweden recruited 4 troops".
    const state = tinyWorld({ mine: { owner: 'me', troops: 1 }, theirs: { owner: 'ai', troops: 1 } }, []);
    for (const id of ['me', 'ai']) state.nations[id] = { ...state.nations[id]!, treasury: 1000, manpower: 1e8 };
    const afterAi = recruit(state, 'ai', 'theirs', 5).state;
    expect(entriesSince(state, afterAi)).toHaveLength(0);
    const afterMe = recruit(state, 'me', 'mine', 5).state;
    expect(entriesSince(state, afterMe)).toHaveLength(1);
  });
});
