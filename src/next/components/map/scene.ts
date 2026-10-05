/**
 * What the base layer shows, derived from the live Sim (§8.8, §9.3), DOM-free
 * so it is tested in Node: the fill colour and hatch flag of every province
 * per map mode, the key that says when those fills are stale, the provinces a
 * repaint must cover, nation label points and capital stars.
 */
import { CAPITAL, RENDER, TIME } from '@/next/game/balance';
import { ownedProvinces } from '@/next/game/cache';
import { statusOf } from '@/next/game/province';
import { asProvince } from '@/next/game/ids';
import type { Good, MapMode, NationIx, ProvinceIx, Sim, Terrain } from '@/next/game/types';
import type { MapGeometry } from '@/next/lib/geometry';
import { toScreen } from './camera';
import { playerSupply } from './derived';
import type { Camera } from './types';
import type { Rect } from './drawBase';

/** Terrain mode: one muted hue per class, legible under white borders. */
export const TERRAIN_COLOURS: Readonly<Record<Terrain, string>> = {
  plains: '#5f8f4e',
  hills: '#8d8a4f',
  mountains: '#8a7262',
  jungle: '#2f6b45',
  desert: '#c2a467',
  arctic: '#c9d3dc',
  urban: '#8b8f99',
};
/** Resources mode: the province's good; authored oil fields are the darkest. */
export const GOOD_COLOURS: Readonly<Record<Good, string>> = { food: '#6aa84f', steel: '#7f8ea3', oil: '#a0702f' };
export const OIL_FIELD_COLOUR = '#5c3a12';
/** Stability mode: a single-hue ramp from 0 (light) to 100 (deep), in this many steps. */
export const STABILITY_STEPS = 10;
const STABILITY_RAMP = Array.from({ length: STABILITY_STEPS + 1 }, (_, i) => {
  // Lightness 82% at 0 down to 30% at 100, hue fixed: colour is one cue, the step count another.
  const lightness = 82 - (52 * i) / STABILITY_STEPS;
  return `hsl(205 55% ${lightness.toFixed(1)}%)`;
});
/** Supply mode: own land linked to the capital, land within the halo, own land cut off, everything else. */
export const SUPPLY_COLOURS = { connected: '#3f9b5f', supplied: '#b9a148', unsupplied: '#c2483f', none: '#3a4250' } as const;

export interface Fills {
  fills: string[];
  hatched: boolean[];
}

export function stabilityColour(stability: number): string {
  const step = Math.max(0, Math.min(STABILITY_STEPS, Math.round((stability / 100) * STABILITY_STEPS)));
  return STABILITY_RAMP[step]!;
}

/** Fill colour and occupied hatch per province for `mode`. Only political mode hatches. */
export function provinceFills(sim: Sim, mode: MapMode): Fills {
  const { map, state } = sim;
  const count = map.provinces.length;
  const fills = new Array<string>(count);
  const hatched = new Array<boolean>(count).fill(false);
  const supply = mode === 'supply' ? playerSupply(sim) : null;
  const player = state.player;
  for (let i = 0; i < count; i++) {
    const p = asProvince(i);
    const fact = map.provinces[i]!;
    const province = state.provinces[i]!;
    switch (mode) {
      case 'political':
        fills[i] = state.nations[province.owner]!.colour;
        hatched[i] = statusOf(sim, p) === 'occupied';
        break;
      case 'terrain':
        fills[i] = TERRAIN_COLOURS[fact.terrain];
        break;
      case 'resources':
        fills[i] = fact.oilField ? OIL_FIELD_COLOUR : GOOD_COLOURS[fact.good];
        break;
      case 'stability':
        fills[i] = stabilityColour(province.stability);
        break;
      case 'supply': {
        const own = province.owner === player;
        if (own && supply!.connected[i] === 1) fills[i] = SUPPLY_COLOURS.connected;
        else if (supply!.supplied[i] === 1) fills[i] = SUPPLY_COLOURS.supplied;
        else fills[i] = own ? SUPPLY_COLOURS.unsupplied : SUPPLY_COLOURS.none;
        break;
      }
    }
  }
  return { fills, hatched };
}

/**
 * Changes whenever `provinceFills(sim, mode)` could: ownership for political
 * and supply, plus the day for political (integration is daily) and the hour
 * for stability (it drifts hourly). Terrain and resources never change.
 */
export function fillKey(sim: Sim, mode: MapMode): string {
  const version = sim.cache.ownershipVersion;
  const tick = sim.state.tick;
  switch (mode) {
    case 'political':
      return `political|${version}|${Math.floor(tick / TIME.TICKS_PER_DAY)}`;
    case 'supply':
      return `supply|${version}`;
    case 'stability':
      return `stability|${Math.floor(tick / TIME.TICKS_PER_HOUR)}`;
    case 'terrain':
    case 'resources':
      return mode;
  }
}

/** Provinces whose fill or hatch differs between two fill sets, ascending. */
export function changedProvinces(before: Fills, after: Fills): ProvinceIx[] {
  const out: ProvinceIx[] = [];
  const count = after.fills.length;
  for (let i = 0; i < count; i++) {
    if (before.fills[i] !== after.fills[i] || before.hatched[i] !== after.hatched[i]) out.push(asProvince(i));
  }
  return out;
}

/** Provinces whose owner differs between two owner snapshots, ascending. */
export function ownerChanges(before: ArrayLike<number>, after: ArrayLike<number>): ProvinceIx[] {
  const out: ProvinceIx[] = [];
  for (let i = 0; i < after.length; i++) if (before[i] !== after[i]) out.push(asProvince(i));
  return out;
}

/**
 * The screen rectangles (CSS px) a partial repaint clips to: each province's
 * box under camera `c`, grown by `pad`. Null when a full repaint is cheaper,
 * that is when more than RENDER.DIRTY_RECT_MAX provinces changed.
 */
export function dirtyRects(g: MapGeometry, c: Camera, provinces: readonly ProvinceIx[], pad: number): Rect[] | null {
  if (provinces.length > RENDER.DIRTY_RECT_MAX) return null;
  return provinces.map((p) => {
    const [x0, y0] = toScreen(c, g.bbox[4 * p]!, g.bbox[4 * p + 1]!);
    const [x1, y1] = toScreen(c, g.bbox[4 * p + 2]!, g.bbox[4 * p + 3]!);
    return { x: Math.floor(x0 - pad), y: Math.floor(y0 - pad), w: Math.ceil(x1 - x0 + 2 * pad) + 1, h: Math.ceil(y1 - y0 + 2 * pad) + 1 };
  });
}

export interface NationLabel {
  nation: NationIx;
  /** Base space. */
  x: number;
  y: number;
  /** Owned area in base units squared; bigger nations get bigger type and win overlaps. */
  area: number;
}

/**
 * One label per living nation at the label point of its largest owned
 * province, biggest nation first (ties to the lower index), so a greedy
 * screen-space declutter keeps the names that matter.
 */
export function nationLabels(sim: Sim, g: MapGeometry): NationLabel[] {
  const out: NationLabel[] = [];
  for (const nation of sim.state.nations) {
    if (!nation.alive) continue;
    let area = 0;
    let best = -1;
    let bestArea = -1;
    for (const p of ownedProvinces(sim, nation.ix)) {
      const a = g.area[p]!;
      area += a;
      if (a > bestArea) {
        bestArea = a;
        best = p;
      }
    }
    if (best < 0) continue;
    out.push({ nation: nation.ix, x: g.labelAt[2 * best]!, y: g.labelAt[2 * best + 1]!, area });
  }
  return out.sort((a, b) => b.area - a.area || a.nation - b.nation);
}

/**
 * Capital stars at zoom `k` (§8.8): the player's seat always, empires of at
 * least CAPITAL.EMPIRE_PROVINCES provinces at every zoom, and every other seat
 * once city dots show.
 */
export function capitalStars(sim: Sim, k: number): ProvinceIx[] {
  const out: ProvinceIx[] = [];
  const all = k >= RENDER.CITY_DOTS_FROM_ZOOM;
  for (const nation of sim.state.nations) {
    if (!nation.alive || nation.capital === null) continue;
    if (all || nation.isPlayer || ownedProvinces(sim, nation.ix).length >= CAPITAL.EMPIRE_PROVINCES) out.push(nation.capital);
  }
  return out.sort((a, b) => a - b);
}
