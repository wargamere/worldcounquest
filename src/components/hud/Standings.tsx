'use client';

import { VICTORY } from '@/game/balance';
import { grossIncome, totalTroops } from '@/game/economy';
import type { GameState, NationId } from '@/game/types';
import { compact } from '../ui/format';
import { HistoryChart } from './HistoryChart';

/** The biggest powers on the map, and where you stand among them. */
export function Standings({ game, onShow }: { game: GameState; onShow: (id: NationId) => void }) {
  const counts = new Map<NationId, number>();
  for (const c of Object.values(game.countries)) counts.set(c.ownerId, (counts.get(c.ownerId) ?? 0) + 1);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const rank = ranked.findIndex(([id]) => id === game.playerId) + 1;
  const shown = ranked.slice(0, 8);
  if (!shown.some(([id]) => id === game.playerId)) {
    const you = ranked.find(([id]) => id === game.playerId);
    if (you) shown.push(you);
  }
  const goal = Math.ceil(Object.keys(game.countries).length * VICTORY.CONTROL_FRACTION);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
      <div className="mb-3">
        <HistoryChart game={game} />
      </div>
      <p className="mb-1.5 text-[11px] text-slate-500">
        {counts.size} nations remain · you rank #{rank} · {goal} countries wins
      </p>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-wider text-slate-500">
            <th className="py-1 font-medium">Nation</th>
            <th className="py-1 text-right font-medium">Countries</th>
            <th className="py-1 text-right font-medium">Troops</th>
            <th className="py-1 text-right font-medium">Income</th>
          </tr>
        </thead>
        <tbody>
          {shown.map(([id, countries]) => {
            const nation = game.nations[id];
            const you = id === game.playerId;
            return (
              <tr
                key={id}
                onClick={() => onShow(id)}
                className={`cursor-pointer border-t border-slate-900 hover:bg-slate-900 ${you ? 'text-amber-100' : 'text-slate-300'}`}
              >
                <td className="py-1.5">
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: nation?.colour }} />
                    <span className="truncate">{you ? `${nation?.name} (you)` : nation?.name}</span>
                  </span>
                </td>
                <td className="py-1.5 text-right tabular-nums">{countries}</td>
                <td className="py-1.5 text-right tabular-nums">{compact(totalTroops(game, id))}</td>
                <td className="py-1.5 text-right tabular-nums">{compact(grossIncome(game, id))}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
