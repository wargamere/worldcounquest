'use client';

import { STOCK_LABELS } from '@/next/game/economy';
import type { StockChip } from '@/next/game/views';
import { compact, formatDays, formatRate, signedCompact } from '../ui/format';
import { Icon } from '../ui/Icon';

/**
 * One stock (§3.9): amount (Recruits as stock / cap), net per day, "runs out in",
 * red when short, "auto". The last two show only on wide screens — at 1280 px
 * they pushed the Oil chip out of the bar — and always in the tooltip.
 */
export function ResourceChip({ chip, open, onToggle }: { chip: StockChip; open: boolean; onToggle: () => void }) {
  const urgent = chip.daysLeft !== null && chip.daysLeft < 1;
  const runsOut = chip.netPerDay < 0 && chip.daysLeft !== null;
  const tone = chip.short ? 'border-rose-500 bg-rose-950/60 text-rose-100' : 'border-slate-700 bg-slate-900 text-slate-100';
  const label = `${STOCK_LABELS[chip.key]} ${Math.round(chip.amount)}${chip.cap === null ? '' : ` of ${Math.round(chip.cap)}`}, ${signedCompact(chip.netPerDay)} per day${chip.short ? ', short' : ''}${runsOut ? `, runs out in ${formatDays(chip.daysLeft ?? 0)}` : ''}${chip.auto ? ', kept stocked automatically' : ''}`;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-label={label}
      title={label}
      className={`flex h-8 shrink-0 items-center gap-1.5 rounded border px-2 text-xs ${tone} ${urgent ? 'motion-safe:animate-pulse' : ''} hover:border-slate-500`}
    >
      <Icon name={chip.key} size={14} className={chip.short ? 'text-rose-300' : 'text-slate-400'} />
      <span className="font-semibold tabular-nums">
        {compact(chip.amount)}
        {chip.cap !== null && <span className="font-normal text-slate-400">/{compact(chip.cap)}</span>}
      </span>
      {/* Below 1280 px the five chips with rates overflow the bar, so only a draining stock keeps its rate there. */}
      <span className={`tabular-nums ${chip.netPerDay < -0.5 ? 'text-rose-300' : `hidden xl:inline ${chip.netPerDay > 0.5 ? 'text-emerald-300' : 'text-slate-500'}`}`}>{formatRate(chip.netPerDay)}</span>
      {runsOut && <span className="hidden whitespace-nowrap text-[10px] text-rose-300 2xl:inline">out in {formatDays(chip.daysLeft ?? 0)}</span>}
      {chip.auto && <span className="hidden rounded bg-slate-700 px-1 text-[9px] uppercase tracking-wide text-slate-300 2xl:inline">auto</span>}
    </button>
  );
}
