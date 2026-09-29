'use client';

import { TURN } from '@/game/balance';
import { formatTurn } from '@/game/log';
import { controlShare, countryCount, rivalHegemon } from '@/game/victory';
import type { GameState } from '@/game/types';

function Figure({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg bg-slate-900 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className="text-lg font-bold tabular-nums text-slate-100">{value}</div>
    </div>
  );
}

export function EndScreen({ game, onRestart }: { game: GameState; onRestart: () => void }) {
  const won = game.status === 'won';
  const hegemon = won ? null : rivalHegemon(game);
  const when = formatTurn(game.turn, TURN.START_YEAR, TURN.START_MONTH);
  const years = (game.turn / 12).toFixed(1);
  const s = game.stats;

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-slate-950/90 p-6">
      <div className="w-full max-w-md text-center">
        <h2 className={`text-3xl font-bold ${won ? 'text-amber-300' : 'text-rose-300'}`}>
          {won ? 'Hegemony achieved' : hegemon ? `${game.nations[hegemon]?.name} rules the world` : 'Your nation has fallen'}
        </h2>
        <p className="mt-2 text-sm text-slate-300">
          {won
            ? `You hold ${countryCount(game, game.playerId)} countries — ${(controlShare(game, game.playerId) * 100).toFixed(0)}% of the world — by ${when}, after ${years} years.`
            : hegemon
              ? `A rival reached hegemony in ${when}, while you still held ${countryCount(game, game.playerId)} countries.`
              : `Your last territory fell in ${when}, after ${years} years.`}
        </p>
        <div className="mt-5 grid grid-cols-3 gap-2 text-left">
          <Figure label="Peak size" value={s.peakCountries} />
          <Figure label="Attacks won" value={s.battlesWon} />
          <Figure label="Attacks lost" value={s.battlesLost} />
          <Figure label="Defences held" value={s.defencesHeld} />
          <Figure label="Countries lost" value={s.countriesLost} />
          <Figure label="Months" value={game.turn} />
        </div>
        <button type="button" onClick={onRestart} className="mt-6 rounded bg-slate-100 px-5 py-2.5 text-sm font-bold text-slate-950 hover:bg-white">
          New game
        </button>
      </div>
    </div>
  );
}
