'use client';

import { useEffect } from 'react';
import { CountryPanel } from '@/components/hud/CountryPanel';
import { EventLog } from '@/components/hud/EventLog';
import { TopBar } from '@/components/hud/TopBar';
import { WorldMap } from '@/components/map/WorldMap';
import { EndScreen } from '@/components/screens/EndScreen';
import { StartScreen } from '@/components/screens/StartScreen';
import { useGameStore } from '@/store/gameStore';

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

export default function Home() {
  const store = useGameStore();

  useEffect(() => {
    void useGameStore.getState().init(BASE_PATH);
  }, []);

  if (store.phase === 'loading') {
    return <Centered>Loading the world…</Centered>;
  }

  if (store.phase === 'error') {
    return <Centered>{store.loadError ?? 'Something went wrong.'}</Centered>;
  }

  if (store.phase === 'menu' || !store.game || !store.world) {
    return (
      <StartScreen
        hasSavedGame={store.hasSavedGame}
        onResume={store.resumeGame}
        onStart={store.startGame}
      />
    );
  }

  const { game, world, selectedId, orderFromId } = store;

  return (
    <div className="relative flex h-full flex-col">
      <TopBar game={game} onEndTurn={store.endTurn} onQuit={store.abandonGame} />

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <div className="min-h-0 flex-1">
          <WorldMap
            world={world}
            game={game}
            selectedId={selectedId}
            stagingId={orderFromId}
            onSelect={(id) => {
              store.select(id);
              if (id) store.dismissMessage();
            }}
          />
        </div>

        <div className="flex max-h-[55vh] w-full flex-col md:max-h-none md:w-80">
          {selectedId ? (
            <CountryPanel
              game={game}
              countryId={selectedId}
              stagingId={orderFromId}
              message={store.message}
              onInvest={store.doInvest}
              onRecruit={store.doRecruit}
              onBeginOrder={store.beginOrder}
              onMove={store.doMove}
              onAttack={store.doAttack}
              onClose={() => store.select(null)}
            />
          ) : (
            <p className="border-t border-slate-800 p-3 text-xs text-slate-500 md:border-l md:border-t-0">
              Click a country to inspect it. Drag to pan, scroll or pinch to zoom — troop counts
              appear as you zoom in.
            </p>
          )}
          <EventLog game={game} />
        </div>
      </div>

      {game.status !== 'playing' && <EndScreen game={game} onRestart={store.abandonGame} />}
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex h-full items-center justify-center p-6 text-center text-sm text-slate-400">
      {children}
    </main>
  );
}
