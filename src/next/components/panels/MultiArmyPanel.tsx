'use client';

import { useCallback } from 'react';
import type { ArmyId, Sim, Stance } from '@/next/game/types';
import { armyView } from '@/next/game/views';
import { playerNation, useGameStore, useSimView } from '@/next/store/gameStore';
import { act } from '../ui/act';
import { formatDuration, whole } from '../ui/format';
import { Icon } from '../ui/Icon';
import { STANCE_TEXT } from '../ui/labels';
import { Action } from './ArmyPanel';

const STANCES: readonly Stance[] = ['manual', 'defend', 'delegate'];

/** Several armies (§8.3): totals, the list with ETAs, Merge all when co-located; ordered together they arrive together. */
export function MultiArmyPanel({ armies }: { armies: readonly ArmyId[] }) {
  const view = useSimView(useCallback((sim: Sim) => armyView(sim, armies), [armies]));
  const multiSelect = useGameStore((s) => s.multiSelect);
  if (view === null) return <p className="p-3 text-xs text-slate-500">These armies are gone.</p>;
  const nation = playerNation();
  return (
    <div className="space-y-3 p-3 text-xs">
      <header className="flex items-start justify-between">
        <div>
          <h2 className="text-base font-semibold text-slate-50">{view.name}</h2>
          <p className="text-slate-400">
            {view.totalUnits} units · {whole(view.hp)} / {whole(view.maxHp)} HP · {view.status}
          </p>
        </div>
        <button type="button" aria-label="Close" onClick={() => act().cancel()} className="text-slate-500 hover:text-slate-200">
          <Icon name="close" size={16} />
        </button>
      </header>
      <ul className="space-y-1">
        {view.rows.map((r) => (
          <li key={r.id}>
            <button type="button" onClick={() => act().selectArmies([r.id])} className="flex w-full items-center gap-2 rounded bg-slate-900 px-2 py-1 text-left hover:bg-slate-800">
              <span className="font-medium text-slate-100">{r.name}</span>
              <span className="tabular-nums text-slate-400">{r.units}</span>
              <span className="ml-auto truncate text-[11px] text-slate-500">{r.eta === null ? r.status : `${formatDuration(r.eta)} · ${r.status}`}</span>
            </button>
          </li>
        ))}
      </ul>
      {view.ours && nation !== null && (
        <>
          <p className="text-[11px] text-slate-500">Click a province to order them all; they arrive together by default.</p>
          <div className="flex items-center gap-1" role="group" aria-label="Stance for all">
            {STANCES.map((s) => (
              <button key={s} type="button" onClick={() => act().command({ kind: 'stance', nation, armies: view.ids, stance: s })} className="flex-1 rounded border border-slate-700 px-2 py-1 text-slate-300 hover:border-slate-500">
                All {STANCE_TEXT[s]}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {view.canMerge && <Action label="Merge all" onClick={() => act().command({ kind: 'merge', nation, armies: view.ids })} />}
            {view.moving && <Action label="Stop all" onClick={() => act().command({ kind: 'stop', nation, armies: view.ids })} />}
            {view.inBattle && <Action label="Retreat (−10%)" tone="warn" onClick={() => act().command({ kind: 'retreat', nation, armies: view.ids, to: null })} />}
            <Action label={multiSelect ? 'Done adding' : '+ Add armies'} onClick={() => act().setMultiSelect(!multiSelect)} />
          </div>
        </>
      )}
    </div>
  );
}
