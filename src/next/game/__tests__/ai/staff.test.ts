import { describe, expect, it } from 'vitest';
import { applyCommand } from '../../commands';
import { armyById, rebuildArmyIndex } from '../../cache';
import { runStaff } from '../../ai/staff';
import type { ArmyId } from '../../types';
import { tinySim } from '../helpers';

function world() {
  const t = tinySim({
    provinces: {
      mc: { owner: 'me', capitalOf: 'me' },
      mf: { owner: 'me' },
      e: { owner: 'ee', garrison: 0 },
      ec: { owner: 'ee', capitalOf: 'ee' },
      far: { owner: 'zz', capitalOf: 'zz' },
    },
    edges: [
      ['mc', 'mf'],
      ['mf', 'e'],
      ['e', 'ec'],
      ['ec', 'far'],
    ],
    armies: [
      { owner: 'me', at: 'mf', units: { rifles: 6 }, stance: 'manual' },
      { owner: 'me', at: 'mf', units: { rifles: 6 }, stance: 'delegate' },
      { owner: 'me', at: 'mc', units: { rifles: 4 }, stance: 'defend' },
    ],
  });
  return t;
}

describe('staff-scope', () => {
  it('moves only Delegate and Defend armies', () => {
    const { sim, p, a } = world();
    const manual = a(0);
    const applied = runStaff(sim);
    const named = new Set<ArmyId>();
    for (const { command, result } of applied) {
      expect(result.ok).toBe(true);
      if (command.kind === 'move' || command.kind === 'retreat' || command.kind === 'merge') for (const id of command.armies) named.add(id);
      if (command.kind === 'split') named.add(command.army);
    }
    expect(named.has(manual)).toBe(false);
    // The delegated army takes the undefended province next door.
    expect(applied.some(({ command }) => command.kind === 'move' && command.to === p('e') && command.armies.includes(a(1)))).toBe(true);
    // The Staff cannot command a Manual army even if asked to.
    expect(applyCommand(sim, { kind: 'move', nation: sim.state.player, armies: [manual], to: p('mc'), together: false, append: false }, 'staff').ok).toBe(false);
  });

  it('a Defend army goes back to its post when it is idle elsewhere', () => {
    const { sim, p, a } = world();
    const guard = armyById(sim, a(2))!;
    guard.at = p('mf');
    rebuildArmyIndex(sim);
    const applied = runStaff(sim);
    expect(applied.some(({ command }) => command.kind === 'move' && command.to === p('mc') && command.armies.includes(a(2)))).toBe(true);
  });

  it('a manual order takes a delegated army back', () => {
    const { sim, p, a } = world();
    const result = applyCommand(sim, { kind: 'move', nation: sim.state.player, armies: [a(1)], to: p('mc'), together: false, append: false }, 'player');
    expect(result.ok).toBe(true);
    expect(armyById(sim, a(1))!.stance).toBe('manual');
    expect(runStaff(sim).some(({ command }) => 'armies' in command && command.armies.includes(a(1)))).toBe(false);
  });

  it('thinks every ADVISOR.THINK_HOURS', () => {
    const { sim } = world();
    expect(runStaff(sim).length).toBeGreaterThan(0);
    expect(runStaff(sim)).toEqual([]);
  });
});
