import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RENDER } from '@/next/game/balance';
import { armiesOf, armyById } from '@/next/game/cache';
import { isArmyVisible } from '@/next/game/supply';
import { realSim } from '@/next/game/__tests__/helpers';
import { buildGeometry, isNationBorder } from '@/next/lib/geometry';
import { parseTopology } from '@/next/lib/mapData';
import { worldCamera } from '../camera';
import { layoutMarkers, type Marker } from '../markers';
import { capitalStars, nationLabels, provinceFills } from '../scene';
import type { MapFrame } from '../types';

const ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
const topology = parseTopology(JSON.parse(readFileSync(`${ROOT}public/provinces.json`, 'utf8')));
const sim = realSim({ player: '250', seed: 'map' });
const g = buildGeometry(topology, sim.map);
const frame = (over: Partial<MapFrame> = {}): MapFrame => ({
  sim,
  alpha: 0,
  selectedArmies: new Set(),
  selectedProvince: null,
  hover: null,
  preview: null,
  mode: 'political',
  showAll: false,
  highlights: [],
  coarse: false,
  ...over,
});

/** Median wall time of `runs` calls (ms). */
function median(runs: number, fn: () => void): number {
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    fn();
    times.push(performance.now() - t);
  }
  return times.sort((a, b) => a - b)[Math.floor(runs / 2)]!;
}

describe('the map on the real opening', () => {
  it('lays out every own army at world zoom and stays within the caps when all armies show', () => {
    const view = { w: 1440, h: 900 };
    const camera = worldCamera(view.w, view.h);
    const out: Marker[] = [];
    const count = layoutMarkers(frame(), g, camera, view.w, view.h, out);
    const ownIds = new Set(armiesOf(sim, sim.state.player).map((a) => a.id));
    const placed = new Set(out.slice(0, count).flatMap((m) => m.armies));
    for (const id of ownIds) expect(placed.has(id)).toBe(true);
    // Fog: every hostile army shown is one the player can see.
    for (const m of out.slice(0, count)) if (!m.ours) for (const id of m.armies) expect(isArmyVisible(sim, armyById(sim, id)!)).toBe(true);

    const all = layoutMarkers(frame({ showAll: true }), g, { k: 3, x: -1500, y: -500 }, view.w, view.h, out);
    expect(all).toBeGreaterThan(0);
    expect(all).toBeLessThanOrEqual(RENDER.MAX_MARKERS_FINE);
    const touch = layoutMarkers(frame({ showAll: true, coarse: true }), g, camera, view.w, view.h, out);
    expect(touch).toBeLessThanOrEqual(RENDER.MAX_MARKERS_COARSE);
  });

  it('fills, labels and stars cover the world', () => {
    const { fills, hatched } = provinceFills(sim, 'political');
    expect(fills).toHaveLength(sim.map.provinces.length);
    expect(hatched.some(Boolean)).toBe(false);
    expect(new Set(fills).size).toBeLessThanOrEqual(8);
    expect(nationLabels(sim, g)).toHaveLength(sim.state.nations.filter((n) => n.alive).length);
    const stars = capitalStars(sim, 1);
    expect(stars).toContain(sim.state.nations[sim.state.player]!.capital);
    expect(capitalStars(sim, RENDER.CITY_DOTS_FROM_ZOOM).length).toBe(sim.state.nations.filter((n) => n.alive && n.capital !== null).length);
    const owners = sim.state.provinces.map((p) => p.owner);
    expect(g.arcs.filter((a) => isNationBorder(a, owners)).length).toBeGreaterThan(300);
  });

  it('stays well inside the frame budget (loose guard for a slow CI box)', () => {
    const out: Marker[] = [];
    const camera = worldCamera(1440, 900);
    const layout = median(15, () => layoutMarkers(frame({ showAll: true }), g, camera, 1440, 900, out));
    const fills = median(15, () => provinceFills(sim, 'political'));
    // The laptop budget for the whole overlay is 3 ms; this container runs about 10x slower.
    expect(layout).toBeLessThan(30);
    expect(fills).toBeLessThan(30);
  });
});
