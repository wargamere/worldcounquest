/**
 * VP, the race and the result. Victory is holding VICTORY.VP_SHARE of world VP;
 * the player loses with the last province, or when an AI gets there first.
 * Milestone news fires when a nation's VP crosses a share since the last check.
 */
import { VICTORY } from './balance';
import { checkedVp } from './cache';
import { pushFeed } from './feed';
import { asNation } from './ids';
import type { GameStatus, NationIx, Sim } from './types';

export function vpOf(sim: Sim, n: NationIx): number {
  return sim.cache.vp[n] ?? 0;
}

export function vpShare(sim: Sim, n: NationIx): number {
  const total = sim.map.totalVp;
  return total > 0 ? vpOf(sim, n) / total : 0;
}

/** The living AI nation with the most VP (ties to the lower index), or null if none holds any. */
export function leadingRival(sim: Sim): { nation: NationIx; vp: number; share: number } | null {
  let best: NationIx | null = null;
  let bestVp = 0;
  for (let i = 0; i < sim.state.nations.length; i += 1) {
    const nation = sim.state.nations[i]!;
    const vp = sim.cache.vp[i] ?? 0;
    if (nation.alive && !nation.isPlayer && vp > bestVp) {
      best = asNation(i);
      bestVp = vp;
    }
  }
  if (best === null) return null;
  return { nation: best, vp: bestVp, share: vpShare(sim, best) };
}

const percent = (share: number): string => `${Math.round(share * 100)}%`;

function announceMilestones(sim: Sim): void {
  const { map, state, cache } = sim;
  const before = checkedVp(sim);
  const total = map.totalVp;
  for (let i = 0; i < state.nations.length; i += 1) {
    const n = asNation(i);
    const was = before[i] ?? 0;
    const now = cache.vp[i] ?? 0;
    before[i] = now;
    if (now <= was || total <= 0) continue;
    const name = map.nations[i]!.name;
    const isPlayer = n === state.player;
    for (const share of VICTORY.MILESTONES) {
      const at = share * total;
      if (was < at && now >= at) {
        pushFeed(sim, {
          kind: 'milestone',
          severity: isPlayer ? 'good' : 'info',
          text: `${name} holds ${percent(share)} of the world`,
          nations: [n],
          province: null,
          army: null,
        });
      }
    }
    const warning = VICTORY.RIVAL_WARNING * total;
    if (!isPlayer && was < warning && now >= warning) {
      pushFeed(sim, {
        kind: 'milestone',
        severity: 'critical',
        text: `${name} holds ${percent(VICTORY.RIVAL_WARNING)} of the world and is closing on the goal`,
        nations: [n, state.player],
        province: null,
        army: null,
      });
    }
  }
}

function judge(sim: Sim): { status: GameStatus; text: string } {
  const { map, state, cache } = sim;
  if ((cache.nationProvinces[state.player]?.length ?? 0) === 0) return { status: 'lost', text: 'Your nation has fallen' };
  if (vpOf(sim, state.player) >= map.goalVp) return { status: 'won', text: 'Hegemony achieved' };
  const rival = leadingRival(sim);
  if (VICTORY.RIVAL_DEFEATS && rival !== null && rival.vp >= map.goalVp) {
    return { status: 'lost', text: `${map.nations[rival.nation]!.name} rules the world` };
  }
  return { status: 'playing', text: '' };
}

/**
 * Checks milestones and the result, and records a change of result on the
 * state (status, endedAt, events.statusChanged, a victory or defeat entry).
 * After a result, or in the sandbox, nothing is checked.
 */
export function evaluateStatus(sim: Sim): GameStatus {
  const { state } = sim;
  if (state.sandbox || state.status !== 'playing') return state.status;
  announceMilestones(sim);
  const { status, text } = judge(sim);
  if (status === 'playing') return status;
  state.status = status;
  state.endedAt = state.tick;
  sim.cache.events.statusChanged = true;
  pushFeed(sim, {
    kind: status === 'won' ? 'victory' : 'defeat',
    severity: status === 'won' ? 'good' : 'critical',
    text,
    nations: [state.player],
    province: null,
    army: null,
  });
  return status;
}
