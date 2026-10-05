import { describe, expect, it } from 'vitest';
import { RENDER } from '@/next/game/balance';
import { canvasDpr, frameBounds, minZoom, rasterTransform, toBase, toScreen, visibleBounds, worldCamera, zoomAbout } from '../camera';
import type { Camera } from '../types';

const c: Camera = { k: 2.5, x: -120, y: 40 };

describe('camera maths', () => {
  it('maps base to screen and back', () => {
    expect(toScreen(c, 100, 200)).toEqual([130, 540]);
    expect(toBase(c, 130, 540)).toEqual([100, 200]);
    const [bx, by] = toBase(c, 17.3, 905.1);
    const [sx, sy] = toScreen(c, bx, by);
    expect(sx).toBeCloseTo(17.3, 9);
    expect(sy).toBeCloseTo(905.1, 9);
  });

  it('frames a box centred, filling the requested share of the tighter side', () => {
    const cam = frameBounds([100, 50, 300, 150], 800, 600, 0.8, 64);
    // 200 x 100 into 800 x 600: width binds, k = 0.8 x 800 / 200.
    expect(cam.k).toBeCloseTo(3.2, 12);
    expect(toScreen(cam, 200, 100)).toEqual([400, 300]);
    const [x0] = toScreen(cam, 100, 50);
    const [x1] = toScreen(cam, 300, 150);
    expect(x1 - x0).toBeCloseTo(0.8 * 800, 9);
  });

  it('never zooms past maxK, and survives a zero-size box', () => {
    const cam = frameBounds([10, 10, 11, 11], 800, 600, 0.8, 12);
    expect(cam.k).toBe(12);
    expect(toScreen(cam, 10.5, 10.5)).toEqual([400, 300]);
    const point = frameBounds([10, 10, 10, 10], 800, 600, 0.8, 12);
    expect(point.k).toBe(12);
    expect(toScreen(point, 10, 10)).toEqual([400, 300]);
  });

  it('fits the whole world at the minimum zoom', () => {
    expect(minZoom(1000, 1000)).toBe(1000 / RENDER.WORLD_WIDTH);
    const world = worldCamera(1000, 800);
    expect(world.k).toBe(0.5);
    const [x0, y0, x1, y1] = visibleBounds(world, 1000, 800);
    expect(x0).toBeCloseTo(0, 9);
    expect(x1).toBeCloseTo(RENDER.WORLD_WIDTH, 9);
    expect((y0 + y1) / 2).toBeCloseTo(RENDER.WORLD_HEIGHT / 2, 9);
  });

  it('zooms about a screen point, which stays put, within the clamps', () => {
    const z = zoomAbout(c, 2, 300, 200, 0.5, 64);
    expect(z.k).toBe(5);
    const [bx, by] = toBase(c, 300, 200);
    const [sx, sy] = toScreen(z, bx, by);
    expect(sx).toBeCloseTo(300, 9);
    expect(sy).toBeCloseTo(200, 9);
    expect(zoomAbout(c, 100, 0, 0, 0.5, 64).k).toBe(64);
    expect(zoomAbout(c, 0.01, 0, 0, 0.5, 64).k).toBe(0.5);
  });

  it('gives the blit transform that carries a raster from one camera to another', () => {
    const to: Camera = { k: 4, x: 30, y: -70 };
    const t = rasterTransform(c, to);
    for (const [bx, by] of [
      [0, 0],
      [512, 333],
    ] as const) {
      const [s0x, s0y] = toScreen(c, bx, by);
      const [s1x, s1y] = toScreen(to, bx, by);
      expect(t.scale * s0x + t.dx).toBeCloseTo(s1x, 9);
      expect(t.scale * s0y + t.dy).toBeCloseTo(s1y, 9);
    }
  });

  it('caps the canvas DPR at 2 and at 4 megapixels', () => {
    expect(canvasDpr(1, 1280, 720)).toBe(1);
    expect(canvasDpr(3, 400, 800)).toBe(RENDER.MAX_DPR);
    const dpr = canvasDpr(2, 2560, 1440);
    expect(dpr).toBeCloseTo(Math.sqrt(RENDER.MAX_CANVAS_PIXELS / (2560 * 1440)), 12);
    expect(2560 * dpr * 1440 * dpr).toBeCloseTo(RENDER.MAX_CANVAS_PIXELS, 3);
  });
});
