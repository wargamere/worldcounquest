/**
 * The daily VP history behind the end-screen chart: the player plus the
 * leading rivals, one point per midnight.
 */
import { HISTORY, TIME } from './balance';
import { asNation } from './ids';
import { recordPeaks } from './stats';
import type { HistoryPoint, NationIx, Sim } from './types';

/** Records today's point (whole days elapsed) and the player's peaks. */
export function recordDay(sim: Sim): void {
  const { state, cache } = sim;
  const day = Math.floor(state.tick / TIME.TICKS_PER_DAY);
  const rivals: NationIx[] = [];
  state.nations.forEach((nation, i) => {
    if (nation.alive && !nation.isPlayer && (cache.vp[i] ?? 0) > 0) rivals.push(asNation(i));
  });
  rivals.sort((a, b) => cache.vp[b]! - cache.vp[a]! || a - b);
  const tracked = [state.player, ...rivals.slice(0, HISTORY.TRACKED_NATIONS)];
  const point: HistoryPoint = { day, vp: tracked.map((n): [NationIx, number] => [n, cache.vp[n] ?? 0]) };
  const last = state.history[state.history.length - 1];
  if (last !== undefined && last.day === day) state.history[state.history.length - 1] = point;
  else state.history.push(point);
  if (state.history.length > HISTORY.MAX_POINTS) state.history = downsample(state.history);
  recordPeaks(sim);
}

/** Every second point, always keeping the newest. */
function downsample(history: readonly HistoryPoint[]): HistoryPoint[] {
  const last = history.length - 1;
  return history.filter((_, i) => i % 2 === 0 || i === last);
}
