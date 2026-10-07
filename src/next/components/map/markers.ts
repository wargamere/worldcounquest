/**
 * Army marker layout (§9.4), pure and tested in Node. Each frame turns the
 * live armies into at most RENDER.MAX_MARKERS_* screen-space markers:
 *
 * - level of detail: below RENDER.AGGREGATE_MARKERS_BELOW_ZOOM one chip per
 *   (province, nation) and moving armies as dots; above it one chip per army,
 *   fanned around the anchor up to RENDER.FAN_MAX, then one "+N" chip;
 * - hiding: fog (unless "Show all armies"), and at low zoom small hostile
 *   stacks far from the player's land;
 * - declutter: greedy by priority. The player's own markers and the selection
 *   always stay; anything else is dropped when it would overlap a marker
 *   already placed, and the list stops at the cap.
 *
 * The output keeps priority order (most important first), which is the order
 * hit tests scan and the reverse of the order markers are drawn in. Marker
 * objects and their `armies` arrays are reused frame to frame.
 */
import { RENDER, UNITS } from '@/next/game/balance';
import { armiesAt } from '@/next/game/cache';
import { asNation, asProvince } from '@/next/game/ids';
import { isArmyVisible } from '@/next/game/supply';
import { legProgress } from '@/next/game/travel';
import { UNIT_TYPES } from '@/next/game/types';
import type { Army, ArmyId, NationIx, ProvinceIx, Sim, UnitType } from '@/next/game/types';
import type { MapGeometry } from '@/next/lib/geometry';
import { toScreen } from './camera';
import { hopsFromPlayerLand, playerSupply } from './derived';
import type { Camera, MapFrame } from './types';

export interface Marker {
  /** Screen position (CSS px) of the chip's centre. */
  x: number;
  y: number;
  armies: ArmyId[];
  nation: NationIx;
  units: number;
  glyph: UnitType;
  moving: boolean;
  inBattle: boolean;
  waitingTicks: number;
  unsupplied: boolean;
  selected: boolean;
  ours: boolean;
  hpShare: number;
}

/** Declutter priorities, 1 first (§9.4). */
export const PRIORITY = {
  SELECTED: 1,
  OWN_BATTLE: 2,
  OWN_MOVING: 3,
  OWN_IDLE: 4,
  ENEMY_FIGHTING_YOU: 5,
  ENEMY_HEADING_TO_YOU: 6,
  ENEMY_BIG: 7,
  OTHER: 8,
} as const;
/** Hostile stacks of at least this many units outrank the rest. */
const BIG_STACK_UNITS = RENDER.HIDE_SMALL_ENEMY_UNITS;
/** A moving army at aggregate zoom is a dot this wide (CSS px). */
export const DOT_PX = 4;
/** Gap between fanned chips (CSS px). */
const FAN_GAP = 2;

export type MarkerLod = 'aggregate' | 'chips' | 'glyphs';

export function markerLod(k: number): MarkerLod {
  if (k < RENDER.AGGREGATE_MARKERS_BELOW_ZOOM) return 'aggregate';
  return k < RENDER.GLYPH_MARKERS_FROM_ZOOM ? 'chips' : 'glyphs';
}

export function chipSize(coarse: boolean): { w: number; h: number } {
  return coarse ? { w: RENDER.MARKER_W_TOUCH, h: RENDER.MARKER_H_TOUCH } : { w: RENDER.MARKER_W, h: RENDER.MARKER_H };
}

/**
 * Chip-centre offsets, in half-chip steps, for `count` chips sharing an anchor:
 * a row of two, a triangle of three, a 2x2 block of four, and the "+N" chip
 * centred under the block as a fifth.
 */
const FAN_SLOTS: readonly (readonly (readonly [number, number])[])[] = [
  [],
  [[0, 0]],
  [
    [-1, 0],
    [1, 0],
  ],
  [
    [-1, -1],
    [1, -1],
    [0, 1],
  ],
  [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ],
  [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
    [0, 3],
  ],
];

/** Offsets (CSS px) of `count` fanned chips of size w x h around their anchor; count is 1..FAN_MAX + 1. */
export function fanOffset(count: number, slot: number, w: number, h: number): [number, number] {
  const slots = FAN_SLOTS[Math.min(count, FAN_SLOTS.length - 1)]!;
  const [sx, sy] = slots[Math.min(slot, slots.length - 1)] ?? [0, 0];
  return [(sx * (w + FAN_GAP)) / 2, (sy * (h + FAN_GAP)) / 2];
}

// ------------------------------------------------------------ candidates

/** One marker before declutter, pooled across frames. */
interface Candidate {
  marker: Marker;
  priority: number;
  /** The lowest army id; the stable tie-break. */
  key: number;
  dot: boolean;
}

const pool: Candidate[] = [];
let used = 0;
const order: number[] = [];

function newMarker(): Marker {
  return {
    x: 0,
    y: 0,
    armies: [],
    nation: asNation(0),
    units: 0,
    glyph: 'rifles',
    moving: false,
    inBattle: false,
    waitingTicks: 0,
    unsupplied: false,
    selected: false,
    ours: false,
    hpShare: 1,
  };
}

function take(): Candidate {
  let c = pool[used];
  if (c === undefined) {
    c = { marker: newMarker(), priority: PRIORITY.OTHER, key: 0, dot: false };
    pool.push(c);
  }
  used += 1;
  const m = c.marker;
  m.armies.length = 0;
  m.units = 0;
  m.moving = false;
  m.inBattle = false;
  m.waitingTicks = 0;
  m.unsupplied = false;
  m.selected = false;
  m.ours = false;
  m.hpShare = 1;
  c.priority = PRIORITY.OTHER;
  c.key = Number.MAX_SAFE_INTEGER;
  c.dot = false;
  return c;
}

/** Per-type unit counts of the candidate being filled, for its dominant glyph. */
const glyphCounts = new Float64Array(UNIT_TYPES.length);
/** HP and full HP of the candidate being filled. */
let hpNow = 0;
let hpFull = 0;

function startFill(): void {
  glyphCounts.fill(0);
  hpNow = 0;
  hpFull = 0;
}

/** The province an enemy army is marching to: its final destination, else the end of its leg. */
function destinationOf(army: Army): ProvinceIx | null {
  if (army.path.length > 0) return army.path[army.path.length - 1]!;
  return army.leg?.to ?? null;
}

function priorityOf(sim: Sim, army: Army, selected: boolean): number {
  if (selected) return PRIORITY.SELECTED;
  const player = sim.state.player;
  if (army.owner === player) {
    if (army.battle !== null) return PRIORITY.OWN_BATTLE;
    if (army.leg !== null || army.path.length > 0) return PRIORITY.OWN_MOVING;
    return PRIORITY.OWN_IDLE;
  }
  if (army.battle !== null) {
    const here = army.at;
    if (sim.state.provinces[here]!.owner === player || armiesAt(sim, here).some((a) => a.owner === player)) return PRIORITY.ENEMY_FIGHTING_YOU;
  }
  if (army.leg !== null) {
    const to = destinationOf(army);
    if ((to !== null && sim.state.provinces[to]!.owner === player) || sim.state.provinces[army.leg.to]!.owner === player) return PRIORITY.ENEMY_HEADING_TO_YOU;
  }
  return PRIORITY.OTHER;
}

/** Adds one army to the candidate being filled. */
function addArmy(sim: Sim, c: Candidate, army: Army, selected: ReadonlySet<ArmyId>, unsupplied: Uint8Array | null): void {
  const m = c.marker;
  const isSelected = selected.has(army.id);
  m.armies.push(army.id);
  m.nation = army.owner;
  m.ours = army.owner === sim.state.player;
  m.selected ||= isSelected;
  m.moving ||= army.leg !== null;
  m.inBattle ||= army.battle !== null;
  if (army.leg === null && army.path.length > 0 && army.departAt > sim.state.tick) m.waitingTicks = Math.max(m.waitingTicks, army.departAt - sim.state.tick);
  if (m.ours && unsupplied !== null && unsupplied[army.at] === 0) m.unsupplied = true;
  UNIT_TYPES.forEach((type, i) => {
    const stack = army.units[type];
    m.units += stack.count;
    glyphCounts[i] = glyphCounts[i]! + stack.count;
    hpNow += stack.hp;
    hpFull += stack.count * UNITS[type].hp;
  });
  c.priority = Math.min(c.priority, priorityOf(sim, army, isSelected));
  c.key = Math.min(c.key, army.id);
}

function finishFill(c: Candidate): void {
  const m = c.marker;
  let best = 0;
  for (let i = 1; i < UNIT_TYPES.length; i++) if (glyphCounts[i]! > glyphCounts[best]!) best = i;
  m.glyph = UNIT_TYPES[best]!;
  m.hpShare = hpFull > 0 ? Math.max(0, Math.min(1, hpNow / hpFull)) : 1;
  if (!m.ours && m.units >= BIG_STACK_UNITS) c.priority = Math.min(c.priority, PRIORITY.ENEMY_BIG);
}

// ------------------------------------------------------------ declutter grid

/** Placed-marker buckets in screen cells, reused across frames. */
let gridCols = 0;
let gridRows = 0;
let gridCell = 1;
let heads = new Int32Array(0);
let next = new Int32Array(0);

function resetGrid(viewW: number, viewH: number, cell: number, cap: number): void {
  gridCell = cell;
  // Markers may sit just outside the view; one extra cell on every side holds them.
  gridCols = Math.ceil(viewW / cell) + 2;
  gridRows = Math.ceil(viewH / cell) + 2;
  if (heads.length < gridCols * gridRows) heads = new Int32Array(gridCols * gridRows);
  heads.fill(-1, 0, gridCols * gridRows);
  if (next.length < cap) next = new Int32Array(cap);
}

function cellIndex(x: number, y: number): number {
  const c = Math.max(0, Math.min(gridCols - 1, Math.floor(x / gridCell) + 1));
  const r = Math.max(0, Math.min(gridRows - 1, Math.floor(y / gridCell) + 1));
  return r * gridCols + c;
}

function overlapsPlaced(out: readonly Marker[], x: number, y: number, w: number, h: number): boolean {
  const c0 = Math.max(0, Math.floor((x - w) / gridCell) + 1);
  const c1 = Math.min(gridCols - 1, Math.floor((x + w) / gridCell) + 1);
  const r0 = Math.max(0, Math.floor((y - h) / gridCell) + 1);
  const r1 = Math.min(gridRows - 1, Math.floor((y + h) / gridCell) + 1);
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      for (let i = heads[r * gridCols + c]!; i >= 0; i = next[i]!) {
        const m = out[i]!;
        if (Math.abs(m.x - x) < w && Math.abs(m.y - y) < h) return true;
      }
    }
  }
  return false;
}

function copyInto(into: Marker, from: Marker): void {
  into.x = from.x;
  into.y = from.y;
  into.armies.length = 0;
  for (const id of from.armies) into.armies.push(id);
  into.nation = from.nation;
  into.units = from.units;
  into.glyph = from.glyph;
  into.moving = from.moving;
  into.inBattle = from.inBattle;
  into.waitingTicks = from.waitingTicks;
  into.unsupplied = from.unsupplied;
  into.selected = from.selected;
  into.ours = from.ours;
  into.hpShare = from.hpShare;
}

// ------------------------------------------------------------ the layout

/** Standing visible armies of the province being laid out, reused. */
const here: Army[] = [];
/** Nations of the province being laid out at aggregate zoom, reused. */
const groups: Candidate[] = [];

/**
 * Lays out this frame's markers into `out` (grown as needed; entries past the
 * returned count are stale) and returns how many were placed.
 */
export function layoutMarkers(frame: MapFrame, g: MapGeometry, c: Camera, viewW: number, viewH: number, out: Marker[]): number {
  const { sim } = frame;
  const { state } = sim;
  const player = state.player;
  const lod = markerLod(c.k);
  const aggregate = lod === 'aggregate';
  const { w, h } = chipSize(frame.coarse);
  const cap = frame.coarse ? RENDER.MAX_MARKERS_COARSE : RENDER.MAX_MARKERS_FINE;
  const hops = aggregate ? hopsFromPlayerLand(sim) : null;
  const supply = playerSupply(sim).supplied;
  // Anything whose anchor is this far off screen cannot show any part of a chip.
  const margin = 2 * (w + h);
  const onScreen = (x: number, y: number): boolean => x >= -margin && y >= -margin && x <= viewW + margin && y <= viewH + margin;
  const visible = (army: Army): boolean => army.alive && (army.owner === player || frame.showAll || isArmyVisible(sim, army));
  const hidden = (units: number, ours: boolean, selected: boolean, p: ProvinceIx): boolean =>
    hops !== null && !ours && !selected && units < RENDER.HIDE_SMALL_ENEMY_UNITS && hops[p]! > RENDER.HIDE_SMALL_ENEMY_HOPS;
  used = 0;

  // Standing armies, province by province.
  const provinceCount = sim.map.provinces.length;
  for (let p = 0; p < provinceCount; p++) {
    const province = asProvince(p);
    const standing = armiesAt(sim, province);
    if (standing.length === 0) continue;
    here.length = 0;
    for (const army of standing) if (army.leg === null && visible(army)) here.push(army);
    if (here.length === 0) continue;
    const [ax, ay] = toScreen(c, g.anchor[2 * p]!, g.anchor[2 * p + 1]!);
    if (!onScreen(ax, ay)) continue;
    const firstNew = used;
    if (aggregate) {
      groups.length = 0;
      for (const army of here) {
        if (groups.some((x) => x.marker.nation === army.owner)) continue;
        const group = take();
        startFill();
        for (const same of here) if (same.owner === army.owner) addArmy(sim, group, same, frame.selectedArmies, supply);
        finishFill(group);
        groups.push(group);
      }
    } else {
      here.sort((a, b) => priorityOf(sim, a, frame.selectedArmies.has(a.id)) - priorityOf(sim, b, frame.selectedArmies.has(b.id)) || a.id - b.id);
      const single = Math.min(here.length, RENDER.FAN_MAX);
      for (let i = 0; i < single; i++) {
        const cand = take();
        startFill();
        addArmy(sim, cand, here[i]!, frame.selectedArmies, supply);
        finishFill(cand);
      }
      if (here.length > single) {
        const rest = take();
        startFill();
        for (let i = single; i < here.length; i++) addArmy(sim, rest, here[i]!, frame.selectedArmies, supply);
        finishFill(rest);
      }
    }
    // Hide small far stacks, then fan what is left around the anchor.
    let kept = firstNew;
    for (let i = firstNew; i < used; i++) {
      const cand = pool[i]!;
      if (hidden(cand.marker.units, cand.marker.ours, cand.marker.selected, province)) continue;
      if (kept !== i) {
        pool[i] = pool[kept]!;
        pool[kept] = cand;
      }
      kept += 1;
    }
    used = kept;
    const fanned = used - firstNew;
    if (aggregate) {
      // Nations in one province: most important first, then by index.
      sortRange(firstNew, used, (a, b) => a.priority - b.priority || a.marker.nation - b.marker.nation);
    }
    for (let i = firstNew; i < used; i++) {
      const [dx, dy] = fanOffset(fanned, i - firstNew, w, h);
      pool[i]!.marker.x = ax + dx;
      pool[i]!.marker.y = ay + dy;
    }
  }

  // Moving armies: each its own marker, between the anchors of its leg.
  for (const army of state.armies) {
    if (army.leg === null || !visible(army)) continue;
    const from = army.leg.from;
    const to = army.leg.to;
    const [bx, by] = armyBasePosition(g, army, frame.alpha);
    const [x, y] = toScreen(c, bx, by);
    if (!onScreen(x, y)) continue;
    const cand = take();
    startFill();
    addArmy(sim, cand, army, frame.selectedArmies, supply);
    finishFill(cand);
    const near = hops === null ? from : hops[from]! <= hops[to]! ? from : to;
    if (hidden(cand.marker.units, cand.marker.ours, cand.marker.selected, near)) {
      used -= 1;
      continue;
    }
    cand.dot = aggregate;
    cand.marker.x = x;
    cand.marker.y = y;
  }

  // Declutter: priority order, own and selected markers always kept.
  order.length = used;
  for (let i = 0; i < used; i++) order[i] = i;
  order.sort((a, b) => pool[a]!.priority - pool[b]!.priority || pool[a]!.key - pool[b]!.key || a - b);
  resetGrid(viewW, viewH, 2 * w, cap);
  let count = 0;
  for (let i = 0; i < used && count < cap; i++) {
    const cand = pool[order[i]!]!;
    const m = cand.marker;
    const mw = cand.dot ? DOT_PX : w;
    const mh = cand.dot ? DOT_PX : h;
    const always = m.selected || m.ours;
    if (!always && overlapsPlaced(out, m.x, m.y, mw, mh)) continue;
    let slot = out[count];
    if (slot === undefined) {
      slot = newMarker();
      out.push(slot);
    }
    copyInto(slot, m);
    const cell = cellIndex(m.x, m.y);
    next[count] = heads[cell]!;
    heads[cell] = count;
    count += 1;
  }
  return count;
}

/** Insertion sort of pool[from..to): ranges are a province's few markers. */
function sortRange(from: number, to: number, compare: (a: Candidate, b: Candidate) => number): void {
  for (let i = from + 1; i < to; i++) {
    const item = pool[i]!;
    let j = i - 1;
    while (j >= from && compare(pool[j]!, item) > 0) {
      pool[j + 1] = pool[j]!;
      j--;
    }
    pool[j + 1] = item;
  }
}

/** Where an army is drawn in base space: its anchor, or along its leg at (done + alpha) / ticks (§1). */
export function armyBasePosition(g: MapGeometry, army: Army, alpha: number): [number, number] {
  const leg = army.leg;
  if (leg === null) return [g.anchor[2 * army.at]!, g.anchor[2 * army.at + 1]!];
  const t = legProgress(leg, alpha);
  const fx = g.anchor[2 * leg.from]!;
  const fy = g.anchor[2 * leg.from + 1]!;
  return [fx + (g.anchor[2 * leg.to]! - fx) * t, fy + (g.anchor[2 * leg.to + 1]! - fy) * t];
}

/** Whether a marker is drawn as a moving-army dot at this zoom. */
export function isDot(marker: Marker, k: number): boolean {
  return marker.moving && markerLod(k) === 'aggregate';
}

/** The armies of the marker nearest (x, y) within `radius` CSS px, the more important on a tie; null if none. */
export function markerAt(markers: readonly Marker[], count: number, x: number, y: number, radius: number): readonly ArmyId[] | null {
  let best: Marker | null = null;
  let bestDistance = radius * radius;
  for (let i = 0; i < count; i++) {
    const m = markers[i]!;
    const d = (m.x - x) * (m.x - x) + (m.y - y) * (m.y - y);
    if (d <= bestDistance && (best === null || d < bestDistance)) {
      best = m;
      bestDistance = d;
    }
  }
  // A copy: marker arrays are pooled and rewritten every frame, and a press holds this until release.
  return best === null ? null : best.armies.slice();
}

/** Every army whose marker centre lies inside the rectangle (CSS px), ascending id. */
export function armiesInRect(markers: readonly Marker[], count: number, x0: number, y0: number, x1: number, y1: number): ArmyId[] {
  const lx = Math.min(x0, x1);
  const hx = Math.max(x0, x1);
  const ly = Math.min(y0, y1);
  const hy = Math.max(y0, y1);
  const out: ArmyId[] = [];
  for (let i = 0; i < count; i++) {
    const m = markers[i]!;
    if (m.x >= lx && m.x <= hx && m.y >= ly && m.y <= hy) out.push(...m.armies);
  }
  return out.sort((a, b) => a - b);
}
