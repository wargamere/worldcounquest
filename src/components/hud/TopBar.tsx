'use client';

import { TURN, VICTORY } from '@/game/balance';
import { manpowerRegen, netIncome, totalTroops } from '@/game/economy';
import { formatTurn } from '@/game/log';
import { countryCount, leadingRival } from '@/game/victory';
import type { GameState } from '@/game/types';
import { compact, signed } from '../ui/format';

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex flex-col leading-tight">
      <span className="text-[10px] uppercase tracking-wider text-slate-500">{label}</span>
      <span className={`text-sm font-semibold tabular-nums ${tone ?? 'text-slate-100'}`}>{value}</span>
    </div>
  );
}

/**
 * The race to hegemony: you against the biggest rival, both measured against the
 * number of countries that wins the game. Direct labels carry identity; the bar
 * colours are the two nations' map colours.
 */
function Race({ game }: { game: GameState }) {
  const total = Object.keys(game.countries).length;
  const goal = Math.ceil(total * VICTORY.CONTROL_FRACTION);
  const mine = countryCount(game, game.playerId);
  const rival = leadingRival(game);
  const rivalNation = rival ? game.nations[rival.nationId] : undefined;
  const rows = [
    { label: 'You', value: mine, colour: game.nations[game.playerId]?.colour ?? '#f2c14e' },
    ...(rival && rivalNation ? [{ label: rivalNation.name, value: rival.countries, colour: rivalNation.colour }] : []),
  ];
  return (
    <div className="flex min-w-[170px] flex-col gap-0.5" aria-label={`Race to ${goal} countries`}>
      <span className="text-[10px] uppercase tracking-wider text-slate-500">Race to {goal} countries</span>
      {rows.map((row) => (
        <div key={row.label} className="flex items-center gap-1.5" title={`${row.label}: ${row.value} of ${goal}`}>
          <span className="w-16 truncate text-[11px] text-slate-300">{row.label}</span>
          <span className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-slate-800">
            <span
              className="absolute inset-y-0 left-0 rounded-full"
              style={{ width: `${Math.min(100, (row.value / goal) * 100)}%`, background: row.colour }}
            />
          </span>
          <span className="w-7 text-right text-[11px] font-semibold tabular-nums text-slate-200">{row.value}</span>
        </div>
      ))}
    </div>
  );
}

interface TopBarProps {
  game: GameState;
  onEndTurn: () => void;
  onAdvise: () => void;
  onHelp: () => void;
  onQuit: () => void;
}

export function TopBar({ game, onEndTurn, onAdvise, onHelp, onQuit }: TopBarProps) {
  const nation = game.nations[game.playerId];
  const net = netIncome(game, game.playerId);

  return (
    <header className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-slate-800 bg-slate-950 px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="inline-block h-3 w-3 rounded-sm" style={{ background: nation?.colour }} />
        <div className="flex flex-col leading-tight">
          <span className="text-[10px] uppercase tracking-wider text-slate-500">{nation?.name ?? 'Nation'}</span>
          <span className="text-sm font-semibold text-slate-100">
            {formatTurn(game.turn, TURN.START_YEAR, TURN.START_MONTH)}
          </span>
        </div>
      </div>

      <Stat label="Treasury" value={compact(nation?.treasury ?? 0)} />
      <Stat label="Net / turn" value={signed(net)} tone={net >= 0 ? 'text-emerald-400' : 'text-rose-400'} />
      <Stat label="Manpower" value={`${compact(nation?.manpower ?? 0)} ${signed(manpowerRegen(game, game.playerId) / 1000)}k`} />
      <Stat label="Troops" value={compact(totalTroops(game, game.playerId))} />
      <Race game={game} />

      <div className="ml-auto flex items-center gap-1.5">
        <button type="button" onClick={onHelp} title="How to play (?)" className="h-8 w-8 rounded border border-slate-700 text-sm text-slate-300 hover:border-slate-500">
          ?
        </button>
        <button type="button" onClick={onQuit} className="rounded border border-slate-700 px-2 py-1.5 text-xs text-slate-400 hover:border-slate-500 hover:text-slate-200">
          New game
        </button>
        <button
          type="button"
          onClick={onAdvise}
          title="Suggest a safe attack (A)"
          className="rounded border border-sky-700 px-3 py-1.5 text-sm font-medium text-sky-200 hover:bg-sky-950"
        >
          Advise
        </button>
        <button
          type="button"
          onClick={onEndTurn}
          title="End turn (Enter)"
          className="rounded bg-amber-500 px-4 py-1.5 text-sm font-semibold text-slate-950 hover:bg-amber-400"
        >
          End turn
        </button>
      </div>
    </header>
  );
}
