import { describe, expect, it } from 'vitest';
import { AI } from '../../balance';
import { forecastPicks } from '../../ai/military';
import { planMinor } from '../../ai/minor';
import { armyById } from '../../cache';
import { edgeBetween } from '../../world';
import { tinySim } from '../helpers';
import { AFTER_CALM, ordersTo } from './fixtures';

/** A minor with `rifles` Rifles in its capital next to `t`, a province of nation tt (a major or not). */
function world(rifles: number, targetMajor: boolean) {
  const t = tinySim({
    provinces: {
      mc: { owner: 'mm', capitalOf: 'mm' },
      t: { owner: 'tt', garrison: 160 },
      tc: { owner: 'tt', capitalOf: 'tt' },
      me: { owner: 'me' },
    },
    edges: [
      ['mc', 't'],
      ['t', 'tc'],
    ],
    armies: [{ owner: 'mm', at: 'mc', units: { rifles } }],
  });
  t.sim.state.tick = AFTER_CALM;
  t.sim.state.nations[t.n('mm')]!.tier = 'minor';
  t.sim.state.nations[t.n('tt')]!.tier = targetMajor ? 'major' : 'minor';
  return t;
}

/** The forecast the minor's single army would get against `t`. */
function keepOf(rifles: number, targetMajor: boolean): { wins: boolean; keep: number } {
  const { sim, n, p, a } = world(rifles, targetMajor);
  const army = armyById(sim, a(0))!;
  const edge = edgeBetween(sim.map, p('mc'), p('t'))!;
  const { prediction } = forecastPicks(sim, n('mm'), p('t'), [{ army, eta: 20, gather: 0, approach: p('mc'), landed: edge.sea }], null, true);
  return { wins: prediction.winner === 'attacker', keep: prediction.attackerKeeps };
}

describe('minor-caution', () => {
  it('attacks only when the forecast keeps MINOR_KEEP, or MINOR_KEEP_VS_MAJOR against a major', () => {
    let attacked = 0;
    let refused = 0;
    for (const targetMajor of [false, true]) {
      const threshold = targetMajor ? AI.MINOR_KEEP_VS_MAJOR : AI.MINOR_KEEP;
      for (let rifles = 4; rifles <= 30; rifles += 2) {
        const { wins, keep } = keepOf(rifles, targetMajor);
        const { sim, n, p } = world(rifles, targetMajor);
        const attacks = ordersTo(planMinor(sim, n('mm')), p('t'));
        expect(attacks, `${rifles} Rifles keep ${keep.toFixed(2)} vs ${targetMajor ? 'major' : 'minor'}`).toBe(wins && keep >= threshold);
        if (attacks) attacked += 1;
        else if (wins && keep >= AI.MINOR_KEEP) refused += 1;
      }
    }
    // Both outcomes happen, and some wins a major would take are refused for keeping too little.
    expect(attacked).toBeGreaterThan(0);
    expect(refused).toBeGreaterThan(0);
  });
});
