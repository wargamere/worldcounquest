'use client';

import { useCallback, useState } from 'react';
import { COMBAT, UNITS } from '@/next/game/balance';
import { STOCK_LABELS } from '@/next/game/economy';
import { STOCK_KEYS, UNIT_TYPES } from '@/next/game/types';
import type { ArmyId, Command, NationIx, Sim, Stance } from '@/next/game/types';
import { armyView } from '@/next/game/views';
import { playerNation, useSimView } from '@/next/store/gameStore';
import { act } from '../ui/act';
import { pct, whole } from '../ui/format';
import { Icon } from '../ui/Icon';
import { STANCE_HINT, STANCE_TEXT } from '../ui/labels';
import { Meter } from '../ui/Meter';
import { halfOf, SplitSheet } from './SplitSheet';

const STANCES: readonly Stance[] = ['manual', 'defend', 'delegate'];

/** Asks before a disband, which has no refund (§4.3). */
export function confirmDisband(name: string): boolean {
  return typeof window === 'undefined' || window.confirm(`Disband ${name}? Its units are lost with no refund.`);
}

/** The Army panel (§8.3) for one army, yours or a visible rival's. */
export function ArmyPanel({ army }: { army: ArmyId }) {
  const view = useSimView(useCallback((sim: Sim) => armyView(sim, [army]), [army]));
  const [splitting, setSplitting] = useState(false);
  if (view === null) return <p className="p-3 text-xs text-slate-500">This army is gone.</p>;
  const nation = playerNation();
  const run = (build: (n: NationIx) => Command): void => {
    if (nation !== null) act().command(build(nation));
  };
  return (
    <div className="space-y-3 p-3 text-xs">
      <header className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold text-slate-50">{view.ours ? view.name : `${view.ownerName} · ${view.name}`}</h2>
          <p className="text-slate-400">{view.status}</p>
        </div>
        <button type="button" aria-label="Close" onClick={() => act().cancel()} className="text-slate-500 hover:text-slate-200">
          <Icon name="close" size={16} />
        </button>
      </header>

      {view.ours && (
        <div className="space-y-2">
          <div className="flex items-center gap-1" role="radiogroup" aria-label="Stance">
            {STANCES.map((s) => (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={view.stance === s}
                title={STANCE_HINT[s]}
                onClick={() => run((n) => ({ kind: 'stance', nation: n, armies: view.ids, stance: s }))}
                className={`flex-1 rounded border px-2 py-1 ${view.stance === s ? 'border-amber-500 bg-amber-500/15 text-amber-100' : 'border-slate-700 text-slate-300 hover:border-slate-500'}`}
              >
                {STANCE_TEXT[s]}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1" role="radiogroup" aria-label="Retreat threshold">
            <span className="mr-1 text-slate-400">Withdraw below</span>
            {COMBAT.RETREAT_OPTIONS.map((r) => (
              <button
                key={r}
                type="button"
                role="radio"
                aria-checked={Math.abs(view.retreatAt - r) < 1e-9}
                onClick={() => run((n) => ({ kind: 'retreatAt', nation: n, armies: view.ids, at: r }))}
                className={`rounded border px-2 py-0.5 ${Math.abs(view.retreatAt - r) < 1e-9 ? 'border-amber-500 bg-amber-500/15 text-amber-100' : 'border-slate-700 text-slate-300 hover:border-slate-500'}`}
              >
                {r === 0 ? 'Off' : pct(r)}
              </button>
            ))}
          </div>
        </div>
      )}

      <section aria-label="Composition" className="space-y-1">
        {UNIT_TYPES.filter((u) => view.units[u].count > 0).map((u) => {
          const stack = view.units[u];
          const max = stack.count * UNITS[u].hp;
          return (
            <div key={u} className="flex items-center gap-2">
              <span className="w-8 rounded bg-slate-800 px-1 text-center font-mono text-[10px] text-slate-300">{UNITS[u].short}</span>
              <span className="w-24 text-slate-200">
                {UNITS[u].name} ×{stack.count}
              </span>
              <span className="flex-1">
                <Meter value={stack.hp} max={max} colour="#34d399" label={`${UNITS[u].name} health`} />
              </span>
              <span className="w-9 text-right tabular-nums text-slate-400">{pct(max > 0 ? stack.hp / max : 0)}</span>
            </div>
          );
        })}
      </section>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-slate-300">
        <dt className="text-slate-500">Units</dt>
        <dd className="text-right tabular-nums">{view.totalUnits}</dd>
        <dt className="text-slate-500">HP</dt>
        <dd className="text-right tabular-nums">
          {whole(view.hp)} / {whole(view.maxHp)}
        </dd>
        <dt className="text-slate-500">Speed</dt>
        <dd className="text-right tabular-nums">
          {whole(view.speedKmh)} km/h{view.pacedBy !== null && <span className="block text-[10px] text-slate-500">{UNITS[view.pacedBy].name} set the pace</span>}
        </dd>
        <dt className="text-slate-500">Upkeep</dt>
        <dd className="text-right tabular-nums">
          {STOCK_KEYS.filter((k) => (view.upkeep[k] ?? 0) > 0)
            .map((k) => `${whole(view.upkeep[k] ?? 0)} ${STOCK_LABELS[k]}`)
            .join(' · ')}
          /d
        </dd>
        <dt className="text-slate-500">Supply</dt>
        <dd className={`text-right ${view.supplied ? 'text-slate-300' : 'text-orange-300'}`}>{view.supplied ? 'Supplied' : 'Out of supply'}</dd>
      </dl>

      {view.ours && (
        <>
          {view.idle && <p className="text-[11px] text-slate-500">Click a province to order a move or attack; right-click orders at once.</p>}
          <div className="flex flex-wrap gap-1.5">
            {view.moving && (
              <Action label="Stop" onClick={() => run((n) => ({ kind: 'stop', nation: n, armies: view.ids }))} />
            )}
            {view.canSplit && <Action label="Split" onClick={() => setSplitting(!splitting)} />}
            {view.mergeable.length >= 2 && <Action label={`Merge (${view.mergeable.length})`} onClick={() => run((n) => ({ kind: 'merge', nation: n, armies: view.mergeable }))} />}
            {view.inBattle && <Action label="Retreat (−10%)" tone="warn" onClick={() => run((n) => ({ kind: 'retreat', nation: n, armies: view.ids, to: null }))} />}
            <Action label="+ Add armies" onClick={() => act().setMultiSelect(true)} />
            <Action
              label="Disband"
              tone="danger"
              onClick={() => {
                if (confirmDisband(view.name)) run((n) => ({ kind: 'disband', nation: n, army: army }));
              }}
            />
          </div>
          {splitting && view.canSplit && <SplitSheet key={army} army={army} units={view.units} onDone={() => setSplitting(false)} />}
          {!splitting && view.canSplit && Object.keys(halfOf(view.units)).length === 0 && <p className="text-[11px] text-slate-500">Too small to split.</p>}
        </>
      )}
    </div>
  );
}

export function Action({ label, onClick, tone = 'plain' }: { label: string; onClick: () => void; tone?: 'plain' | 'warn' | 'danger' }) {
  const style = tone === 'danger' ? 'border-rose-700 text-rose-200 hover:border-rose-500' : tone === 'warn' ? 'border-orange-600 text-orange-200 hover:border-orange-400' : 'border-slate-600 text-slate-200 hover:border-slate-400';
  return (
    <button type="button" onClick={onClick} className={`rounded border px-2 py-1 ${style}`}>
      {label}
    </button>
  );
}
