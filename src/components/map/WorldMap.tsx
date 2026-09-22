'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { geoNaturalEarth1, geoPath } from 'd3-geo';
import { select } from 'd3-selection';
import { zoom, zoomIdentity, type D3ZoomEvent } from 'd3-zoom';
import { nationColour, UNCLAIMED_COLOUR } from '@/game/colours';
import type { CountryId, GameState } from '@/game/types';
import type { World } from '@/lib/world';
import { CountryPath } from './CountryPath';

interface WorldMapProps {
  world: World;
  game: GameState;
  selectedId: CountryId | null;
  stagingId: CountryId | null;
  onSelect: (id: CountryId | null) => void;
}

/** Troop labels only appear once zoomed past this, or the map is unreadable. */
const LABEL_ZOOM_THRESHOLD = 2.2;
const MIN_ZOOM = 1;
const MAX_ZOOM = 14;

export function WorldMap({ world, game, selectedId, stagingId, onSelect }: WorldMapProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ width: 1200, height: 700 });
  const [transform, setTransform] = useState(() => zoomIdentity);

  useEffect(() => {
    const element = svgRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) setSize({ width, height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  /**
   * Path geometry depends only on the shapes and the viewport, never on game
   * state, so it is computed here and handed down as stable strings.
   */
  const geometry = useMemo(() => {
    const projection = geoNaturalEarth1().fitSize(
      [size.width, size.height],
      { type: 'FeatureCollection', features: world.shapes.map((s) => s.feature) },
    );
    const path = geoPath(projection);
    return world.shapes.map((shape) => ({
      id: shape.id,
      name: shape.name,
      d: path(shape.feature) ?? '',
      centroid: path.centroid(shape.feature),
    }));
  }, [world.shapes, size.width, size.height]);

  useEffect(() => {
    const element = svgRef.current;
    if (!element) return;
    const behaviour = zoom<SVGSVGElement, unknown>()
      .scaleExtent([MIN_ZOOM, MAX_ZOOM])
      .on('zoom', (event: D3ZoomEvent<SVGSVGElement, unknown>) => setTransform(event.transform));
    const selection = select(element);
    selection.call(behaviour);
    return () => {
      selection.on('.zoom', null);
    };
  }, []);

  const showLabels = transform.k >= LABEL_ZOOM_THRESHOLD;

  return (
    <svg
      ref={svgRef}
      className="h-full w-full touch-none select-none bg-[#0b1120]"
      onClick={() => onSelect(null)}
    >
      <g transform={transform.toString()}>
        {geometry.map((shape) => {
          const country = game.countries[shape.id];
          return (
            <CountryPath
              key={shape.id}
              id={shape.id}
              d={shape.d}
              fill={country ? nationColour(country.ownerId, game.playerId) : UNCLAIMED_COLOUR}
              selected={shape.id === selectedId}
              staging={shape.id === stagingId}
              onSelect={onSelect}
            />
          );
        })}
        {showLabels &&
          geometry.map((shape) => {
            const country = game.countries[shape.id];
            if (!country || !Number.isFinite(shape.centroid[0])) return null;
            return (
              <text
                key={`label-${shape.id}`}
                x={shape.centroid[0]}
                y={shape.centroid[1]}
                textAnchor="middle"
                className="pointer-events-none fill-slate-950 font-semibold"
                style={{ fontSize: `${11 / transform.k}px` }}
              >
                {country.troops}
              </text>
            );
          })}
      </g>
    </svg>
  );
}
