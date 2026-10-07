'use client';

import { useRef } from 'react';
import { useGameStore } from '@/next/store/gameStore';
import { act } from '../ui/act';

type Snap = 'peek' | 'half' | 'full';
const HEIGHT: Readonly<Record<Snap, string>> = { peek: '96px', half: '50vh', full: 'calc(100% - 8px)' };
const ORDER: readonly Snap[] = ['peek', 'half', 'full'];
/** A swipe longer than this moves one snap. */
const SWIPE_PX = 40;

/** The phone bottom sheet (§8.6): peek 96 px, half 50vh, full to the top of the map area (the HUD above it stays); swipe the handle to change snaps. */
export function BottomSheet({ children, peek }: { children: React.ReactNode; peek: React.ReactNode }) {
  const sheet = useGameStore((s) => s.sheet);
  const start = useRef<number | null>(null);
  const move = (direction: 1 | -1): void => {
    const i = ORDER.indexOf(sheet);
    const next = ORDER[Math.min(ORDER.length - 1, Math.max(0, i + direction))];
    if (next !== undefined) act().setSheet(next);
  };
  return (
    <section
      className="absolute inset-x-0 bottom-0 z-30 flex flex-col rounded-t-2xl border-t border-slate-700 bg-slate-950 shadow-[0_-8px_24px_rgba(0,0,0,0.5)] transition-[height] duration-200"
      style={{ height: HEIGHT[sheet] }}
      aria-label="Details"
    >
      <div
        className="flex h-7 shrink-0 touch-none items-center justify-center"
        onPointerDown={(e) => {
          start.current = e.clientY;
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerUp={(e) => {
          if (start.current === null) return;
          const dy = e.clientY - start.current;
          start.current = null;
          if (dy < -SWIPE_PX) move(1);
          else if (dy > SWIPE_PX) move(-1);
          else move(sheet === 'peek' ? 1 : -1);
        }}
        role="button"
        tabIndex={0}
        aria-label="Resize the sheet"
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp') move(1);
          if (e.key === 'ArrowDown') move(-1);
        }}
      >
        <span className="h-1 w-10 rounded-full bg-slate-600" />
      </div>
      <div className="shrink-0 px-3 pb-2">{peek}</div>
      <div className={`min-h-0 flex-1 overflow-y-auto ${sheet === 'peek' ? 'hidden' : ''}`}>{children}</div>
    </section>
  );
}
