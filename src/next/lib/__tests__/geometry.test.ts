import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RENDER } from '@/next/game/balance';
import { asProvince } from '@/next/game/ids';
import { createGame } from '@/next/game/init';
import { realMapStatic } from '@/next/game/__tests__/helpers';
import { arcSides, boundsOf, buildGeometry, isNationBorder, isPlayerBorder, isProvinceBorder } from '../geometry';
import { buildHitGrid, provinceAt } from '../hitTest';
import { parseSeeds, parseTopology } from '../mapData';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const read = (path: string): unknown => JSON.parse(readFileSync(`${ROOT}${path}`, 'utf8'));
const topology = parseTopology(read('public/provinces.json'));
const map = realMapStatic();
const g = buildGeometry(topology, map);

describe('buildGeometry on the committed map', () => {
  it('covers every province with rings, bounds and anchors in base space', () => {
    expect(g.width).toBe(RENDER.WORLD_WIDTH);
    expect(g.height).toBe(RENDER.WORLD_HEIGHT);
    expect(g.area.length).toBe(map.provinces.length);
    for (const p of map.provinces) {
      const ix = p.ix;
      expect(g.provinceRingCount[ix]).toBeGreaterThan(0);
      expect(g.area[ix]).toBeGreaterThan(0);
      const [x0, y0, x1, y1] = [g.bbox[4 * ix]!, g.bbox[4 * ix + 1]!, g.bbox[4 * ix + 2]!, g.bbox[4 * ix + 3]!];
      expect(x0).toBeGreaterThanOrEqual(0);
      expect(y0).toBeGreaterThanOrEqual(0);
      expect(x1).toBeLessThanOrEqual(g.width);
      expect(y1).toBeLessThanOrEqual(g.height);
      const ax = g.anchor[2 * ix]!;
      const ay = g.anchor[2 * ix + 1]!;
      expect(ax >= x0 && ax <= x1 && ay >= y0 && ay <= y1).toBe(true);
    }
    // Rings are stored back to back, in ProvinceIx order.
    let next = 0;
    for (let ix = 0; ix < map.provinces.length; ix++) {
      expect(g.provinceRingStart[ix]).toBe(next);
      next += g.provinceRingCount[ix]!;
    }
    expect(next).toBe(g.ringStart.length);
    const last = g.ringStart.length - 1;
    expect(2 * (g.ringStart[last]! + g.ringLength[last]!)).toBe(g.coords.length);
  });

  it('never streaks across the antimeridian', () => {
    // A ring that wrapped to the far edge would hold one edge longer than half the map.
    let longest = 0;
    for (let r = 0; r < g.ringStart.length; r++) {
      const start = g.ringStart[r]!;
      for (let i = 1; i < g.ringLength[r]!; i++) longest = Math.max(longest, Math.abs(g.coords[2 * (start + i)]! - g.coords[2 * (start + i - 1)]!));
    }
    expect(longest).toBeLessThan(g.width / 4);
  });

  it('puts at least 99% of label points inside their own province', () => {
    const grid = buildHitGrid(g, RENDER.HIT_GRID_CELL);
    let hits = 0;
    for (const p of map.provinces) if (provinceAt(grid, g, g.labelAt[2 * p.ix]!, g.labelAt[2 * p.ix + 1]!) === p.ix) hits++;
    expect(hits / map.provinces.length).toBeGreaterThanOrEqual(0.99);
  });

  it('gives every arc at least one side, and both sides are different provinces', () => {
    const sides = arcSides(topology, map);
    expect(sides.length).toBe(topology.arcs.length);
    expect(g.arcs.length).toBe(topology.arcs.length);
    for (const arc of g.arcs) {
      expect(arc.left).toBeGreaterThanOrEqual(0);
      expect(arc.left).toBeLessThan(map.provinces.length);
      if (arc.right !== null) expect(arc.right).not.toBe(arc.left);
      expect(arc.coords.length).toBeGreaterThanOrEqual(4);
    }
    // Every land edge between two provinces is drawn by at least one shared arc.
    const shared = new Set(g.arcs.filter(isProvinceBorder).map((a) => `${Math.min(a.left, a.right!)}|${Math.max(a.left, a.right!)}`));
    let landEdges = 0;
    let drawn = 0;
    map.edges.forEach((edges, from) => {
      for (const e of edges) {
        if (e.sea || e.to < from) continue;
        landEdges++;
        if (shared.has(`${e.to}|${from}`) || shared.has(`${from}|${e.to}`)) drawn++;
      }
    });
    expect(drawn / landEdges).toBeGreaterThan(0.95);
  });

  it('starts with nation borders exactly where countries meet', () => {
    const state = createGame(map, { playerCountryId: '250', difficulty: 'standard', seed: 'geometry' });
    const owners = state.provinces.map((p) => p.owner);
    const countries = map.provinces.map((p) => p.country);
    const byOwner = g.arcs.filter((a) => isNationBorder(a, owners)).length;
    const byCountry = g.arcs.filter((a) => a.right !== null && map.provinces[a.left]!.country !== map.provinces[a.right]!.country).length;
    expect(byOwner).toBe(byCountry);
    expect(byOwner).toBeGreaterThan(300);
    // The player border is France's outline: every arc with France on exactly one side.
    const france = state.player;
    const player = g.arcs.filter((a) => isPlayerBorder(a, owners, france));
    expect(player.length).toBeGreaterThan(0);
    for (const a of player) expect(countries[a.left] === france || (a.right !== null && countries[a.right] === france)).toBe(true);
    expect(g.arcs.filter((a) => isNationBorder(a, countries)).length).toBe(byCountry);
  });

  it('builds a closed sphere outline, a graticule and bounds for a province set', () => {
    expect(g.sphere.length).toBeGreaterThan(100);
    expect(g.graticule.length).toBeGreaterThan(30);
    const paris = map.provinceById.get(map.provinces.find((p) => p.name === 'Île-de-France')?.id ?? '') ?? asProvince(0);
    const bounds = boundsOf(g, [paris]);
    expect(bounds).toEqual([g.bbox[4 * paris], g.bbox[4 * paris + 1], g.bbox[4 * paris + 2], g.bbox[4 * paris + 3]]);
    expect(boundsOf(g, [])).toBeNull();
  });

  it('rejects files that disagree', () => {
    expect(() => parseTopology({ type: 'FeatureCollection' })).toThrow(/not a TopoJSON/);
    expect(() => parseTopology({ type: 'Topology', arcs: [[[0, 0]]], objects: {} })).toThrow(/no "provinces"/);
    expect(() => parseSeeds([{ id: '250' }])).toThrow(/row 0/);
    const missing = { ...topology, objects: { provinces: { ...topology.objects.provinces, geometries: topology.objects.provinces.geometries.slice(1) } } };
    expect(() => buildGeometry(missing, map)).toThrow(/no outline/);
  });
});
