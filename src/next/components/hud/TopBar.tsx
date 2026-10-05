'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Sim } from '@/next/game/types';
import { hudView } from '@/next/game/views';
import { useGameStore, useSimView } from '@/next/store/gameStore';
import { act } from '../ui/act';
import { Icon } from '../ui/Icon';
import { BattleChip } from './BattleChip';
import { ChipRow } from './ChipRow';
import { IncomingChip } from './IncomingChip';
import { SpeedControl } from './SpeedControl';
import { VpRace } from './VpRace';

/** Desktop top bar (§8.1, 56 px): nation · clock · speed · stocks · VP race · Incoming · battles · Suggest · menu. */
export function TopBar() {
  const showAll = useGameStore((s) => s.prefs.showAllArmies);
  const hud = useSimView(useCallback((sim: Sim) => hudView(sim, showAll), [showAll]));
  if (hud === null) return null;
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-slate-800 bg-slate-950 px-3">
      <button type="button" onClick={() => act().focusHome()} className="flex items-center gap-2 rounded px-1 py-1 hover:bg-slate-900" title="Frame your nation (H)">
        <span aria-hidden className="h-3 w-3 rounded-full ring-2 ring-amber-400" style={{ background: hud.colour }} />
        <span className="max-w-[9rem] truncate text-sm font-semibold text-slate-100">{hud.nation}</span>
      </button>
      <span className="whitespace-nowrap text-sm font-medium tabular-nums text-slate-200" aria-live="off">
        {hud.clock}
      </span>
      <SpeedControl />
      <ChipRow />
      <div className="ml-auto flex items-center gap-2">
        <VpRace hud={hud} />
        <IncomingChip count={hud.incoming} />
        <BattleChip count={hud.battles} />
        <SuggestButton idle={hud.idle} />
        <GameMenu />
      </div>
    </header>
  );
}

export function SuggestButton({ idle, round = false }: { idle: number; round?: boolean }) {
  return (
    <button
      type="button"
      onClick={() => act().advise()}
      className={`relative flex items-center gap-1 border border-sky-600/70 bg-sky-950/50 text-sky-100 hover:border-sky-400 ${round ? 'h-12 w-12 justify-center rounded-full' : 'h-8 rounded px-2 text-xs font-semibold'}`}
      aria-label={`Suggest (A)${idle > 0 ? `, ${idle} idle armies` : ''}`}
      title="Suggest: the advisor's best moves (A)"
      data-coach="suggest"
    >
      <Icon name="suggest" size={round ? 20 : 14} />
      {!round && 'Suggest'}
      {idle > 0 && <span className="absolute -right-1.5 -top-1.5 grid h-4 min-w-[1rem] place-items-center rounded-full bg-sky-500 px-1 text-[10px] font-bold text-slate-950">{idle}</span>}
    </button>
  );
}

const MENU: readonly { label: string; key: string; run: () => void }[] = [
  { label: 'Economy', key: 'E', run: () => act().openPanel('economy') },
  { label: 'Exchange', key: 'X', run: () => act().openPanel('exchange') },
  { label: 'Production', key: 'P', run: () => act().openPanel('production') },
  { label: 'Great Powers', key: 'G', run: () => act().openPanel('powers') },
  { label: 'Feed', key: 'L', run: () => act().openPanel('feed') },
  { label: 'Delegate all idle armies', key: 'F', run: () => act().delegate('delegate', 'idle') },
  { label: 'Save now', key: 'Ctrl+S', run: () => act().saveNow() },
  { label: 'Help', key: '?', run: () => act().openPanel('help') },
  { label: 'Settings', key: '', run: () => act().openPanel('settings') },
  { label: 'Quit to the start screen', key: '', run: () => act().abandonGame() },
];

/** The ☰ menu: drawers, delegation, saving and quitting. */
export function GameMenu({ round = false }: { round?: boolean }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent): void => {
      if (box.current !== null && e.target instanceof Node && !box.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div ref={box} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Menu"
        onClick={() => setOpen(!open)}
        className={`grid place-items-center border border-slate-700 bg-slate-900 text-slate-200 hover:border-slate-500 ${round ? 'h-12 w-12 rounded-full' : 'h-8 w-8 rounded'}`}
      >
        <Icon name="menu" size={round ? 20 : 16} />
      </button>
      {open && (
        <ul role="menu" className={`absolute z-50 w-60 rounded-lg border border-slate-700 bg-slate-950/95 py-1 text-sm shadow-xl ${round ? 'right-full top-0 mr-2' : 'right-0 top-full mt-1'}`}>
          {MENU.map((item) => (
            <li key={item.label} role="none">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  item.run();
                }}
                className="flex w-full items-center justify-between px-3 py-2 text-left text-slate-200 hover:bg-slate-800"
              >
                {item.label}
                {item.key !== '' && <kbd className="text-[10px] text-slate-500">{item.key}</kbd>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
