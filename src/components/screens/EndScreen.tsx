'use client';

import { TURN } from '@/game/balance';
import { formatTurn } from '@/game/log';
import { controlShare, countryCount } from '@/game/victory';
import type { GameState } from '@/game/types';

export function EndScreen({ game, onRestart }: { game: GameState; onRestart: () => void }) {
  const won = game.status === 'won';
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-slate-950/90 p-6">
      <div className="max-w-md text-center">
        <h2 className={`text-3xl font-bold ${won ? 'text-amber-300' : 'text-rose-300'}`}>
          {won ? 'Hegemony achieved' : 'Your nation has fallen'}
        </h2>
        <p className="mt-2 text-sm text-slate-300">
          {won
            ? `You hold ${countryCount(game, game.playerId)} countries — ${(controlShare(game, game.playerId) * 100).toFixed(0)}% of the world — by ${formatTurn(game.turn, TURN.START_YEAR, TURN.START_MONTH)}.`
            : `You lost your last territory by ${formatTurn(game.turn, TURN.START_YEAR, TURN.START_MONTH)}.`}
        </p>
        <button
          type="button"
          onClick={onRestart}
          className="mt-5 rounded bg-slate-100 px-5 py-2.5 text-sm font-bold text-slate-950 hover:bg-white"
        >
          New game
        </button>
      </div>
    </div>
  );
}
