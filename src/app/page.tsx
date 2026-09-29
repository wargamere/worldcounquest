'use client';

import { useEffect, useState } from 'react';
import { CountryPanel } from '@/components/hud/CountryPanel';
import { EventLog } from '@/components/hud/EventLog';
import { Standings } from '@/components/hud/Standings';
import { TopBar } from '@/components/hud/TopBar';
import { TurnReport } from '@/components/hud/TurnReport';
import { WorldMap } from '@/components/map/WorldMap';
import { EndScreen } from '@/components/screens/EndScreen';
import { HelpOverlay } from '@/components/screens/HelpOverlay';
import { StartScreen } from '@/components/screens/StartScreen';
import { useGameStore } from '@/store/gameStore';

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

/** Keys that act on the game, ignored while typing into a field. */
function useShortcuts(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const store = useGameStore.getState();
      if (store.showHelp) {
        if (event.key === 'Escape' || event.key === 'Enter') store.setHelp(false);
        return;
      }
      if (store.showReport && (event.key === 'Enter' || event.key === 'Escape')) {
        event.preventDefault();
        store.dismissReport();
        return;
      }
      switch (event.key) {
        case 'Enter':
          if (target?.tagName === 'BUTTON') return;
          event.preventDefault();
          store.endTurn();
          break;
        case 'Escape':
          store.back();
          break;
        case 'a':
        case 'A':
          store.advise();
          break;
        case 'h':
        case 'H':
          store.focusHome();
          break;
        case '?':
          store.setHelp(true);
          break;
      }
    };
    // A mouse or touch click leaves the clicked button focused, and a focused
    // button swallows Enter — pressing Enter after clicking "Advise" re-ran the
    // advisor instead of ending the turn. Pointer clicks give focus back; keyboard
    // users who tab onto a button keep normal button behaviour.
    const release = () => {
      const focused = document.activeElement;
      if (focused instanceof HTMLButtonElement) focused.blur();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerup', release);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerup', release);
    };
  }, [active]);
}

export default function Home() {
  const store = useGameStore();
  const [tab, setTab] = useState<'events' | 'powers'>('events');

  useEffect(() => {
    void useGameStore.getState().init(BASE_PATH);
  }, []);

  useShortcuts(store.phase === 'playing');

  if (store.phase === 'loading') return <Centered>Loading the world…</Centered>;
  if (store.phase === 'error') return <Centered>{store.loadError ?? 'Something went wrong.'}</Centered>;

  if (store.phase === 'menu' || !store.game || !store.world) {
    return <StartScreen hasSavedGame={store.hasSavedGame} onResume={store.resumeGame} onStart={store.startGame} />;
  }

  const { game, world, selectedId, targetId } = store;

  return (
    <div className="relative flex h-full flex-col">
      <TopBar
        game={game}
        onEndTurn={store.endTurn}
        onAdvise={store.advise}
        onHelp={() => store.setHelp(true)}
        onQuit={store.abandonGame}
      />

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <div className="relative min-h-0 flex-1">
          <WorldMap
            world={world}
            game={game}
            selectedId={selectedId}
            targetId={targetId}
            focus={store.focus}
            onCountryClick={store.clickCountry}
            onBackgroundClick={store.back}
            onHome={store.focusHome}
          />
          {store.showReport && (
            <TurnReport
              game={game}
              onShow={(ids) => {
                store.dismissReport();
                const first = ids[0];
                if (first) store.selectCountry(first);
                store.focusCountries(ids);
              }}
              onClose={store.dismissReport}
            />
          )}
          {!selectedId && store.flash && (
            <p role="status" className="absolute bottom-3 left-3 right-16 z-10 rounded border border-slate-700 bg-slate-950/95 px-3 py-2 text-xs text-slate-200 md:right-auto md:max-w-sm">
              {store.flash.text}
            </p>
          )}
        </div>

        <div className="flex max-h-[42vh] w-full flex-col border-t border-slate-800 bg-slate-950 md:max-h-none md:w-[22rem] md:border-l md:border-t-0">
          <div className="min-h-0 overflow-y-auto md:max-h-[62%]">
            {selectedId ? (
              <CountryPanel
                game={game}
                countryId={selectedId}
                targetId={targetId}
                suggestedTroops={store.suggestedTroops}
                flash={store.flash}
                onInvest={store.doInvest}
                onRecruit={store.doRecruit}
                onAttack={store.doAttack}
                onMove={store.doMove}
                onOrder={store.setOrder}
                onCancelOrder={store.back}
                onShowNation={store.focusNation}
                onClose={store.deselect}
              />
            ) : (
              <p className="p-3 text-xs leading-relaxed text-slate-500">
                Select one of your <span className="text-amber-300">gold</span> countries to recruit, invest, move or
                attack. Press <kbd className="rounded border border-slate-700 px-1">A</kbd> for advice,{' '}
                <kbd className="rounded border border-slate-700 px-1">Enter</kbd> to end the turn.
              </p>
            )}
          </div>

          <div className="flex min-h-0 flex-1 flex-col border-t border-slate-800">
            <div className="flex gap-1 px-3 pt-2" role="tablist">
              {(['events', 'powers'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  aria-selected={tab === t}
                  onClick={() => setTab(t)}
                  className={`rounded px-2 py-1 text-[11px] font-semibold uppercase tracking-wider ${tab === t ? 'bg-slate-800 text-slate-100' : 'text-slate-500 hover:text-slate-300'}`}
                >
                  {t === 'events' ? 'Events' : 'Great powers'}
                </button>
              ))}
            </div>
            <div className="flex min-h-0 flex-1 flex-col pt-2">
              {tab === 'events' ? <EventLog game={game} /> : <Standings game={game} onShow={store.focusNation} />}
            </div>
          </div>
        </div>
      </div>

      {store.showHelp && <HelpOverlay onClose={() => store.setHelp(false)} />}
      {game.status !== 'playing' && <EndScreen game={game} onRestart={store.abandonGame} />}
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <main className="flex h-full items-center justify-center p-6 text-center text-sm text-slate-400">{children}</main>;
}
