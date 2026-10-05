/**
 * Small worlds for the map tests: a tinySim plus a synthetic MapGeometry in
 * which every province is a square around its anchor, so screen positions are
 * easy to reason about.
 */
import { asArmy } from '@/next/game/ids';
import { tinySim, type TinySpec, type TinySim } from '@/next/game/__tests__/helpers';
import type { ArmyId, Leg, ProvinceIx } from '@/next/game/types';
import type { MapGeometry } from '@/next/lib/geometry';
import type { MapFrame } from '../types';

/** Half the side of each synthetic province square (base units). */
export const HALF = 20;

/** A geometry with one square ring of side 2 x HALF per province, centred on `anchors[p]`. */
export function squareGeometry(anchors: readonly (readonly [number, number])[]): MapGeometry {
  const count = anchors.length;
  const coords = new Float32Array(count * 8);
  const ringStart = new Uint32Array(count);
  const ringLength = new Uint32Array(count).fill(4);
  const provinceRingStart = new Uint32Array(count);
  const provinceRingCount = new Uint16Array(count).fill(1);
  const bbox = new Float32Array(count * 4);
  const anchor = new Float32Array(count * 2);
  const area = new Float32Array(count).fill(4 * HALF * HALF);
  anchors.forEach(([x, y], p) => {
    coords.set([x - HALF, y - HALF, x + HALF, y - HALF, x + HALF, y + HALF, x - HALF, y + HALF], p * 8);
    ringStart[p] = p * 4;
    provinceRingStart[p] = p;
    bbox.set([x - HALF, y - HALF, x + HALF, y + HALF], p * 4);
    anchor.set([x, y], p * 2);
  });
  return {
    width: 2000,
    height: 1000,
    coords,
    ringStart,
    ringLength,
    provinceRingStart,
    provinceRingCount,
    bbox,
    anchor,
    labelAt: anchor.slice(),
    area,
    arcs: [],
    sphere: new Float32Array(0),
    graticule: [],
  };
}

/** A chain a-b-c-...: one province per key, edges between neighbours, anchors 100 base units apart on y = 100. */
export function chainWorld(owners: readonly string[], extra: Partial<TinySpec> = {}): TinySim & { g: MapGeometry; keys: string[] } {
  const keys = owners.map((_, i) => `p${i}`);
  const provinces: TinySpec['provinces'] = {};
  keys.forEach((key, i) => {
    provinces[key] = { owner: owners[i]! };
  });
  const edges: TinySpec['edges'] = keys.slice(1).map((key, i) => [keys[i]!, key]);
  const world = tinySim({ provinces, edges, player: 'me', ...extra });
  const g = squareGeometry(keys.map((_, i) => [100 + 100 * i, 100] as const));
  return { ...world, g, keys };
}

export function frameOf(world: TinySim, over: Partial<MapFrame> = {}): MapFrame {
  return {
    sim: world.sim,
    alpha: 0,
    selectedArmies: new Set<ArmyId>(),
    selectedProvince: null,
    hover: null,
    preview: null,
    mode: 'political',
    showAll: true,
    highlights: [],
    coarse: false,
    ...over,
  };
}

export function legOf(from: ProvinceIx, to: ProvinceIx, ticks: number, done: number): Leg {
  return { from, to, ticks, done, sea: false };
}

export const ids = (...n: number[]): ArmyId[] => n.map((i) => asArmy(i));
