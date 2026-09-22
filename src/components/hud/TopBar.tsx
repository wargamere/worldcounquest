'use client';

import { TURN } from '@/game/balance';
import { grossIncome, manpowerRegen, netIncome, totalTroops } from '@/game/economy';
import { formatTurn } from '@/game/log';
import { countriesToWin, countryCount } from '@/game/victory';
import type { GameState } from '@/game/types';

const compact = (value: number): string =>
  value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(1)}M`
    : value >= 1_000
      ? `${(value / 1_000).toFixed(0)}k`
      : `${Math.round(value)}`;

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex flex-col leading-tight">
      <span className="text-[10px] uppercase tracking-wider text-slate-400">{label}</span>
      <span className={`text-sm font-semibold tabular-nums ${tone ?? 'text-slate-100'}`}>
        {value}
      </span>
    </div>
  );
}

export function TopBar({ game, onEndTurn, onQuit }: {
  game: GameState;
  onEndTurn: () => void;
  onQuit: () => void;
}) {
  const nation = game.nations[game.playerId];
  const net = netIncome(game, game.playerId);

  return (
    <header className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-slate-800 bg-slate-950/95 px-3 py-2 backdrop-blur">
      <div className="flex flex-col leading-tight">
        <span className="text-[10px] uppercase tracking-wider text-slate-400">
          {nation?.name ?? 'Nation'}
        </span>
        <span className="text-sm font-semibold text-slate-100">
          {formatTurn(game.turn, TURN.START_YEAR, TURN.START_MONTH)}
        </span>
      </div>

      <Stat label="Treasury" value={compact(nation?.treasury ?? 0)} />
      <Stat
        label="Net / turn"
        value={`${net >= 0 ? '+' : ''}${net.toFixed(0)}`}
        tone={net >= 0 ? 'text-emerald-400' : 'text-rose-400'}
      />
      <Stat label="Gross" value={grossIncome(game, game.playerId).toFixed(0)} />
      <Stat
        label="Manpower"
        value={`${compact(nation?.manpower ?? 0)} (+${compact(manpowerRegen(game, game.playerId))})`}
      />
      <Stat label="Troops" value={compact(totalTroops(game, game.playerId))} />
      <Stat label="Countries" value={`${countryCount(game, game.playerId)}`} />
      <Stat label="To win" value={`${countriesToWin(game)}`} />

      <div className="ml-auto flex items-center gap-2">
        <button
          type="button"
          onClick={onQuit}
          className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-400 hover:border-slate-500 hover:text-slate-200"
        >
          New game
        </button>
        <button
          type="button"
          onClick={onEndTurn}
          className="rounded bg-amber-500 px-4 py-1.5 text-sm font-semibold text-slate-950 hover:bg-amber-400"
        >
          End turn
        </button>
      </div>
    </header>
  );
}
