'use client';

import { useEffect, useState } from 'react';
import { useGameStore } from '@/next/store/gameStore';
import { DesktopLayout } from './layout/DesktopLayout';
import { PhoneLayout } from './layout/PhoneLayout';
import { useBreakpoint } from './layout/useBreakpoint';
import { EndScreen } from './screens/EndScreen';
import { PerfOverlay } from './screens/PerfOverlay';
import { StartScreen } from './screens/StartScreen';
import { act } from './ui/act';
import { useShortcuts } from './useShortcuts';

/** GitHub Pages serves the game under /<repo>; the map files are fetched under the same prefix. */
const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

/**
 * The whole game UI (§8): loading, the Start screen, then the desktop or phone
 * layout over the canvas map, with the end screen on top once the game is decided.
 */
export function GameRoot() {
  const phase = useGameStore((s) => s.phase);
  const loadError = useGameStore((s) => s.loadError);
  const endDismissed = useGameStore((s) => s.endDismissed);
  const reduceMotion = useGameStore((s) => s.prefs.reduceMotion);
  const { phone, landscape } = useBreakpoint();
  // Read once on the client; the overlay only renders in a game, long after hydration.
  const [perf] = useState(() => typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('debug') === 'perf');

  useEffect(() => {
    void act().init(BASE_PATH);
  }, []);
  // The map and the CSS read this to stop pulses (§8.8).
  useEffect(() => {
    document.documentElement.dataset['reduceMotion'] = reduceMotion ? 'true' : 'false';
  }, [reduceMotion]);
  useShortcuts(phase === 'playing');

  if (phase === 'loading') return <Centered>Loading the world…</Centered>;
  if (phase === 'error') {
    return (
      <Centered>
        <p>{loadError ?? 'Something went wrong.'}</p>
        <button type="button" onClick={() => window.location.reload()} className="mt-3 rounded border border-slate-600 px-3 py-1.5 text-slate-200 hover:border-slate-400">
          Try again
        </button>
      </Centered>
    );
  }
  if (phase === 'menu') return <StartScreen />;
  return (
    <div className="relative h-full overflow-hidden">
      {phone ? <PhoneLayout landscape={landscape} /> : <DesktopLayout />}
      {!endDismissed && <EndScreen />}
      {perf && <PerfOverlay />}
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <main className="flex h-full flex-col items-center justify-center p-6 text-center text-sm text-slate-400">{children}</main>;
}
