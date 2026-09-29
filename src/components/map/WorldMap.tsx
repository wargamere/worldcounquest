'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { geoGraticule10, geoNaturalEarth1, geoPath } from 'd3-geo';
import { select } from 'd3-selection';
import 'd3-transition';
import { zoom, zoomIdentity, type D3ZoomEvent, type ZoomBehavior } from 'd3-zoom';
import { mesh } from 'topojson-client';
import { ADVISOR } from '@/game/balance';
import { UNCLAIMED_COLOUR } from '@/game/colours';
import { countryRisk } from '@/game/orders';
import type { CountryId, GameState } from '@/game/types';
import { nationBorders, type World } from '@/lib/world';
import type { FocusRequest } from '@/store/gameStore';
import { CountryPath } from './CountryPath';

interface WorldMapProps {
  world: World;
  game: GameState;
  selectedId: CountryId | null;
  targetId: CountryId | null;
  focus: FocusRequest | null;
  onCountryClick: (id: CountryId) => void;
  onBackgroundClick: () => void;
  onHome: () => void;
}

/** Below this zoom only the labels that matter to you are drawn. */
const LABEL_ZOOM_THRESHOLD = 2.4;
const MIN_ZOOM = 1;
const MAX_ZOOM = 16;
/** Share of the view a focused region fills, and the closest a focus will zoom. */
const FOCUS_FILL = 0.4;
const FOCUS_MAX_ZOOM = 6;
const OCEAN = '#0b1120';

export function WorldMap(props: WorldMapProps) {
  const { world, game, selectedId, targetId, focus, onCountryClick, onBackgroundClick, onHome } = props;
  const svgRef = useRef<SVGSVGElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const behaviourRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const [size, setSize] = useState({ width: 1200, height: 700 });
  const [transform, setTransform] = useState(() => zoomIdentity);
  const [hoverId, setHoverId] = useState<CountryId | null>(null);
  // The tooltip stays hidden until a mouse move has positioned it; otherwise a
  // country under a stationary cursor shows its tooltip pinned to the corner.
  const [tipPlaced, setTipPlaced] = useState(false);

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

  /** Projection and every path string. Depends on the viewport only, never on play. */
  const geometry = useMemo(() => {
    const projection = geoNaturalEarth1().fitExtent(
      [[8, 8], [size.width - 8, size.height - 8]],
      { type: 'Sphere' },
    );
    const path = geoPath(projection);
    return {
      path,
      sphere: path({ type: 'Sphere' }) ?? '',
      graticule: path(geoGraticule10()) ?? '',
      shapes: world.shapes.map((shape) => ({
        id: shape.id,
        d: path(shape.feature) ?? '',
        label: path.centroid(shape.mainland),
        bounds: path.bounds(shape.mainland),
      })),
    };
  }, [world.shapes, size.width, size.height]);

  const byId = useMemo(() => new Map(geometry.shapes.map((s) => [s.id, s])), [geometry.shapes]);

  /** Empire outlines. Recomputed only when ownership actually changes. */
  const ownership = Object.values(game.countries).map((c) => c.ownerId).join(',');
  const borders = useMemo(() => {
    const ownerOf = (id: CountryId) => game.countries[id]?.ownerId;
    const player = game.playerId;
    const index = new Map<object, CountryId | undefined>();
    world.topology.objects.countries.geometries.forEach((g, i) => index.set(g, world.idsByIndex[i]));
    const isPlayer = (g: object) => {
      const id = index.get(g);
      return id !== undefined && ownerOf(id) === player;
    };
    return {
      nations: geometry.path(nationBorders(world, ownerOf)) ?? '',
      player: geometry.path(
        mesh(world.topology, world.topology.objects.countries, (a, b) => isPlayer(a) !== isPlayer(b) || (a === b && isPlayer(a))),
      ) ?? '',
    };
    // `ownership` stands in for game.countries so selection changes do not rebuild meshes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownership, geometry.path, world, game.playerId]);

  useEffect(() => {
    const element = svgRef.current;
    if (!element) return;
    const behaviour = zoom<SVGSVGElement, unknown>()
      .scaleExtent([MIN_ZOOM, MAX_ZOOM])
      .translateExtent([[-size.width * 0.25, -size.height * 0.25], [size.width * 1.25, size.height * 1.25]])
      .on('zoom', (event: D3ZoomEvent<SVGSVGElement, unknown>) => setTransform(event.transform));
    behaviourRef.current = behaviour;
    const selection = select(element);
    selection.call(behaviour).on('dblclick.zoom', null);
    return () => {
      selection.on('.zoom', null);
    };
  }, [size.width, size.height]);

  /** Frames the requested countries, smoothly. */
  useEffect(() => {
    const element = svgRef.current;
    const behaviour = behaviourRef.current;
    if (!focus || !element || !behaviour || focus.countryIds.length === 0) return;
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const id of focus.countryIds) {
      const b = byId.get(id)?.bounds;
      if (!b) continue;
      x0 = Math.min(x0, b[0][0]);
      y0 = Math.min(y0, b[0][1]);
      x1 = Math.max(x1, b[1][0]);
      y1 = Math.max(y1, b[1][1]);
    }
    if (!Number.isFinite(x0)) return;
    const k = Math.min(
      FOCUS_MAX_ZOOM,
      Math.max(MIN_ZOOM, FOCUS_FILL / Math.max((x1 - x0) / size.width, (y1 - y0) / size.height, 1e-3)),
    );
    const target = zoomIdentity
      .translate(size.width / 2 - (k * (x0 + x1)) / 2, size.height / 2 - (k * (y0 + y1)) / 2)
      .scale(k);
    select(element)
      .transition()
      .duration(650)
      .call((t) => behaviour.transform(t, target));
  }, [focus, byId, size.width, size.height]);

  const zoomBy = useCallback((factor: number) => {
    const element = svgRef.current;
    const behaviour = behaviourRef.current;
    if (element && behaviour) {
      select(element)
        .transition()
        .duration(250)
        .call((t) => behaviour.scaleBy(t, factor));
    }
  }, []);
  const zoomIn = useCallback(() => zoomBy(1.6), [zoomBy]);
  const zoomOut = useCallback(() => zoomBy(1 / 1.6), [zoomBy]);

  const onHover = useCallback((id: CountryId | null) => setHoverId(id), []);

  const moveTooltip = (event: React.MouseEvent) => {
    const tip = tooltipRef.current;
    const box = svgRef.current?.getBoundingClientRect();
    if (!tip || !box) return;
    const x = event.clientX - box.left;
    const y = event.clientY - box.top;
    const flip = x > box.width - 220;
    tip.style.transform = `translate(${flip ? x - 14 - tip.offsetWidth : x + 14}px, ${y + 14}px)`;
    if (!tipPlaced) setTipPlaced(true);
  };

  // --- What to highlight -----------------------------------------------------
  const selected = selectedId ? game.countries[selectedId] : undefined;
  const canOrder = selected !== undefined && selected.ownerId === game.playerId && !selected.hasMoved;
  const neighbours = selected ? (game.adjacency[selected.id] ?? []) : [];
  const attackTargets = canOrder ? neighbours.filter((n) => game.countries[n]?.ownerId !== game.playerId) : [];
  const moveTargets = canOrder ? neighbours.filter((n) => game.countries[n]?.ownerId === game.playerId) : [];

  const mine = Object.values(game.countries).filter((c) => c.ownerId === game.playerId);
  const endangered = mine.filter((c) => countryRisk(game, c.id).chance >= ADVISOR.DANGER_THRESHOLD).map((c) => c.id);

  const important = new Set<CountryId>([...mine.map((c) => c.id), ...neighbours, ...(selectedId ? [selectedId] : [])]);
  for (const c of mine) for (const n of game.adjacency[c.id] ?? []) important.add(n);

  const k = transform.k;
  const showAll = k >= LABEL_ZOOM_THRESHOLD;
  const fontSize = 10 / k;

  /**
   * Troop labels, placed greedily in priority order — the order you are giving,
   * then your own countries, then their neighbours, then everyone else by army
   * size — skipping any label that would overlap one already placed. Without
   * this a grown empire's labels pile on top of each other at world zoom.
   */
  const labels: { id: CountryId; x: number; y: number; w: number; h: number; text: string; ours: boolean }[] = [];
  {
    const priority = (id: CountryId, troops: number): number => {
      if (id === selectedId || id === targetId) return 4e9;
      if (game.countries[id]?.ownerId === game.playerId) return 3e9 + troops;
      if (important.has(id)) return 2e9 + troops;
      return troops;
    };
    const candidates = geometry.shapes
      .map((shape) => ({ shape, country: game.countries[shape.id] }))
      .filter(
        (c): c is { shape: (typeof geometry.shapes)[number]; country: NonNullable<typeof c.country> } =>
          c.country !== undefined &&
          Number.isFinite(c.shape.label[0]) &&
          (showAll || important.has(c.shape.id)),
      )
      .sort((a, b) => priority(b.shape.id, b.country.troops) - priority(a.shape.id, a.country.troops));
    const gap = fontSize * 0.2;
    for (const { shape, country } of candidates) {
      const [x, y] = shape.label;
      const text = country.troops >= 10_000 ? `${Math.round(country.troops / 1000)}k` : `${country.troops}`;
      const w = (text.length * 0.62 + 1) * fontSize;
      const h = fontSize * 1.45;
      const clashes = labels.some(
        (l) => Math.abs(l.x - x) * 2 < l.w + w + gap && Math.abs(l.y - y) * 2 < l.h + h + gap,
      );
      if (!clashes) labels.push({ id: shape.id, x, y, w, h, text, ours: country.ownerId === game.playerId });
    }
  }

  const hovered = hoverId ? game.countries[hoverId] : undefined;
  const hoveredOwner = hovered ? game.nations[hovered.ownerId] : undefined;

  const outline = (ids: CountryId[], stroke: string, width: number, dash?: string) =>
    ids.map((id) => {
      const d = byId.get(id)?.d;
      return d ? (
        <path
          key={`${stroke}-${id}`}
          d={d}
          fill="none"
          stroke={stroke}
          strokeWidth={width}
          strokeDasharray={dash}
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
          pointerEvents="none"
        />
      ) : null;
    });

  return (
    <div
      className="relative h-full w-full overflow-hidden"
      onMouseMove={moveTooltip}
      onMouseLeave={() => {
        setHoverId(null);
        setTipPlaced(false);
      }}
    >
      <svg
        ref={svgRef}
        className="h-full w-full touch-none select-none"
        style={{ background: OCEAN }}
        onClick={onBackgroundClick}
        role="img"
        aria-label="World map"
      >
        <g transform={transform.toString()}>
          <path d={geometry.sphere} fill="#0f1b33" />
          <path d={geometry.graticule} fill="none" stroke="#1a2a4a" strokeWidth={0.5} vectorEffect="non-scaling-stroke" pointerEvents="none" />

          {geometry.shapes.map((shape) => {
            const country = game.countries[shape.id];
            const colour = country ? game.nations[country.ownerId]?.colour ?? UNCLAIMED_COLOUR : UNCLAIMED_COLOUR;
            return (
              <CountryPath key={shape.id} id={shape.id} d={shape.d} fill={colour} onSelect={onCountryClick} onHover={onHover} />
            );
          })}

          <path d={borders.nations} fill="none" stroke={OCEAN} strokeWidth={1.6} vectorEffect="non-scaling-stroke" pointerEvents="none" />
          <path d={borders.player} fill="none" stroke="#fde68a" strokeWidth={1.4} vectorEffect="non-scaling-stroke" pointerEvents="none" />

          {outline(moveTargets, '#7dd3fc', 1.4, '4 3')}
          {outline(attackTargets, '#fb7185', 1.6, '4 3')}
          {outline(endangered, '#ef4444', 2)}
          {selectedId && outline([selectedId], '#ffffff', 2.4)}
          {targetId && outline([targetId], targetId && game.countries[targetId]?.ownerId === game.playerId ? '#38bdf8' : '#f43f5e', 3)}

          {labels.map((label) => (
            <g key={`label-${label.id}`} pointerEvents="none">
              <rect
                x={label.x - label.w / 2}
                y={label.y - label.h / 2}
                width={label.w}
                height={label.h}
                rx={label.h / 2}
                fill="#0b1120"
                fillOpacity={0.82}
                stroke={label.ours ? '#f2c14e' : 'none'}
                strokeWidth={label.ours ? 1 : 0}
                vectorEffect="non-scaling-stroke"
              />
              <text
                x={label.x}
                y={label.y}
                textAnchor="middle"
                dominantBaseline="central"
                fill="#e2e8f0"
                style={{ fontSize: `${fontSize}px`, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}
              >
                {label.text}
              </text>
            </g>
          ))}
        </g>
      </svg>

      <div
        ref={tooltipRef}
        className={`pointer-events-none absolute left-0 top-0 z-10 max-w-[220px] rounded-md border border-slate-700 bg-slate-950/95 px-2.5 py-1.5 text-xs shadow-lg transition-opacity duration-100 ${hovered && tipPlaced ? 'opacity-100' : 'opacity-0'}`}
      >
        {hovered && (
          <>
            <div className="font-semibold text-slate-50">{hovered.name}</div>
            <div className="flex items-center gap-1.5 text-slate-400">
              <span className="inline-block h-2 w-2 rounded-full" style={{ background: hoveredOwner?.colour }} />
              {hovered.ownerId === game.playerId ? 'Yours' : hoveredOwner?.name}
            </div>
            <div className="mt-0.5 tabular-nums text-slate-300">
              {hovered.troops} troops · dev {hovered.development}
            </div>
          </>
        )}
      </div>

      <div className="absolute bottom-3 right-3 z-10 flex flex-col gap-1">
        <MapButton label="+" title="Zoom in" onPress={zoomIn} />
        <MapButton label="−" title="Zoom out" onPress={zoomOut} />
        <MapButton label="⌂" title="Your nation (H)" onPress={onHome} />
      </div>
    </div>
  );
}

function MapButton({ label, title, onPress }: { label: string; title: string; onPress: () => void }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={(e) => {
        e.stopPropagation();
        onPress();
      }}
      className="h-9 w-9 rounded-md border border-slate-700 bg-slate-950/90 text-lg leading-none text-slate-200 hover:border-slate-500 hover:bg-slate-900"
    >
      {label}
    </button>
  );
}
