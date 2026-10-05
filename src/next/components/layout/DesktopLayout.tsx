'use client';

import { useState } from 'react';
import { useGameStore } from '@/next/store/gameStore';
import { FeedPanel } from '../feed/FeedPanel';
import { Toasts } from '../feed/Toasts';
import { PausedBanner } from '../hud/PausedBanner';
import { TopBar } from '../hud/TopBar';
import { ContextPanel } from '../panels/ContextPanel';
import { GreatPowers } from '../panels/GreatPowers';
import { Coach } from '../screens/Coach';
import { act } from '../ui/act';
import { Icon } from '../ui/Icon';
import { Drawers } from './Drawers';
import { MapArea } from './MapArea';

/** Desktop (§8.1): the top bar, the map, and a collapsible 360 px right column with the context panel above Feed / Great Powers. */
export function DesktopLayout() {
  const panel = useGameStore((s) => s.panel);
  const [open, setOpen] = useState(true);
  const tab = panel === 'powers' ? 'powers' : 'feed';
  return (
    <div className="flex h-full flex-col">
      <TopBar />
      <div className="relative flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1 overflow-hidden">
          <MapArea phone={false} />
          <PausedBanner />
          <Toasts />
          <Coach />
          <button
            type="button"
            onClick={() => setOpen(!open)}
            aria-label={open ? 'Hide the side panel' : 'Show the side panel'}
            aria-expanded={open}
            className="absolute right-0 top-1/2 z-20 grid h-10 w-5 -translate-y-1/2 place-items-center rounded-l border border-r-0 border-slate-700 bg-slate-950/90 text-slate-400 hover:text-slate-100"
          >
            <Icon name="go" size={12} className={open ? '' : 'rotate-180'} />
          </button>
        </div>
        {open && (
          <aside className="flex w-[360px] shrink-0 flex-col border-l border-slate-800 bg-slate-950" aria-label="Side panel">
            <div className="min-h-0 max-h-[62%] overflow-y-auto">
              <ContextPanel />
            </div>
            <div className="flex min-h-0 flex-1 flex-col border-t border-slate-800">
              <div className="flex gap-1 px-3 pt-2" role="tablist" aria-label="Side tabs">
                <button type="button" role="tab" aria-selected={tab === 'feed'} onClick={() => tab !== 'feed' && act().openPanel('feed')} className={`rounded px-2 py-1 text-[11px] font-semibold uppercase tracking-wider ${tab === 'feed' ? 'bg-slate-800 text-slate-100' : 'text-slate-500 hover:text-slate-300'}`}>
                  Feed
                </button>
                <button type="button" role="tab" aria-selected={tab === 'powers'} onClick={() => tab !== 'powers' && act().openPanel('powers')} className={`rounded px-2 py-1 text-[11px] font-semibold uppercase tracking-wider ${tab === 'powers' ? 'bg-slate-800 text-slate-100' : 'text-slate-500 hover:text-slate-300'}`}>
                  Great Powers
                </button>
              </div>
              {tab === 'feed' ? (
                <FeedPanel />
              ) : (
                <div className="min-h-0 flex-1 overflow-y-auto p-3">
                  <GreatPowers />
                </div>
              )}
            </div>
          </aside>
        )}
        <Drawers phone={false} />
      </div>
    </div>
  );
}
