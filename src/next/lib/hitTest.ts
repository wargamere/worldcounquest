/**
 * Province hit testing in base space (§9.5), pure and allocation-light. A grid
 * of RENDER.HIT_GRID_CELL cells lists every province whose bounding box
 * overlaps the cell; a lookup tests only those, with an even-odd test over the
 * projected rings. The tiny-province rule (§4.7) lets a province too small to
 * hit on screen win a tap close to its anchor, so Luxembourg is tappable at
 * world zoom. Army markers are hit-tested in screen space by markers.ts.
 */
import { RENDER } from '@/next/game/balance';
import { asProvince } from '@/next/game/ids';
import type { ProvinceIx } from '@/next/game/types';
import { ringsContain, type MapGeometry } from './geometry';

export interface HitGrid {
  readonly cols: number;
  readonly rows: number;
  readonly cellSize: number;
  readonly cells: readonly Uint16Array[];
}

export function buildHitGrid(g: MapGeometry, cellSize: number): HitGrid {
  const cols = Math.ceil(g.width / cellSize);
  const rows = Math.ceil(g.height / cellSize);
  const lists: number[][] = Array.from({ length: cols * rows }, () => []);
  const count = g.area.length;
  for (let p = 0; p < count; p++) {
    const c0 = Math.max(0, Math.floor(g.bbox[4 * p]! / cellSize));
    const r0 = Math.max(0, Math.floor(g.bbox[4 * p + 1]! / cellSize));
    const c1 = Math.min(cols - 1, Math.floor(g.bbox[4 * p + 2]! / cellSize));
    const r1 = Math.min(rows - 1, Math.floor(g.bbox[4 * p + 3]! / cellSize));
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) lists[r * cols + c]!.push(p);
  }
  return { cols, rows, cellSize, cells: lists.map((list) => Uint16Array.from(list)) };
}

function inBox(g: MapGeometry, p: number, x: number, y: number): boolean {
  return x >= g.bbox[4 * p]! && x <= g.bbox[4 * p + 2]! && y >= g.bbox[4 * p + 1]! && y <= g.bbox[4 * p + 3]!;
}

export function pointInProvince(g: MapGeometry, p: ProvinceIx, x: number, y: number): boolean {
  if (!inBox(g, p, x, y)) return false;
  return ringsContain(g.coords, g.ringStart, g.ringLength, g.provinceRingStart[p]!, g.provinceRingCount[p]!, x, y);
}

function cellOf(grid: HitGrid, x: number, y: number): Uint16Array | null {
  const c = Math.floor(x / grid.cellSize);
  const r = Math.floor(y / grid.cellSize);
  if (c < 0 || r < 0 || c >= grid.cols || r >= grid.rows) return null;
  return grid.cells[r * grid.cols + c] ?? null;
}

export function provinceAt(grid: HitGrid, g: MapGeometry, x: number, y: number): ProvinceIx | null {
  const cell = cellOf(grid, x, y);
  if (cell === null) return null;
  for (const p of cell) if (pointInProvince(g, asProvince(p), x, y)) return asProvince(p);
  return null;
}

/** Marks for de-duplicating grid candidates without allocating per query. */
const stamps = new WeakMap<HitGrid, { marks: Uint32Array; stamp: number }>();

function visitRect(grid: HitGrid, g: MapGeometry, x0: number, y0: number, x1: number, y1: number, visit: (p: number) => void): void {
  let entry = stamps.get(grid);
  if (entry === undefined) {
    entry = { marks: new Uint32Array(g.area.length), stamp: 0 };
    stamps.set(grid, entry);
  }
  entry.stamp += 1;
  const { marks, stamp } = entry;
  const c0 = Math.max(0, Math.floor(Math.min(x0, x1) / grid.cellSize));
  const r0 = Math.max(0, Math.floor(Math.min(y0, y1) / grid.cellSize));
  const c1 = Math.min(grid.cols - 1, Math.floor(Math.max(x0, x1) / grid.cellSize));
  const r1 = Math.min(grid.rows - 1, Math.floor(Math.max(y0, y1) / grid.cellSize));
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      for (const p of grid.cells[r * grid.cols + c]!) {
        if (marks[p] === stamp) continue;
        marks[p] = stamp;
        visit(p);
      }
    }
  }
}

/** Provinces whose bounding box meets the rectangle, ascending. */
export function provincesInRect(grid: HitGrid, g: MapGeometry, x0: number, y0: number, x1: number, y1: number): ProvinceIx[] {
  const lx = Math.min(x0, x1);
  const hx = Math.max(x0, x1);
  const ly = Math.min(y0, y1);
  const hy = Math.max(y0, y1);
  const out: ProvinceIx[] = [];
  visitRect(grid, g, lx, ly, hx, hy, (p) => {
    if (g.bbox[4 * p]! <= hx && g.bbox[4 * p + 2]! >= lx && g.bbox[4 * p + 1]! <= hy && g.bbox[4 * p + 3]! >= ly) out.push(asProvince(p));
  });
  return out.sort((a, b) => a - b);
}

/**
 * The tiny-province rule: among provinces smaller than RENDER.TINY_PROVINCE_PX2
 * on screen at scale `k`, the one whose anchor is nearest (x, y), if within
 * RENDER.TINY_ANCHOR_PX on screen. Ties go to the lower index.
 */
export function tinyProvinceAt(grid: HitGrid, g: MapGeometry, x: number, y: number, k: number): ProvinceIx | null {
  const radius = RENDER.TINY_ANCHOR_PX / k;
  const maxArea = RENDER.TINY_PROVINCE_PX2 / (k * k);
  const limit = radius * radius;
  let best: number | null = null;
  let bestDistance = Infinity;
  visitRect(grid, g, x - radius, y - radius, x + radius, y + radius, (p) => {
    if (g.area[p]! >= maxArea) return;
    const dx = g.anchor[2 * p]! - x;
    const dy = g.anchor[2 * p + 1]! - y;
    const d = dx * dx + dy * dy;
    if (d > limit) return;
    if (best === null || d < bestDistance || (d === bestDistance && p < best)) {
      best = p;
      bestDistance = d;
    }
  });
  return best === null ? null : asProvince(best);
}

/** What a tap at base point (x, y) selects at scale `k`: a tiny province near its anchor first, then the province under the point. */
export function pickProvince(grid: HitGrid, g: MapGeometry, x: number, y: number, k: number): ProvinceIx | null {
  return tinyProvinceAt(grid, g, x, y, k) ?? provinceAt(grid, g, x, y);
}
