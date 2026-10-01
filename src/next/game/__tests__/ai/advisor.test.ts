import { describe, expect, it } from 'vitest';
import { ADVISOR } from '../../balance';
import { validateCommand } from '../../commands';
import { advise, suggestFirstTarget, suggestForce } from '../../ai/advisor';
import type { ArmyId, Sim } from '../../types';
import { tinySim } from '../helpers';

/** The player's capital `mc` with a guard, a weak hostile province `t` next door, and a hostile army near the capital. */
function world(threat: number) {
  return tinySim({
    provinces: {
      mc: { owner: 'me', capitalOf: 'me' },
      t: { owner: 'ee', garrison: 30 },
      ec: { owner: 'ee', capitalOf: 'ee' },
      x: { owner: 'xx', capitalOf: 'xx' },
    },
    edges: [
      ['mc', 't'],
      ['t', 'ec'],
      ['mc', 'x'],
    ],
    armies: [{ owner: 'me', at: 'mc', units: { rifles: 10 } }, ...(threat > 0 ? [{ owner: 'xx', at: 'x', units: { rifles: threat } }] : [])],
    stocks: { me: { funds: 3000, recruits: 5000, food: 500, steel: 300 } },
  });
}

function cardArmies(sim: Sim): ArmyId[] {
  return advise(sim, 10).flatMap((card) => card.commands.flatMap((c) => ('armies' in c ? [...c.armies] : [])));
}

describe('advisor-safe', () => {
  it('every card validates, and none takes the capital guard', () => {
    const { sim, a } = world(8);
    const cards = advise(sim, 10);
    for (const card of cards) for (const command of card.commands) expect(validateCommand(sim, command, 'player')).toEqual({ ok: true, armies: [] });
    expect(cardArmies(sim)).not.toContain(a(0));
  });

  it('suggests the attack once the capital is safe', () => {
    const { sim, p, a } = world(0);
    const cards = advise(sim, ADVISOR.SUGGESTIONS);
    const attack = cards.find((c) => c.kind === 'attack');
    expect(attack?.kind === 'attack' && [p('t'), p('x')].includes(attack.plan.target)).toBe(true);
    expect(attack?.kind === 'attack' && attack.forecast.winChance).toBeGreaterThanOrEqual(ADVISOR.MIN_WIN_CHANCE);
    expect(cardArmies(sim)).toContain(a(0));
    for (const card of cards) for (const command of card.commands) expect(validateCommand(sim, command, 'player').ok).toBe(true);
  });

  it('suggestForce and suggestFirstTarget pick a winning force', () => {
    const { sim, p, a } = world(0);
    const force = suggestForce(sim, p('t'));
    expect(force?.armies).toEqual([a(0)]);
    expect(force?.preview.forecast?.winChance).toBeGreaterThanOrEqual(ADVISOR.MIN_WIN_CHANCE);
    const first = suggestFirstTarget(sim);
    expect(first?.armies).toEqual([a(0)]);
    expect([p('t'), p('x')]).toContain(first?.target);
    // A guarded capital lends nothing.
    const guarded = world(8);
    expect(suggestForce(guarded.sim, guarded.p('t'))).toBeNull();
  });
});
