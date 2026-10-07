'use client';

import { useCallback } from 'react';
import { UNITS } from '@/next/game/balance';
import type { Sim } from '@/next/game/types';
import { constructionsView, productionView } from '@/next/game/views';
import { playerNation, useHeavySimView } from '@/next/store/gameStore';
import { act } from '../ui/act';
import { Meter } from '../ui/Meter';

/** Production (P, §8.3): every Training Ground in one table, plus every construction in progress. */
export function ProductionPanel() {
  const data = useHeavySimView(
    useCallback((sim: Sim) => {
      const name = (p: number): string => sim.map.provinces[p]?.name ?? '';
      return {
        grounds: productionView(sim).map((row) => ({ ...row, name: name(row.province), rallyName: row.rally === null ? null : name(row.rally) })),
        builds: constructionsView(sim),
      };
    }, []),
  );
  if (data === null) return null;
  const nation = playerNation();
  return (
    <div className="space-y-4 text-xs">
      <section>
        <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Training Grounds</h3>
        {data.grounds.length === 0 && <p className="text-slate-500">You have no Training Ground.</p>}
        <table className="w-full">
          <tbody>
            {data.grounds.map((g) => {
              const head = g.queue[0];
              return (
                <tr key={g.province} className="border-t border-slate-800 align-middle">
                  <td className="py-1.5">
                    <button type="button" onClick={() => act().showProvince(g.province)} className="text-left text-slate-100 hover:text-white">
                      {g.name}
                    </button>
                    <span className="block text-[10px] text-slate-500">level {g.level}</span>
                  </td>
                  <td className="w-32 px-2">
                    {head === undefined ? (
                      <span className="text-slate-500">idle</span>
                    ) : (
                      <>
                        <span className="text-slate-300">{UNITS[head.unit].name}</span>
                        <Meter value={head.hoursTotal - head.hoursLeft} max={head.hoursTotal} label={`${UNITS[head.unit].name} progress`} height={4} />
                      </>
                    )}
                    {g.queue.length > 1 && <span className="text-[10px] text-slate-500">+{g.queue.length - 1} queued</span>}
                  </td>
                  <td className="px-1 text-center">
                    <label className="flex items-center gap-1 text-[11px] text-slate-400">
                      <input
                        type="checkbox"
                        checked={g.keepTraining}
                        onChange={(e) => {
                          if (nation !== null) act().command({ kind: 'keepTraining', nation, province: g.province, on: e.target.checked });
                        }}
                        className="accent-amber-500"
                      />
                      keep
                    </label>
                  </td>
                  <td className="px-1 text-[11px] text-slate-400">{g.rallyName === null ? '' : `→ ${g.rallyName}`}</td>
                  <td className="text-right">
                    <button
                      type="button"
                      onClick={() => {
                        if (nation !== null) act().command({ kind: 'train', nation, province: g.province, unit: 'rifles', count: 1 });
                      }}
                      className="rounded border border-slate-600 px-1.5 py-0.5 text-[11px] text-slate-200 hover:border-slate-400"
                    >
                      +1 Rifles
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
      <section>
        <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Construction</h3>
        {data.builds.length === 0 && <p className="text-slate-500">Nothing is being built.</p>}
        <ul className="space-y-1.5">
          {data.builds.map((b) => (
            <li key={b.province}>
              <div className="flex justify-between">
                <button type="button" onClick={() => act().showProvince(b.province)} className="text-slate-100 hover:text-white">
                  {b.label} {b.construction.level} · {b.name}
                </button>
                <span className="tabular-nums text-slate-400">{Math.ceil(b.construction.hoursLeft)} h</span>
              </div>
              <Meter value={b.construction.hoursTotal - b.construction.hoursLeft} max={b.construction.hoursTotal} label={`${b.label} progress`} height={4} />
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
