'use client';

import { useCallback } from 'react';
import { TERRAIN } from '@/next/game/balance';
import { STOCK_LABELS } from '@/next/game/economy';
import type { ProvinceIx, Sim } from '@/next/game/types';
import { armyRows, provinceView } from '@/next/game/views';
import { useGameStore, useSimView } from '@/next/store/gameStore';
import { act } from '../ui/act';
import { formatRate, whole } from '../ui/format';
import { Icon } from '../ui/Icon';
import { STATUS_TEXT } from '../ui/labels';
import { Meter } from '../ui/Meter';
import { BuildingRows } from './BuildingRows';
import { TrainingQueue } from './TrainingQueue';

/** The Province panel (§8.3): header, output, stability, garrison, supply, buildings, training, armies; intel and Attack with… abroad. */
export function ProvincePanel({ province }: { province: ProvinceIx }) {
  const showAll = useGameStore((s) => s.prefs.showAllArmies);
  const data = useSimView(
    useCallback(
      (sim: Sim) => {
        const view = provinceView(sim, province, showAll);
        return { view, armies: armyRows(sim, view.armies) };
      },
      [province, showAll],
    ),
  );
  if (data === null) return null;
  const { view, armies } = data;
  const statusTone = view.status === 'home' ? 'bg-emerald-900/60 text-emerald-200' : view.status === 'integrated' ? 'bg-sky-900/60 text-sky-200' : 'bg-orange-900/60 text-orange-200';
  return (
    <div className="space-y-3 p-3">
      <header>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="flex items-center gap-1.5 truncate text-base font-semibold text-slate-50">
              {view.seat && <Icon name="capital" size={14} className="text-amber-300" label="Capital" />}
              {view.name}
            </h2>
            {view.city !== null && <p className="text-[11px] text-slate-400">{view.city}</p>}
          </div>
          <button type="button" aria-label="Close" onClick={() => act().cancel()} className="text-slate-500 hover:text-slate-200">
            <Icon name="close" size={16} />
          </button>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px]">
          <span className="inline-flex items-center gap-1 rounded bg-slate-800 px-1.5 py-0.5 text-slate-200">
            <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: view.ownerColour }} />
            {view.foreign ? view.ownerName : 'You'}
          </span>
          <span className={`rounded px-1.5 py-0.5 ${statusTone}`}>
            {STATUS_TEXT[view.status]}
            {view.integratesInDays !== null && ` · integrates in ${view.integratesInDays} d`}
          </span>
          <span className="rounded bg-slate-800 px-1.5 py-0.5 text-slate-300">{TERRAIN[view.terrain].label}</span>
          <span className="inline-flex items-center gap-1 rounded bg-slate-800 px-1.5 py-0.5 text-slate-300">
            <Icon name={view.output.good} size={11} />
            {STOCK_LABELS[view.output.good]}
            {view.oilField && ' field'}
          </span>
          <span className="rounded bg-slate-800 px-1.5 py-0.5 text-slate-300">{view.vp} VP</span>
          {view.originalCapital && !view.seat && <span className="rounded bg-slate-800 px-1.5 py-0.5 text-slate-400">old capital of {view.countryName}</span>}
        </div>
        {view.blockedBy !== null && <p className="mt-1 text-[11px] text-orange-300">{view.blockedBy}</p>}
      </header>

      {view.battle && (
        <button type="button" onClick={() => act().selectBattle(province)} className="flex w-full items-center gap-2 rounded border border-rose-600/60 bg-rose-950/40 px-2 py-1.5 text-left text-xs text-rose-100 hover:border-rose-400">
          <Icon name="battle" size={14} /> A battle is being fought here — open the Battle panel
        </button>
      )}

      {!view.foreign && (
        <section className="grid grid-cols-3 gap-1 text-center text-xs">
          <Stat label="Funds" value={formatRate(view.output.funds)} />
          <Stat label={STOCK_LABELS[view.output.good]} value={formatRate(view.output.goods)} />
          <Stat label="Recruits" value={formatRate(view.output.recruits)} />
        </section>
      )}

      <section className="space-y-1 text-xs">
        <div className="flex justify-between text-slate-300" title={view.stabilityNotes.join('\n')}>
          <span>Stability</span>
          <span className="tabular-nums">
            {Math.round(view.stability)} → {view.stabilityTarget}
          </span>
        </div>
        <Meter value={view.stability} max={100} colour={view.stability < 20 ? '#f43f5e' : view.stability < 50 ? '#f59e0b' : '#34d399'} label="Stability" />
        <ul className="text-[11px] text-slate-500">
          {view.stabilityNotes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
        <div className="flex justify-between pt-1 text-slate-300">
          <span>Garrison</span>
          <span className="tabular-nums">
            {whole(view.garrison)} / {whole(view.garrisonCap)} HP
            {view.garrisonRegenPerDay > 0.5 && <span className="text-slate-500"> · +{whole(view.garrisonRegenPerDay)}/d</span>}
          </span>
        </div>
        <Meter value={view.garrison} max={view.garrisonCap} colour="#94a3b8" label="Garrison" />
        {view.ramparts > 0 && <p className="text-[11px] text-slate-400">Ramparts {view.ramparts}</p>}
        {!view.foreign && (
          <p className={`text-[11px] ${view.connected ? 'text-slate-400' : 'text-orange-300'}`}>
            {view.connected ? 'Connected to your capital' : view.supplied ? 'Cut off from your capital, still supplied nearby' : 'Cut off and out of supply'}
          </p>
        )}
      </section>

      {view.foreign && (
        <section className="space-y-2 text-xs">
          <p className="text-slate-400">
            Visible armies here: <span className="tabular-nums text-slate-200">{view.visibleUnits}</span> units
          </p>
          <button type="button" data-coach="attack" onClick={() => act().openAttackWith(province)} className="w-full rounded bg-rose-600 py-2 text-sm font-semibold text-white hover:bg-rose-500">
            Attack with…
          </button>
        </section>
      )}

      {!view.foreign && <BuildingRows province={province} rows={view.buildings} construction={view.construction} />}
      {!view.foreign && view.trainingLevel > 0 && <TrainingQueue view={view} />}

      {armies.length > 0 && (
        <section aria-label="Armies here" className="space-y-1">
          <h3 className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Armies here</h3>
          {armies.map((a) => (
            <button key={a.id} type="button" onClick={() => act().selectArmies([a.id])} className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-xs hover:bg-slate-800">
              <span aria-hidden className={`h-2.5 w-2.5 rounded-sm ${a.ours ? 'ring-1 ring-amber-400' : ''}`} style={{ background: a.colour }} />
              <span className="font-medium text-slate-100">{a.ours ? a.name : `${a.ownerName} ${a.name}`}</span>
              <span className="tabular-nums text-slate-400">{a.units} units</span>
              <span className="ml-auto truncate text-[11px] text-slate-500">{a.status}</span>
            </button>
          ))}
        </section>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded bg-slate-900 px-1 py-1.5">
      <div className="text-[10px] text-slate-500">{label}</div>
      <div className="font-semibold tabular-nums text-slate-100">{value}</div>
    </div>
  );
}
