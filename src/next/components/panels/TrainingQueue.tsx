'use client';

import { TRAINING, UNITS } from '@/next/game/balance';
import type { ProvinceIx, UnitType } from '@/next/game/types';
import type { ProvinceView } from '@/next/game/views';
import { playerNation } from '@/next/store/gameStore';
import { act } from '../ui/act';
import { CostChips } from '../ui/CostChips';
import { Icon } from '../ui/Icon';
import { Meter } from '../ui/Meter';

/** Training (§8.3): unit buttons with cost and hours (+1, ×5), the queue with progress and ✕, Keep training and Rally. */
export function TrainingQueue({ view }: { view: ProvinceView }) {
  const province: ProvinceIx = view.id;
  const train = (unit: UnitType, count: number): void => {
    const nation = playerNation();
    if (nation !== null) act().command({ kind: 'train', nation, province, unit, count });
  };
  const full = view.queue.length >= TRAINING.QUEUE_MAX;
  return (
    <section aria-label="Training" className="space-y-1.5" id="training-section" data-coach="training">
      <h3 className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Training · Training Ground {view.trainingLevel}</h3>
      <div className="space-y-1">
        {view.trainOptions.map((o) => (
          <div key={o.unit} className="flex items-center gap-2 rounded border border-slate-800 bg-slate-900/60 px-2 py-1 text-xs">
            <span className="w-24 font-medium text-slate-100">{UNITS[o.unit].name}</span>
            <CostChips cost={o.cost} />
            <span className="text-[11px] text-slate-500">{o.hours.toFixed(o.hours % 1 === 0 ? 0 : 1)} h</span>
            <span className="ml-auto flex gap-1">
              <button type="button" disabled={o.reason !== null || full} title={o.reason ?? (full ? 'The queue is full' : undefined)} onClick={() => train(o.unit, 1)} className="rounded bg-slate-200 px-1.5 py-0.5 text-[11px] font-semibold text-slate-950 hover:bg-white disabled:bg-slate-800 disabled:text-slate-500">
                +1
              </button>
              <button type="button" disabled={o.reason !== null || full} title={o.reason ?? undefined} onClick={() => train(o.unit, TRAINING.MAX_PER_ORDER)} className="rounded border border-slate-600 px-1.5 py-0.5 text-[11px] text-slate-200 hover:border-slate-400 disabled:opacity-40">
                ×{TRAINING.MAX_PER_ORDER}
              </button>
            </span>
          </div>
        ))}
        {view.trainOptions.length > 0 && view.trainOptions.every((o) => o.reason !== null) && <p className="text-[11px] text-slate-500">{view.trainOptions[0]!.reason}</p>}
      </div>
      {view.queue.length > 0 && (
        <ol className="space-y-1" aria-label="Queue">
          {view.queue.map((item, i) => (
            <li key={i} className="flex items-center gap-2 text-xs">
              <span className="w-24 truncate text-slate-200">{UNITS[item.unit].name}</span>
              <span className="flex-1">
                {item.started ? <Meter value={item.hoursTotal - item.hoursLeft} max={item.hoursTotal} label={`${UNITS[item.unit].name} progress`} /> : <span className="text-[11px] text-slate-500">{i === 0 && view.waitingFor !== null ? `waiting for ${view.waitingFor}` : 'queued'}</span>}
              </span>
              <span className="w-10 text-right text-[11px] tabular-nums text-slate-500">{Math.ceil(item.hoursLeft)} h</span>
              <button
                type="button"
                aria-label={`Cancel ${UNITS[item.unit].name}`}
                onClick={() => {
                  const nation = playerNation();
                  if (nation !== null) act().command({ kind: 'cancelTrain', nation, province, index: i });
                }}
                className="text-slate-500 hover:text-rose-300"
              >
                <Icon name="close" size={14} />
              </button>
            </li>
          ))}
        </ol>
      )}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <label className="flex items-center gap-1.5 text-slate-300">
          <input
            type="checkbox"
            checked={view.keepTraining}
            onChange={(e) => {
              const nation = playerNation();
              if (nation !== null) act().command({ kind: 'keepTraining', nation, province, on: e.target.checked });
            }}
            className="accent-amber-500"
          />
          Keep training
        </label>
        <button type="button" onClick={() => act().startRally(province)} className="rounded border border-slate-700 px-2 py-0.5 text-slate-200 hover:border-slate-500">
          {view.rallyName === null ? 'Rally…' : `Rally: ${view.rallyName}`}
        </button>
        {view.rally !== null && (
          <button
            type="button"
            onClick={() => {
              const nation = playerNation();
              if (nation !== null) act().command({ kind: 'rally', nation, province, to: null });
            }}
            className="text-[11px] text-slate-500 hover:text-slate-300"
          >
            clear
          </button>
        )}
      </div>
    </section>
  );
}
