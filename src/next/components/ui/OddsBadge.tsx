import type { Verdict } from '@/next/game/types';
import { VERDICT_LABEL } from '@/next/game/views';
import { pct5 } from './format';

const STYLE: Readonly<Record<Verdict, string>> = {
  decisive: 'border-emerald-400/60 bg-emerald-500/15 text-emerald-200',
  likely: 'border-lime-400/60 bg-lime-500/15 text-lime-200',
  close: 'border-amber-400/60 bg-amber-500/15 text-amber-200',
  unlikely: 'border-orange-400/60 bg-orange-500/15 text-orange-200',
  hopeless: 'border-rose-400/60 bg-rose-500/15 text-rose-200',
};

/** The verdict chip (§5.10): the band in words, optionally with the figure rounded to 5%. */
export function OddsBadge({ verdict, winChance, fogged = false }: { verdict: Verdict; winChance?: number; fogged?: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded border px-1.5 py-0.5 text-[11px] font-semibold ${STYLE[verdict]}`}
      title={fogged ? 'Based on what you can see' : undefined}
    >
      {VERDICT_LABEL[verdict]}
      {winChance !== undefined && <span className="font-normal tabular-nums opacity-90">≈ {pct5(winChance)}</span>}
      {fogged && <span aria-label="based on what you can see">?</span>}
    </span>
  );
}
