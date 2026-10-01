/**
 * The harness player (§6.9, §12.5). 'advisor' plays as a competent, careful
 * player would with the game's own tools: every army is delegated to the Staff
 * (which sim.ts runs every ADVISOR.THINK_HOURS), and the economy, training and
 * market are run by the major planner. 'passive' does nothing (observer mode).
 * Every change goes through applyCommand as the player.
 */
import { armiesOf } from '../cache';
import { applyCommand } from '../commands';
import type { Command, Sim } from '../types';
import { assessNation } from './assess';
import { planEconomy, planMarketAfter, planTraining } from './economy';

export type AutoplayStyle = 'advisor' | 'passive';

/** Call once per game hour. */
export function autoplay(sim: Sim, style: AutoplayStyle): void {
  const { state } = sim;
  if (style === 'passive' || (state.status !== 'playing' && !state.sandbox)) return;
  const n = state.player;
  if (!state.nations[n]!.alive) return;
  const manual = armiesOf(sim, n)
    .filter((a) => a.alive && a.stance !== 'delegate')
    .map((a) => a.id);
  const commands: Command[] = [];
  if (manual.length > 0) commands.push({ kind: 'stance', nation: n, armies: manual, stance: 'delegate' });
  const view = assessNation(sim, n);
  commands.push(...planEconomy(sim, view), ...planTraining(sim, view), ...planMarketAfter(sim, view));
  for (const command of commands) applyCommand(sim, command, 'player');
}
