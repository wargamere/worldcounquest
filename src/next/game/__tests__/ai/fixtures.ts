/**
 * Shared pieces for the AI regression tests: planning an AI nation's move as
 * of a given tick, reading what its commands would order, and a hook that runs
 * the AI phase itself so a test sees every command and its result.
 */
import { DIFFICULTY } from '../../balance';
import { hoursToTicks } from '../../clock';
import { assessNation, type NationView } from '../../ai/assess';
import { settingsFor, type PlannerSettings } from '../../ai/military';
import { resetCounters, runAiPhase, type AppliedCommand } from '../../ai/think';
import { runStaff } from '../../ai/staff';
import type { ArmyId, Command, NationIx, ProvinceIx, Sim, SimHooks } from '../../types';

/** A tick after every difficulty's opening calm and on a day past every player grace. */
export const AFTER_CALM = Math.max(
  ...Object.values(DIFFICULTY).map((d) => Math.max(hoursToTicks(d.openingCalmHours), d.playerGraceDays * 96)),
);

/** A fresh view and the nation's own settings, with offensives forced on unless told otherwise. */
export function planning(sim: Sim, n: NationIx, override: Partial<PlannerSettings> = {}): { view: NationView; s: PlannerSettings } {
  resetCounters(sim);
  const view = assessNation(sim, n);
  return { view, s: { ...settingsFor(sim, n), attack: true, ...override } };
}

/** The move commands among `commands`. */
export function moves(commands: readonly Command[]): Extract<Command, { kind: 'move' }>[] {
  return commands.filter((c): c is Extract<Command, { kind: 'move' }> => c.kind === 'move');
}

/** Whether some command orders an army to `to`. */
export function ordersTo(commands: readonly Command[], to: ProvinceIx): boolean {
  return moves(commands).some((c) => c.to === to);
}

/** The army ids a list of commands moves. */
export function movedArmies(commands: readonly Command[]): ArmyId[] {
  return moves(commands).flatMap((c) => [...c.armies]);
}

/**
 * Hooks that run the AI and Staff phases at the start of the tick's AI phase and
 * hand each applied command to `seen`; the sim's own aiPhase then finds nothing
 * due, so the game plays exactly as without the hook.
 */
export function watchAi(sim: Sim, seen: (applied: AppliedCommand, tick: number) => void): SimHooks {
  return {
    phase(name, edge) {
      if (name !== 'ai' || edge !== 'start') return;
      for (const applied of runAiPhase(sim)) seen(applied, sim.state.tick);
      for (const applied of runStaff(sim)) seen(applied, sim.state.tick);
    },
  };
}
