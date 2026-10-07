'use client';

import { useCallback, useState } from 'react';
import { BUILDINGS } from '@/next/game/balance';
import { STOCK_LABELS } from '@/next/game/economy';
import { BUILDING_TYPES, STOCK_KEYS } from '@/next/game/types';
import type { BuildingType, Sim } from '@/next/game/types';
import { bestBuildView, economyView } from '@/next/game/views';
import { playerNation, useHeavySimView } from '@/next/store/gameStore';
import { act } from '../ui/act';
import { CostChips } from '../ui/CostChips';
import { formatDays, formatRate, whole } from '../ui/format';
import { Icon } from '../ui/Icon';
import { Stepper } from '../ui/Stepper';

const MAX_BEST = 10;

/** Economy (E, §8.3): per stock produced, consumed, net and days left; top producers; buildings; Build in best N. */
export function EconomyPanel() {
  const data = useHeavySimView(
    useCallback((sim: Sim) => {
      const view = economyView(sim);
      return { view, names: view.topProducers.map((p) => sim.map.provinces[p.province]!.name) };
    }, []),
  );
  if (data === null) return null;
  const { view, names } = data;
  return (
    <div className="space-y-4 text-xs">
      <table className="w-full text-right tabular-nums">
        <thead className="text-[10px] uppercase tracking-wider text-slate-500">
          <tr>
            <th className="text-left font-medium">Stock</th>
            <th className="font-medium">Produced</th>
            <th className="font-medium">Consumed</th>
            <th className="font-medium">Net</th>
            <th className="font-medium">Lasts</th>
          </tr>
        </thead>
        <tbody>
          {STOCK_KEYS.map((k) => {
            const days = view.days[k] ?? null;
            return (
              <tr key={k} className="border-t border-slate-800">
                <td className="py-1 text-left text-slate-200">
                  <Icon name={k} size={12} className="mr-1 text-slate-500" />
                  {STOCK_LABELS[k]}
                </td>
                <td className="text-slate-300">{formatRate(view.rates.income[k])}</td>
                <td className="text-slate-300">{formatRate(-view.rates.upkeep[k])}</td>
                <td className={view.rates.net[k] < -0.5 ? 'text-rose-300' : 'text-emerald-300'}>{formatRate(view.rates.net[k])}</td>
                <td className="text-slate-400">{days === null ? '—' : formatDays(days)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <section>
        <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Top producers (Funds)</h3>
        <ol className="space-y-0.5">
          {view.topProducers.map((p, i) => (
            <li key={p.province} className="flex justify-between">
              <button type="button" onClick={() => act().showProvince(p.province)} className="text-slate-200 hover:text-white">
                {names[i]}
              </button>
              <span className="tabular-nums text-slate-400">
                {formatRate(p.funds)} Funds · {formatRate(p.goods)} {STOCK_LABELS[p.good]}
              </span>
            </li>
          ))}
        </ol>
      </section>
      <section>
        <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Building levels</h3>
        <p className="text-slate-300">{BUILDING_TYPES.map((b) => `${BUILDINGS[b].name} ${view.buildingCounts[b]}`).join(' · ')}</p>
      </section>
      <BestN />
    </div>
  );
}

/** "Build in best N": pick a building, see provinces ranked by daily gain per Funds, pick N, queue. */
function BestN() {
  const [building, setBuilding] = useState<BuildingType>('works');
  const [count, setCount] = useState(3);
  const rows = useHeavySimView(useCallback((sim: Sim) => bestBuildView(sim, building, MAX_BEST), [building]));
  if (rows === null) return null;
  const chosen = rows.slice(0, count);
  const queue = (): void => {
    const nation = playerNation();
    if (nation === null) return;
    for (const row of chosen) if (row.preview.reason === null && !act().command({ kind: 'build', nation, province: row.province, building }).ok) break;
  };
  return (
    <section className="space-y-2 rounded border border-slate-800 p-2">
      <h3 className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Build in the best provinces</h3>
      <div className="flex flex-wrap items-center gap-2">
        <select value={building} onChange={(e) => setBuilding(e.target.value as BuildingType)} className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-slate-100" aria-label="Building">
          {BUILDING_TYPES.map((b) => (
            <option key={b} value={b}>
              {b === 'works' ? 'Works (Farms, Mines, Oil Wells)' : BUILDINGS[b].name}
            </option>
          ))}
        </select>
        <Stepper value={count} min={1} max={MAX_BEST} label="provinces" onChange={setCount} />
      </div>
      {rows.length === 0 && <p className="text-slate-500">Nowhere to build that right now.</p>}
      <ol className="space-y-1">
        {rows.map((row, i) => (
          <li key={row.province} className={`flex items-center gap-2 rounded px-1.5 py-1 ${i < count ? 'bg-slate-800/70' : 'opacity-60'}`}>
            <span className="w-4 text-slate-500">{i + 1}</span>
            <span className="flex-1 truncate text-slate-100">
              {row.label} {row.preview.level} · {row.name}
            </span>
            <CostChips cost={row.preview.cost} />
            {row.preview.paybackDays !== null && <span className="text-emerald-300">{Math.ceil(row.preview.paybackDays)} d</span>}
            {row.preview.reason !== null && <span className="max-w-[8rem] truncate text-[10px] text-slate-500" title={row.preview.reason}>{row.preview.reason}</span>}
          </li>
        ))}
      </ol>
      <button type="button" disabled={chosen.every((r) => r.preview.reason !== null)} onClick={queue} className="w-full rounded bg-slate-200 py-1.5 font-semibold text-slate-950 hover:bg-white disabled:opacity-40">
        Queue {chosen.filter((r) => r.preview.reason === null).length} of {whole(chosen.length)}
      </button>
    </section>
  );
}
