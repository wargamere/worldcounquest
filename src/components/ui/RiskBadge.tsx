import { pct } from './format';

/**
 * A chance of something bad happening, as a status: icon, label and colour
 * together, so the meaning never rests on colour alone.
 */
export function RiskBadge({ chance, label }: { chance: number; label: string }) {
  const level = chance >= 0.5 ? 'critical' : chance >= 0.2 ? 'warning' : 'good';
  const style = {
    good: { icon: '✓', box: 'border-emerald-800 bg-emerald-950/50 text-emerald-200' },
    warning: { icon: '!', box: 'border-amber-800 bg-amber-950/50 text-amber-200' },
    critical: { icon: '✕', box: 'border-rose-800 bg-rose-950/60 text-rose-200' },
  }[level];
  return (
    <div className={`flex items-center justify-between gap-2 rounded border px-2 py-1 text-xs ${style.box}`}>
      <span className="flex items-center gap-1.5">
        <span aria-hidden className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-black/30 text-[10px] font-bold">
          {style.icon}
        </span>
        {label}
      </span>
      <span className="font-semibold tabular-nums">{pct(chance)}</span>
    </div>
  );
}
