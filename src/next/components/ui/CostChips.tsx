import { STOCK_KEYS } from '@/next/game/types';
import type { Cost } from '@/next/game/types';
import { compact } from './format';
import { Icon } from './Icon';

/** A cost as icon chips in stock order: "⛁ 400 ▱ 30". */
export function CostChips({ cost, scale = 1 }: { cost: Cost; scale?: number }) {
  const parts = STOCK_KEYS.filter((k) => (cost[k] ?? 0) > 0);
  if (parts.length === 0) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 text-[11px] tabular-nums text-slate-300">
      {parts.map((k) => (
        <span key={k} className="inline-flex items-center gap-0.5" title={k}>
          <Icon name={k} size={11} className="text-slate-500" />
          {compact((cost[k] ?? 0) * scale)}
        </span>
      ))}
    </span>
  );
}
