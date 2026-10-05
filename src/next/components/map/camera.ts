/**
 * Camera maths, DOM-free (§9.2). The camera maps base space to CSS pixels as
 * screen = k x base + (x, y), the same transform d3-zoom keeps, so every
 * zoom threshold in RENDER is a k: CSS pixels per base unit.
 */
import { RENDER } from '@/next/game/balance';
import type { Camera } from './types';

/** Share of the view a framed region fills. */
export const FRAME_FILL = 0.8;
/** The closest frameProvinces zooms, so one small province is not blown up to the zoom limit. */
export const FRAME_MAX_ZOOM = 12;

export function toBase(c: Camera, sx: number, sy: number): [number, number] {
  return [(sx - c.x) / c.k, (sy - c.y) / c.k];
}

export function toScreen(c: Camera, bx: number, by: number): [number, number] {
  return [bx * c.k + c.x, by * c.k + c.y];
}

/** The camera that centres `bbox` (x0, y0, x1, y1) and fills `fill` of the view, at most `maxK`. */
export function frameBounds(bbox: readonly [number, number, number, number], viewW: number, viewH: number, fill: number, maxK: number): Camera {
  const [x0, y0, x1, y1] = bbox;
  const w = Math.max(x1 - x0, 1e-6);
  const h = Math.max(y1 - y0, 1e-6);
  const k = Math.min(maxK, fill * Math.min(viewW / w, viewH / h));
  return { k, x: viewW / 2 - k * ((x0 + x1) / 2), y: viewH / 2 - k * ((y0 + y1) / 2) };
}

/** The smallest zoom: the whole world fits the view. */
export function minZoom(viewW: number, viewH: number): number {
  return Math.min(viewW / RENDER.WORLD_WIDTH, viewH / RENDER.WORLD_HEIGHT);
}

/** The whole world, centred. */
export function worldCamera(viewW: number, viewH: number): Camera {
  return frameBounds([0, 0, RENDER.WORLD_WIDTH, RENDER.WORLD_HEIGHT], viewW, viewH, 1, minZoom(viewW, viewH));
}

/** Device pixels per CSS pixel for a canvas of this CSS size: never above 2 or above 4 megapixels (§9.3). */
export function canvasDpr(devicePixelRatio: number, cssW: number, cssH: number): number {
  const area = Math.max(1, cssW * cssH);
  return Math.min(devicePixelRatio, RENDER.MAX_DPR, Math.sqrt(RENDER.MAX_CANVAS_PIXELS / area));
}

/**
 * Where a raster drawn at camera `from` lands under camera `to`: the screen
 * point s0 maps to scale x s0 + (dx, dy). The gesture blit draws the last
 * raster with exactly this transform.
 */
export function rasterTransform(from: Camera, to: Camera): { scale: number; dx: number; dy: number } {
  const scale = to.k / from.k;
  return { scale, dx: to.x - scale * from.x, dy: to.y - scale * from.y };
}

/** Zooms by `factor` about the screen point (sx, sy), clamped to [minK, maxK]. */
export function zoomAbout(c: Camera, factor: number, sx: number, sy: number, minK: number, maxK: number): Camera {
  const k = Math.min(maxK, Math.max(minK, c.k * factor));
  const [bx, by] = toBase(c, sx, sy);
  return { k, x: sx - k * bx, y: sy - k * by };
}

/** The base-space rectangle the view shows, as x0, y0, x1, y1. */
export function visibleBounds(c: Camera, viewW: number, viewH: number): [number, number, number, number] {
  const [x0, y0] = toBase(c, 0, 0);
  const [x1, y1] = toBase(c, viewW, viewH);
  return [x0, y0, x1, y1];
}
