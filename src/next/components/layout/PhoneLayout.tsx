'use client';

import { useCallback } from 'react';
import type { Sim } from '@/next/game/types';
import { armyView, orderView, provinceView } from '@/next/game/views';
import { useGameStore, useSimView, type GameStore } from '@/next/store/gameStore';
import { Toasts } from '../feed/Toasts';
import { ChipRow } from '../hud/ChipRow';
import { CompactBar } from '../hud/CompactBar';
import { PausedBanner } from '../hud/PausedBanner';
import { ContextPanel } from '../panels/ContextPanel';
import { Coach } from '../screens/Coach';
import { act } from '../ui/act';
import { Icon } from '../ui/Icon';
import { BottomSheet } from './BottomSheet';
import { Drawers } from './Drawers';
import { FloatingButtons } from './FloatingButtons';
import { MapArea } from './MapArea';

/** Phones (§8.6): compact bar, chip row, the map, floating buttons and a bottom sheet (a 320 px side drawer when held sideways). */
export function PhoneLayout({ landscape }: { landscape: boolean }) {
  const hasContent = useGameStore((s) => s.selection.kind !== 'none' || s.draft !== null || s.attackWith !== null || s.suggestions.length > 0 || s.rallyFrom !== null);
  return (
    <div className="flex h-full flex-col">
      <CompactBar />
      <div className="h-10 shrink-0 border-b border-slate-800 bg-slate-950 px-2 py-1">
        <ChipRow withAlerts />
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <MapArea phone />
        <PausedBanner />
        <Toasts bottom={!landscape} />
        <FloatingButtons />
        <Coach phone />
        {hasContent &&
          (landscape ? (
            <aside className="absolute inset-y-0 left-0 z-30 w-80 overflow-y-auto border-r border-slate-700 bg-slate-950" aria-label="Details">
              <ContextPanel />
            </aside>
          ) : (
            <BottomSheet peek={<Peek />}>
              <ContextPanel />
            </BottomSheet>
          ))}
        <Drawers phone />
      </div>
    </div>
  );
}

type PeekState = Pick<GameStore, 'selection' | 'draft' | 'attackWith' | 'preview'>;

/** The sheet's peek (96 px): the selection's title and its primary action (Attack / Move / Build / Train). */
function Peek() {
  const selection = useGameStore((s) => s.selection);
  const draft = useGameStore((s) => s.draft);
  const attackWith = useGameStore((s) => s.attackWith);
  const preview = useGameStore((s) => s.preview);
  const title = useSimView(useCallback((sim: Sim) => peekTitle(sim, { selection, draft, attackWith, preview }), [selection, draft, attackWith, preview]));
  const button = 'rounded px-4 py-2.5 text-sm font-semibold';
  let primary: React.ReactNode = null;
  if (draft !== null && preview !== null) {
    primary = (
      <button type="button" onClick={() => act().confirmDraft()} className={`${button} ${preview.intent === 'attack' ? 'bg-rose-600 text-white' : 'bg-slate-200 text-slate-950'}`}>
        {preview.intent === 'attack' ? 'Attack' : 'Move'}
      </button>
    );
  } else if (attackWith !== null) {
    primary = (
      <button type="button" disabled={attackWith.picked.length === 0} onClick={() => act().confirmAttackWith()} className={`${button} bg-rose-600 text-white disabled:opacity-40`}>
        Attack
      </button>
    );
  } else if (selection.kind === 'province' && title?.foreign === true) {
    primary = (
      <button type="button" onClick={() => act().openAttackWith(selection.province)} className={`${button} bg-rose-600 text-white`}>
        Attack with…
      </button>
    );
  } else if (selection.kind === 'province') {
    primary = (
      <button type="button" onClick={() => act().setSheet('half')} className={`${button} bg-slate-200 text-slate-950`}>
        {title?.training === true ? 'Train' : 'Build'}
      </button>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-slate-100">{title?.text ?? ''}</p>
        {selection.kind === 'armies' && draft === null && <p className="text-[11px] text-slate-400">Tap a province to order</p>}
      </div>
      {primary}
      <button type="button" onClick={() => act().cancel()} aria-label="Close" className="grid h-11 w-11 place-items-center rounded text-slate-400">
        <Icon name="close" size={16} />
      </button>
    </div>
  );
}

function peekTitle(sim: Sim, s: PeekState): { text: string; foreign: boolean; training: boolean } {
  if (s.draft !== null && s.preview !== null) return { text: orderView(sim, s.preview).targetName, foreign: false, training: false };
  if (s.attackWith !== null) return { text: `Attack ${sim.map.provinces[s.attackWith.target]?.name ?? ''}`, foreign: true, training: false };
  if (s.selection.kind === 'armies') return { text: armyView(sim, s.selection.armies)?.name ?? '', foreign: false, training: false };
  if (s.selection.kind === 'province' || s.selection.kind === 'battle') {
    const p = provinceView(sim, s.selection.province);
    return { text: s.selection.kind === 'battle' ? `Battle · ${p.name}` : p.name, foreign: p.foreign, training: p.trainingLevel > 0 };
  }
  return { text: '', foreign: false, training: false };
}
