'use client';

import { useCallback } from 'react';
import type { ProvinceIx, Sim } from '@/next/game/types';
import { armyRows, battleView } from '@/next/game/views';
import { playerNation, useSimView } from '@/next/store/gameStore';
import { act } from '../ui/act';
import { formatDuration, whole } from '../ui/format';
import { Icon } from '../ui/Icon';
import { modifierChip } from '../ui/labels';
import { Meter } from '../ui/Meter';
import { Sparkline } from '../ui/Sparkline';
import { ForecastBlock } from './ForecastBlock';

/** The Battle panel (§8.3): both sides now against the start, last hour's damage, modifiers, an HP sparkline, the live forecast and reinforcements. */
export function BattlePanel({ province }: { province: ProvinceIx }) {
  const data = useSimView(
    useCallback(
      (sim: Sim) => {
        const view = battleView(sim, province);
        if (view === null) return null;
        return { view, reinforcements: armyRows(sim, view.reinforcements.map((r) => r.army)), player: sim.state.player, ownerIsPlayer: sim.state.provinces[province]!.owner === sim.state.player };
      },
      [province],
    ),
  );
  if (data === null) return <p className="p-3 text-xs text-slate-500">The battle is over.</p>;
  const { view, reinforcements, player, ownerIsPlayer } = data;
  const mineSide = view.sides.find((s) => s.nation === player);
  const due = new Map(view.reinforcements.map((r) => [r.army, r.inTicks]));
  return (
    <div className="space-y-3 p-3 text-xs">
      <header className="flex items-start justify-between">
        <div>
          <p className="text-[10px] uppercase tracking-wider text-rose-300">Battle · hour {view.hours}</p>
          <h2 className="text-base font-semibold text-slate-50">{view.name}</h2>
        </div>
        <button type="button" aria-label="Close" onClick={() => act().cancel()} className="text-slate-500 hover:text-slate-200">
          <Icon name="close" size={16} />
        </button>
      </header>
      <section className="space-y-2">
        {view.sides.map((side) => {
          const name = view.names[side.nation];
          const history = view.log.map((r) => r.sides.find((s) => s.nation === side.nation)?.hp ?? 0);
          return (
            <div key={side.nation} className="rounded border border-slate-800 bg-slate-900/70 p-2">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 font-medium text-slate-100">
                  <span aria-hidden className="h-2.5 w-2.5 rounded-sm" style={{ background: name?.colour }} />
                  {side.nation === player ? 'You' : name?.name}
                  <span className="text-[10px] font-normal text-slate-500">{side.role === 'defender' ? 'defending' : 'attacking'}</span>
                </span>
                <span className="tabular-nums text-slate-300">
                  {whole(side.hp)} / {whole(side.startHp)} HP
                </span>
              </div>
              <div className="mt-1">
                <Meter value={side.hp} max={side.startHp} colour={name?.colour ?? '#94a3b8'} label={`${name?.name ?? ''} HP`} />
              </div>
              <div className="mt-1 flex items-center justify-between text-[11px] text-slate-400">
                <span>
                  last hour: dealt {whole(side.dealt)} · took {whole(side.taken)}
                  {side.role === 'attacker' && side.directions > 1 && ` · ${side.directions} directions`}
                </span>
                {history.length > 1 && <Sparkline series={[{ values: history, colour: name?.colour ?? '#94a3b8' }]} min={0} width={72} height={18} label={`${name?.name ?? ''} HP over the last ${history.length} rounds`} />}
              </div>
            </div>
          );
        })}
        {view.garrison > 0.5 && <p className="text-slate-400">Garrison fighting for the owner: {whole(view.garrison)} HP</p>}
      </section>
      {view.modifiers.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {view.modifiers.map((m, i) => (
            <span key={i} className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-300">
              {m.side === 'attacker' ? 'A' : 'D'} · {modifierChip(m.code, m.factor)}
            </span>
          ))}
        </div>
      )}
      {view.forecast !== null && <ForecastBlock forecast={view.forecast} attacking={mineSide === undefined || mineSide.role === 'attacker'} />}
      {reinforcements.length > 0 && (
        <section>
          <h3 className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Arriving within 12 h</h3>
          <ul className="mt-1 space-y-0.5">
            {reinforcements.map((r) => (
              <li key={r.id} className="flex justify-between text-slate-300">
                <span className="flex items-center gap-1">
                  <span aria-hidden className="h-2 w-2 rounded-sm" style={{ background: r.colour }} />
                  {r.ours ? r.name : `${r.ownerName} ${r.name}`} · {r.units}
                </span>
                <span className="tabular-nums">{formatDuration(due.get(r.id) ?? 0)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <div className="flex gap-2">
        {!ownerIsPlayer && (
          <button type="button" onClick={() => act().openAttackWith(province)} className="flex-1 rounded bg-rose-600 py-2 font-semibold text-white hover:bg-rose-500">
            Reinforce
          </button>
        )}
        {view.mine.length > 0 && (
          <button
            type="button"
            onClick={() => {
              const nation = playerNation();
              if (nation !== null) act().command({ kind: 'retreat', nation, armies: view.mine, to: null });
            }}
            className="flex-1 rounded border border-orange-600 py-2 text-orange-200 hover:border-orange-400"
          >
            Retreat mine (−10%)
          </button>
        )}
      </div>
      {ownerIsPlayer && <p className="text-[11px] text-slate-500">To reinforce, select armies and click this province.</p>}
    </div>
  );
}
