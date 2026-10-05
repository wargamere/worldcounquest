/**
 * Words the panels show for game codes: forecast warnings, modifier chips,
 * province statuses, stances and feed kinds. One place, so the same thing is
 * always called the same.
 */
import type { FeedKind, ModifierCode, OrderWarning, ProvinceStatus, Severity, Stance } from '@/next/game/types';
import type { IconName } from './Icon';

export const WARNING_TEXT: Readonly<Record<OrderWarning, string>> = {
  noRoute: 'No route to this province',
  crossesHostile: 'The route crosses enemy land — arrival may slip',
  staggered: 'Armies arrive apart — the first fights alone',
  capitalExposed: 'Leaves your capital exposed',
  oilShort: 'Out of Oil: Oil users march at half speed',
  unsupplied: 'Unsupplied at the target',
  landing: 'Sea landing: landed units deal ×0.75 for 12 h',
  reinforcementsInbound: 'Enemy reinforcements are on the way',
  leavesBattle: 'Leaving a battle costs 10% of HP',
};

export const MODIFIER_TEXT: Readonly<Record<ModifierCode, string>> = {
  terrain: 'Terrain',
  ramparts: 'Ramparts',
  flank: 'Flank',
  frontage: 'Frontage',
  landing: 'Landing',
  oilShort: 'Oil short',
  unsupplied: 'Unsupplied',
  tankTerrain: 'Tank terrain',
  gunsVsGarrison: 'Guns vs garrison',
};

export const STATUS_TEXT: Readonly<Record<ProvinceStatus, string>> = {
  home: 'Home',
  integrated: 'Integrated',
  occupied: 'Occupied',
};

export const STANCE_TEXT: Readonly<Record<Stance, string>> = {
  manual: 'Manual',
  defend: 'Defend',
  delegate: 'Delegate',
};

export const STANCE_HINT: Readonly<Record<Stance, string>> = {
  manual: 'Follows only your orders',
  defend: 'The Staff may move it to threatened provinces within 24 h of its post',
  delegate: 'The Staff may attack, defend and stage with it',
};

export const SEVERITY_TEXT: Readonly<Record<Severity, string>> = {
  info: 'text-slate-300',
  good: 'text-emerald-300',
  bad: 'text-orange-300',
  critical: 'text-rose-300',
};

export const SEVERITY_BORDER: Readonly<Record<Severity, string>> = {
  info: 'border-slate-600',
  good: 'border-emerald-500/70',
  bad: 'border-orange-500/70',
  critical: 'border-rose-500',
};

export const FEED_ICON: Readonly<Record<FeedKind, IconName>> = {
  battleStarted: 'battle',
  battleWon: 'flag',
  battleLost: 'battle',
  defenceHeld: 'shield',
  provinceCaptured: 'flag',
  provinceLost: 'warning',
  capitalLost: 'capital',
  capitalMoved: 'capital',
  capitulation: 'flag',
  eliminated: 'close',
  enemySighted: 'incoming',
  armyDestroyed: 'warning',
  retreated: 'go',
  routeBlocked: 'warning',
  unitsReady: 'train',
  constructionDone: 'build',
  shortage: 'warning',
  shortageEnded: 'check',
  revolt: 'warning',
  integrated: 'check',
  milestone: 'chart',
  digest: 'clock',
  victory: 'capital',
  defeat: 'warning',
};

/** A modifier factor as a chip: "Flank ×1.20". */
export function modifierChip(code: ModifierCode, factor: number): string {
  return `${MODIFIER_TEXT[code]} ×${factor.toFixed(2)}`;
}
