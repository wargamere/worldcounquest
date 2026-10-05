import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RENDER } from '@/next/game/balance';
import { asProvince } from '@/next/game/ids';
import { localRng } from '@/next/game/rng';
import { realMapStatic } from '@/next/game/__tests__/helpers';
import type { ProvinceIx } from '@/next/game/types';
import { buildGeometry } from '../geometry';
import { buildHitGrid, pickProvince, pointInProvince, provinceAt, provincesInRect, tinyProvinceAt } from '../hitTest';
import { parseTopology } from '../mapData';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const topology = parseTopology(JSON.parse(readFileSync(`${ROOT}public/provinces.json`, 'utf8')));
const map = realMapStatic();
const g = buildGeometry(topology, map);
const grid = buildHitGrid(g, RENDER.HIT_GRID_CELL);
const byName = (name: string): ProvinceIx => {
  const p = map.provinces.find((x) => x.name === name);
  if (p === undefined) throw new Error(`no province ${name}`);
  return p.ix;
};

function bruteForce(x: number, y: number): ProvinceIx | null {
  for (let p = 0; p < map.provinces.length; p++) if (pointInProvince(g, asProvince(p), x, y)) return asProvince(p);
  return null;
}

describe('hit grid', () => {
  it('is 125 x 63 cells of 16 base units', () => {
    expect(grid.cols).toBe(125);
    expect(grid.rows).toBe(63);
    expect(grid.cells.length).toBe(125 * 63);
  });

  it('equals brute force on 1,000 random points', () => {
    const rng = localRng(20261001);
    let land = 0;
    for (let i = 0; i < 1000; i++) {
      const x = rng() * g.width;
      const y = rng() * g.height;
      const expected = bruteForce(x, y);
      if (expected !== null) land++;
      expect(provinceAt(grid, g, x, y)).toBe(expected);
    }
    expect(land).toBeGreaterThan(150);
  });

  it('finds nothing off the map or in open sea', () => {
    expect(provinceAt(grid, g, -5, 500)).toBeNull();
    expect(provinceAt(grid, g, 1000, 2000)).toBeNull();
    // The middle of the South Pacific.
    expect(provinceAt(grid, g, 120, 640)).toBeNull();
  });

  it('lists the provinces whose bounds meet a rectangle, ascending', () => {
    const lux = byName('Luxembourg');
    const x = g.anchor[2 * lux]!;
    const y = g.anchor[2 * lux + 1]!;
    const near = provincesInRect(grid, g, x + 10, y + 10, x - 10, y - 10);
    expect(near).toContain(lux);
    expect([...near].sort((a, b) => a - b)).toEqual(near);
    const brute = map.provinces
      .filter((p) => g.bbox[4 * p.ix]! <= x + 10 && g.bbox[4 * p.ix + 2]! >= x - 10 && g.bbox[4 * p.ix + 1]! <= y + 10 && g.bbox[4 * p.ix + 3]! >= y - 10)
      .map((p) => p.ix);
    expect(near).toEqual(brute);
  });
});

describe('the tiny-province rule', () => {
  const lux = byName('Luxembourg');
  const ax = g.anchor[2 * lux]!;
  const ay = g.anchor[2 * lux + 1]!;

  it('lets Luxembourg win a tap near its anchor at world zoom', () => {
    const k = 0.6;
    expect(g.area[lux]! * k * k).toBeLessThan(RENDER.TINY_PROVINCE_PX2);
    expect(pickProvince(grid, g, ax, ay, k)).toBe(lux);
    // Taps that land in a neighbour but closest to Luxembourg's anchor still pick Luxembourg.
    let outside = 0;
    for (let px = 1; px <= RENDER.TINY_ANCHOR_PX; px++) {
      for (let step = 0; step < 16; step++) {
        const angle = (step / 16) * 2 * Math.PI;
        const x = ax + (px / k) * Math.cos(angle);
        const y = ay + (px / k) * Math.sin(angle);
        const under = provinceAt(grid, g, x, y);
        const tiny = tinyProvinceAt(grid, g, x, y, k);
        expect(pickProvince(grid, g, x, y, k)).toBe(tiny ?? under);
        if (tiny === lux && under !== lux) outside++;
      }
    }
    expect(outside).toBeGreaterThan(0);
    // Beyond 16 px it no longer wins.
    expect(tinyProvinceAt(grid, g, ax + 17 / k, ay, k)).not.toBe(lux);
  });

  it('picks the nearest tiny anchor, ties to the lower index', () => {
    const k = 0.6;
    const x = ax + 3;
    const y = ay - 2;
    const limit = (RENDER.TINY_ANCHOR_PX / k) * (RENDER.TINY_ANCHOR_PX / k);
    let best: number | null = null;
    let bestD = Infinity;
    for (let p = 0; p < map.provinces.length; p++) {
      if (g.area[p]! * k * k >= RENDER.TINY_PROVINCE_PX2) continue;
      const d = (g.anchor[2 * p]! - x) * (g.anchor[2 * p]! - x) + (g.anchor[2 * p + 1]! - y) * (g.anchor[2 * p + 1]! - y);
      if (d <= limit && d < bestD) {
        best = p;
        bestD = d;
      }
    }
    expect(tinyProvinceAt(grid, g, x, y, k)).toBe(best);
  });

  it('stops applying once the province is big enough on screen', () => {
    const k = Math.sqrt(RENDER.TINY_PROVINCE_PX2 / g.area[lux]!) * 1.01;
    const x = ax + 10 / k;
    expect(tinyProvinceAt(grid, g, x, ay, k)).toBeNull();
    expect(pickProvince(grid, g, x, ay, k)).toBe(provinceAt(grid, g, x, ay));
  });
});
