'use client';

import { useGameStore } from '@/next/store/gameStore';
import { act } from '../ui/act';

/** Top centre: why the game is paused, the two-tab guard and the one-time legacy note (§8.2, §10). */
export function PausedBanner() {
  const speed = useGameStore((s) => s.speed);
  const reason = useGameStore((s) => s.pausedReason);
  const tabLost = useGameStore((s) => s.tabLost);
  const legacy = useGameStore((s) => s.legacyNote);
  const warning = useGameStore((s) => s.saveWarning);
  return (
    <div className="pointer-events-none absolute inset-x-0 top-2 z-30 flex flex-col items-center gap-1 px-3">
      {tabLost && (
        <div role="alert" className="pointer-events-auto flex items-center gap-3 rounded-lg border border-amber-500/70 bg-slate-950/95 px-3 py-2 text-xs text-amber-100 shadow-lg">
          This game is open in another tab.
          <button type="button" onClick={() => act().takeOverTab()} className="rounded bg-amber-500 px-2 py-1 font-semibold text-slate-950 hover:bg-amber-400">
            Take over
          </button>
        </div>
      )}
      {!tabLost && speed === 0 && reason !== null && (
        <div role="status" className="pointer-events-auto rounded-lg border border-slate-600 bg-slate-950/95 px-3 py-1.5 text-xs font-medium text-slate-100 shadow-lg">
          {reason}
        </div>
      )}
      {legacy && (
        <div role="status" className="pointer-events-auto flex items-center gap-3 rounded-lg border border-sky-600/60 bg-slate-950/95 px-3 py-1.5 text-xs text-sky-100 shadow-lg">
          Hegemon is now real-time — turn-based saves can&apos;t be continued.
          <button type="button" onClick={() => act().dismissLegacyNote()} className="text-sky-300 hover:text-sky-100">
            OK
          </button>
        </div>
      )}
      {warning !== null && warning !== 'notOwner' && (
        <div role="alert" className="pointer-events-auto rounded-lg border border-rose-600/60 bg-slate-950/95 px-3 py-1.5 text-xs text-rose-100 shadow-lg">
          The last save failed ({warning === 'quota' ? 'storage is full' : 'storage is blocked'}); your previous save is kept.
        </div>
      )}
    </div>
  );
}
