'use client';

import { useState } from 'react';
import { TURN } from '@/game/balance';
import { formatTurn, visibleLog } from '@/game/log';
import type { GameState, LogEntry, LogKind } from '@/game/types';

const TONE: Record<LogKind, string> = {
  combat: 'text-slate-300',
  economy: 'text-emerald-300/90',
  action: 'text-sky-300/90',
  system: 'text-amber-300',
};

/** Battles involving you get an icon, so the eye finds them in a long log. */
function marker(entry: LogEntry, playerId: string): string | null {
  const combat = entry.combat;
  if (!combat) return null;
  if (combat.attackerId === playerId) return combat.captured ? '⚔✓' : '⚔✕';
  if (combat.defenderId === playerId) return combat.captured ? '🛡✕' : '🛡✓';
  return null;
}

export function EventLog({ game }: { game: GameState }) {
  const [showAll, setShowAll] = useState(false);
  const entries = (showAll ? game.log : visibleLog(game)).slice(0, 150);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex justify-end px-3 pb-1">
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="text-[10px] text-slate-500 underline-offset-2 hover:text-slate-300 hover:underline"
        >
          {showAll ? 'Only what concerns you' : `Show everything (${game.log.length})`}
        </button>
      </div>
      <ol className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 text-xs">
        {entries.length === 0 && <li className="text-slate-600">Nothing yet.</li>}
        {entries.map((entry) => {
          const mark = marker(entry, game.playerId);
          return (
            <li key={entry.id} className="border-b border-slate-900 py-1.5 last:border-0">
              <span className="mr-1.5 text-[10px] text-slate-600">
                {formatTurn(entry.turn, TURN.START_YEAR, TURN.START_MONTH)}
              </span>
              {mark && <span className="mr-1 text-[10px]" aria-hidden>{mark}</span>}
              <span className={TONE[entry.kind]}>{entry.text}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
