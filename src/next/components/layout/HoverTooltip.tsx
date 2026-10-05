'use client';

import { useCallback, useEffect, useRef } from 'react';
import { TERRAIN } from '@/next/game/balance';
import { STOCK_LABELS } from '@/next/game/economy';
import type { ProvinceIx, Sim } from '@/next/game/types';
import { tooltipView } from '@/next/game/views';
import { useGameStore, useSimView } from '@/next/store/gameStore';
import { formatDuration, whole } from '../ui/format';
import { Icon } from '../ui/Icon';
import { STATUS_TEXT } from '../ui/labels';
import { OddsBadge } from '../ui/OddsBadge';

const OFFSET_PX = 16;

/** The hover tooltip (§4.7): the province, its owner and garrison, and with armies selected the route ETA and forecast. */
export function HoverTooltip() {
  const hover = useGameStore((s) => s.hover);
  const showAll = useGameStore((s) => s.prefs.showAllArmies);
  const preview = useGameStore((s) => s.preview);
  const box = useRef<HTMLDivElement>(null);
  // Follows the pointer without re-rendering: the position is written straight to the element.
  useEffect(() => {
    const onMove = (e: PointerEvent): void => {
      const el = box.current;
      if (el === null || el.parentElement === null) return;
      const host = el.parentElement.getBoundingClientRect();
      const x = e.clientX - host.left + OFFSET_PX;
      const y = e.clientY - host.top + OFFSET_PX;
      el.style.transform = `translate(${Math.min(x, host.width - el.offsetWidth - 8)}px, ${Math.min(y, host.height - el.offsetHeight - 8)}px)`;
    };
    window.addEventListener('pointermove', onMove);
    return () => window.removeEventListener('pointermove', onMove);
  }, []);
  const view = useSimView(useCallback((sim: Sim) => (hover === null ? null : tooltipView(sim, hover, showAll)), [hover, showAll]));
  return (
    <div ref={box} className={`pointer-events-none absolute left-0 top-0 z-20 max-w-[16rem] rounded border border-slate-700 bg-slate-950/95 px-2 py-1.5 text-[11px] text-slate-300 shadow-lg ${view === null ? 'hidden' : ''}`}>
      {view !== null && <TooltipBody view={view} />}
      {view !== null && preview !== null && preview.to === hover && (
        <div className="mt-1 flex items-center gap-1.5 border-t border-slate-800 pt-1">
          <span>
            {preview.intent === 'attack' ? 'Attack' : 'Move'} · {formatDuration(preview.arriveInTicks)}
          </span>
          {preview.forecast !== null && <OddsBadge verdict={preview.forecast.verdict} winChance={preview.forecast.winChance} fogged={preview.forecast.fogged} />}
        </div>
      )}
    </div>
  );
}

function TooltipBody({ view }: { view: ReturnType<typeof tooltipView> }) {
  return (
    <>
      <p className="font-semibold text-slate-100">{view.name}</p>
      <p>
        {view.owner} · {STATUS_TEXT[view.status]} · {TERRAIN[view.terrain].label} ·{' '}
        <Icon name={view.good} size={10} /> {STOCK_LABELS[view.good]}
      </p>
      <p>
        Garrison {whole(view.garrison)} HP{view.visibleUnits > 0 && ` · ${view.visibleUnits} units seen`}
      </p>
    </>
  );
}

/** Long-press on a province (touch): its details without losing the selection. */
export function ProvinceInfoCard({ province, onClose }: { province: ProvinceIx; onClose: () => void }) {
  const showAll = useGameStore((s) => s.prefs.showAllArmies);
  const view = useSimView(useCallback((sim: Sim) => tooltipView(sim, province, showAll), [province, showAll]));
  if (view === null) return null;
  return (
    <div className="absolute left-1/2 top-3 z-30 w-64 -translate-x-1/2 rounded-lg border border-slate-700 bg-slate-950/95 p-2 text-xs text-slate-300 shadow-xl" role="dialog" aria-label={view.name}>
      <div className="flex items-start justify-between">
        <div>
          <TooltipBody view={view} />
        </div>
        <button type="button" aria-label="Close" onClick={onClose} className="grid h-8 w-8 place-items-center text-slate-500">
          <Icon name="close" size={14} />
        </button>
      </div>
    </div>
  );
}
