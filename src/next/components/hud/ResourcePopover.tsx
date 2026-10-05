'use client';

import { useCallback, useEffect, useRef } from 'react';
import { UNITS } from '@/next/game/balance';
import { STOCK_LABELS } from '@/next/game/economy';
import type { Sim, StockKey } from '@/next/game/types';
import { stockView } from '@/next/game/views';
import { useSimView } from '@/next/store/gameStore';
import { act } from '../ui/act';
import { compact, formatDays, formatRate, whole } from '../ui/format';
import { STATUS_TEXT } from '../ui/labels';
import { Sparkline } from '../ui/Sparkline';

/** A chip's breakdown (§3.9): production by status and top producers, consumption by use, price, shortage effect. */
export function ResourcePopover({ stock, onClose }: { stock: StockKey; onClose: () => void }) {
  const view = useSimView(useCallback((sim: Sim) => stockView(sim, stock), [stock]));
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    const onDown = (e: PointerEvent): void => {
      if (box.current !== null && e.target instanceof Node && !box.current.contains(e.target) && !(e.target instanceof Element && e.target.closest('[data-chip]'))) onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onDown);
    };
  }, [onClose]);
  if (view === null) return null;
  return (
    <div ref={box} role="dialog" aria-label={`${STOCK_LABELS[stock]} breakdown`} className="absolute left-0 top-full z-40 mt-1 w-72 rounded-lg border border-slate-700 bg-slate-950/95 p-3 text-xs shadow-xl">
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-slate-100">{STOCK_LABELS[stock]}</h3>
        <span className="tabular-nums text-slate-300">
          {whole(view.amount)}
          {view.cap !== null && <span className="text-slate-500"> / {whole(view.cap)} cap</span>}
        </span>
      </div>
      <dl className="grid grid-cols-3 gap-1 text-center">
        <Cell label="Produced" value={formatRate(view.income)} />
        <Cell label="Consumed" value={formatRate(-view.upkeep)} />
        <Cell label="Net" value={formatRate(view.net)} tone={view.net < -0.5 ? 'text-rose-300' : 'text-emerald-300'} />
      </dl>
      {view.daysLeft !== null && view.net < 0 && <p className="mt-1 text-rose-300">Runs out in {formatDays(view.daysLeft)}.</p>}
      {view.byStatus.length > 0 && (
        <section className="mt-2">
          <h4 className="text-[10px] uppercase tracking-wider text-slate-500">Production</h4>
          {view.byStatus.map((row) => (
            <Row key={row.status} label={STATUS_TEXT[row.status]} value={formatRate(row.amount)} />
          ))}
          {view.worksBonus > 0.5 && <Row label="of which Works bonus" value={formatRate(view.worksBonus)} />}
          {view.top.length > 0 && (
            <ol className="mt-1 space-y-0.5 text-slate-400">
              {view.top.map((p) => (
                <li key={p.province} className="flex justify-between">
                  <button type="button" className="truncate text-left hover:text-slate-100" onClick={() => act().focusProvinces([p.province])}>
                    {p.name}
                  </button>
                  <span className="tabular-nums">{formatRate(p.amount)}</span>
                </li>
              ))}
            </ol>
          )}
        </section>
      )}
      {(view.upkeepByUnit.length > 0 || view.training > 0) && (
        <section className="mt-2">
          <h4 className="text-[10px] uppercase tracking-wider text-slate-500">Consumption</h4>
          {view.upkeepByUnit.map((row) => (
            <Row key={row.unit} label={`${UNITS[row.unit].name} upkeep`} value={formatRate(-row.amount)} />
          ))}
          {view.training > 0 && <Row label="Held by training queues" value={compact(view.training)} />}
        </section>
      )}
      {view.price !== null && (
        <section className="mt-2 flex items-center justify-between gap-2">
          <div>
            <h4 className="text-[10px] uppercase tracking-wider text-slate-500">Exchange</h4>
            <p className="tabular-nums text-slate-300">
              buy {view.price.buy.toFixed(2)} · sell {view.price.sell.toFixed(2)} · ×{view.price.factor.toFixed(2)}
            </p>
          </div>
          <Sparkline series={[{ values: view.price.history, colour: '#38bdf8' }]} baseline={1} label={`${STOCK_LABELS[stock]} price, last 14 days`} />
        </section>
      )}
      <p className={`mt-2 ${view.short ? 'text-rose-300' : 'text-slate-500'}`}>{view.short ? view.effect : `If it runs out — ${view.effect}`}</p>
      {view.price !== null && (
        <button type="button" onClick={() => act().openPanel('exchange')} className="mt-2 w-full rounded border border-slate-700 py-1 text-slate-200 hover:border-slate-500">
          Open the Exchange (X)
        </button>
      )}
    </div>
  );
}

function Cell({ label, value, tone = 'text-slate-100' }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded bg-slate-900 px-1 py-1">
      <dt className="text-[10px] text-slate-500">{label}</dt>
      <dd className={`font-semibold tabular-nums ${tone}`}>{value}</dd>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between text-slate-300">
      <span>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}
