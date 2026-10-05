'use client';

import { useState } from 'react';
import { UNITS } from '@/next/game/balance';
import { UNIT_TYPES } from '@/next/game/types';
import type { ArmyId, UnitCounts, Units } from '@/next/game/types';
import { playerNation } from '@/next/store/gameStore';
import { act } from '../ui/act';
import { Stepper } from '../ui/Stepper';

/** Half of every type, rounded down; an army of single units gives up its last type instead. */
export function halfOf(units: Units): UnitCounts {
  const take: UnitCounts = {};
  let total = 0;
  for (const u of UNIT_TYPES) {
    const half = Math.floor(units[u].count / 2);
    if (half > 0) take[u] = half;
    total += half;
  }
  if (total > 0) return take;
  const present = UNIT_TYPES.filter((u) => units[u].count > 0);
  const last = present[present.length - 1];
  return present.length >= 2 && last !== undefined ? { [last]: units[last].count } : {};
}

/** Split (§4.3): whole units per type move to a new army; HP moves proportionally. */
export function SplitSheet({ army, units, onDone }: { army: ArmyId; units: Units; onDone: () => void }) {
  const [take, setTake] = useState<UnitCounts>(() => halfOf(units));
  const total = UNIT_TYPES.reduce((sum, u) => sum + (take[u] ?? 0), 0);
  const all = UNIT_TYPES.reduce((sum, u) => sum + units[u].count, 0);
  const split = (): void => {
    const nation = playerNation();
    if (nation === null) return;
    const result = act().command({ kind: 'split', nation, army, take });
    if (result.ok) onDone();
  };
  return (
    <div className="space-y-2 rounded border border-slate-700 bg-slate-900 p-2 text-xs">
      {UNIT_TYPES.filter((u) => units[u].count > 0).map((u) => (
        <div key={u} className="flex items-center justify-between">
          <span className="text-slate-200">{UNITS[u].name}</span>
          <Stepper value={take[u] ?? 0} min={0} max={units[u].count} label={UNITS[u].name} format={(v) => `${v} / ${units[u].count}`} onChange={(v) => setTake({ ...take, [u]: v })} />
        </div>
      ))}
      <div className="flex gap-2">
        <button type="button" onClick={() => setTake(halfOf(units))} className="rounded border border-slate-600 px-2 py-1 text-slate-200 hover:border-slate-400">
          Split half
        </button>
        <button type="button" disabled={total === 0 || total >= all} onClick={split} className="ml-auto rounded bg-slate-200 px-2 py-1 font-semibold text-slate-950 hover:bg-white disabled:opacity-40">
          Split off {total}
        </button>
        <button type="button" onClick={onDone} className="rounded px-2 py-1 text-slate-400 hover:text-slate-200">
          Cancel
        </button>
      </div>
    </div>
  );
}
