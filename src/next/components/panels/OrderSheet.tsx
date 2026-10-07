'use client';

import { useCallback } from 'react';
import type { OrderPreview, Sim } from '@/next/game/types';
import { orderView } from '@/next/game/views';
import { useGameStore, useSimView } from '@/next/store/gameStore';
import { act } from '../ui/act';
import { formatDuration } from '../ui/format';
import { ForecastBlock, Warnings } from './ForecastBlock';

/** The order sheet (§8.3): routes with ETAs and departure delays, flank directions, the forecast, warnings, Cancel and Attack / Move. */
export function OrderSheet() {
  const draft = useGameStore((s) => s.draft);
  const preview = useGameStore((s) => s.preview);
  if (draft === null || preview === null) return null;
  return <OrderBody preview={preview} together={draft.together} append={draft.append} />;
}

function OrderBody({ preview, together, append }: { preview: OrderPreview; together: boolean; append: boolean }) {
  const view = useSimView(useCallback((sim: Sim) => orderView(sim, preview), [preview]));
  if (view === null) return null;
  const noRoute = preview.warnings.includes('noRoute') || preview.routes.length === 0;
  const groups = new Set<string>();
  return (
    <div className="space-y-3 p-3 text-xs">
      <header>
        <p className="text-[10px] uppercase tracking-wider text-slate-500">{view.verb === 'Attack' ? 'Attack' : 'Move to'}</p>
        <h2 className="text-base font-semibold text-slate-50">{view.targetName}</h2>
        <p className="flex items-center gap-1 text-slate-400">
          <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: view.ownerColour }} />
          {view.ownerName}
        </p>
      </header>
      {!noRoute && append && <p className="text-slate-400">Added after the current route: the timing and odds are shown once it is ordered.</p>}
      {!noRoute && !append && (
        <section aria-label="Routes" className="space-y-1">
          {view.routes.map((r) => {
            const key = `${r.groupSize}|${r.etaTicks}|${r.departInTicks}|${r.approachName ?? ''}`;
            const first = !groups.has(key);
            groups.add(key);
            return (
              <div key={r.army} className="flex items-baseline justify-between gap-2 rounded bg-slate-900 px-2 py-1">
                <span className="text-slate-100">
                  {r.name}
                  {r.groupSize > 1 && first && <span className="block text-[10px] text-slate-500">{r.groupSize} armies here march as one</span>}
                </span>
                <span className="text-right tabular-nums text-slate-300">
                  {formatDuration(r.etaTicks)}
                  {r.departInTicks > 0 && <span className="block text-[10px] text-amber-300">departs in {formatDuration(r.departInTicks)}</span>}
                  {r.hostile > 0 && <span className="block text-[10px] text-rose-300">crosses {r.hostile} hostile</span>}
                </span>
              </div>
            );
          })}
          <p className="text-slate-400">
            Arrives in {formatDuration(preview.arriveInTicks)}
            {preview.intent === 'attack' && ` · ${preview.directions} ${preview.directions === 1 ? 'direction' : 'directions'}`}
            {view.approaches.length > 0 && preview.intent === 'attack' && ` (from ${view.approaches.join(', ')})`}
          </p>
        </section>
      )}
      {preview.forecast !== null && !append && <ForecastBlock forecast={preview.forecast} />}
      <Warnings warnings={preview.warnings} />
      <div className="flex flex-wrap gap-3 text-slate-300">
        {preview.routes.length >= 2 && (
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={together} onChange={(e) => act().setDraftOption({ together: e.target.checked })} className="accent-amber-500" />
            Arrive together
          </label>
        )}
        <label className="flex items-center gap-1.5" title="Add this as a waypoint after the current route">
          <input type="checkbox" checked={append} onChange={(e) => act().setDraftOption({ append: e.target.checked })} className="accent-amber-500" />
          Waypoint
        </label>
      </div>
      <div className="flex gap-2">
        <button type="button" onClick={() => act().cancel()} className="flex-1 rounded border border-slate-600 py-2 text-slate-200 hover:border-slate-400">
          Cancel
        </button>
        <button
          type="button"
          disabled={noRoute}
          onClick={() => act().confirmDraft()}
          className={`flex-[2] rounded py-2 text-sm font-semibold disabled:opacity-40 ${view.verb === 'Attack' ? 'bg-rose-600 text-white hover:bg-rose-500' : 'bg-slate-200 text-slate-950 hover:bg-white'}`}
        >
          {view.verb} <kbd className="ml-1 text-[10px] opacity-70">Enter</kbd>
        </button>
      </div>
    </div>
  );
}
