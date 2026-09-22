'use client';

import { useState } from 'react';
import { TURN } from '@/game/balance';
import { formatTurn, visibleLog } from '@/game/log';
import type { GameState, LogKind } from '@/game/types';

const TONE: Record<LogKind, string> = {
  combat: 'text-rose-300',
  economy: 'text-emerald-300',
  action: 'text-sky-300',
  system: 'text-amber-300',
};

export function EventLog({ game }: { game: GameState }) {
  const [showAll, setShowAll] = useState(false);
  const entries = showAll ? game.log : visibleLog(game);

  return (
    <section className="flex min-h-0 flex-1 flex-col border-t border-slate-800">
      <div className="flex items-center justify-between px-3 py-1.5">
        <h2 className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
          Events
        </h2>
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="text-[10px] text-slate-500 underline-offset-2 hover:text-slate-300 hover:underline"
        >
          {showAll ? 'Relevant only' : `Show all (${game.log.length})`}
        </button>
      </div>
      <ol className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 text-xs">
        {entries.length === 0 && <li className="text-slate-600">Nothing yet.</li>}
        {entries.map((entry) => (
          <li key={entry.id} className="border-b border-slate-900 py-1.5 last:border-0">
            <span className="mr-1.5 text-[10px] text-slate-600">
              {formatTurn(entry.turn, TURN.START_YEAR, TURN.START_MONTH)}
            </span>
            <span className={TONE[entry.kind]}>{entry.text}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
