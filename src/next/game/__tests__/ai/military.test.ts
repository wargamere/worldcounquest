import { describe, expect, it } from 'vitest';
import { AI, CAPITAL } from '../../balance';
import { applyCommand } from '../../commands';
import { armyById, rebuildArmyIndex } from '../../cache';
import { hoursToTicks } from '../../clock';
import { zeroUnits } from '../../keys';
import { defenceF, provinceValue, threatAt, threatSoft, threatUnitsAt } from '../../ai/assess';
import { candidateTargets, planDefence, planOffensive, planOperation, planRetreats } from '../../ai/military';
import { thinkNation } from '../../ai/think';
import { totalHp } from '../../units';
import { step } from '../steps';
import { tinySim } from '../helpers';
import { AFTER_CALM, moves, movedArmies, ordersTo, planning } from './fixtures';

describe('belgium-uk: the capital guard is never sent', () => {
  const world = (threatened: boolean) =>
    tinySim({
      provinces: {
        bel: { owner: 'be', capitalOf: 'be' },
        fra: { owner: 'fr', capitalOf: 'fr' },
        lon: { owner: 'uk', capitalOf: 'uk', garrison: 0 },
        me: { owner: 'me' },
      },
      edges: [
        ['bel', 'fra'],
        ['bel', 'lon'],
      ],
      armies: [{ owner: 'be', at: 'bel', units: { rifles: 10 } }, ...(threatened ? [{ owner: 'fr', at: 'fra', units: { rifles: 8 } }] : [])],
    });

  it('issues no attack that would leave the capital below 2.0 × its threat', () => {
    const { sim, n, p } = world(true);
    sim.state.tick = AFTER_CALM;
    const be = n('be');
    expect(threatAt(sim, be, p('bel')).f).toBeGreaterThan(0);
    const commands = thinkNation(sim, be, false);
    expect(ordersTo(commands, p('lon'))).toBe(false);
    expect(movedArmies(commands)).toEqual([]);
  });

  it('attacks the same prize once nothing threatens the capital', () => {
    const { sim, n, p } = world(false);
    sim.state.tick = AFTER_CALM;
    expect(ordersTo(thinkNation(sim, n('be'), false), p('lon'))).toBe(true);
  });
});

describe('homeland-armies: a safe capital lends its armies', () => {
  it('uses the armies standing in an unthreatened capital for an operation', () => {
    const { sim, n, p, a } = tinySim({
      provinces: {
        cap: { owner: 'aa', capitalOf: 'aa' },
        front: { owner: 'aa' },
        tgt: { owner: 'bb' },
        bcap: { owner: 'bb', capitalOf: 'bb' },
        me: { owner: 'me' },
      },
      edges: [
        ['cap', 'front'],
        ['front', 'tgt'],
        ['tgt', 'bcap'],
      ],
      armies: [{ owner: 'aa', at: 'cap', units: { rifles: 8 } }],
    });
    sim.state.tick = AFTER_CALM;
    const commands = thinkNation(sim, n('aa'), false);
    const attack = moves(commands).find((c) => c.to === p('tgt'));
    expect(attack?.armies).toContain(a(0));
    expect(attack?.together).toBe(true);
  });
});

describe('us-panama: sizing adds armies until the prize can be held', () => {
  const world = () =>
    tinySim({
      provinces: {
        dc: { owner: 'us', capitalOf: 'us' },
        tex: { owner: 'us' },
        pan: { owner: 'pa' },
        pcap: { owner: 'pa', capitalOf: 'pa' },
        col: { owner: 'co', capitalOf: 'co' },
        me: { owner: 'me' },
      },
      edges: [
        ['dc', 'tex'],
        ['tex', 'pan'],
        ['pan', 'pcap'],
        ['pan', 'col'],
      ],
      armies: [
        { owner: 'us', at: 'tex', units: { rifles: 10 } },
        { owner: 'us', at: 'tex', units: { rifles: 6 } },
        { owner: 'us', at: 'dc', units: { rifles: 30 } },
        { owner: 'co', at: 'col', units: { rifles: 20 } },
      ],
    });

  it('a force well above the need attacks, and brings more than the win alone needs', () => {
    const { sim, n, p, a } = world();
    sim.state.tick = AFTER_CALM;
    const { view, s } = planning(sim, n('us'));
    const plan = planOperation(sim, view, s, p('pan'));
    expect(plan).not.toBeNull();
    expect(plan!.prediction.winner).toBe('attacker');
    // The nearest army alone wins the battle (it keeps far more than attackKeep)...
    const { view: alone, s: s2 } = planning(sim, n('us'), { armies: new Set([a(0)]) });
    const solo = planOperation(sim, alone, s2, p('pan'));
    expect(solo).toBeNull();
    // ...but only the far army makes the prize holdable against Colombia next door.
    expect(plan!.armies).toContain(a(2));
  });
});

describe('china-vietnam: threat sums every hostile force within two hops', () => {
  const world = (neighbours: number) =>
    tinySim({
      provinces: {
        c: { owner: 'cn', capitalOf: 'cn' },
        m: { owner: 'cn' },
        s: { owner: 'cn' },
        v1: { owner: 'vn', capitalOf: 'vn' },
        v2: { owner: 'la', capitalOf: 'la' },
        v3: { owner: 'mm', capitalOf: 'mm' },
        me: { owner: 'me' },
      },
      edges: [
        ['c', 'm'],
        ['m', 's'],
        ['s', 'v1'],
        ['s', 'v2'],
        ['s', 'v3'],
      ],
      armies: [
        { owner: 'cn', at: 'c', units: { rifles: 10 } },
        ...['vn', 'la', 'mm'].slice(0, neighbours).map((owner, i) => ({ owner, at: `v${i + 1}`, units: { rifles: 2 } })),
      ],
    });

  it('one weak neighbour alone is held by the garrison', () => {
    const { sim, n, p } = world(1);
    const { view, s } = planning(sim, n('cn'));
    expect(view.defence[p('s')]).toBeGreaterThanOrEqual(view.need[p('s')]!);
    expect(planDefence(sim, view, s)).toEqual([]);
  });

  it('three weak neighbours together trigger a defence move', () => {
    const { sim, n, p, a } = world(3);
    const { view, s } = planning(sim, n('cn'));
    expect(threatAt(sim, n('cn'), p('s')).f).toBeGreaterThan(2 * threatAtOne());
    expect(view.defence[p('s')]).toBeLessThan(view.need[p('s')]!);
    const commands = planDefence(sim, view, s);
    expect(moves(commands)).toEqual([expect.objectContaining({ armies: [a(0)], to: p('s') })]);
  });

  function threatAtOne(): number {
    const { sim, n, p } = world(1);
    return threatAt(sim, n('cn'), p('s')).f;
  }
});

describe('france-month-one: threat sees what is coming', () => {
  it('counts hostile armies inbound and units in hostile training queues', () => {
    const { sim, n, p, a } = tinySim({
      provinces: {
        par: { owner: 'fr', capitalOf: 'fr' },
        ber: { owner: 'de', capitalOf: 'de', buildings: { training: 1 } },
        far: { owner: 'de' },
        mid2: { owner: 'de' },
        mid: { owner: 'de' },
        me: { owner: 'me' },
      },
      edges: [
        ['par', 'ber'],
        ['par', 'mid'],
        ['mid', 'mid2'],
        ['mid2', 'far'],
      ],
      armies: [{ owner: 'de', at: 'far', units: { rifles: 6 } }],
    });
    const fr = n('fr');
    // Three hops away the army does not count; on its way into the neighbour it does.
    expect(totalHp(threatUnitsAt(sim, fr, p('par'), null))).toBe(0);
    const army = armyById(sim, a(0))!;
    army.at = p('mid2');
    army.leg = { from: p('mid2'), to: p('mid'), ticks: 20, done: 1, sea: false };
    rebuildArmyIndex(sim);
    expect(totalHp(threatUnitsAt(sim, fr, p('par'), null))).toBe(6 * 20);
    sim.state.provinces[p('ber')]!.queue.push({ unit: 'rifles', hoursLeft: 6, hoursTotal: 6, paid: {}, started: true });
    sim.state.provinces[p('ber')]!.queue.push({ unit: 'tanks', hoursLeft: 16, hoursTotal: 16, paid: {}, started: false });
    const queued = threatUnitsAt(sim, fr, p('par'), null);
    expect(queued.rifles.hp).toBeCloseTo(6 * 20 + AI.THREAT_QUEUED_SHARE * 20, 9);
    expect(queued.tanks.hp).toBeCloseTo(AI.THREAT_QUEUED_SHARE * 36, 9);
  });
});

describe('arrive-together: one operation from several provinces', () => {
  it('gathers armies from two provinces and they enter the target in the same tick', () => {
    const { sim, n, p, a } = tinySim({
      provinces: {
        ac: { owner: 'aa', capitalOf: 'aa' },
        a1: { owner: 'aa' },
        a2: { owner: 'aa' },
        t: { owner: 'bb', garrison: 150 },
        bc: { owner: 'bb', capitalOf: 'bb' },
        me: { owner: 'me' },
      },
      edges: [
        ['ac', 'a1'],
        ['ac', 'a2'],
        ['a1', 't', 100],
        ['a2', 't', 260],
        ['t', 'bc'],
      ],
      armies: [
        { owner: 'aa', at: 'a1', units: { rifles: 6 } },
        { owner: 'aa', at: 'a2', units: { rifles: 6 } },
      ],
    });
    sim.state.tick = AFTER_CALM;
    const { view, s } = planning(sim, n('aa'));
    const commands = planOffensive(sim, view, s);
    expect(commands).toHaveLength(1);
    const command = moves(commands)[0]!;
    expect(command.together).toBe(true);
    expect([...command.armies].sort()).toEqual([a(0), a(1)]);
    expect(applyCommand(sim, command, 'ai').ok).toBe(true);
    const arrived = new Map<number, number>();
    for (let i = 0; i < 400 && arrived.size < 2; i += 1) {
      step(sim);
      for (const id of [a(0), a(1)]) {
        const army = armyById(sim, id);
        if (army !== undefined && army.leg === null && army.at === p('t') && !arrived.has(id)) arrived.set(id, sim.state.tick);
      }
    }
    expect(arrived.size).toBe(2);
    expect(arrived.get(a(0))).toBe(arrived.get(a(1)));
  });
});

describe('flank-preference: a new direction beats a nearer army on the same road', () => {
  const world = (flankKm: number) =>
    tinySim({
      provinces: {
        ac: { owner: 'aa', capitalOf: 'aa' },
        b1: { owner: 'aa' },
        a1: { owner: 'aa' },
        a2: { owner: 'aa' },
        t: { owner: 'bb', garrison: 150 },
        bc: { owner: 'bb', capitalOf: 'bb' },
        me: { owner: 'me' },
      },
      edges: [
        ['ac', 'b1'],
        ['ac', 'a2', 400],
        ['b1', 'a1', 50],
        ['a1', 't', 100],
        ['a2', 't', flankKm],
        ['t', 'bc'],
      ],
      armies: [
        { owner: 'aa', at: 'a1', units: { rifles: 6 } },
        { owner: 'aa', at: 'b1', units: { rifles: 6 } },
        { owner: 'aa', at: 'a2', units: { rifles: 6 } },
      ],
    });

  it('takes the flanking army when it is at most FLANK_PREFERENCE_HOURS slower', () => {
    const { sim, n, p, a } = world(200);
    const { view, s } = planning(sim, n('aa'));
    const plan = planOperation(sim, view, s, p('t'));
    expect(plan?.armies).toEqual([a(0), a(2)]);
    expect(plan?.directions).toBe(2);
  });

  it('takes the nearer army when the flank is much slower', () => {
    const { sim, n, p, a } = world(200 + 20 * (AI.FLANK_PREFERENCE_HOURS + 6));
    const { view, s } = planning(sim, n('aa'));
    expect(planOperation(sim, view, s, p('t'))?.armies).toEqual([a(0), a(1)]);
  });
});

describe('hold-check: a prize that cannot be held is left alone', () => {
  const world = (counter: number) =>
    tinySim({
      provinces: {
        ac: { owner: 'aa', capitalOf: 'aa', garrison: 5000 },
        t: { owner: 'bb' },
        bc: { owner: 'bb', capitalOf: 'bb' },
        cc: { owner: 'cc', capitalOf: 'cc' },
        me: { owner: 'me' },
      },
      edges: [
        ['ac', 't'],
        ['t', 'bc'],
        ['t', 'cc'],
      ],
      armies: [{ owner: 'aa', at: 'ac', units: { rifles: 10 } }, ...(counter > 0 ? [{ owner: 'cc', at: 'cc', units: { rifles: counter } }] : [])],
    });

  it('declines a win whose survivors would face a far larger force next door', () => {
    const { sim, n, p } = world(40);
    const { view, s } = planning(sim, n('aa'));
    expect(planOperation(sim, view, s, p('t'))).toBeNull();
  });

  it('takes the same win when nothing can strike back', () => {
    const { sim, n, p } = world(0);
    const { view, s } = planning(sim, n('aa'));
    expect(planOperation(sim, view, s, p('t'))).not.toBeNull();
  });
});

describe('capital-value: a capital carries its whole nation', () => {
  it('values a capital above a bigger province that would not end its owner', () => {
    const provinces: Record<string, { owner: string; capitalOf?: string; population?: number }> = {
      bcap: { owner: 'bb', capitalOf: 'bb' },
      big: { owner: 'cc', capitalOf: 'cc', population: 1_000_000 },
      cbig: { owner: 'cc', population: 30_000_000 },
      me: { owner: 'me' },
      ac: { owner: 'aa', capitalOf: 'aa' },
    };
    for (let i = 0; i < 6; i += 1) provinces[`b${i}`] = { owner: 'bb' };
    const { sim, n, p } = tinySim({ provinces, edges: [['ac', 'bcap'], ['ac', 'cbig'], ['big', 'cbig'], ...[0, 1, 2, 3, 4, 5].map((i): [string, string] => ['bcap', `b${i}`])] });
    const aa = n('aa');
    expect(provinceValue(sim, p('bcap'), aa)).toBeGreaterThan(provinceValue(sim, p('cbig'), aa));
    expect(sim.map.provinces[p('cbig')]!.population).toBeGreaterThan(sim.map.provinces[p('bcap')]!.population);
  });
});

describe('retreat-hopeless: a beaten attacker falls back', () => {
  const world = (share: number) => {
    const t = tinySim({
      provinces: {
        ac: { owner: 'aa', capitalOf: 'aa' },
        t: { owner: 'bb' },
        bc: { owner: 'bb', capitalOf: 'bb' },
        me: { owner: 'me' },
      },
      edges: [
        ['ac', 't'],
        ['t', 'bc'],
      ],
      armies: [
        { owner: 'aa', at: 't', units: { rifles: 6 } },
        { owner: 'bb', at: 't', units: { rifles: 12 } },
      ],
    });
    const army = armyById(t.sim, t.a(0))!;
    army.cameFrom = t.p('ac');
    army.units.rifles.hp = 6 * 20 * share;
    army.units.rifles.count = Math.ceil(army.units.rifles.hp / 20);
    army.battle = { joinedAt: 0, startHp: 6 * 20, direction: t.p('ac') };
    return t;
  };

  it('retreats an attacker below RETREAT_BELOW_HP of its start in a losing battle', () => {
    const { sim, n, a } = world(AI.RETREAT_BELOW_HP - 0.1);
    const { view } = planning(sim, n('aa'));
    expect(planRetreats(sim, view)).toEqual([{ kind: 'retreat', nation: n('aa'), armies: [a(0)], to: null }]);
  });

  it('keeps fighting above the threshold', () => {
    const { sim, n } = world(AI.RETREAT_BELOW_HP + 0.1);
    const { view } = planning(sim, n('aa'));
    expect(planRetreats(sim, view)).toEqual([]);
  });
});

describe('opening-calm and player-grace', () => {
  const world = () =>
    tinySim({
      provinces: {
        ac: { owner: 'aa', capitalOf: 'aa' },
        mine: { owner: 'me', garrison: 0 },
        mcap: { owner: 'me', capitalOf: 'me' },
        theirs: { owner: 'bb', garrison: 0 },
        bc: { owner: 'bb', capitalOf: 'bb' },
      },
      edges: [
        ['ac', 'mine'],
        ['mine', 'mcap'],
        ['ac', 'theirs'],
        ['theirs', 'bc'],
      ],
      armies: [{ owner: 'aa', at: 'ac', units: { rifles: 10 } }],
      difficulty: 'standard',
    });

  it('launches no offensive before the opening calm', () => {
    const { sim, n } = world();
    sim.state.tick = hoursToTicks(48) - 1;
    expect(moves(thinkNation(sim, n('aa'), false))).toEqual([]);
  });

  it('spares the player before the grace day, then attacks', () => {
    const { sim, n, p } = world();
    sim.state.tick = hoursToTicks(48);
    const early = thinkNation(sim, n('aa'), false);
    expect(ordersTo(early, p('mine'))).toBe(false);
    expect(ordersTo(early, p('theirs'))).toBe(true);
    const late = world();
    late.sim.state.tick = 5 * 96;
    late.sim.state.provinces[late.p('theirs')]!.garrison = 400;
    expect(ordersTo(thinkNation(late.sim, late.n('aa'), false), late.p('mine'))).toBe(true);
  });

  it('a provoked nation targets the player at once', () => {
    const { sim, n, p } = world();
    sim.state.tick = hoursToTicks(48);
    sim.state.nations[n('aa')]!.ai.provoked = true;
    const { view, s } = planning(sim, n('aa'), { attack: true });
    const s2 = { ...s, allowPlayerTargets: true };
    expect(candidateTargets(sim, view, s2)).toContain(p('mine'));
  });
});

describe('leader-fear', () => {
  /** The leader's home is {lc, t} either way; only the land it occupies (and so its VP share) differs. */
  const world = (leaderHolds: boolean) => {
    const provinces: Record<string, { owner: string; capitalOf?: string; country?: string }> = {
      ac: { owner: 'aa', capitalOf: 'aa' },
      lc: { owner: 'll', capitalOf: 'll' },
      t: { owner: 'll' },
      me: { owner: 'me' },
      x0: { owner: 'xx', capitalOf: 'xx' },
    };
    for (let i = 1; i < 12; i += 1) provinces[`x${i}`] = i >= 6 && leaderHolds ? { owner: 'll', country: 'xx' } : { owner: 'xx' };
    return tinySim({ provinces, edges: [['ac', 't']] });
  };

  it('values the provinces of a nation holding LEADER_FEAR_SHARE of world VP at ×LEADER_FEAR_BONUS', () => {
    const feared = world(true);
    const calm = world(false);
    expect(feared.sim.cache.vp[feared.n('ll')]! / feared.sim.map.totalVp).toBeGreaterThanOrEqual(AI.LEADER_FEAR_SHARE);
    expect(calm.sim.cache.vp[calm.n('ll')]! / calm.sim.map.totalVp).toBeLessThan(AI.LEADER_FEAR_SHARE);
    const ratio = provinceValue(feared.sim, feared.p('t'), feared.n('aa')) / provinceValue(calm.sim, calm.p('t'), calm.n('aa'));
    expect(ratio).toBeCloseTo(AI.LEADER_FEAR_BONUS, 9);
  });
});

describe('the guard need', () => {
  it('is CAPITAL.GUARD_NEED × threat at the capital and FRONT_GUARD × threat on the frontier', () => {
    const { sim, n, p } = tinySim({
      provinces: { cap: { owner: 'aa', capitalOf: 'aa' }, f: { owner: 'aa' }, e: { owner: 'bb', capitalOf: 'bb' }, me: { owner: 'me' } },
      edges: [
        ['cap', 'f'],
        ['f', 'e'],
        ['cap', 'e'],
      ],
      armies: [{ owner: 'bb', at: 'e', units: { rifles: 5 } }],
    });
    const { view } = planning(sim, n('aa'));
    expect(view.need[p('cap')]).toBeCloseTo(CAPITAL.GUARD_NEED * view.threat[p('cap')]!, 9);
    expect(view.need[p('f')]).toBeCloseTo(AI.FRONT_GUARD * view.threat[p('f')]!, 9);
    expect(view.frontier[0]).toBe(p('cap'));
    expect(defenceF(sim, p('f'), zeroUnits(), threatSoft(view, p('f')))).toBeCloseTo(view.defence[p('f')]!, 9);
  });
});
