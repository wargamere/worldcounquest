/**
 * The Staff (§6.9): every ADVISOR.THINK_HOURS it commands the player's Delegate
 * and Defend armies, never Manual ones. Delegate armies get the advisor planner
 * (defence, retreats, offensive, staging) with the advisor's settings; Defend
 * armies only defend within ADVISOR.DEFEND_RADIUS_HOURS of their post and go
 * back to it when idle. The Staff never trains, builds or trades. Its commands
 * go through applyCommand as source 'staff', so it cannot touch a Manual army.
 */
import { ADVISOR } from '../balance';
import { armiesOf, armyById } from '../cache';
import { hoursToTicks } from '../clock';
import { isIdle } from '../armies';
import { UNIT_TYPES } from '../types';
import type { ArmyId, Command, Sim } from '../types';
import { assessPlayer, defenceF, sameOwnRegion, threatSoft, ownUnitsAt, type NationView } from './assess';
import { advisorSettings, planDefence, planOffensive, planRetreats, planStaging, type PlannerSettings } from './military';
import { resetCounters, runThink, type AppliedCommand } from './think';

/** Idle Defend armies away from their post go back, if the province they are in can spare them. */
function returnToPosts(sim: Sim, view: NationView, defend: ReadonlySet<ArmyId>, used: ReadonlySet<ArmyId>): Command[] {
  const { state } = sim;
  const n = view.nation;
  const out: Command[] = [];
  for (const id of [...defend].sort((a, b) => a - b)) {
    const army = armyById(sim, id);
    if (army === undefined || used.has(id) || !isIdle(sim, army) || army.post === null || army.post === army.at) continue;
    if (state.provinces[army.post]!.owner !== n || !sameOwnRegion(sim, view, army.at, army.post)) continue;
    const need = view.need[army.at] ?? 0;
    if (need > 0) {
      const rest = ownUnitsAt(sim, n, army.at);
      for (const type of UNIT_TYPES) {
        rest[type].hp = Math.max(0, rest[type].hp - army.units[type].hp);
        rest[type].count = Math.max(0, rest[type].count - army.units[type].count);
      }
      if (defenceF(sim, army.at, rest, threatSoft(view, army.at)) < need) continue;
    }
    out.push({ kind: 'move', nation: n, armies: [id], to: army.post, together: false, append: false });
  }
  return out;
}

/** Runs the Staff for the player's delegated armies when its think is due. */
export function staffPhase(sim: Sim): void {
  runStaff(sim);
}

/** The Staff phase, reporting every command it applied. */
export function runStaff(sim: Sim): AppliedCommand[] {
  const { state } = sim;
  if (state.status !== 'playing' && !state.sandbox) return [];
  const player = state.nations[state.player]!;
  if (!player.alive || state.tick < player.ai.nextThink) return [];
  player.ai.nextThink = state.tick + hoursToTicks(ADVISOR.THINK_HOURS);
  const delegate = new Set<ArmyId>();
  const defend = new Set<ArmyId>();
  for (const army of armiesOf(sim, state.player)) {
    if (!army.alive) continue;
    if (army.stance === 'delegate') delegate.add(army.id);
    else if (army.stance === 'defend') defend.add(army.id);
  }
  if (delegate.size === 0 && defend.size === 0) return [];
  resetCounters(sim);
  const view = assessPlayer(sim);
  const guard: PlannerSettings = { ...advisorSettings(defend), attack: false, defendRadiusTicks: hoursToTicks(ADVISOR.DEFEND_RADIUS_HOURS) };
  const field = advisorSettings(delegate);
  const commands: Command[] = [...planDefence(sim, view, guard), ...planDefence(sim, view, field), ...planRetreats(sim, view)];
  commands.push(...planOffensive(sim, view, field), ...planStaging(sim, view, field));
  const used = new Set<ArmyId>();
  for (const command of commands) if (command.kind === 'move' || command.kind === 'retreat') for (const id of command.armies) used.add(id);
  return runThink(sim, view, [...commands, ...returnToPosts(sim, view, defend, used)], 'staff');
}
