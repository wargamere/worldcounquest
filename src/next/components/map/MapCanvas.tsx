'use client';

/**
 * The canvas map (§9): two stacked canvases, base and overlay, inside one
 * element that also takes the input. It mounts once per map and never
 * re-renders for game state: the controller draws from the loop's renderer
 * callback and reads the live Sim through `getFrame()`, and the latest
 * `getFrame` and `handlers` are read through a ref, so new props never
 * rebuild the map.
 */
import { useEffect, useRef } from 'react';
import type { MapStatic } from '@/next/game/types';
import type { MapGeometry } from '@/next/lib/geometry';
import { createMapController } from './controller';
import { BASE_COLOURS } from './drawBase';
import type { MapFrame, MapHandle, MapInputHandlers } from './types';

export interface MapCanvasProps {
  map: MapStatic;
  geometry: MapGeometry;
  getFrame(): MapFrame;
  handlers: MapInputHandlers;
  onReady(handle: MapHandle): void;
}

export function MapCanvas(props: MapCanvasProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const baseRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const latest = useRef<MapCanvasProps>(props);
  useEffect(() => {
    latest.current = props;
  });

  const { map, geometry } = props;
  useEffect(() => {
    const host = hostRef.current;
    const base = baseRef.current;
    const overlay = overlayRef.current;
    if (host === null || base === null || overlay === null) return;
    const controller = createMapController({
      host,
      base,
      overlay,
      map,
      geometry,
      getFrame: () => latest.current.getFrame(),
      handlers: () => latest.current.handlers,
    });
    latest.current.onReady(controller.handle);
    return () => controller.destroy();
  }, [map, geometry]);

  return (
    <div
      ref={hostRef}
      role="application"
      aria-label="World map"
      className="absolute inset-0 touch-none select-none overflow-hidden"
      style={{ background: BASE_COLOURS.space }}
    >
      <canvas ref={baseRef} aria-hidden="true" className="pointer-events-none absolute origin-top-left" />
      <canvas ref={overlayRef} aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full" />
    </div>
  );
}
