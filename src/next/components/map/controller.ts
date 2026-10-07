/**
 * The canvas map's imperative core (§9.1–§9.6), created once per mounted
 * MapCanvas. It owns the camera (d3-zoom), both canvases, the base scene and
 * the marker layout, and it draws from the loop's renderer callback, reading
 * the live Sim through `getFrame()`. React never re-renders it for game state.
 *
 * The base layer is a raster with RENDER.GESTURE_MARGIN of extra view on each
 * side. While a gesture runs it is moved and scaled with a CSS transform (the
 * compositor does the blit, so it costs nothing on the main thread), and it is
 * re-rastered GESTURE_SETTLE_MS after the last zoom event, or at once if the
 * gesture drifts GESTURE_RERASTER_SCALE in scale. Ownership changes repaint
 * only the changed provinces' rectangles (at most BASE_REPAINT_MAX_HZ), or the
 * whole raster beyond DIRTY_RECT_MAX provinces.
 */
import { select } from 'd3-selection';
import 'd3-transition';
import { zoom, zoomIdentity, type D3ZoomEvent, type ZoomBehavior } from 'd3-zoom';
import { RENDER } from '@/next/game/balance';
import { armiesAt, ownedProvinces } from '@/next/game/cache';
import type { ArmyId, MapMode, MapStatic, ProvinceIx, Sim } from '@/next/game/types';
import { boundsOf, isNationBorder, isPlayerBorder, isProvinceBorder, type MapGeometry } from '@/next/lib/geometry';
import { buildHitGrid, pickProvince } from '@/next/lib/hitTest';
import { registerRenderer, wake, type FrameInfo } from '@/next/store/loop';
import { canvasDpr, FRAME_FILL, FRAME_MAX_ZOOM, frameBounds, minZoom, rasterTransform, toBase, worldCamera } from './camera';
import { drawBase, drawBaseLabels, type BaseScene } from './drawBase';
import { drawDragLine, drawOverlay, hitRadius, setReducedMotion } from './drawOverlay';
import { attachInput, type InputFeedback, type MapPick } from './input';
import { armiesInRect, layoutMarkers, markerAt, type Marker } from './markers';
import { buildArcPath, buildSeaLinkPath, provincePathsFor } from './paths';
import { capitalStars, changedProvinces, dirtyRects, fillKey, nationLabels, ownerChanges, provinceFills, type Fills, type NationLabel } from './scene';
import type { Camera, MapFrame, MapHandle, MapInputHandlers } from './types';

export interface MapControllerOptions {
  host: HTMLDivElement;
  base: HTMLCanvasElement;
  overlay: HTMLCanvasElement;
  map: MapStatic;
  geometry: MapGeometry;
  getFrame(): MapFrame;
  /** The latest handlers; read on every event so the component can pass new ones. */
  handlers(): MapInputHandlers;
}
export interface MapController {
  handle: MapHandle;
  destroy(): void;
}

/** Draw timings of the last frames, for the ?debug=perf overlay. */
export const mapTimings = { baseMs: 0, overlayMs: 0, markers: 0 };

/** Camera moves the handle animates (ms). */
const ZOOM_BY_MS = 250;
const HOME_MS = 600;
/** The camera may pan this share of the world beyond its edges. */
const PAN_SLACK = 0.1;
/** Repaint rectangles are grown by this much (CSS px) so borders are re-stroked whole. */
const DIRTY_PAD = 2;
/** Ownership repaints are clipped to the changed provinces; the whole base is redrawn at most this often (ms) to keep nation labels whole. */
const LABEL_REFRESH_MS = 2000;

export function createMapController(o: MapControllerOptions): MapController {
  const { host, base, overlay, map } = o;
  const g = o.geometry;
  const paths = provincePathsFor(g);
  const internal = buildArcPath(g, isProvinceBorder);
  const seaLinks = buildSeaLinkPath(map, g);
  const grid = buildHitGrid(g, RENDER.HIT_GRID_CELL);
  const baseContext = base.getContext('2d', { alpha: false });
  const overlayContext = overlay.getContext('2d');
  if (baseContext === null || overlayContext === null) throw new Error('Canvas 2D is not available');
  const baseCtx: CanvasRenderingContext2D = baseContext;
  const overlayCtx: CanvasRenderingContext2D = overlayContext;
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');

  // ---------------------------------------------------------- view and camera
  let viewW = 0;
  let viewH = 0;
  let baseDpr = 1;
  let overlayDpr = 1;
  let camera: Camera = { k: 1, x: 0, y: 0 };
  let cameraReady = false;
  /** The camera the base raster was last drawn at. */
  let raster: Camera = camera;
  let gesturing = false;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  let repaintTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingFrame: (() => void) | null = null;

  const marginX = (): number => viewW * RENDER.GESTURE_MARGIN;
  const marginY = (): number => viewH * RENDER.GESTURE_MARGIN;
  /** The camera of the raster canvas, whose origin lies a margin above and left of the view. */
  const rasterCamera = (c: Camera): Camera => ({ k: c.k, x: c.x + marginX(), y: c.y + marginY() });

  // ---------------------------------------------------------- base scene
  let sceneSim: Sim | null = null;
  let mode: MapMode | null = null;
  let key = '';
  let fills: Fills | null = null;
  let owners: Int32Array | null = null;
  let bordersVersion = -1;
  let nations = new Path2D();
  let player = new Path2D();
  let labels: NationLabel[] = [];
  let needFullBase = true;
  const dirty = new Set<ProvinceIx>();
  let lastRepaintMs = -Infinity;

  const scene = (): BaseScene => ({
    paths,
    fills: fills?.fills ?? [],
    hatched: fills?.hatched ?? [],
    internal,
    nations,
    player,
    seaLinks,
    mode: mode ?? 'political',
  });

  /** Brings fills, borders and labels up to date with the Sim, at most BASE_REPAINT_MAX_HZ unless the mode changed. */
  function updateScene(frame: MapFrame): void {
    const sim = frame.sim;
    if (sim !== sceneSim) {
      sceneSim = sim;
      fills = null;
      owners = null;
      bordersVersion = -1;
    }
    const nextKey = fillKey(sim, frame.mode);
    const modeChanged = frame.mode !== mode;
    const ownership = sim.cache.ownershipVersion !== bordersVersion;
    if (fills !== null && !modeChanged && nextKey === key && !ownership) return;
    const now = performance.now();
    const wait = lastRepaintMs + 1000 / RENDER.BASE_REPAINT_MAX_HZ - now;
    if (fills !== null && !modeChanged && wait > 0) {
      // Coalesced: come back when the repaint window opens.
      repaintTimer ??= setTimeout(() => {
        repaintTimer = null;
        wake();
      }, wait);
      return;
    }
    lastRepaintMs = now;
    const next = provinceFills(sim, frame.mode);
    if (ownership) {
      const current = Int32Array.from(sim.state.provinces, (p) => p.owner);
      if (owners !== null) for (const p of ownerChanges(owners, current)) dirty.add(p);
      owners = current;
      const snapshot = current;
      const you = sim.state.player;
      nations = buildArcPath(g, (arc) => isNationBorder(arc, snapshot));
      player = buildArcPath(g, (arc) => isPlayerBorder(arc, snapshot, you));
      labels = nationLabels(sim, g);
      bordersVersion = sim.cache.ownershipVersion;
    }
    if (fills === null || modeChanged) needFullBase = true;
    else for (const p of changedProvinces(fills, next)) dirty.add(p);
    fills = next;
    key = nextKey;
    mode = frame.mode;
  }

  function paintBase(sim: Sim, clip: ReturnType<typeof dirtyRects>): void {
    const started = performance.now();
    const c = rasterCamera(raster);
    drawBase(baseCtx, scene(), g, c, baseDpr, clip);
    drawBaseLabels(baseCtx, { sim, nations: labels, stars: capitalStars(sim, c.k) }, g, c, baseDpr, clip);
    mapTimings.baseMs = performance.now() - started;
  }

  function placeRaster(): void {
    if (!gesturing) {
      base.style.transform = '';
      return;
    }
    // The raster drawn at `raster` lands under `camera` with this transform (camera.ts), shifted for the margin.
    const t = rasterTransform(raster, camera);
    const ex = t.dx + marginX() * (1 - t.scale);
    const ey = t.dy + marginY() * (1 - t.scale);
    base.style.transform = `translate(${ex}px, ${ey}px) scale(${t.scale})`;
  }

  let lastFullPaint = 0;
  function drawBaseIfNeeded(sim: Sim): void {
    if (gesturing) {
      const drift = camera.k / raster.k;
      if (drift < RENDER.GESTURE_RERASTER_SCALE && drift > 1 / RENDER.GESTURE_RERASTER_SCALE) {
        placeRaster();
        return;
      }
      needFullBase = true;
    }
    if (needFullBase) {
      raster = camera;
      paintBase(sim, null);
      lastFullPaint = performance.now();
      needFullBase = false;
      dirty.clear();
    } else if (dirty.size > 0) {
      // Nation labels move and resize with captures, which a clipped repaint leaves
      // in pieces; a full repaint every LABEL_REFRESH_MS at most puts them right.
      const now = performance.now();
      if (now - lastFullPaint >= LABEL_REFRESH_MS) {
        paintBase(sim, null);
        lastFullPaint = now;
      } else paintBase(sim, dirtyRects(g, rasterCamera(raster), [...dirty].sort((a, b) => a - b), DIRTY_PAD));
      dirty.clear();
    }
    placeRaster();
  }

  // ---------------------------------------------------------- overlay
  const markers: Marker[] = [];
  let markerCount = 0;
  let feedback: InputFeedback = { box: null, drag: null };
  let feedbackVersion = 0;
  const seen = {
    sim: null as Sim | null,
    tick: -1,
    alpha: -1,
    armyVersion: -1,
    camera: null as Camera | null,
    selected: null as ReadonlySet<ArmyId> | null,
    hover: null as ProvinceIx | null,
    selectedProvince: null as ProvinceIx | null,
    preview: null as MapFrame['preview'],
    mode: null as MapMode | null,
    showAll: false,
    highlights: null as readonly ProvinceIx[] | null,
    feedback: -1,
    width: 0,
  };

  function overlayStale(frame: MapFrame, pulsing: boolean): boolean {
    const sim = frame.sim;
    const stale =
      pulsing ||
      seen.sim !== sim ||
      seen.tick !== sim.state.tick ||
      seen.alpha !== frameAlpha(frame) ||
      seen.armyVersion !== sim.cache.armyVersion ||
      seen.camera !== camera ||
      seen.selected !== frame.selectedArmies ||
      seen.hover !== frame.hover ||
      seen.selectedProvince !== frame.selectedProvince ||
      seen.preview !== frame.preview ||
      seen.mode !== frame.mode ||
      seen.showAll !== frame.showAll ||
      seen.highlights !== frame.highlights ||
      seen.feedback !== feedbackVersion ||
      seen.width !== overlay.width;
    seen.sim = sim;
    seen.tick = sim.state.tick;
    seen.alpha = frameAlpha(frame);
    seen.armyVersion = sim.cache.armyVersion;
    seen.camera = camera;
    seen.selected = frame.selectedArmies;
    seen.hover = frame.hover;
    seen.selectedProvince = frame.selectedProvince;
    seen.preview = frame.preview;
    seen.mode = frame.mode;
    seen.showAll = frame.showAll;
    seen.highlights = frame.highlights;
    seen.feedback = feedbackVersion;
    seen.width = overlay.width;
    return stale;
  }

  function drawOverlayLayer(frame: MapFrame, nowMs: number): void {
    const started = performance.now();
    markerCount = layoutMarkers(frame, g, camera, viewW, viewH, markers);
    drawOverlay(overlayCtx, { markers, count: markerCount, frame, box: feedback.box, nowMs }, g, camera, overlayDpr);
    if (feedback.drag !== null) drawDragLine(overlayCtx, feedback.drag.from, feedback.drag.to, overlayDpr);
    mapTimings.overlayMs = performance.now() - started;
    mapTimings.markers = markerCount;
  }

  // ---------------------------------------------------------- the frame
  const draw = (_info: FrameInfo): void => {
    if (viewW === 0 || viewH === 0) return;
    const frame = o.getFrame();
    const reduced = motion.matches || document.documentElement.dataset['reduceMotion'] === 'true';
    setReducedMotion(reduced);
    updateScene(frame);
    drawBaseIfNeeded(frame.sim);
    const player = frame.sim.state.player;
    const pulsing = !reduced && frame.sim.cache.battles.some((p) => frame.sim.state.provinces[p]!.owner === player);
    if (overlayStale(frame, pulsing)) drawOverlayLayer(frame, performance.now());
  };

  // ---------------------------------------------------------- d3-zoom
  const behaviour: ZoomBehavior<HTMLDivElement, unknown> = zoom<HTMLDivElement, unknown>();
  const pointIn = (event: Event): [number, number] | null => {
    const box = host.getBoundingClientRect();
    if (event instanceof MouseEvent) return [event.clientX - box.left, event.clientY - box.top];
    if (typeof TouchEvent !== 'undefined' && event instanceof TouchEvent) {
      const touch = event.changedTouches[0];
      return touch === undefined ? null : [touch.clientX - box.left, touch.clientY - box.top];
    }
    return null;
  };
  behaviour
    .filter((event: Event) => {
      if (event.type === 'wheel') return true;
      if (event instanceof MouseEvent && (event.button !== 0 || event.ctrlKey)) return false;
      // Shift is box select; a gesture that starts on a marker is a selection or a drag order.
      if ((event instanceof MouseEvent || (typeof TouchEvent !== 'undefined' && event instanceof TouchEvent)) && event.shiftKey) return false;
      // A second finger always joins the pinch, wherever it lands.
      if (typeof TouchEvent !== 'undefined' && event instanceof TouchEvent && event.touches.length > 1) return true;
      const point = pointIn(event);
      return point === null || pick.marker(point[0], point[1]) === null;
    })
    .on('zoom', (event: D3ZoomEvent<HTMLDivElement, unknown>) => {
      const t = event.transform;
      camera = { k: t.k, x: t.x, y: t.y };
      gesturing = true;
      if (settleTimer !== null) clearTimeout(settleTimer);
      settleTimer = setTimeout(settle, RENDER.GESTURE_SETTLE_MS);
      o.handlers().cameraChanged(camera, true);
      wake();
    });
  function settle(): void {
    if (settleTimer !== null) clearTimeout(settleTimer);
    settleTimer = null;
    gesturing = false;
    needFullBase = true;
    o.handlers().cameraChanged(camera, false);
    wake();
  }
  const zoomTarget = select(host);
  zoomTarget.call(behaviour).on('dblclick.zoom', null);

  function applyCamera(target: Camera, ms: number): void {
    const transform = zoomIdentity.translate(target.x, target.y).scale(target.k);
    if (ms > 0) behaviour.transform(zoomTarget.transition().duration(ms), transform);
    else behaviour.transform(zoomTarget, transform);
  }

  function configure(): void {
    const minK = minZoom(viewW, viewH);
    const sx = RENDER.WORLD_WIDTH * PAN_SLACK;
    const sy = RENDER.WORLD_HEIGHT * PAN_SLACK;
    behaviour
      .extent([
        [0, 0],
        [viewW, viewH],
      ])
      .scaleExtent([minK, RENDER.MAX_ZOOM])
      .translateExtent([
        [-sx, -sy],
        [RENDER.WORLD_WIDTH + sx, RENDER.WORLD_HEIGHT + sy],
      ]);
  }

  function resize(width: number, height: number): void {
    if (width <= 0 || height <= 0) return;
    viewW = width;
    viewH = height;
    const device = window.devicePixelRatio || 1;
    const bw = viewW * (1 + 2 * RENDER.GESTURE_MARGIN);
    const bh = viewH * (1 + 2 * RENDER.GESTURE_MARGIN);
    baseDpr = canvasDpr(device, bw, bh, RENDER.MAX_BASE_CANVAS_PIXELS);
    overlayDpr = canvasDpr(device, viewW, viewH);
    base.width = Math.round(bw * baseDpr);
    base.height = Math.round(bh * baseDpr);
    base.style.width = `${bw}px`;
    base.style.height = `${bh}px`;
    base.style.left = `${-marginX()}px`;
    base.style.top = `${-marginY()}px`;
    overlay.width = Math.round(viewW * overlayDpr);
    overlay.height = Math.round(viewH * overlayDpr);
    configure();
    needFullBase = true;
    if (!cameraReady) {
      cameraReady = true;
      applyCamera(worldCamera(viewW, viewH), 0);
      settle();
    }
    if (pendingFrame !== null) {
      const run = pendingFrame;
      pendingFrame = null;
      run();
    }
    wake();
  }
  const observer = new ResizeObserver((entries) => {
    const box = entries[0]?.contentRect;
    if (box !== undefined) resize(box.width, box.height);
  });
  observer.observe(host);

  // ---------------------------------------------------------- input
  const pick: MapPick = {
    marker: (x, y) => markerAt(markers, markerCount, x, y, hitRadius(coarse)),
    province: (x, y) => {
      const [bx, by] = toBase(camera, x, y);
      return pickProvince(grid, g, bx, by, camera.k);
    },
    armiesIn: (x0, y0, x1, y1) => armiesInRect(markers, markerCount, x0, y0, x1, y1),
    ownArmiesAt: (p) => {
      const sim = o.getFrame().sim;
      return armiesAt(sim, p)
        .filter((a) => a.alive && a.leg === null && a.owner === sim.state.player)
        .map((a) => a.id);
    },
    feedback: (f) => {
      feedback = f;
      feedbackVersion += 1;
      wake();
    },
  };
  const forward: MapInputHandlers = {
    tapMarker: (armies, additive) => o.handlers().tapMarker(armies, additive),
    tapProvince: (p, additive) => o.handlers().tapProvince(p, additive),
    secondary: (p, append) => o.handlers().secondary(p, append),
    longPressMarker: (armies) => o.handlers().longPressMarker(armies),
    longPressProvince: (p) => o.handlers().longPressProvince(p),
    box: (armies, additive) => o.handlers().box(armies, additive),
    hover: (p) => o.handlers().hover(p),
    dragOrder: (armies, p) => o.handlers().dragOrder(armies, p),
    cameraChanged: (c, moving) => o.handlers().cameraChanged(c, moving),
  };
  const detachInput = attachInput(host, pick, forward, coarse);
  const unregister = registerRenderer(draw);

  // ---------------------------------------------------------- the handle
  const handle: MapHandle = {
    frameProvinces(ps, ms) {
      const run = (): void => {
        const bounds = boundsOf(g, ps);
        if (bounds === null) return;
        const target = frameBounds(bounds, viewW, viewH, FRAME_FILL, FRAME_MAX_ZOOM);
        // A region bigger than the world at minimum zoom shows the whole world instead.
        applyCamera(target.k >= minZoom(viewW, viewH) ? target : worldCamera(viewW, viewH), ms);
      };
      if (viewW === 0) pendingFrame = run;
      else run();
    },
    zoomBy(factor) {
      behaviour.scaleBy(zoomTarget.transition().duration(ZOOM_BY_MS), factor);
    },
    home() {
      const sim = o.getFrame().sim;
      const own = homeland(sim);
      if (own.length > 0) handle.frameProvinces(own, HOME_MS);
      else applyCamera(worldCamera(viewW, viewH), HOME_MS);
    },
  };

  return {
    handle,
    destroy() {
      unregister();
      detachInput();
      observer.disconnect();
      zoomTarget.interrupt();
      zoomTarget.on('.zoom', null);
      if (settleTimer !== null) clearTimeout(settleTimer);
      if (repaintTimer !== null) clearTimeout(repaintTimer);
    },
  };
}

/** The alpha that moves markers; it only matters while some army is on a leg. */
function frameAlpha(frame: MapFrame): number {
  return frame.sim.state.armies.some((a) => a.leg !== null) ? frame.alpha : 0;
}


/**
 * The player's provinces joined by land to their capital (or to their first
 * province once the capital is lost). Framing every owned province put the
 * camera over the Atlantic for France, because French Guiana is French.
 */
function homeland(sim: Sim): ProvinceIx[] {
  const n = sim.state.player;
  const own = ownedProvinces(sim, n);
  const capital = sim.state.nations[n]!.capital;
  const start = capital !== null && sim.state.provinces[capital]!.owner === n ? capital : own[0];
  if (start === undefined) return [];
  const seen = new Set<ProvinceIx>([start]);
  const queue: ProvinceIx[] = [start];
  for (let head = 0; head < queue.length; head += 1) {
    for (const e of sim.map.edges[queue[head]!]!) {
      if (e.sea || seen.has(e.to) || sim.state.provinces[e.to]!.owner !== n) continue;
      seen.add(e.to);
      queue.push(e.to);
    }
  }
  return queue;
}
