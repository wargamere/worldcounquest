/**
 * Procedural map textures, generated once per canvas context: seamless noise
 * tiles for the ocean and for each terrain class. Terrain tiles are grey
 * around the middle so the 'overlay' blend keeps a nation's colour on average
 * and only adds relief: ridges for mountains, soft swells for hills, dunes for
 * desert, canopy for jungle, a sheen for ice and rooftop speckle for cities.
 *
 * The noise is a seeded, periodic value noise (no Math.random), so the map
 * looks the same on every load and the tiles repeat without seams.
 */
import type { Terrain } from '@/next/game/types';

/** Tile edge in texels. One texel is drawn as one CSS pixel. */
export const TILE = 128;

/** A 32-bit integer hash of a lattice point (deterministic, cheap). */
function hash(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const smooth = (t: number): number => t * t * (3 - 2 * t);

/** Periodic value noise in 0..1 at texel (x, y) on a lattice of `cells` cells per tile. */
function valueNoise(x: number, y: number, cells: number, seed: number): number {
  const fx = (x / TILE) * cells;
  const fy = (y / TILE) * cells;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = smooth(fx - x0);
  const ty = smooth(fy - y0);
  const wrap = (v: number): number => ((v % cells) + cells) % cells;
  const a = hash(wrap(x0), wrap(y0), seed);
  const b = hash(wrap(x0 + 1), wrap(y0), seed);
  const c = hash(wrap(x0), wrap(y0 + 1), seed);
  const d = hash(wrap(x0 + 1), wrap(y0 + 1), seed);
  return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
}

/** Fractal noise: `octaves` layers from `cells` cells, each twice as fine and half as strong. Range ~0..1. */
function fbm(x: number, y: number, cells: number, octaves: number, seed: number): number {
  let sum = 0;
  let weight = 0;
  let amp = 1;
  let c = cells;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise(x, y, c, seed + o * 101);
    weight += amp;
    amp *= 0.5;
    c *= 2;
  }
  return sum / weight;
}

type Shader = (x: number, y: number) => number;

/** Relief per terrain as a signed brightness offset (about -1..1) around mid grey. */
const RELIEF: Readonly<Record<Terrain, { shader: Shader; strength: number }>> = {
  plains: { shader: (x, y) => (fbm(x, y, 3, 4, 11) - 0.5) * 1.6 + (fbm(x, y, 32, 2, 13) - 0.5) * 0.5, strength: 0.2 },
  hills: {
    // Soft swells lit from the north-west: the noise minus a nudged copy of itself.
    shader: (x, y) => (fbm(x, y, 4, 4, 23) - fbm(x + 3, y + 3, 4, 4, 23)) * 7 + (fbm(x, y, 16, 2, 29) - 0.5) * 0.6,
    strength: 0.5,
  },
  mountains: {
    // Ridged noise (sharp crests), lit from the north-west, with scree grain.
    shader: (x, y) => {
      const ridge = (a: number, b: number): number => 1 - Math.abs(fbm(a, b, 4, 4, 37) * 2 - 1);
      return (ridge(x, y) - ridge(x + 2, y + 2)) * 9 + (fbm(x, y, 32, 2, 41) - 0.5) * 0.7;
    },
    strength: 0.75,
  },
  desert: {
    // Wind-blown dunes: wavy bands, plus sand grain.
    shader: (x, y) => Math.sin(((x + y * 0.35) / TILE) * Math.PI * 2 * 6 + fbm(x, y, 4, 3, 53) * 6) * 0.6 + (fbm(x, y, 64, 1, 59) - 0.5) * 0.8,
    strength: 0.32,
  },
  jungle: {
    // Canopy: dense round crowns with dark gaps.
    shader: (x, y) => {
      const crowns = fbm(x, y, 16, 2, 61);
      return (crowns > 0.55 ? 1 : -0.4) * (crowns - 0.35) * 2.2 + (fbm(x, y, 48, 1, 67) - 0.5) * 0.5;
    },
    strength: 0.45,
  },
  arctic: { shader: (x, y) => 0.35 + (fbm(x, y, 4, 3, 71) - 0.5) * 0.8, strength: 0.35 },
  urban: {
    // Built-up land: a dense, fine speckle of rooftops over soft mottling (a street grid read as graph paper on whole regions).
    shader: (x, y) => (hash(x >> 1, y >> 1, 79) - 0.5) * 1.1 + (fbm(x, y, 8, 3, 83) - 0.5) * 0.9,
    strength: 0.3,
  },
};

function tileCanvas(paint: (data: Uint8ClampedArray) => void): HTMLCanvasElement | null {
  const canvas = document.createElement('canvas');
  canvas.width = TILE;
  canvas.height = TILE;
  const ctx = canvas.getContext('2d');
  if (ctx === null) return null;
  const image = ctx.createImageData(TILE, TILE);
  paint(image.data);
  ctx.putImageData(image, 0, 0);
  return canvas;
}

function reliefTile(terrain: Terrain): HTMLCanvasElement | null {
  const { shader, strength } = RELIEF[terrain];
  return tileCanvas((data) => {
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const v = Math.max(-1, Math.min(1, shader(x, y))) * strength;
        const grey = Math.round(128 + v * 127);
        const i = 4 * (y * TILE + x);
        data[i] = grey;
        data[i + 1] = grey;
        data[i + 2] = grey;
        data[i + 3] = 255;
      }
    }
  });
}

/** The ocean: deep blue with slow swells and fine ripples (drawn opaque, under the land). */
function oceanTile(): HTMLCanvasElement | null {
  return tileCanvas((data) => {
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const swell = fbm(x, y, 3, 4, 83);
        const ripple = fbm(x, y, 24, 2, 89);
        const v = (swell - 0.5) * 0.9 + (ripple - 0.5) * 0.35;
        const i = 4 * (y * TILE + x);
        data[i] = Math.round(10 + v * 10);
        data[i + 1] = Math.round(27 + v * 16);
        data[i + 2] = Math.round(52 + v * 26);
        data[i + 3] = 255;
      }
    }
  });
}

export interface MapTextures {
  ocean: CanvasPattern | null;
  relief: Readonly<Record<Terrain, CanvasPattern | null>>;
}

const cache = new WeakMap<CanvasRenderingContext2D, MapTextures>();

/** The textures for `ctx`, built on first use (about 20 ms once). */
export function texturesFor(ctx: CanvasRenderingContext2D): MapTextures {
  const known = cache.get(ctx);
  if (known !== undefined) return known;
  const pattern = (tile: HTMLCanvasElement | null): CanvasPattern | null => (tile === null ? null : ctx.createPattern(tile, 'repeat'));
  const relief = {} as Record<Terrain, CanvasPattern | null>;
  for (const terrain of Object.keys(RELIEF) as Terrain[]) relief[terrain] = pattern(reliefTile(terrain));
  const textures: MapTextures = { ocean: pattern(oceanTile()), relief };
  cache.set(ctx, textures);
  return textures;
}
