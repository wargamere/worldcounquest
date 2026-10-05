/**
 * The draw functions run in Node against a recording 2D context and a Path2D
 * stand-in: no pixels, but every code path executes on the real map, and the
 * call counts check the batching and culling rules of §9.3.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RENDER } from '@/next/game/balance';
import { armiesOf, rebuildArmyIndex } from '@/next/game/cache';
import { realSim } from '@/next/game/__tests__/helpers';
import { buildGeometry, isNationBorder, isPlayerBorder, isProvinceBorder } from '@/next/lib/geometry';
import { parseTopology } from '@/next/lib/mapData';
import type { MapFrame } from '../types';

class FakePath2D {
  ops = 0;
  moveTo(): void {
    this.ops += 1;
  }
  lineTo(): void {
    this.ops += 1;
  }
  closePath(): void {}
  addPath(p: FakePath2D): void {
    this.ops += p.ops;
  }
}

interface Recorder {
  ctx: CanvasRenderingContext2D;
  calls: Map<string, number>;
  reset(): void;
}

/** A 2D context whose every method only counts its calls. */
function recorder(width: number, height: number): Recorder {
  const calls = new Map<string, number>();
  const props: Record<string, unknown> = { canvas: { width, height } };
  const special: Record<string, (...args: unknown[]) => unknown> = {
    measureText: (text) => ({ width: String(text).length * 6 }),
    createPattern: () => ({ setTransform: () => undefined }),
  };
  const ctx = new Proxy(props, {
    get(target, key: string) {
      if (key in target) return target[key];
      return (...args: unknown[]) => {
        calls.set(key, (calls.get(key) ?? 0) + 1);
        return special[key]?.(...args);
      };
    },
    set(target, key: string, value: unknown) {
      target[key] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, calls, reset: () => calls.clear() };
}

const globals = globalThis as unknown as Record<string, unknown>;
const saved = { Path2D: globals['Path2D'], DOMMatrix: globals['DOMMatrix'], document: globals['document'] };
beforeAll(() => {
  globals['Path2D'] = FakePath2D;
  globals['DOMMatrix'] = class {
    constructor(readonly values: number[]) {}
  };
  globals['document'] = { createElement: () => ({ width: 0, height: 0, getContext: () => recorder(8, 8).ctx }) };
});
afterAll(() => {
  globals['Path2D'] = saved.Path2D;
  globals['DOMMatrix'] = saved.DOMMatrix;
  globals['document'] = saved.document;
});

const ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
const topology = parseTopology(JSON.parse(readFileSync(`${ROOT}public/provinces.json`, 'utf8')));
const sim = realSim({ player: '250', seed: 'draw' });
const g = buildGeometry(topology, sim.map);

describe('drawing on the real map', () => {
  it('batches fills by colour below zoom 3 and culls single fills above it', async () => {
    const { buildArcPath, buildSeaLinkPath, provincePathsFor } = await import('../paths');
    const { drawBase, drawBaseLabels } = await import('../drawBase');
    const { provinceFills, nationLabels, capitalStars } = await import('../scene');
    const owners = sim.state.provinces.map((p) => p.owner);
    const fills = provinceFills(sim, 'political');
    // One occupied province, so a hatched batch exists.
    fills.hatched[0] = true;
    const scene = {
      paths: provincePathsFor(g),
      fills: fills.fills,
      hatched: fills.hatched,
      internal: buildArcPath(g, isProvinceBorder),
      nations: buildArcPath(g, (a) => isNationBorder(a, owners)),
      player: buildArcPath(g, (a) => isPlayerBorder(a, owners, sim.state.player)),
      seaLinks: buildSeaLinkPath(sim.map, g),
      mode: 'political' as const,
    };
    const colours = new Set(fills.fills).size;
    const r = recorder(1440, 900);
    drawBase(r.ctx, scene, g, { k: 0.7, x: 20, y: 50 }, 1, null);
    // Sphere, then a solid and a hatched fill per colour, plus the hatch pattern over the one hatched batch.
    expect(r.calls.get('fill')).toBe(1 + 2 * colours + colours);
    expect(r.calls.get('stroke')).toBe(4);

    r.reset();
    drawBase(r.ctx, scene, g, { k: 8, x: -8000, y: -2400 }, 1, null);
    const fillsAtZoom = r.calls.get('fill')!;
    expect(fillsAtZoom).toBeGreaterThan(1);
    expect(fillsAtZoom).toBeLessThan(200);
    // Internal borders join in from zoom 2.
    expect(r.calls.get('stroke')).toBe(5);

    r.reset();
    drawBase(r.ctx, scene, g, { k: 8, x: -8000, y: -2400 }, 1, [{ x: 10, y: 10, w: 20, h: 20 }]);
    expect(r.calls.get('clip')).toBe(1);
    expect(r.calls.get('fill')!).toBeLessThanOrEqual(fillsAtZoom);

    // World zoom: nation labels; zoom 3: city dots (arcs) and no text; zoom 6: province names.
    for (const [k, call, some] of [
      [0.7, 'fillText', true],
      [3, 'fillText', false],
      [3, 'arc', true],
      [6, 'fillText', true],
    ] as const) {
      r.reset();
      const camera = k < 1 ? { k, x: 20, y: 50 } : { k, x: -900 * k, y: -250 * k };
      drawBaseLabels(r.ctx, { sim, nations: nationLabels(sim, g), stars: capitalStars(sim, k) }, g, camera, 1, null);
      expect((r.calls.get(call) ?? 0) > 0).toBe(some);
    }
  });

  it('draws the overlay with routes, battles, previews and markers at every level of detail', async () => {
    const { drawOverlay, drawDragLine } = await import('../drawOverlay');
    const { layoutMarkers } = await import('../markers');
    const { previewOrder } = await import('@/next/game/orders');
    const own = armiesOf(sim, sim.state.player);
    const first = own[0]!;
    const to = sim.map.edges[first.at]![0]!.to;
    const preview = previewOrder(sim, sim.state.player, [first.id], to, true);
    // A second army marches, so its route and ETA chip are drawn.
    const second = own[1]!;
    const next = sim.map.edges[second.at]![0]!.to;
    second.leg = { from: second.at, to: next, ticks: 8, done: 3, sea: false };
    rebuildArmyIndex(sim);
    const frame: MapFrame = {
      sim,
      alpha: 0.5,
      selectedArmies: new Set([first.id, second.id]),
      selectedProvince: first.at,
      hover: to,
      preview,
      mode: 'political',
      showAll: true,
      highlights: [to],
      coarse: false,
    };
    const r = recorder(1440, 900);
    for (const camera of [
      { k: 0.7, x: 20, y: 50 },
      { k: 3, x: -2900, y: -700 },
      { k: RENDER.GLYPH_MARKERS_FROM_ZOOM + 1, x: -6000, y: -1600 },
    ]) {
      r.reset();
      const markers: Parameters<typeof layoutMarkers>[5] = [];
      const count = layoutMarkers(frame, g, camera, 1440, 900, markers);
      drawOverlay(r.ctx, { markers, count, frame, box: { x: 1, y: 2, w: 30, h: 40 }, nowMs: 1234 }, g, camera, 2);
      expect(r.calls.get('clearRect')).toBe(1);
      expect(r.calls.get('strokeRect')).toBeGreaterThanOrEqual(1);
    }
    drawDragLine(r.ctx, [0, 0], [50, 40], 1);
    second.leg = null;
    rebuildArmyIndex(sim);
  });
});
