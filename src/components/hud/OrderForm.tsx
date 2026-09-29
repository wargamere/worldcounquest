'use client';

import { useState } from 'react';
import { safeGarrison } from '@/game/ai';
import { ADVISOR } from '@/game/balance';
import { attackPresets, previewAttack, previewMove } from '@/game/orders';
import type { CountryId, GameState } from '@/game/types';
import { pct } from '../ui/format';
import { RiskBadge } from '../ui/RiskBadge';

interface OrderFormProps {
  game: GameState;
  sourceId: CountryId;
  targetId: CountryId;
  suggestedTroops: number | null;
  onAttack: (troops: number) => void;
  onMove: (troops: number) => void;
  onCancel: () => void;
}

const button =
  'rounded px-3 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-40';

/**
 * Move or attack from one country into a neighbour. Every number shown is
 * computed by the same functions the game resolves with.
 */
export function OrderForm({ game, sourceId, targetId, suggestedTroops, onAttack, onMove, onCancel }: OrderFormProps) {
  const source = game.countries[sourceId];
  const target = game.countries[targetId];
  const isAttack = target !== undefined && target.ownerId !== game.playerId;
  const presets = attackPresets(game, sourceId, targetId);
  const max = isAttack ? presets.all : Math.max(0, (source?.troops ?? 0) - 1);
  const moveDefault = source ? Math.max(1, source.troops - safeGarrison(game, sourceId, ADVISOR.RISK_TOLERANCE)) : 1;
  const initial = suggestedTroops ?? (isAttack ? presets.recommended : moveDefault);
  const [troops, setTroops] = useState(() => Math.min(max, Math.max(1, initial)));

  if (!source || !target) return null;
  if (max < 1) {
    return (
      <div className="rounded border border-slate-800 p-2 text-xs text-slate-400">
        {source.name} has no troops to spare.{' '}
        <button type="button" className="underline" onClick={onCancel}>Cancel</button>
      </div>
    );
  }

  const n = Math.min(max, Math.max(1, troops));
  const attackPreview = isAttack ? previewAttack(game, sourceId, targetId, n) : null;
  const movePreview = isAttack ? null : previewMove(game, sourceId, targetId, n);
  const owner = game.nations[target.ownerId];

  const preset = (label: string, value: number | null) => (
    <button
      type="button"
      disabled={value === null}
      onClick={() => value !== null && setTroops(value)}
      className={`flex-1 rounded border px-1.5 py-1 text-[11px] leading-tight transition disabled:opacity-35 ${
        value === n ? 'border-sky-500 bg-sky-500/15 text-sky-100' : 'border-slate-700 text-slate-300 hover:border-slate-500'
      }`}
    >
      <span className="block font-semibold">{label}</span>
      <span className="tabular-nums text-slate-400">{value ?? '—'}</span>
    </button>
  );

  return (
    <section
      className={`flex flex-col gap-2 rounded-lg border p-2.5 ${isAttack ? 'border-rose-900 bg-rose-950/25' : 'border-sky-900 bg-sky-950/25'}`}
      aria-label={isAttack ? 'Attack order' : 'Move order'}
    >
      <header className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-50">
          {isAttack ? 'Attack' : 'Move to'} {target.name}
        </h3>
        <button type="button" onClick={onCancel} className="text-[11px] text-slate-400 hover:text-slate-200">
          Cancel <kbd className="rounded border border-slate-700 px-1">Esc</kbd>
        </button>
      </header>
      <p className="-mt-1 text-[11px] text-slate-400">
        From {source.name} ({source.troops} troops)
        {isAttack && <> · held by {owner?.name} with {target.troops}, dev {target.development}</>}
      </p>

      <label className="flex items-center gap-2 text-xs text-slate-300">
        <span className="w-12 shrink-0">Troops</span>
        <input
          type="range"
          min={1}
          max={max}
          value={n}
          onChange={(e) => setTroops(Number(e.target.value))}
          className="flex-1 accent-sky-400"
        />
        <input
          type="number"
          min={1}
          max={max}
          value={n}
          onChange={(e) => setTroops(Math.max(1, Math.min(max, Number(e.target.value) || 1)))}
          className="w-16 rounded border border-slate-700 bg-slate-900 px-1.5 py-1 text-right tabular-nums text-slate-100"
          aria-label="Troops to commit"
        />
      </label>

      {isAttack && attackPreview && (
        <>
          <div className="flex gap-1">
            {preset(`Sure ${pct(ADVISOR.SAFE_CHANCE)}`, presets.safe)}
            {preset(`Likely ${pct(ADVISOR.LIKELY_CHANCE)}`, presets.likely)}
            {preset('Home safe', presets.spare > 0 ? presets.spare : null)}
            {preset('All', presets.all)}
          </div>
          <div className="flex items-end justify-between rounded bg-slate-950/60 px-2 py-1.5">
            <div>
              <div className="text-[10px] uppercase tracking-wider text-slate-400">Chance to capture</div>
              <div className="text-2xl font-bold tabular-nums text-slate-50">{pct(attackPreview.winChance)}</div>
            </div>
            <div className="text-right text-[11px] leading-tight text-slate-400">
              <div>If it works, <span className="font-semibold tabular-nums text-slate-200">{attackPreview.survivors}</span> hold it</div>
              <div>If it fails, all {n} are lost</div>
            </div>
          </div>
          <RiskBadge chance={attackPreview.sourceRisk} label={`${source.name} falls next turn`} />
          <RiskBadge chance={attackPreview.holdRisk} label={`${target.name} is retaken`} />
          <button
            type="button"
            onClick={() => onAttack(n)}
            className={`${button} ${attackPreview.winChance >= 0.5 ? 'bg-rose-600 text-white hover:bg-rose-500' : 'bg-rose-950 text-rose-200 ring-1 ring-rose-700 hover:bg-rose-900'}`}
          >
            Attack with {n} {attackPreview.winChance < 0.5 && '(long odds)'}
          </button>
        </>
      )}

      {!isAttack && movePreview && (
        <>
          <RiskBadge chance={movePreview.sourceRisk} label={`${source.name} falls next turn`} />
          <RiskBadge chance={movePreview.destinationRisk} label={`${target.name} falls next turn`} />
          <button type="button" onClick={() => onMove(n)} className={`${button} bg-sky-600 text-white hover:bg-sky-500`}>
            Move {n} troops
          </button>
          <p className="text-[10px] text-slate-500">Moving uses {source.name}&apos;s action for this turn.</p>
        </>
      )}
    </section>
  );
}
