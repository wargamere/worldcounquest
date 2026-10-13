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
import type { Army, ProvinceIx, Sim } from '@/next/game/types';
import type { MapGeometry } from '@/next/lib/geometry';
import { toScreen } from './camera';
import { threatenedProvinces } from './derived';
import type { Rect } from './drawBase';
import { armyBasePosition, chipSize, DOT_PX, markerLod, type Marker } from './markers';
import { provincePathsFor } from './paths';
import { counterSprite, GLYPH_SHARE, shade, SPRITE_PAD } from './sprites';
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
  chipHalo: 'rgba(3, 6, 12, 0.78)',
  hollow: 'rgba(5, 8, 15, 0.85)',
  etaChip: 'rgba(15, 23, 42, 0.92)',
  box: 'rgba(255, 255, 255, 0.85)',
  boxFill: 'rgba(255, 255, 255, 0.08)',
  healthGood: '#4ade80',
  healthMid: '#facc15',
  healthLow: '#f87171',
  selectionGlow: 'rgba(255, 255, 255, 0.9)',
  routeGlow: 'rgba(255, 255, 255, 0.13)',
  attackRoute: '#fca5a5',
  threatGlow: 'rgba(239, 68, 68, 0.25)',
  battleGlyph: '#fde68a',
  hoverFill: 'rgba(255, 255, 255, 0.08)',
  selectedFill: 'rgba(255, 255, 255, 0.12)',
  attackFill: 'rgba(239, 68, 68, 0.22)',
  previewFill: 'rgba(255, 255, 255, 0.1)',
} as const;

/** Breathing period of the selection halo (ms). */
const SELECT_PULSE_MS = 1600;

/** Pulse period of provinces under attack (ms); reduce motion holds it steady. */
const PULSE_MS = 1200;
const BATTLE_RING_PX = 9;
/** Sparks orbiting a battle ring. */
const BATTLE_SPARKS = 5;
/** Marching routes move one dash pixel per this many ms. */
const ROUTE_FLOW_MS_PER_PX = 45;
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

function fillProvinces(ctx: CanvasRenderingContext2D, g: MapGeometry, provinces: Iterable<ProvinceIx>, colour: string): void {
  const paths = provincePathsFor(g);
  ctx.fillStyle = colour;
  for (const p of provinces) ctx.fill(paths[p]!);
}

/** Dash offset for marching routes: they flow toward their destination; still under reduce motion. */
function march(nowMs: number): number {
  return reducedMotion ? 0 : -(nowMs / ROUTE_FLOW_MS_PER_PX) % 1000;
}

/** A battle is shown when it involves the player, lies in the player's vision, or "Show all armies" is on. */
function battleVisible(sim: Sim, p: ProvinceIx, showAll: boolean): boolean {
  if (showAll || sim.cache.vision[p] === 1) return true;
  const player = sim.state.player;
  return sim.state.provinces[p]!.owner === player || armiesAt(sim, p).some((a) => a.owner === player);
}

// ------------------------------------------------------------ routes

/** Traces a route as one polyline (not stroked); returns the last segment for an arrowhead. */
function tracePath(ctx: CanvasRenderingContext2D, c: Camera, g: MapGeometry, start: readonly [number, number], nodes: readonly ProvinceIx[]): [number, number, number, number] {
  ctx.beginPath();
  let [px, py] = toScreen(c, start[0], start[1]);
  let [lx, ly] = [px, py];
  ctx.moveTo(px, py);
  for (const p of nodes) {
    lx = px;
    ly = py;
    [px, py] = toScreen(c, g.anchor[2 * p]!, g.anchor[2 * p + 1]!);
    ctx.lineTo(px, py);
  }
  return [lx, ly, px, py];
}

/** A route: a soft glow under a dashed line marching toward the destination, with a filled head at the end. */
function routeTo(ctx: CanvasRenderingContext2D, c: Camera, g: MapGeometry, start: readonly [number, number], nodes: readonly ProvinceIx[], colour: string, width: number, nowMs: number, head: boolean): void {
  const [x0, y0, x1, y1] = tracePath(ctx, c, g, start, nodes);
  ctx.setLineDash([]);
  ctx.strokeStyle = OVERLAY_COLOURS.routeGlow;
  ctx.lineWidth = width + 4;
  ctx.stroke();
  ctx.setLineDash([6, 5]);
  ctx.lineDashOffset = march(nowMs);
  ctx.strokeStyle = colour;
  ctx.lineWidth = width;
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.lineDashOffset = 0;
  if (head) arrowHead(ctx, x0, y0, x1, y1, colour, width * 3 + 3);
}

/** A filled arrowhead at (x1, y1) pointing along the segment from (x0, y0). */
function arrowHead(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, colour: string, size: number): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const length = Math.sqrt(dx * dx + dy * dy);
  if (length < 1) return;
  const ux = dx / length;
  const uy = dy / length;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 - size * (ux - 0.55 * uy), y1 - size * (uy + 0.55 * ux));
  ctx.lineTo(x1 - size * 0.7 * ux, y1 - size * 0.7 * uy);
  ctx.lineTo(x1 - size * (ux + 0.55 * uy), y1 - size * (uy - 0.55 * ux));
  ctx.closePath();
  ctx.fillStyle = colour;
  ctx.strokeStyle = OVERLAY_COLOURS.chipHalo;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fill();
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
  for (let i = 0; i < input.count; i++) {
    const m = input.markers[i]!;
    if (!m.ours) continue;
    for (const id of m.armies) {
      const army = armyById(sim, id);
      if (army === undefined || !army.alive || (army.leg === null && army.path.length === 0)) continue;
      const selected = frame.selectedArmies.has(id);
      const nodes = army.leg === null ? army.path : [army.leg.to, ...army.path];
      const attack = army.intent === 'attack';
      const colour = attack ? OVERLAY_COLOURS.attackRoute : selected ? OVERLAY_COLOURS.route : OVERLAY_COLOURS.ownRoute;
      routeTo(ctx, c, g, armyBasePosition(g, army, frame.alpha), nodes, colour, selected ? 2 : 1.5, input.nowMs, true);
      if (!selected) continue;
      const eta = etaTicks(sim, army);
      const end = finalNode(army);
      if (eta === null || end === null) continue;
      const [x, y] = toScreen(c, g.anchor[2 * end]!, g.anchor[2 * end + 1]!);
      etaChip(ctx, formatDuration(eta), x, y);
    }
  }
}

/** The order preview: dashed white routes, red through hostile land before the target, and the arrival chip. */
function drawPreview(ctx: CanvasRenderingContext2D, frame: MapFrame, g: MapGeometry, c: Camera, nowMs: number): void {
  const preview = frame.preview;
  if (preview === null) return;
  const { sim } = frame;
  const player = sim.state.player;
  for (const route of preview.routes) {
    const army = armyById(sim, route.army);
    if (army === undefined) continue;
    tracePath(ctx, c, g, armyBasePosition(g, army, frame.alpha), route.nodes);
    ctx.strokeStyle = OVERLAY_COLOURS.routeGlow;
    ctx.lineWidth = 7;
    ctx.stroke();
  }
  ctx.lineWidth = 2.5;
  ctx.setLineDash([7, 5]);
  ctx.lineDashOffset = march(nowMs);
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
  ctx.lineDashOffset = 0;
  const [tx, ty] = toScreen(c, g.anchor[2 * preview.to]!, g.anchor[2 * preview.to + 1]!);
  for (const route of preview.routes) {
    const last = route.nodes[route.nodes.length - 1];
    const before = route.nodes[route.nodes.length - 2];
    const army = armyById(sim, route.army);
    if (last === undefined || army === undefined) continue;
    const [bx, by] = before === undefined ? armyBasePosition(g, army, frame.alpha) : [g.anchor[2 * before]!, g.anchor[2 * before + 1]!];
    const [sx, sy] = toScreen(c, bx, by);
    arrowHead(ctx, sx, sy, tx, ty, preview.intent === 'attack' ? OVERLAY_COLOURS.attackRoute : OVERLAY_COLOURS.route, 11);
  }
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
    const colour = toYou ? OVERLAY_COLOURS.enemyArrowToYou : OVERLAY_COLOURS.enemyArrow;
    const [x1, y1] = toScreen(c, g.anchor[2 * army.leg.to]!, g.anchor[2 * army.leg.to + 1]!);
    if (toYou) {
      ctx.strokeStyle = OVERLAY_COLOURS.threatGlow;
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.moveTo(m.x, m.y);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }
    ctx.strokeStyle = colour;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(m.x, m.y);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    arrowHead(ctx, m.x, m.y, x1, y1, colour, 9);
  }
}

// ------------------------------------------------------------ battles

/** Two crossed swords centred on (x, y), blades `r` long. */
function swords(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  for (const dir of [1, -1]) {
    const bx = x - dir * r * 0.7;
    const by = y + r * 0.7;
    const tx = x + dir * r * 0.7;
    const ty = y - r * 0.7;
    // Blade.
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(tx, ty);
    ctx.lineWidth = 1.8;
    ctx.stroke();
    // Cross-guard, square to the blade near the hilt.
    const gx = x - dir * r * 0.38;
    const gy = y + r * 0.38;
    ctx.beginPath();
    ctx.moveTo(gx - r * 0.25, gy - dir * r * 0.25);
    ctx.lineTo(gx + r * 0.25, gy + dir * r * 0.25);
    ctx.lineWidth = 1.4;
    ctx.stroke();
  }
}

/**
 * A battle: a flickering fire glow, a ring split by HP share (the defender's
 * colour clockwise from the top, the strongest attacker's for the rest) with
 * sparks orbiting it, and crossed swords on a dark disc.
 */
function drawBattles(ctx: CanvasRenderingContext2D, frame: MapFrame, g: MapGeometry, c: Camera, nowMs: number): void {
  const { sim } = frame;
  const { h } = chipSize(frame.coarse, markerLod(c.k));
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
    // Each battle flickers on its own phase, so a front does not pulse in lockstep.
    const phase = nowMs / 180 + p * 1.7;
    const flicker = reducedMotion ? 0.8 : 0.7 + 0.3 * Math.sin(phase) * Math.sin(phase * 0.37 + 1);
    const fire = ctx.createRadialGradient(x, y, 2, x, y, BATTLE_RING_PX * 2.6);
    fire.addColorStop(0, `rgba(255, 196, 92, ${(0.55 * flicker).toFixed(3)})`);
    fire.addColorStop(0.45, `rgba(239, 68, 68, ${(0.28 * flicker).toFixed(3)})`);
    fire.addColorStop(1, 'rgba(239, 68, 68, 0)');
    ctx.fillStyle = fire;
    ctx.beginPath();
    ctx.arc(x, y, BATTLE_RING_PX * 2.6, 0, 2 * Math.PI);
    ctx.fill();

    const top = -Math.PI / 2;
    ctx.lineWidth = 6;
    ctx.strokeStyle = OVERLAY_COLOURS.hollow;
    ctx.beginPath();
    ctx.arc(x, y, BATTLE_RING_PX, 0, 2 * Math.PI);
    ctx.stroke();
    ctx.lineWidth = 3.5;
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
    ctx.arc(x, y, BATTLE_RING_PX - 1.8, 0, 2 * Math.PI);
    ctx.fill();
    ctx.strokeStyle = OVERLAY_COLOURS.battleGlyph;
    ctx.lineCap = 'round';
    swords(ctx, x, y, BATTLE_RING_PX * 0.62);

    if (!reducedMotion) {
      // Sparks circling the ring.
      for (let i = 0; i < BATTLE_SPARKS; i++) {
        const angle = nowMs / 520 + (i * 2 * Math.PI) / BATTLE_SPARKS + p;
        const radius = BATTLE_RING_PX + 4 + 1.5 * Math.sin(nowMs / 140 + i * 2.1);
        const alpha = 0.45 + 0.55 * Math.abs(Math.sin(nowMs / 230 + i));
        ctx.fillStyle = `rgba(255, 214, 120, ${alpha.toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(x + radius * Math.cos(angle), y + radius * Math.sin(angle), 1.3, 0, 2 * Math.PI);
        ctx.fill();
      }
    }
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

/** Health bar colour: green, amber below two thirds, red below a third. */
function healthColour(share: number): string {
  if (share >= 2 / 3) return OVERLAY_COLOURS.healthGood;
  return share >= 1 / 3 ? OVERLAY_COLOURS.healthMid : OVERLAY_COLOURS.healthLow;
}

/** A moving army at world zoom: a lit bead in its nation colour. */
function drawDot(ctx: CanvasRenderingContext2D, m: Marker, colour: string): void {
  const r = DOT_PX / 2 + (m.selected ? 1.5 : 0.8);
  const bead = ctx.createRadialGradient(m.x - r * 0.35, m.y - r * 0.35, 0, m.x, m.y, r);
  bead.addColorStop(0, shade(colour, 0.45));
  bead.addColorStop(1, shade(colour, -0.2));
  ctx.beginPath();
  ctx.arc(m.x, m.y, r, 0, 2 * Math.PI);
  ctx.fillStyle = bead;
  ctx.fill();
  ctx.strokeStyle = m.selected ? OVERLAY_COLOURS.selection : m.ours ? PLAYER_COLOUR : 'rgba(3, 6, 12, 0.7)';
  ctx.lineWidth = m.ours || m.selected ? 1.2 : 0.8;
  ctx.stroke();
}

function drawMarker(ctx: CanvasRenderingContext2D, m: Marker, sim: Sim, k: number, coarse: boolean, dpr: number, nowMs: number): void {
  const colour = sim.state.nations[m.nation]!.colour;
  const lod = markerLod(k);
  if (m.moving && lod === 'aggregate') {
    drawDot(ctx, m, colour);
    return;
  }
  const { w, h } = chipSize(coarse, lod);
  const x = m.x - w / 2;
  const y = m.y - h / 2;
  const glyph = lod === 'glyphs' && m.armies.length === 1 ? m.glyph : null;
  if (m.selected) {
    // A breathing white halo around the selection.
    const pulse = reducedMotion ? 1 : 0.65 + 0.35 * Math.sin((2 * Math.PI * nowMs) / SELECT_PULSE_MS);
    ctx.save();
    ctx.shadowColor = OVERLAY_COLOURS.selectionGlow;
    ctx.shadowBlur = 10 * pulse;
    roundRect(ctx, x - 3, y - 3, w + 6, h + 6, 7);
    ctx.strokeStyle = OVERLAY_COLOURS.selection;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }
  const sprite = counterSprite({ colour, glyph, ours: m.ours, unsupplied: m.unsupplied, w, h }, dpr);
  if (sprite !== null) ctx.drawImage(sprite, x - SPRITE_PAD, y - SPRITE_PAD, w + 2 * SPRITE_PAD, h + 2 * SPRITE_PAD);
  else {
    roundRect(ctx, x, y, w, h, 4);
    ctx.fillStyle = colour;
    ctx.fill();
  }
  // At chip zoom a chip holding several armies is the fan's "+N".
  const text = lod !== 'aggregate' && m.armies.length > 1 ? `+${m.armies.length}` : String(m.units);
  ctx.font = `800 ${coarse ? 12 : 11}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = OVERLAY_COLOURS.chipHalo;
  ctx.fillStyle = OVERLAY_COLOURS.chipText;
  ctx.lineWidth = 3;
  const tx = glyph === null ? m.x : x + w * GLYPH_SHARE + (w * (1 - GLYPH_SHARE)) / 2;
  ctx.strokeText(text, tx, m.y + 0.5);
  ctx.fillText(text, tx, m.y + 0.5);
  if (glyph !== null) {
    // Health bar under the counter.
    const barY = y + h + 2.5;
    roundRect(ctx, x + 1, barY, w - 2, 3.5, 1.75);
    ctx.fillStyle = OVERLAY_COLOURS.chipHalo;
    ctx.fill();
    if (m.hpShare > 0) {
      roundRect(ctx, x + 1, barY, Math.max(3.5, (w - 2) * m.hpShare), 3.5, 1.75);
      ctx.fillStyle = healthColour(m.hpShare);
      ctx.fill();
    }
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
    fillProvinces(ctx, g, underAttack, OVERLAY_COLOURS.attackFill);
    strokeProvinces(ctx, g, underAttack, OVERLAY_COLOURS.attack, 2.5, k, null);
    ctx.globalAlpha = 1;
  }
  if (frame.highlights.length > 0) strokeProvinces(ctx, g, frame.highlights, OVERLAY_COLOURS.highlight, 2, k, null);
  if (frame.hover !== null && frame.hover !== frame.selectedProvince) {
    fillProvinces(ctx, g, [frame.hover], OVERLAY_COLOURS.hoverFill);
    strokeProvinces(ctx, g, [frame.hover], OVERLAY_COLOURS.hover, 1.5, k, null);
  }
  if (frame.selectedProvince !== null) {
    fillProvinces(ctx, g, [frame.selectedProvince], OVERLAY_COLOURS.selectedFill);
    ctx.save();
    ctx.shadowColor = OVERLAY_COLOURS.selectionGlow;
    ctx.shadowBlur = 8;
    strokeProvinces(ctx, g, [frame.selectedProvince], OVERLAY_COLOURS.selection, 2.5, k, null);
    ctx.restore();
  }
  if (frame.preview !== null) {
    fillProvinces(ctx, g, [frame.preview.to], frame.preview.intent === 'attack' ? OVERLAY_COLOURS.attackFill : OVERLAY_COLOURS.previewFill);
    strokeProvinces(ctx, g, [frame.preview.to], OVERLAY_COLOURS.selection, 2, k, [4, 3]);
  }

  // Everything else, in screen space.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawOwnRoutes(ctx, input, g, c);
  drawPreview(ctx, frame, g, c, input.nowMs);
  drawEnemyArrows(ctx, input, g, c);
  drawBattles(ctx, frame, g, c, input.nowMs);
  // Least important first, so the selection ends on top.
  for (let i = input.count - 1; i >= 0; i--) drawMarker(ctx, input.markers[i]!, sim, k, frame.coarse, dpr, input.nowMs);

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
