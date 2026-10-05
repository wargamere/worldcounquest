/**
 * The overlay layer (§8.8, §9.1), redrawn every frame while anything moves:
 * threat outlines, the pulsing outline of provinces under attack, highlights,
 * hover and selection, routes with ETA chips, hostile arrows, battle glyphs,
 * army markers and the box-select rectangle. It only reads the Sim.
 *
 * Province outlines are drawn in base space under the camera transform; every
 * marker, chip and glyph is drawn in screen space so it keeps its pixel size.
 */
import { RENDER } from '@/next/game/balance';
import { armyById, armiesAt } from '@/next/game/cache';
import { formatDuration } from '@/next/game/clock';
import { PLAYER_COLOUR } from '@/next/game/colours';
import { etaTicks } from '@/next/game/movement';
import { totalHp } from '@/next/game/units';
import type { Army, ProvinceIx, Sim, UnitType } from '@/next/game/types';
import type { MapGeometry } from '@/next/lib/geometry';
import { toScreen } from './camera';
import { threatenedProvinces } from './derived';
import type { Rect } from './drawBase';
import { armyBasePosition, chipSize, DOT_PX, markerLod, type Marker } from './markers';
import { provincePathsFor } from './paths';
import type { Camera, MapFrame } from './types';

export interface OverlayInput {
  markers: readonly Marker[];
  count: number;
  frame: MapFrame;
  box: Rect | null;
  nowMs: number;
}

export const OVERLAY_COLOURS = {
  selection: '#ffffff',
  hover: 'rgba(255, 255, 255, 0.6)',
  highlight: '#7dd3fc',
  threat: '#ef4444',
  attack: '#f87171',
  route: 'rgba(255, 255, 255, 0.9)',
  routeHostile: '#f87171',
  ownRoute: 'rgba(255, 255, 255, 0.55)',
  enemyArrow: 'rgba(226, 232, 240, 0.7)',
  enemyArrowToYou: '#ef4444',
  chipText: '#ffffff',
  chipHalo: 'rgba(5, 8, 15, 0.8)',
  hollow: 'rgba(5, 8, 15, 0.85)',
  etaChip: 'rgba(15, 23, 42, 0.92)',
  box: 'rgba(255, 255, 255, 0.85)',
  boxFill: 'rgba(255, 255, 255, 0.08)',
  healthGood: '#4ade80',
  healthLow: '#f87171',
} as const;

/** Pulse period of provinces under attack (ms); reduce motion holds it steady. */
const PULSE_MS = 1200;
const BATTLE_RING_PX = 8;
/** The battle glyph sits above a province's fanned markers by this much beyond one chip height (CSS px). */
const BATTLE_GLYPH_RAISE = 11;
const ARROW_HEAD_PX = 6;

let reducedMotion = false;
/** Reduce motion stops the pulses (§8.8). */
export function setReducedMotion(on: boolean): void {
  reducedMotion = on;
}

// ------------------------------------------------------------ province outlines

function strokeProvinces(ctx: CanvasRenderingContext2D, g: MapGeometry, provinces: Iterable<ProvinceIx>, colour: string, widthPx: number, k: number, dash: readonly number[] | null): void {
  const paths = provincePathsFor(g);
  ctx.strokeStyle = colour;
  ctx.lineWidth = widthPx / k;
  ctx.setLineDash(dash === null ? [] : dash.map((d) => d / k));
  for (const p of provinces) ctx.stroke(paths[p]!);
  ctx.setLineDash([]);
}

/** A battle is shown when it involves the player, lies in the player's vision, or "Show all armies" is on. */
function battleVisible(sim: Sim, p: ProvinceIx, showAll: boolean): boolean {
  if (showAll || sim.cache.vision[p] === 1) return true;
  const player = sim.state.player;
  return sim.state.provinces[p]!.owner === player || armiesAt(sim, p).some((a) => a.owner === player);
}

// ------------------------------------------------------------ routes

function routeTo(ctx: CanvasRenderingContext2D, c: Camera, g: MapGeometry, start: readonly [number, number], nodes: readonly ProvinceIx[]): void {
  ctx.beginPath();
  const [sx, sy] = toScreen(c, start[0], start[1]);
  ctx.moveTo(sx, sy);
  for (const p of nodes) {
    const [x, y] = toScreen(c, g.anchor[2 * p]!, g.anchor[2 * p + 1]!);
    ctx.lineTo(x, y);
  }
  ctx.stroke();
}

function etaChip(ctx: CanvasRenderingContext2D, text: string, x: number, y: number): void {
  ctx.font = '600 11px system-ui, sans-serif';
  const w = ctx.measureText(text).width + 10;
  const h = 16;
  ctx.fillStyle = OVERLAY_COLOURS.etaChip;
  roundRect(ctx, x - w / 2, y - h - 10, w, h, 4);
  ctx.fill();
  ctx.fillStyle = OVERLAY_COLOURS.chipText;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y - h / 2 - 10);
}

/** The province an army is ultimately heading for, or null when it has no route. */
function finalNode(army: Army): ProvinceIx | null {
  return army.path[army.path.length - 1] ?? army.leg?.to ?? null;
}

function drawOwnRoutes(ctx: CanvasRenderingContext2D, input: OverlayInput, g: MapGeometry, c: Camera): void {
  const { frame } = input;
  const { sim } = frame;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 4]);
  for (let i = 0; i < input.count; i++) {
    const m = input.markers[i]!;
    if (!m.ours) continue;
    for (const id of m.armies) {
      const army = armyById(sim, id);
      if (army === undefined || !army.alive || (army.leg === null && army.path.length === 0)) continue;
      const selected = frame.selectedArmies.has(id);
      ctx.strokeStyle = selected ? OVERLAY_COLOURS.route : OVERLAY_COLOURS.ownRoute;
      const nodes = army.leg === null ? army.path : [army.leg.to, ...army.path];
      routeTo(ctx, c, g, armyBasePosition(g, army, frame.alpha), nodes);
      if (!selected) continue;
      const eta = etaTicks(sim, army);
      const end = finalNode(army);
      if (eta === null || end === null) continue;
      const [x, y] = toScreen(c, g.anchor[2 * end]!, g.anchor[2 * end + 1]!);
      ctx.setLineDash([]);
      etaChip(ctx, formatDuration(eta), x, y);
      ctx.setLineDash([5, 4]);
    }
  }
  ctx.setLineDash([]);
}

/** The order preview: dashed white routes, red through hostile land before the target, and the arrival chip. */
function drawPreview(ctx: CanvasRenderingContext2D, frame: MapFrame, g: MapGeometry, c: Camera): void {
  const preview = frame.preview;
  if (preview === null) return;
  const { sim } = frame;
  const player = sim.state.player;
  ctx.lineWidth = 2.5;
  ctx.setLineDash([7, 5]);
  for (const route of preview.routes) {
    const army = armyById(sim, route.army);
    if (army === undefined) continue;
    let [px, py] = armyBasePosition(g, army, frame.alpha);
    route.nodes.forEach((p, i) => {
      const last = i === route.nodes.length - 1;
      const hostile = !last && sim.state.provinces[p]!.owner !== player;
      ctx.strokeStyle = hostile ? OVERLAY_COLOURS.routeHostile : OVERLAY_COLOURS.route;
      const [x0, y0] = toScreen(c, px, py);
      px = g.anchor[2 * p]!;
      py = g.anchor[2 * p + 1]!;
      const [x1, y1] = toScreen(c, px, py);
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    });
  }
  ctx.setLineDash([]);
  const [tx, ty] = toScreen(c, g.anchor[2 * preview.to]!, g.anchor[2 * preview.to + 1]!);
  if (preview.routes.length === 0) {
    ctx.strokeStyle = OVERLAY_COLOURS.routeHostile;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(tx - 6, ty - 6);
    ctx.lineTo(tx + 6, ty + 6);
    ctx.moveTo(tx + 6, ty - 6);
    ctx.lineTo(tx - 6, ty + 6);
    ctx.stroke();
    return;
  }
  etaChip(ctx, formatDuration(preview.arriveInTicks), tx, ty);
}

function arrow(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const length = Math.sqrt(dx * dx + dy * dy);
  if (length < 1) return;
  const ux = dx / length;
  const uy = dy / length;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 - ARROW_HEAD_PX * (ux - 0.5 * uy), y1 - ARROW_HEAD_PX * (uy + 0.5 * ux));
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 - ARROW_HEAD_PX * (ux + 0.5 * uy), y1 - ARROW_HEAD_PX * (uy - 0.5 * ux));
  ctx.stroke();
}

/** Hostile moving armies: an arrow to the next node only, red when it is heading for the player's land. */
function drawEnemyArrows(ctx: CanvasRenderingContext2D, input: OverlayInput, g: MapGeometry, c: Camera): void {
  const { sim } = input.frame;
  const player = sim.state.player;
  ctx.lineWidth = 1.5;
  for (let i = 0; i < input.count; i++) {
    const m = input.markers[i]!;
    if (m.ours || !m.moving) continue;
    const army = armyById(sim, m.armies[0]!);
    if (army === undefined || army.leg === null) continue;
    const end = finalNode(army);
    const toYou = sim.state.provinces[army.leg.to]!.owner === player || (end !== null && sim.state.provinces[end]!.owner === player);
    ctx.strokeStyle = toYou ? OVERLAY_COLOURS.enemyArrowToYou : OVERLAY_COLOURS.enemyArrow;
    const [x1, y1] = toScreen(c, g.anchor[2 * army.leg.to]!, g.anchor[2 * army.leg.to + 1]!);
    arrow(ctx, m.x, m.y, x1, y1);
  }
}

// ------------------------------------------------------------ battles

/** A crossed glyph with a ring split by HP share: the defender's colour clockwise from the top, the strongest attacker's for the rest. */
function drawBattles(ctx: CanvasRenderingContext2D, frame: MapFrame, g: MapGeometry, c: Camera): void {
  const { sim } = frame;
  const { h } = chipSize(frame.coarse);
  for (const p of sim.cache.battles) {
    if (!battleVisible(sim, p, frame.showAll)) continue;
    const owner = sim.state.provinces[p]!.owner;
    let defence = sim.state.provinces[p]!.garrison;
    let attack = 0;
    let strongest = -1;
    let strongestHp = 0;
    const byNation = new Map<number, number>();
    for (const army of armiesAt(sim, p)) {
      if (!army.alive || army.leg !== null) continue;
      const hp = totalHp(army.units);
      if (army.owner === owner) defence += hp;
      else {
        attack += hp;
        const sum = (byNation.get(army.owner) ?? 0) + hp;
        byNation.set(army.owner, sum);
        if (sum > strongestHp) {
          strongestHp = sum;
          strongest = army.owner;
        }
      }
    }
    const [ax, ay] = toScreen(c, g.anchor[2 * p]!, g.anchor[2 * p + 1]!);
    const x = ax;
    const y = ay - h - BATTLE_GLYPH_RAISE;
    const total = defence + attack;
    const share = total > 0 ? defence / total : 0.5;
    const top = -Math.PI / 2;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(x, y, BATTLE_RING_PX, top, top + share * 2 * Math.PI);
    ctx.strokeStyle = sim.state.nations[owner]!.colour;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, BATTLE_RING_PX, top + share * 2 * Math.PI, top + 2 * Math.PI);
    ctx.strokeStyle = strongest >= 0 ? sim.state.nations[strongest]!.colour : OVERLAY_COLOURS.attack;
    ctx.stroke();
    ctx.fillStyle = OVERLAY_COLOURS.hollow;
    ctx.beginPath();
    ctx.arc(x, y, BATTLE_RING_PX - 1.5, 0, 2 * Math.PI);
    ctx.fill();
    ctx.strokeStyle = OVERLAY_COLOURS.chipText;
    ctx.lineWidth = 1.6;
    const s = BATTLE_RING_PX * 0.45;
    ctx.beginPath();
    ctx.moveTo(x - s, y - s);
    ctx.lineTo(x + s, y + s);
    ctx.moveTo(x + s, y - s);
    ctx.lineTo(x - s, y + s);
    ctx.stroke();
  }
}

// ------------------------------------------------------------ markers

export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

/** Generic unit glyphs drawn in code: a box with an X for Rifles, and so on. */
function unitGlyph(ctx: CanvasRenderingContext2D, type: UnitType, x: number, y: number, w: number, h: number): void {
  ctx.strokeRect(x, y, w, h);
  ctx.beginPath();
  switch (type) {
    case 'rifles':
      ctx.moveTo(x, y);
      ctx.lineTo(x + w, y + h);
      ctx.moveTo(x + w, y);
      ctx.lineTo(x, y + h);
      break;
    case 'hunters':
      // An anti-tank chevron.
      ctx.moveTo(x, y + h);
      ctx.lineTo(x + w / 2, y);
      ctx.lineTo(x + w, y + h);
      break;
    case 'motor':
      ctx.moveTo(x, y);
      ctx.lineTo(x + w, y + h);
      ctx.moveTo(x + w, y);
      ctx.lineTo(x, y + h);
      ctx.moveTo(x + w / 2, y);
      ctx.lineTo(x + w / 2, y + h);
      break;
    case 'guns':
      ctx.arc(x + w / 2, y + h / 2, Math.min(w, h) / 4, 0, 2 * Math.PI);
      ctx.fill();
      break;
    case 'tanks':
      ctx.ellipse(x + w / 2, y + h / 2, w * 0.35, h * 0.28, 0, 0, 2 * Math.PI);
      break;
  }
  ctx.stroke();
}

function clockBadge(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  ctx.fillStyle = OVERLAY_COLOURS.etaChip;
  ctx.beginPath();
  ctx.arc(x, y, 5, 0, 2 * Math.PI);
  ctx.fill();
  ctx.strokeStyle = OVERLAY_COLOURS.chipText;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x, y - 3);
  ctx.moveTo(x, y);
  ctx.lineTo(x + 2.2, y);
  ctx.stroke();
}

function drawMarker(ctx: CanvasRenderingContext2D, m: Marker, sim: Sim, k: number, coarse: boolean): void {
  const colour = sim.state.nations[m.nation]!.colour;
  const lod = markerLod(k);
  if (m.moving && lod === 'aggregate') {
    ctx.beginPath();
    ctx.arc(m.x, m.y, DOT_PX / 2 + (m.selected ? 1 : 0), 0, 2 * Math.PI);
    ctx.fillStyle = colour;
    ctx.fill();
    if (m.ours || m.selected) {
      ctx.strokeStyle = m.selected ? OVERLAY_COLOURS.selection : PLAYER_COLOUR;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    return;
  }
  const { w, h } = chipSize(coarse);
  const x = m.x - w / 2;
  const y = m.y - h / 2;
  roundRect(ctx, x, y, w, h, 4);
  ctx.fillStyle = m.unsupplied ? OVERLAY_COLOURS.hollow : colour;
  ctx.fill();
  if (m.unsupplied) {
    ctx.strokeStyle = colour;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  if (m.ours) {
    ctx.strokeStyle = PLAYER_COLOUR;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  if (m.selected) {
    roundRect(ctx, x - 2.5, y - 2.5, w + 5, h + 5, 6);
    ctx.strokeStyle = OVERLAY_COLOURS.selection;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  // At chip zoom a chip holding several armies is the fan's "+N".
  const text = lod !== 'aggregate' && m.armies.length > 1 ? `+${m.armies.length}` : String(m.units);
  const glyph = lod === 'glyphs';
  ctx.font = `700 ${coarse ? 12 : 11}px system-ui, sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = OVERLAY_COLOURS.chipHalo;
  ctx.fillStyle = OVERLAY_COLOURS.chipText;
  ctx.lineWidth = 2.5;
  if (glyph && m.armies.length === 1) {
    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = OVERLAY_COLOURS.chipText;
    unitGlyph(ctx, m.glyph, x + 3, y + h / 2 - 4, 9, 8);
    ctx.restore();
    ctx.textAlign = 'right';
    ctx.strokeText(text, x + w - 3, m.y + 0.5);
    ctx.fillText(text, x + w - 3, m.y + 0.5);
    // Health bar under the chip.
    const barY = y + h + 2;
    ctx.fillStyle = OVERLAY_COLOURS.chipHalo;
    ctx.fillRect(x, barY, w, 3);
    ctx.fillStyle = m.hpShare >= 0.5 ? OVERLAY_COLOURS.healthGood : OVERLAY_COLOURS.healthLow;
    ctx.fillRect(x, barY, w * m.hpShare, 3);
  } else {
    ctx.textAlign = 'center';
    ctx.strokeText(text, m.x, m.y + 0.5);
    ctx.fillText(text, m.x, m.y + 0.5);
  }
  if (m.waitingTicks > 0) clockBadge(ctx, x + w, y);
}

// ------------------------------------------------------------ the layer

export function drawOverlay(ctx: CanvasRenderingContext2D, input: OverlayInput, g: MapGeometry, c: Camera, dpr: number): void {
  const { frame } = input;
  const { sim } = frame;
  const k = c.k;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);

  // Province outlines, in base space.
  ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * c.x, dpr * c.y);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  strokeProvinces(ctx, g, threatenedProvinces(sim, frame.showAll), OVERLAY_COLOURS.threat, 1.5, k, [6, 4]);
  const player = sim.state.player;
  const underAttack = sim.cache.battles.filter((p) => sim.state.provinces[p]!.owner === player);
  if (underAttack.length > 0) {
    const pulse = reducedMotion ? 1 : 0.55 + 0.45 * Math.sin((2 * Math.PI * input.nowMs) / PULSE_MS);
    ctx.globalAlpha = pulse;
    strokeProvinces(ctx, g, underAttack, OVERLAY_COLOURS.attack, 2.5, k, null);
    ctx.globalAlpha = 1;
  }
  if (frame.highlights.length > 0) strokeProvinces(ctx, g, frame.highlights, OVERLAY_COLOURS.highlight, 2, k, null);
  if (frame.hover !== null && frame.hover !== frame.selectedProvince) strokeProvinces(ctx, g, [frame.hover], OVERLAY_COLOURS.hover, 1.5, k, null);
  if (frame.selectedProvince !== null) strokeProvinces(ctx, g, [frame.selectedProvince], OVERLAY_COLOURS.selection, 2.5, k, null);
  if (frame.preview !== null) strokeProvinces(ctx, g, [frame.preview.to], OVERLAY_COLOURS.selection, 2, k, [4, 3]);

  // Everything else, in screen space.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawOwnRoutes(ctx, input, g, c);
  drawPreview(ctx, frame, g, c);
  drawEnemyArrows(ctx, input, g, c);
  drawBattles(ctx, frame, g, c);
  // Least important first, so the selection ends on top.
  for (let i = input.count - 1; i >= 0; i--) drawMarker(ctx, input.markers[i]!, sim, k, frame.coarse);

  if (input.box !== null) {
    const b = input.box;
    ctx.fillStyle = OVERLAY_COLOURS.boxFill;
    ctx.fillRect(b.x, b.y, b.w, b.h);
    ctx.strokeStyle = OVERLAY_COLOURS.box;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(b.x + 0.5, b.y + 0.5, b.w, b.h);
    ctx.setLineDash([]);
  }
  ctx.restore();
}

/** The drag-to-order line from the dragged marker to the pointer (screen space). */
export function drawDragLine(ctx: CanvasRenderingContext2D, from: readonly [number, number], to: readonly [number, number], dpr: number): void {
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.strokeStyle = OVERLAY_COLOURS.route;
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 4]);
  arrow(ctx, from[0], from[1], to[0], to[1]);
  ctx.restore();
}

/** Marker hit radius for the pointer type (§4.7). */
export function hitRadius(coarse: boolean): number {
  return coarse ? RENDER.HIT_RADIUS_COARSE : RENDER.HIT_RADIUS_FINE;
}
