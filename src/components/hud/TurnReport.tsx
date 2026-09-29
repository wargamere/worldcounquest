'use client';

import { TURN } from '@/game/balance';
import { formatTurn } from '@/game/log';
import type { CountryId, GameState } from '@/game/types';
import { signed } from '../ui/format';

/** What happened to you while the rest of the world moved. Shown only when something did. */
export function TurnReport({
  game,
  onShow,
  onClose,
}: {
  game: GameState;
  onShow: (ids: CountryId[]) => void;
  onClose: () => void;
}) {
  const report = game.lastReport;
  if (!report) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 top-3 z-20 flex justify-center px-3">
      <div role="dialog" aria-label="Turn report" className="pointer-events-auto w-full max-w-md rounded-lg border border-slate-700 bg-slate-950/95 p-3 shadow-2xl">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold text-slate-50">
            {formatTurn(report.turn, TURN.START_YEAR, TURN.START_MONTH)} — while you waited
          </h2>
          <span className={`text-xs tabular-nums ${report.income >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
            income {signed(report.income)}
          </span>
        </div>
        <ul className="mt-2 flex flex-col gap-1 text-xs">
          {report.lost.map((loss) => (
            <li key={loss.countryId} className="flex items-center gap-2 text-rose-200">
              <span aria-hidden className="text-rose-400">✕</span>
              {game.nations[loss.byId]?.name ?? 'An enemy'} took <strong>{loss.name}</strong>
            </li>
          ))}
          {report.held > 0 && (
            <li className="flex items-center gap-2 text-emerald-200">
              <span aria-hidden className="text-emerald-400">✓</span>
              Your garrisons threw back {report.held} {report.held === 1 ? 'attack' : 'attacks'}
            </li>
          )}
          {report.deserted > 0 && (
            <li className="flex items-center gap-2 text-amber-200">
              <span aria-hidden className="text-amber-400">!</span>
              The treasury ran dry — {report.deserted} troops deserted
            </li>
          )}
        </ul>
        <div className="mt-3 flex justify-end gap-2">
          {report.lost.length > 0 && (
            <button type="button" onClick={() => onShow(report.lost.map((l) => l.countryId))} className="rounded border border-slate-700 px-3 py-1 text-xs text-slate-300 hover:border-slate-500">
              Show on map
            </button>
          )}
          <button type="button" onClick={onClose} className="rounded bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-950 hover:bg-white">
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}
