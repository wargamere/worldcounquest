'use client';

import { useGameStore } from '@/next/store/gameStore';
import { act } from '../ui/act';
import { ArmyPanel } from './ArmyPanel';
import { AttackWith } from './AttackWith';
import { BattlePanel } from './BattlePanel';
import { MultiArmyPanel } from './MultiArmyPanel';
import { OrderSheet } from './OrderSheet';
import { ProvincePanel } from './ProvincePanel';
import { SuggestionCard } from './SuggestionCard';

/** The context panel (§8.1): Suggest cards on top, then the order sheet, Attack with…, or the selection's panel. */
export function ContextPanel() {
  const selection = useGameStore((s) => s.selection);
  const draft = useGameStore((s) => s.draft);
  const attackWith = useGameStore((s) => s.attackWith);
  const rallyFrom = useGameStore((s) => s.rallyFrom);
  const multiSelect = useGameStore((s) => s.multiSelect);
  let body: React.ReactNode;
  if (draft !== null) body = <OrderSheet />;
  else if (attackWith !== null) body = <AttackWith />;
  else if (selection.kind === 'armies' && selection.armies.length === 1) body = <ArmyPanel army={selection.armies[0]!} />;
  else if (selection.kind === 'armies') body = <MultiArmyPanel armies={selection.armies} />;
  else if (selection.kind === 'province') body = <ProvincePanel province={selection.province} />;
  else if (selection.kind === 'battle') body = <BattlePanel province={selection.province} />;
  else body = <Hint />;
  return (
    <div>
      <SuggestionCard />
      {rallyFrom !== null && <p className="mx-3 mt-3 rounded border border-amber-600/60 bg-amber-950/30 p-2 text-xs text-amber-100">Tap the province new units should march to (Esc cancels).</p>}
      {multiSelect && (
        <div className="mx-3 mt-3 flex items-center gap-2 rounded border border-sky-600/60 bg-sky-950/30 p-2 text-xs text-sky-100">
          <span className="flex-1">
            {selection.kind === 'armies' ? `${selection.armies.length} ${selection.armies.length === 1 ? 'army' : 'armies'}` : 'No armies'} · tap markers to add or remove
          </span>
          <button type="button" onClick={() => act().setMultiSelect(false)} className="rounded bg-sky-500 px-2 py-1 font-semibold text-slate-950">
            Done
          </button>
        </div>
      )}
      {body}
    </div>
  );
}

function Hint() {
  return (
    <div className="space-y-2 p-3 text-xs leading-relaxed text-slate-400">
      <p>
        Your armies are the <span className="text-amber-300">gold-outlined</span> markers. Click one, then click a province to plan a move or an attack — or right-click to order at
        once.
      </p>
      <p>
        <kbd className="rounded border border-slate-700 px-1">Space</kbd> runs and pauses the clock. Orders work while paused. Press{' '}
        <kbd className="rounded border border-slate-700 px-1">A</kbd> for the advisor, <kbd className="rounded border border-slate-700 px-1">N</kbd> for the next idle army and{' '}
        <kbd className="rounded border border-slate-700 px-1">?</kbd> for help.
      </p>
    </div>
  );
}
