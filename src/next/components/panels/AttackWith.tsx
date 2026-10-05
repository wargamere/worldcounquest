'use client';

import { useCallback } from 'react';
import type { ProvinceIx, Sim } from '@/next/game/types';
import { attackWithView, provinceView } from '@/next/game/views';
import { useGameStore, useSimView } from '@/next/store/gameStore';
import { act } from '../ui/act';
import { formatDuration } from '../ui/format';
import { Icon } from '../ui/Icon';
import { ForecastBlock, Warnings } from './ForecastBlock';

/** "Attack with…" (§4.6): your armies within 72 h, the suggested force pre-ticked, a live forecast and Attack. */
export function AttackWith() {
  const attackWith = useGameStore((s) => s.attackWith);
  if (attackWith === null) return null;
  return <AttackWithBody target={attackWith.target} picked={attackWith.picked} />;
}

function AttackWithBody({ target, picked }: { target: ProvinceIx; picked: readonly number[] }) {
  const data = useSimView(
    useCallback((sim: Sim) => {
      const p = provinceView(sim, target);
      return { rows: attackWithView(sim, target), name: p.name, owner: p.ownerName, colour: p.ownerColour };
    }, [target]),
  );
  const preview = useGameStore((s) => s.preview);
  if (data === null) return null;
  const directions = new Set(data.rows.filter((r) => picked.includes(r.army)).map((r) => r.direction)).size;
  return (
    <div className="space-y-3 p-3 text-xs">
      <header className="flex items-start justify-between">
        <div>
          <p className="text-[10px] uppercase tracking-wider text-slate-500">Attack with…</p>
          <h2 className="text-base font-semibold text-slate-50">{data.name}</h2>
          <p className="flex items-center gap-1 text-slate-400">
            <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: data.colour }} />
            {data.owner}
          </p>
        </div>
        <button type="button" aria-label="Close" onClick={() => act().cancel()} className="text-slate-500 hover:text-slate-200">
          <Icon name="close" size={16} />
        </button>
      </header>
      {data.rows.length === 0 && <p className="text-slate-400">None of your armies can reach it within 72 hours.</p>}
      <ul className="space-y-1" aria-label="Your armies in reach">
        {data.rows.map((r) => (
          <li key={r.army}>
            <label className="flex cursor-pointer items-center gap-2 rounded bg-slate-900 px-2 py-1.5 hover:bg-slate-800">
              <input type="checkbox" checked={picked.includes(r.army)} onChange={() => act().toggleAttackWith(r.army)} className="accent-amber-500" />
              <span className="flex-1 text-slate-100">
                {r.name}
                {r.suggested && <span className="ml-1 rounded bg-sky-900/60 px-1 text-[9px] uppercase text-sky-200">suggested</span>}
              </span>
              <span className="tabular-nums text-slate-400">{r.units} units</span>
              <span className="w-14 text-right tabular-nums text-slate-300">{formatDuration(r.etaTicks)}</span>
              {r.directionName !== null && <span className="max-w-[6rem] truncate rounded bg-slate-800 px-1 text-[10px] text-slate-300" title="Direction it attacks from">from {r.directionName}</span>}
            </label>
          </li>
        ))}
      </ul>
      {picked.length >= 2 && directions >= 2 && <p className="text-emerald-300">They arrive together from {directions} directions: +flank.</p>}
      {preview !== null && preview.to === target && preview.forecast !== null && <ForecastBlock forecast={preview.forecast} />}
      {preview !== null && preview.to === target && <Warnings warnings={preview.warnings} />}
      <button
        type="button"
        disabled={picked.length === 0}
        onClick={() => act().confirmAttackWith()}
        className="w-full rounded bg-rose-600 py-2 text-sm font-semibold text-white hover:bg-rose-500 disabled:opacity-40"
      >
        Attack with {picked.length} {picked.length === 1 ? 'army' : 'armies'}
      </button>
    </div>
  );
}
