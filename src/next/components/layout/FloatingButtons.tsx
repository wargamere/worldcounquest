'use client';

import { useCallback, useState } from 'react';
import { feedFor } from '@/next/game/feed';
import type { Sim } from '@/next/game/types';
import { hudView } from '@/next/game/views';
import { useGameStore, useSimView } from '@/next/store/gameStore';
import { GameMenu, SuggestButton } from '../hud/TopBar';
import { act } from '../ui/act';
import { Icon } from '../ui/Icon';

const BADGE_SCAN = 50;

/** Phone floating buttons (§8.6, 48 px, right edge): Home, Suggest, Battles, Feed (with a badge) and Menu. */
export function FloatingButtons() {
  const showAll = useGameStore((s) => s.prefs.showAllArmies);
  const [seen, setSeen] = useState(-1);
  const data = useSimView(
    useCallback(
      (sim: Sim) => {
        const mine = feedFor(sim, 'mine', BADGE_SCAN);
        return { hud: hudView(sim, showAll), newest: mine[0]?.id ?? -1, unread: mine.filter((e) => e.id > seen && (e.severity === 'bad' || e.severity === 'critical')).length };
      },
      [showAll, seen],
    ),
  );
  if (data === null) return null;
  const round = 'relative grid h-12 w-12 place-items-center rounded-full border border-slate-700 bg-slate-950/90 text-slate-200 shadow-lg';
  return (
    <div className="absolute right-2 top-2 z-20 flex flex-col items-end gap-2">
      <button type="button" aria-label="Frame your nation" onClick={() => act().focusHome()} className={round}>
        <Icon name="home" size={20} />
      </button>
      <SuggestButton idle={data.hud.idle} round />
      <button type="button" aria-label={`Battles: ${data.hud.battles}`} onClick={() => act().nextBattle()} className={round}>
        <Icon name="battle" size={20} />
        {data.hud.battles > 0 && <span className="absolute -right-1 -top-1 grid h-5 min-w-[1.25rem] place-items-center rounded-full bg-rose-500 px-1 text-[10px] font-bold text-white">{data.hud.battles}</span>}
      </button>
      <button
        type="button"
        aria-label={`Feed${data.unread > 0 ? `, ${data.unread} new alerts` : ''}`}
        onClick={() => {
          setSeen(data.newest);
          act().openPanel('feed');
        }}
        className={round}
      >
        <Icon name="feed" size={20} />
        {data.unread > 0 && <span className="absolute -right-1 -top-1 grid h-5 min-w-[1.25rem] place-items-center rounded-full bg-orange-500 px-1 text-[10px] font-bold text-slate-950">{data.unread}</span>}
      </button>
      <GameMenu round />
    </div>
  );
}
