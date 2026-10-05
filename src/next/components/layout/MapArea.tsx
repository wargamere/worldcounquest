'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ArmyId, ProvinceIx } from '@/next/game/types';
import { getGeometry, getMapFrame, getMapStatic, setMapHandle, useGameStore } from '@/next/store/gameStore';
import { wake } from '@/next/store/loop';
import { MapCanvas } from '../map/MapCanvas';
import type { Camera, MapFrame, MapHandle, MapInputHandlers } from '../map/types';
import { act } from '../ui/act';
import { HoverTooltip, ProvinceInfoCard } from './HoverTooltip';
import { MapControls } from './MapControls';

/**
 * The canvas map wired to the store (§4.7, §9.6): MapCanvas mounts once, reads
 * the live frame through getMapFrame and reports input here; React never
 * re-renders it for game state.
 */
export function MapArea({ phone }: { phone: boolean }) {
  const map = getMapStatic();
  const geometry = getGeometry();
  const [info, setInfo] = useState<ProvinceIx | null>(null);
  const coarse = useGameStore((s) => s.coarse);

  const handlers = useMemo<MapInputHandlers>(
    () => ({
      tapMarker: (armies: readonly ArmyId[], additive: boolean) => {
        setInfo(null);
        act().clickMarker(armies, additive);
      },
      tapProvince: (p: ProvinceIx, additive: boolean) => {
        setInfo(null);
        act().clickProvince(p, additive);
      },
      secondary: (p: ProvinceIx, append: boolean) => act().orderNow(p, append),
      longPressMarker: (armies: readonly ArmyId[]) => {
        act().setMultiSelect(true);
        act().clickMarker(armies, true);
      },
      longPressProvince: (p: ProvinceIx) => setInfo(p),
      box: (armies: readonly ArmyId[], additive: boolean) => act().boxSelect(armies, additive),
      hover: (p: ProvinceIx | null) => act().setHover(p),
      dragOrder: (armies: readonly ArmyId[], p: ProvinceIx) => act().openDraft(armies, p),
      cameraChanged: (_camera: Camera, _gesturing: boolean) => wake(),
    }),
    [],
  );
  const getFrame = useCallback((): MapFrame => {
    const frame = getMapFrame();
    if (frame === null) throw new Error('The map drew without a running game');
    return frame;
  }, []);
  const onReady = useCallback((handle: MapHandle) => setMapHandle(handle), []);
  // The next map frames the next game: a handle must not outlive its canvas.
  useEffect(() => () => setMapHandle(null), []);

  if (map === null || geometry === null) return null;
  return (
    <div className="absolute inset-0 bg-[#0b1a2e]">
      <MapCanvas map={map} geometry={geometry} getFrame={getFrame} handlers={handlers} onReady={onReady} />
      {!coarse && <HoverTooltip />}
      {info !== null && <ProvinceInfoCard province={info} onClose={() => setInfo(null)} />}
      <MapControls phone={phone} />
    </div>
  );
}
