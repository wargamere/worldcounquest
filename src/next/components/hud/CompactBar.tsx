'use client';

import { useCallback, useRef, useState } from 'react';
import { RENDER } from '@/next/game/balance';
import type { Sim } from '@/next/game/types';
import { hudView } from '@/next/game/views';
import { useGameStore, useSimView } from '@/next/store/gameStore';
import { act } from '../ui/act';
import { Icon } from '../ui/Icon';
import { SpeedControl } from './SpeedControl';
import { VpRace } from './VpRace';

const CYCLE = [1, 2, 4, 8] as const;

/** Phone top bar (§8.6, 48 px): a large play/pause, a speed chip (tap cycles, long-press shows all), the clock and a thin VP bar. */
export function CompactBar() {
  const showAll = useGameStore((s) => s.prefs.showAllArmies);
  const hud = useSimView(useCallback((sim: Sim) => hudView(sim, showAll), [showAll]));
  const speed = useGameStore((s) => s.speed);
  const resume = useGameStore((s) => s.resumeSpeed);
  const throttled = useGameStore((s) => s.throttled);
  const effective = useGameStore((s) => s.effectiveSpeed);
  const [all, setAll] = useState(false);
  const press = useRef<ReturnType<typeof setTimeout> | null>(null);
  const long = useRef(false);
  if (hud === null) return null;
  const shown = speed === 0 ? resume : speed;
  const cycle = (): void => {
    const i = CYCLE.indexOf(shown);
    act().setSpeed(CYCLE[(i + 1) % CYCLE.length] ?? 1);
  };
  return (
    <header className="relative shrink-0 border-b border-slate-800 bg-slate-950">
      <div className="flex h-12 items-center gap-2 px-2">
        <button
          type="button"
          onClick={() => act().togglePause()}
          aria-label={speed === 0 ? 'Resume' : 'Pause'}
          data-coach="speed"
          className={`grid h-11 w-11 place-items-center rounded-full ${speed === 0 ? 'bg-amber-500 text-slate-950' : 'bg-slate-800 text-slate-100'}`}
        >
          <Icon name={speed === 0 ? 'play' : 'pause'} size={22} />
        </button>
        <button
          type="button"
          onPointerDown={() => {
            long.current = false;
            press.current = setTimeout(() => {
              long.current = true;
              setAll(true);
            }, RENDER.LONG_PRESS_MS);
          }}
          onPointerUp={() => {
            if (press.current !== null) clearTimeout(press.current);
            if (!long.current) cycle();
          }}
          onPointerLeave={() => {
            if (press.current !== null) clearTimeout(press.current);
          }}
          aria-label={`Speed ${shown}×; tap for faster, hold for all speeds`}
          className="h-11 min-w-[3.25rem] rounded-full border border-slate-700 px-2 text-sm font-semibold tabular-nums text-slate-100"
        >
          {shown}×{throttled && speed !== 0 && <span className="ml-0.5 text-[10px] text-amber-300">({effective.toFixed(1)})</span>}
        </button>
        <span className="text-sm font-medium tabular-nums text-slate-200">{hud.clock}</span>
        <span aria-hidden className="ml-auto h-3 w-3 rounded-full ring-2 ring-amber-400" style={{ background: hud.colour }} />
      </div>
      <div className="px-2 pb-1">
        <VpRace hud={hud} thin />
      </div>
      {all && (
        <div className="absolute left-2 top-full z-50 mt-1 rounded-lg border border-slate-700 bg-slate-950 p-1 shadow-xl" onClick={() => setAll(false)}>
          <SpeedControl />
        </div>
      )}
    </header>
  );
}
