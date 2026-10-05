/**
 * The base layer (§9.1, §9.3): sphere, graticule, province fills, the occupied
 * hatch, province, nation and player borders, sea links, then (in screen
 * space) city dots, province names, nation labels and capital stars.
 *
 * The camera is applied with one setTransform and line widths are divided by
 * k, so nothing is re-projected. Below RENDER.BATCH_FILLS_BELOW_ZOOM fills are
 * one path per colour; from there on provinces are filled one by one, culled
 * to the view. A `clip` list repaints only those screen rectangles (the
 * ownership dirty rects); null repaints everything.
 */
import { RENDER } from '@/next/game/balance';
import { PLAYER_COLOUR } from '@/next/game/colours';
import type { MapMode, ProvinceIx, Sim } from '@/next/game/types';
import type { MapGeometry } from '@/next/lib/geometry';
import { toBase, toScreen } from './camera';
import { changedColours, colourBatches, rebuildColours, type ColourBatch } from './paths';
import type { NationLabel } from './scene';
import type { Camera } from './types';

export interface BaseScene {
  paths: readonly Path2D[];
  fills: readonly string[];
  hatched: readonly boolean[];
  internal: Path2D;
  nations: Path2D;
  player: Path2D;
  seaLinks: Path2D;
  mode: MapMode;
}
/** A screen rectangle in CSS px. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const BASE_COLOURS = {
  space: '#05080f',
  sea: '#0b1120',
  graticule: 'rgba(148, 163, 184, 0.10)',
  internal: 'rgba(8, 12, 22, 0.45)',
  nation: 'rgba(5, 8, 15, 0.92)',
  /** Nation borders in the non-political modes, where fills do not show owners. */
  nationOnData: 'rgba(255, 255, 255, 0.75)',
  player: PLAYER_COLOUR,
  seaLink: 'rgba(148, 163, 184, 0.55)',
  hatch: 'rgba(5, 8, 15, 0.5)',
  cityDot: 'rgba(241, 245, 249, 0.85)',
  label: '#e2e8f0',
  labelHalo: 'rgba(5, 8, 15, 0.85)',
  star: '#f8fafc',
} as const;

/** Stroke widths in CSS px. */
const WIDTH = { graticule: 0.6, internal: 0.6, nation: 1.2, player: 2.2, seaLink: 1 } as const;
/** Hatch stripes repeat every this many CSS px at every zoom. */
const HATCH_PX = 7;
/** Sea links are dotted: dash and gap in CSS px. */
const SEA_DASH = 3;

// ------------------------------------------------------------ caches

const spheres = new WeakMap<MapGeometry, { sphere: Path2D; graticule: Path2D }>();
function sphereOf(g: MapGeometry): { sphere: Path2D; graticule: Path2D } {
  let entry = spheres.get(g);
  if (entry === undefined) {
    const sphere = new Path2D();
    for (let i = 0; i < g.sphere.length; i += 2) {
      if (i === 0) sphere.moveTo(g.sphere[0]!, g.sphere[1]!);
      else sphere.lineTo(g.sphere[i]!, g.sphere[i + 1]!);
    }
    sphere.closePath();
    const graticule = new Path2D();
    for (const line of g.graticule) {
      graticule.moveTo(line[0]!, line[1]!);
      for (let i = 2; i < line.length; i += 2) graticule.lineTo(line[i]!, line[i + 1]!);
    }
    entry = { sphere, graticule };
    spheres.set(g, entry);
  }
  return entry;
}

/** The colour batches last drawn for a set of province paths, and the fills they were built from. */
interface BatchState {
  fills: string[];
  hatched: boolean[];
  batches: Map<string, ColourBatch>;
}
const batchStates = new WeakMap<readonly Path2D[], BatchState>();

/** Batches for `scene`, rebuilding only the colours whose provinces changed since the last call. */
function batchesFor(g: MapGeometry, scene: BaseScene): Map<string, ColourBatch> {
  const state = batchStates.get(scene.paths);
  if (state === undefined) {
    const fresh: BatchState = { fills: [...scene.fills], hatched: [...scene.hatched], batches: colourBatches(g, scene.paths, scene.fills, scene.hatched) };
    batchStates.set(scene.paths, fresh);
    return fresh.batches;
  }
  if (state.fills !== scene.fills) {
    const colours = changedColours(state.fills, state.hatched, scene.fills, scene.hatched);
    if (colours.size > 0) {
      rebuildColours(state.batches, colours, scene.paths, scene.fills, scene.hatched);
      state.fills = [...scene.fills];
      state.hatched = [...scene.hatched];
    }
  }
  return state.batches;
}

const patterns = new WeakMap<CanvasRenderingContext2D, CanvasPattern | null>();
function hatchPattern(ctx: CanvasRenderingContext2D): CanvasPattern | null {
  if (patterns.has(ctx)) return patterns.get(ctx) ?? null;
  const tile = document.createElement('canvas');
  tile.width = HATCH_PX;
  tile.height = HATCH_PX;
  const t = tile.getContext('2d');
  let pattern: CanvasPattern | null = null;
  if (t !== null) {
    t.strokeStyle = BASE_COLOURS.hatch;
    t.lineWidth = 2;
    t.beginPath();
    // A diagonal and its two wrap-around corners make the stripes seamless.
    t.moveTo(0, HATCH_PX);
    t.lineTo(HATCH_PX, 0);
    t.moveTo(-1, 1);
    t.lineTo(1, -1);
    t.moveTo(HATCH_PX - 1, HATCH_PX + 1);
    t.lineTo(HATCH_PX + 1, HATCH_PX - 1);
    t.stroke();
    pattern = ctx.createPattern(tile, 'repeat');
  }
  patterns.set(ctx, pattern);
  return pattern;
}

// ------------------------------------------------------------ helpers

/** The base-space box the canvas (or the clip rectangles) show under camera `c`. */
function viewBox(c: Camera, cssW: number, cssH: number, clip: readonly Rect[] | null): [number, number, number, number] {
  let sx0 = 0;
  let sy0 = 0;
  let sx1 = cssW;
  let sy1 = cssH;
  if (clip !== null && clip.length > 0) {
    sx0 = Math.min(...clip.map((r) => r.x));
    sy0 = Math.min(...clip.map((r) => r.y));
    sx1 = Math.max(...clip.map((r) => r.x + r.w));
    sy1 = Math.max(...clip.map((r) => r.y + r.h));
  }
  const [x0, y0] = toBase(c, sx0, sy0);
  const [x1, y1] = toBase(c, sx1, sy1);
  return [x0, y0, x1, y1];
}

function boxVisible(g: MapGeometry, p: number, box: readonly [number, number, number, number]): boolean {
  return g.bbox[4 * p]! <= box[2] && g.bbox[4 * p + 2]! >= box[0] && g.bbox[4 * p + 1]! <= box[3] && g.bbox[4 * p + 3]! >= box[1];
}

function applyClip(ctx: CanvasRenderingContext2D, dpr: number, clip: readonly Rect[] | null): void {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (clip === null) return;
  ctx.beginPath();
  for (const r of clip) ctx.rect(r.x, r.y, r.w, r.h);
  ctx.clip();
}

// ------------------------------------------------------------ the layer

export function drawBase(ctx: CanvasRenderingContext2D, scene: BaseScene, g: MapGeometry, c: Camera, dpr: number, clip: readonly Rect[] | null): void {
  const cssW = ctx.canvas.width / dpr;
  const cssH = ctx.canvas.height / dpr;
  const k = c.k;
  ctx.save();
  applyClip(ctx, dpr, clip);
  ctx.fillStyle = BASE_COLOURS.space;
  if (clip === null) ctx.fillRect(0, 0, cssW, cssH);
  else for (const r of clip) ctx.fillRect(r.x, r.y, r.w, r.h);

  ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * c.x, dpr * c.y);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  const { sphere, graticule } = sphereOf(g);
  ctx.fillStyle = BASE_COLOURS.sea;
  ctx.fill(sphere);
  ctx.strokeStyle = BASE_COLOURS.graticule;
  ctx.lineWidth = WIDTH.graticule / k;
  ctx.stroke(graticule);

  const pattern = scene.mode === 'political' ? hatchPattern(ctx) : null;
  // Stripes keep a constant on-screen width: undo the camera scale in the pattern.
  pattern?.setTransform(new DOMMatrix([1 / k, 0, 0, 1 / k, 0, 0]));
  if (k < RENDER.BATCH_FILLS_BELOW_ZOOM) {
    for (const [colour, batch] of batchesFor(g, scene)) {
      ctx.fillStyle = colour;
      ctx.fill(batch.solid);
      ctx.fill(batch.hatched);
      if (pattern !== null) {
        ctx.fillStyle = pattern;
        ctx.fill(batch.hatched);
      }
    }
  } else {
    const box = viewBox(c, cssW, cssH, clip);
    for (let p = 0; p < scene.paths.length; p++) {
      if (!boxVisible(g, p, box)) continue;
      ctx.fillStyle = scene.fills[p]!;
      ctx.fill(scene.paths[p]!);
      if (pattern !== null && scene.hatched[p] === true) {
        ctx.fillStyle = pattern;
        ctx.fill(scene.paths[p]!);
      }
    }
  }

  if (k >= RENDER.PROVINCE_BORDERS_FROM_ZOOM) {
    ctx.strokeStyle = BASE_COLOURS.internal;
    ctx.lineWidth = WIDTH.internal / k;
    ctx.stroke(scene.internal);
  }
  ctx.strokeStyle = scene.mode === 'political' ? BASE_COLOURS.nation : BASE_COLOURS.nationOnData;
  ctx.lineWidth = WIDTH.nation / k;
  ctx.stroke(scene.nations);
  ctx.strokeStyle = BASE_COLOURS.player;
  ctx.lineWidth = WIDTH.player / k;
  ctx.stroke(scene.player);
  ctx.strokeStyle = BASE_COLOURS.seaLink;
  ctx.lineWidth = WIDTH.seaLink / k;
  ctx.setLineDash([SEA_DASH / k, SEA_DASH / k]);
  ctx.stroke(scene.seaLinks);
  ctx.setLineDash([]);
  ctx.restore();
}

// ------------------------------------------------------------ labels

export interface BaseLabels {
  sim: Sim;
  nations: readonly NationLabel[];
  stars: readonly ProvinceIx[];
}

/** Nation label type size (CSS px) grows with the square root of owned screen area. */
const NATION_FONT_MIN = 9;
const NATION_FONT_MAX = 20;
const NATION_FONT_PER_SQRT_PX = 0.35;
const PROVINCE_FONT = 11;
const CITY_DOT_PX = 1.6;
const STAR_PX = 6;
/** Labels need this much clear space around them (CSS px). */
const LABEL_PAD = 3;

function overlaps(placed: readonly Rect[], r: Rect): boolean {
  return placed.some((q) => r.x < q.x + q.w && q.x < r.x + r.w && r.y < q.y + q.h && q.y < r.y + r.h);
}

function haloText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number): void {
  ctx.strokeText(text, x, y);
  ctx.fillText(text, x, y);
}

function star(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const angle = -Math.PI / 2 + (i * Math.PI) / 5;
    const radius = i % 2 === 0 ? r : r * 0.45;
    const px = x + radius * Math.cos(angle);
    const py = y + radius * Math.sin(angle);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

/** City dots (k >= 3), province names (k >= 5), nation labels (k < 2.5) and capital stars, decluttered greedily. */
export function drawBaseLabels(ctx: CanvasRenderingContext2D, labels: BaseLabels, g: MapGeometry, c: Camera, dpr: number, clip: readonly Rect[] | null): void {
  const { sim } = labels;
  const { map } = sim;
  const cssW = ctx.canvas.width / dpr;
  const cssH = ctx.canvas.height / dpr;
  const k = c.k;
  const box = viewBox(c, cssW, cssH, clip);
  const inView = (x: number, y: number): boolean => x >= -40 && y >= -20 && x <= cssW + 40 && y <= cssH + 20;
  ctx.save();
  applyClip(ctx, dpr, clip);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = BASE_COLOURS.labelHalo;
  ctx.lineWidth = 3;
  const placed: Rect[] = [];

  // Stars first: they win every overlap.
  for (const p of labels.stars) {
    const [x, y] = toScreen(c, g.anchor[2 * p]!, g.anchor[2 * p + 1]!);
    if (!inView(x, y)) continue;
    const ours = sim.state.provinces[p]!.owner === sim.state.player;
    star(ctx, x, y, STAR_PX);
    ctx.fillStyle = ours ? BASE_COLOURS.player : BASE_COLOURS.star;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fill();
    placed.push({ x: x - STAR_PX, y: y - STAR_PX, w: 2 * STAR_PX, h: 2 * STAR_PX });
  }
  ctx.lineWidth = 3;

  if (k >= RENDER.CITY_DOTS_FROM_ZOOM) {
    ctx.fillStyle = BASE_COLOURS.cityDot;
    for (const fact of map.provinces) {
      if (fact.city === null || !boxVisible(g, fact.ix, box)) continue;
      const [x, y] = toScreen(c, g.anchor[2 * fact.ix]!, g.anchor[2 * fact.ix + 1]!);
      ctx.beginPath();
      ctx.arc(x, y, CITY_DOT_PX, 0, 2 * Math.PI);
      ctx.fill();
    }
  }

  if (k >= RENDER.PROVINCE_NAMES_FROM_ZOOM) {
    ctx.font = `500 ${PROVINCE_FONT}px system-ui, sans-serif`;
    ctx.fillStyle = BASE_COLOURS.label;
    // Bigger provinces claim their space first.
    const visible = map.provinces.filter((f) => boxVisible(g, f.ix, box)).sort((a, b) => g.area[b.ix]! - g.area[a.ix]! || a.ix - b.ix);
    for (const fact of visible) {
      const [x, y] = toScreen(c, g.labelAt[2 * fact.ix]!, g.labelAt[2 * fact.ix + 1]!);
      if (!inView(x, y)) continue;
      const width = ctx.measureText(fact.name).width;
      const rect = { x: x - width / 2 - LABEL_PAD, y: y - PROVINCE_FONT / 2 - LABEL_PAD, w: width + 2 * LABEL_PAD, h: PROVINCE_FONT + 2 * LABEL_PAD };
      if (overlaps(placed, rect)) continue;
      placed.push(rect);
      haloText(ctx, fact.name, x, y);
    }
  }

  if (k < RENDER.NATION_LABELS_BELOW_ZOOM) {
    ctx.fillStyle = BASE_COLOURS.label;
    for (const label of labels.nations) {
      const [x, y] = toScreen(c, label.x, label.y);
      if (!inView(x, y)) continue;
      const size = Math.min(NATION_FONT_MAX, NATION_FONT_PER_SQRT_PX * Math.sqrt(label.area) * k);
      // Too small to read: the remaining labels are smaller still.
      if (size < NATION_FONT_MIN) break;
      const name = map.nations[label.nation]!.name;
      ctx.font = `600 ${size.toFixed(1)}px system-ui, sans-serif`;
      const width = ctx.measureText(name).width;
      const rect = { x: x - width / 2 - LABEL_PAD, y: y - size / 2 - LABEL_PAD, w: width + 2 * LABEL_PAD, h: size + 2 * LABEL_PAD };
      if (overlaps(placed, rect)) continue;
      placed.push(rect);
      haloText(ctx, name, x, y);
    }
  }
  ctx.restore();
}
