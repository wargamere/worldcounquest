'use client';

import { useCallback } from 'react';
import type { Sim } from '@/next/game/types';
import { historyView, standingsView } from '@/next/game/views';
import { useHeavySimView } from '@/next/store/gameStore';
import { act } from '../ui/act';
import { compact, pct } from '../ui/format';
import { HistoryChart } from './HistoryChart';

const TOP = 12;

/** Great Powers (G, §8.3): the history chart and the top 12 by VP with your row pinned; a row frames that nation. */
export function GreatPowers() {
  const data = useHeavySimView(useCallback((sim: Sim) => ({ chart: historyView(sim), rows: standingsView(sim, TOP), player: sim.state.player }), []));
  if (data === null) return null;
  return (
    <div className="space-y-3 text-xs">
      <HistoryChart chart={data.chart} />
      <table className="w-full tabular-nums">
        <thead className="text-[10px] uppercase tracking-wider text-slate-500">
          <tr>
            <th className="text-left font-medium">Nation</th>
            <th className="text-right font-medium">VP</th>
            <th className="text-right font-medium">Prov.</th>
            <th className="text-right font-medium">Units</th>
            <th className="text-right font-medium">Funds/d</th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row) => (
            <tr key={row.nation} className={`cursor-pointer border-t border-slate-800 hover:bg-slate-800/60 ${row.nation === data.player ? 'bg-amber-500/10' : ''}`} onClick={() => act().focusNation(row.nation)}>
              <td className="py-1 text-left">
                <span className="flex items-center gap-1.5 text-slate-100">
                  <span aria-hidden className="h-2.5 w-2.5 rounded-sm" style={{ background: row.colour }} />
                  {row.nation === data.player ? `${row.name} (you)` : row.name}
                </span>
              </td>
              <td className="text-right text-slate-200">
                {row.vp} <span className="text-slate-500">{pct(row.share)}</span>
              </td>
              <td className="text-right text-slate-300">{row.provinces}</td>
              <td className="text-right text-slate-300">{row.units}</td>
              <td className="text-right text-slate-300">{compact(row.fundsPerDay)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
