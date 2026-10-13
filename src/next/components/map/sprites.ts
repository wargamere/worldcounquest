/**
 * Army counters as pre-drawn sprites. A counter's look depends only on its
 * nation colour, unit type, size and a few flags, so each variant is painted
 * once into an offscreen canvas (gradient body, top highlight, rim, drop
 * shadow, unit silhouette) and every frame only blits it and writes the unit
 * count on top. That keeps hundreds of markers cheap on a phone.
 */
import type { UnitType } from '@/next/game/types';

/** Room around a sprite for its drop shadow (CSS px). */
export const SPRITE_PAD = 5;

const GOLD = '#f2c14e';
const GOLD_DEEP = '#a8791f';

function parseHex(hex: string): [number, number, number] {
  const v = hex.replace('#', '');
  const n = Number.parseInt(v.length === 3 ? v.replace(/(.)/g, '$1$1') : v, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** `colour` mixed toward white (amount > 0) or black (amount < 0). */
export function shade(colour: string, amount: number): string {
  const [r, g, b] = parseHex(colour);
  const target = amount > 0 ? 255 : 0;
  const t = Math.abs(amount);
  const mix = (c: number): number => Math.round(c + (target - c) * t);
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
}

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * A unit silhouette filling the box (x, y, w, h): a helmeted rifleman, a
 * soldier with an anti-tank tube, a truck, a field gun, a tank.
 */
export function silhouette(ctx: CanvasRenderingContext2D, type: UnitType, x: number, y: number, w: number, h: number): void {
  ctx.beginPath();
  switch (type) {
    case 'rifles': {
      const cx = x + w * 0.5;
      // Helmet with a brim, then shoulders.
      ctx.arc(cx, y + h * 0.36, h * 0.3, Math.PI, 0);
      ctx.rect(cx - h * 0.42, y + h * 0.34, h * 0.84, h * 0.08);
      ctx.moveTo(cx - w * 0.42, y + h);
      ctx.quadraticCurveTo(cx - w * 0.4, y + h * 0.5, cx, y + h * 0.5);
      ctx.quadraticCurveTo(cx + w * 0.4, y + h * 0.5, cx + w * 0.42, y + h);
      ctx.closePath();
      ctx.fill();
      // A rifle slung across.
      ctx.beginPath();
      ctx.moveTo(x + w * 0.1, y + h * 0.95);
      ctx.lineTo(x + w * 0.9, y + h * 0.15);
      ctx.lineWidth = Math.max(1, h * 0.12);
      ctx.stroke();
      return;
    }
    case 'hunters': {
      // A kneeling figure with a launcher tube on the shoulder and its back-blast.
      ctx.arc(x + w * 0.42, y + h * 0.35, h * 0.2, 0, 2 * Math.PI);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(x + w * 0.22, y + h);
      ctx.lineTo(x + w * 0.32, y + h * 0.55);
      ctx.lineTo(x + w * 0.56, y + h * 0.55);
      ctx.lineTo(x + w * 0.64, y + h);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(x + w * 0.05, y + h * 0.62);
      ctx.lineTo(x + w * 0.98, y + h * 0.28);
      ctx.lineWidth = Math.max(1.4, h * 0.2);
      ctx.stroke();
      return;
    }
    case 'motor': {
      // A truck: canvas-covered bed, cab, two wheels.
      roundRectPath(ctx, x, y + h * 0.08, w * 0.6, h * 0.62, h * 0.12);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(x + w * 0.64, y + h * 0.7);
      ctx.lineTo(x + w * 0.64, y + h * 0.28);
      ctx.lineTo(x + w * 0.84, y + h * 0.28);
      ctx.lineTo(x + w, y + h * 0.5);
      ctx.lineTo(x + w, y + h * 0.7);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x + w * 0.2, y + h * 0.82, h * 0.17, 0, 2 * Math.PI);
      ctx.arc(x + w * 0.8, y + h * 0.82, h * 0.17, 0, 2 * Math.PI);
      ctx.fill();
      return;
    }
    case 'guns': {
      // A field gun: long barrel raised, a big wheel, the trail on the ground.
      ctx.moveTo(x + w * 0.4, y + h * 0.62);
      ctx.lineTo(x + w * 0.98, y + h * 0.08);
      ctx.lineWidth = Math.max(1.4, h * 0.2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x + w * 0.42, y + h * 0.66);
      ctx.lineTo(x + w * 0.02, y + h * 0.98);
      ctx.lineWidth = Math.max(1, h * 0.13);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x + w * 0.44, y + h * 0.7, h * 0.28, 0, 2 * Math.PI);
      ctx.fill();
      return;
    }
    case 'tanks': {
      // Tracks, hull, turret and gun.
      roundRectPath(ctx, x, y + h * 0.58, w, h * 0.42, h * 0.2);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(x + w * 0.08, y + h * 0.6);
      ctx.lineTo(x + w * 0.16, y + h * 0.4);
      ctx.lineTo(x + w * 0.86, y + h * 0.4);
      ctx.lineTo(x + w * 0.94, y + h * 0.6);
      ctx.closePath();
      ctx.fill();
      roundRectPath(ctx, x + w * 0.3, y + h * 0.12, w * 0.36, h * 0.32, h * 0.1);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(x + w * 0.6, y + h * 0.26);
      ctx.lineTo(x + w * 1.0, y + h * 0.22);
      ctx.lineWidth = Math.max(1, h * 0.12);
      ctx.stroke();
      return;
    }
  }
}

export interface CounterLook {
  colour: string;
  /** The unit drawn on the counter, or null for a count-only chip. */
  glyph: UnitType | null;
  ours: boolean;
  unsupplied: boolean;
  w: number;
  h: number;
}

/** Left part of a counter given to the silhouette, as a share of its width. */
export const GLYPH_SHARE = 0.46;

const sprites = new Map<string, HTMLCanvasElement | null>();

function paintCounter(look: CounterLook, dpr: number): HTMLCanvasElement | null {
  const { w, h } = look;
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil((w + 2 * SPRITE_PAD) * dpr);
  canvas.height = Math.ceil((h + 2 * SPRITE_PAD) * dpr);
  const ctx = canvas.getContext('2d');
  if (ctx === null) return null;
  ctx.scale(dpr, dpr);
  const x = SPRITE_PAD;
  const y = SPRITE_PAD;
  const r = Math.min(5, h * 0.3);

  // Body with a drop shadow: lit from above, the nation colour deepening downwards.
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
  ctx.shadowBlur = 4;
  ctx.shadowOffsetY = 1.5;
  roundRectPath(ctx, x, y, w, h, r);
  if (look.unsupplied) ctx.fillStyle = 'rgba(8, 12, 22, 0.92)';
  else {
    const body = ctx.createLinearGradient(0, y, 0, y + h);
    body.addColorStop(0, shade(look.colour, 0.28));
    body.addColorStop(0.55, look.colour);
    body.addColorStop(1, shade(look.colour, -0.35));
    ctx.fillStyle = body;
  }
  ctx.fill();
  ctx.restore();

  // A glassy highlight on the upper half.
  ctx.save();
  roundRectPath(ctx, x, y, w, h, r);
  ctx.clip();
  const gloss = ctx.createLinearGradient(0, y, 0, y + h * 0.55);
  gloss.addColorStop(0, 'rgba(255, 255, 255, 0.32)');
  gloss.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = gloss;
  ctx.fillRect(x, y, w, h * 0.55);
  ctx.restore();

  // Rim: gold for the player's own, the nation colour when cut off, a dark edge otherwise.
  roundRectPath(ctx, x + 0.5, y + 0.5, w - 1, h - 1, r);
  if (look.ours) {
    ctx.strokeStyle = GOLD_DEEP;
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.strokeStyle = GOLD;
    ctx.lineWidth = 1.6;
    ctx.stroke();
  } else {
    ctx.strokeStyle = look.unsupplied ? look.colour : 'rgba(3, 6, 12, 0.75)';
    ctx.lineWidth = look.unsupplied ? 2 : 1;
    ctx.stroke();
  }

  if (look.glyph !== null) {
    const gw = w * GLYPH_SHARE - 5;
    const gh = h - 8;
    ctx.save();
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#ffffff';
    ctx.lineCap = 'round';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
    ctx.shadowBlur = 1.5;
    silhouette(ctx, look.glyph, x + 4, y + 4, gw, gh);
    ctx.restore();
    // A faint divider between the silhouette and the count.
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + w * GLYPH_SHARE + 0.5, y + 3);
    ctx.lineTo(x + w * GLYPH_SHARE + 0.5, y + h - 3);
    ctx.stroke();
  }
  return canvas;
}

/** The sprite for `look` at `dpr`, painted on first use; null if canvases are unavailable. */
export function counterSprite(look: CounterLook, dpr: number): HTMLCanvasElement | null {
  const key = `${look.colour}|${look.glyph ?? '-'}|${look.ours ? 1 : 0}|${look.unsupplied ? 1 : 0}|${look.w}x${look.h}|${dpr}`;
  let sprite = sprites.get(key);
  if (sprite === undefined) {
    sprite = paintCounter(look, dpr);
    sprites.set(key, sprite);
  }
  return sprite;
}
