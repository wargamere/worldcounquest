import { UNITS } from '@/next/game/balance';
import { UNIT_TYPES } from '@/next/game/types';
import type { Forecast, OrderWarning } from '@/next/game/types';
import { formatHours, pct } from '../ui/format';
import { Icon } from '../ui/Icon';
import { modifierChip, WARNING_TEXT } from '../ui/labels';
import { OddsBadge } from '../ui/OddsBadge';

/** The forecast (§5.10, §8.3): verdict, ≈ win chance, duration, HP kept, expected losses by type and modifier chips. */
export function ForecastBlock({ forecast, attacking = true }: { forecast: Forecast; attacking?: boolean }) {
  const keeps = attacking ? forecast.attackerKeeps : forecast.defenderKeeps;
  const losses = UNIT_TYPES.filter((u) => (forecast.attackerLosses[u] ?? 0) > 0);
  return (
    <div className="space-y-1.5 rounded border border-slate-700 bg-slate-900/70 p-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <OddsBadge verdict={forecast.verdict} winChance={forecast.winChance} fogged={forecast.fogged} />
        <span className="text-slate-300">{forecast.winner === 'undecided' ? 'longer than 4 days' : `about ${formatHours(forecast.hours)}`}</span>
        <span className="text-slate-300">keep about {pct(keeps)}</span>
      </div>
      {attacking && losses.length > 0 && (
        <p className="text-slate-400">
          Expected losses: {losses.map((u) => `${forecast.attackerLosses[u] ?? 0} ${UNITS[u].name}`).join(', ')}
        </p>
      )}
      {forecast.modifiers.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {forecast.modifiers.map((m, i) => (
            <span key={i} className={`rounded px-1.5 py-0.5 text-[10px] ${m.side === 'attacker' ? 'bg-sky-900/50 text-sky-200' : 'bg-slate-800 text-slate-300'}`} title={m.side === 'attacker' ? 'Attackers' : 'Defenders'}>
              {m.side === 'attacker' ? 'A' : 'D'} · {modifierChip(m.code, m.factor)}
            </span>
          ))}
        </div>
      )}
      {forecast.fogged && <p className="text-[11px] text-slate-500">Based on what you can see.</p>}
    </div>
  );
}

export function Warnings({ warnings }: { warnings: readonly OrderWarning[] }) {
  if (warnings.length === 0) return null;
  return (
    <ul className="space-y-0.5 text-[11px] text-amber-200">
      {warnings.map((w) => (
        <li key={w} className="flex items-start gap-1">
          <Icon name="warning" size={12} className="mt-0.5" />
          {WARNING_TEXT[w]}
        </li>
      ))}
    </ul>
  );
}
