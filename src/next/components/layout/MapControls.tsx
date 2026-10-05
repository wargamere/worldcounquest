'use client';

import type { MapMode } from '@/next/game/types';
import { getMapHandle, useGameStore } from '@/next/store/gameStore';
import { act } from '../ui/act';
import { Icon, type IconName } from '../ui/Icon';

export const MAP_MODES: readonly MapMode[] = ['political', 'terrain', 'resources', 'stability', 'supply'];
const MODE_TEXT: Readonly<Record<MapMode, string>> = {
  political: 'Political',
  terrain: 'Terrain',
  resources: 'Resources',
  stability: 'Stability',
  supply: 'Supply',
};
const ZOOM_STEP = 1.6;

export function nextMapMode(mode: MapMode): MapMode {
  return MAP_MODES[(MAP_MODES.indexOf(mode) + 1) % MAP_MODES.length] ?? 'political';
}

/** Map controls, bottom right (§8.1): zoom in, zoom out, home (H), capital (C) and the map mode (V). */
export function MapControls({ phone }: { phone: boolean }) {
  const mode = useGameStore((s) => s.mapMode);
  const size = phone ? 'h-11 w-11' : 'h-8 w-8';
  const button = (icon: IconName, label: string, run: () => void) => (
    <button type="button" aria-label={label} title={label} onClick={run} className={`grid ${size} place-items-center rounded border border-slate-700 bg-slate-950/90 text-slate-200 hover:border-slate-500`}>
      <Icon name={icon} size={16} />
    </button>
  );
  return (
    <div className={`absolute z-20 flex flex-col items-end gap-1 ${phone ? 'bottom-32 left-2 items-start' : 'bottom-3 right-3'}`}>
      <button type="button" onClick={() => act().setMapMode(nextMapMode(mode))} title="Map mode (V)" className="flex h-8 items-center gap-1 rounded border border-slate-700 bg-slate-950/90 px-2 text-xs text-slate-200 hover:border-slate-500">
        <Icon name="layers" size={14} /> {MODE_TEXT[mode]}
      </button>
      {!phone && button('plus', 'Zoom in', () => getMapHandle()?.zoomBy(ZOOM_STEP))}
      {!phone && button('minus', 'Zoom out', () => getMapHandle()?.zoomBy(1 / ZOOM_STEP))}
      {!phone && button('home', 'Your nation (H)', () => act().focusHome())}
      {button('capital', 'Your capital (C)', () => act().focusCapital())}
    </div>
  );
}
