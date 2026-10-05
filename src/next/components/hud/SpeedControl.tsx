'use client';

import { TIME } from '@/next/game/balance';
import type { Speed } from '@/next/game/types';
import { useGameStore } from '@/next/store/gameStore';
import { act } from '../ui/act';
import { Icon } from '../ui/Icon';

/** ⏸ 1× 2× 4× 8×, with the effective speed when the sim cannot keep up (§1, §8.2). */
export function SpeedControl() {
  const speed = useGameStore((s) => s.speed);
  const throttled = useGameStore((s) => s.throttled);
  const effective = useGameStore((s) => s.effectiveSpeed);
  return (
    <div className="flex items-center gap-0.5 rounded border border-slate-700 bg-slate-900 p-0.5" role="group" aria-label="Game speed" data-coach="speed">
      {TIME.SPEEDS.map((s: Speed) => (
        <button
          key={s}
          type="button"
          aria-pressed={speed === s}
          aria-label={s === 0 ? 'Pause' : `Speed ${s}×`}
          onClick={() => act().setSpeed(s)}
          className={`grid h-7 min-w-[2rem] place-items-center rounded px-1.5 text-xs font-semibold tabular-nums ${
            speed === s ? 'bg-amber-500 text-slate-950' : 'text-slate-300 hover:bg-slate-800'
          }`}
        >
          {s === 0 ? <Icon name="pause" size={14} /> : `${s}×`}
        </button>
      ))}
      {throttled && speed !== 0 && (
        <span className="px-1 text-[11px] tabular-nums text-amber-300" title="The simulation runs slower than requested on this device">
          ({effective.toFixed(1)}×)
        </span>
      )}
    </div>
  );
}
