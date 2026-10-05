/**
 * Projected map geometry (§9.2), built once per load and DOM-free so it can be
 * tested in Node. The topology is projected with Natural Earth fitted to a
 * fixed RENDER.WORLD_WIDTH x WORLD_HEIGHT base space; the camera only ever
 * scales and translates that space, so nothing is re-projected on resize.
 *
 * Every arc is projected once and shared: province rings are concatenations
 * of arcs (for fills, hit tests and outlines), and the arcs themselves, each
 * tagged with the province on either side, are what borders are built from.
 * Nation and player borders are then a filter over arcs whose two sides have
 * different owners, which is cheap enough to redo on every capture (unlike a
 * topojson mesh).
 */
import { geoGraticule10, geoNaturalEarth1 } from 'd3-geo';
import type { Polygon, MultiPolygon } from 'topojson-specification';
import { RENDER } from '@/next/game/balance';
import { asProvince } from '@/next/game/ids';
import type { MapStatic, ProvinceIx } from '@/next/game/types';
import type { ProvincesTopology } from './mapData';

export interface MapArc {
  readonly coords: Float32Array;
  readonly left: ProvinceIx;
  readonly right: ProvinceIx | null;
  readonly bbox: readonly [number, number, number, number];
}
/**
 * Base-space geometry. `coords` holds x, y pairs; `ringStart` and `ringLength`
 * count points (so ring r's first x is coords[2 * ringStart[r]]). A province's
 * rings are `provinceRingCount[p]` consecutive rings from `provinceRingStart[p]`,
 * without the closing point. `bbox` is x0, y0, x1, y1 per province; `anchor` and
 * `labelAt` are x, y per province; `area` is in base units squared.
 */
export interface MapGeometry {
  readonly width: number;
  readonly height: number;
  readonly coords: Float32Array;
  readonly ringStart: Uint32Array;
  readonly ringLength: Uint32Array;
  readonly provinceRingStart: Uint32Array;
  readonly provinceRingCount: Uint16Array;
  readonly bbox: Float32Array;
  readonly anchor: Float32Array;
  readonly labelAt: Float32Array;
  readonly area: Float32Array;
  readonly arcs: readonly MapArc[];
  readonly sphere: Float32Array;
  readonly graticule: readonly Float32Array[];
}

type Project = (lon: number, lat: number) => [number, number];

/**
 * Exactly ±180° can come out of dequantisation a hair beyond π, which d3's
 * rotation wraps to the far edge of the map: a streak across the world. The
 * data never crosses the antimeridian, so pulling the edge in is exact enough.
 */
const EDGE_LON = 180 - 1e-7;

function makeProjection(): Project {
  const projection = geoNaturalEarth1().fitSize([RENDER.WORLD_WIDTH, RENDER.WORLD_HEIGHT], { type: 'Sphere' });
  return (lon, lat) => {
    const out = projection([Math.max(-EDGE_LON, Math.min(EDGE_LON, lon)), lat]);
    if (out === null) throw new Error(`Could not project ${lon}, ${lat}`);
    return out;
  };
}

/** Dequantises and projects every arc once. */
function projectArcs(topology: ProvincesTopology, project: Project): Float32Array[] {
  const scale = topology.transform?.scale ?? [1, 1];
  const translate = topology.transform?.translate ?? [0, 0];
  const quantised = topology.transform !== undefined;
  return topology.arcs.map((arc) => {
    const out = new Float32Array(arc.length * 2);
    let x = 0;
    let y = 0;
    arc.forEach((position, i) => {
      const px = position[0] ?? 0;
      const py = position[1] ?? 0;
      x = quantised ? x + px : px;
      y = quantised ? y + py : py;
      const [bx, by] = project(x * scale[0] + translate[0], y * scale[1] + translate[1]);
      out[2 * i] = bx;
      out[2 * i + 1] = by;
    });
    return out;
  });
}

type Rings = number[][];

/** The polygons (each a list of rings of arc indexes) of a province geometry. */
function polygonsOf(geometry: Polygon<{ id: string }> | MultiPolygon<{ id: string }>): Rings[] {
  return geometry.type === 'Polygon' ? [geometry.arcs] : geometry.arcs;
}

function geometriesByProvince(topology: ProvincesTopology, map: MapStatic): (Polygon<{ id: string }> | MultiPolygon<{ id: string }>)[] {
  const out: (Polygon<{ id: string }> | MultiPolygon<{ id: string }>)[] = new Array(map.provinces.length);
  for (const geometry of topology.objects.provinces.geometries) {
    if (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon') continue;
    const ix = map.provinceById.get(String(geometry.id));
    if (ix === undefined) throw new Error(`provinces.json has a province the facts do not know: ${String(geometry.id)}`);
    out[ix] = geometry;
  }
  map.provinces.forEach((p) => {
    if (out[p.ix] === undefined) throw new Error(`provinces.json has no outline for province ${p.id}`);
  });
  return out;
}

/**
 * The province on each side of every arc. The province whose ring runs the arc
 * forwards is `left`; the one running it backwards is `right`, or null on a
 * coastline. If both run it the same way (bad winding) the lower index is left.
 */
export function arcSides(topology: ProvincesTopology, map: MapStatic): readonly { left: ProvinceIx; right: ProvinceIx | null }[] {
  const refs: { p: ProvinceIx; forward: boolean }[][] = topology.arcs.map(() => []);
  geometriesByProvince(topology, map).forEach((geometry, ix) => {
    for (const polygon of polygonsOf(geometry)) {
      for (const ring of polygon) {
        for (const index of ring) {
          const arc = index < 0 ? ~index : index;
          const list = refs[arc];
          if (list === undefined) throw new Error(`Province ${map.provinces[ix]?.id ?? ix} uses arc ${arc}, which does not exist`);
          if (!list.some((r) => r.p === ix)) list.push({ p: asProvince(ix), forward: index >= 0 });
        }
      }
    }
  });
  return refs.map((list, arc) => {
    list.sort((a, b) => (a.forward === b.forward ? a.p - b.p : a.forward ? -1 : 1));
    const left = list[0];
    if (left === undefined) throw new Error(`Arc ${arc} borders no province`);
    return { left: left.p, right: list[1]?.p ?? null };
  });
}

// ------------------------------------------------------------ ring maths

/** Even-odd point-in-rings over `count` consecutive rings from `first`. */
export function ringsContain(coords: Float32Array, ringStart: Uint32Array, ringLength: Uint32Array, first: number, count: number, x: number, y: number): boolean {
  let inside = false;
  for (let r = first; r < first + count; r++) {
    const start = ringStart[r]!;
    const length = ringLength[r]!;
    let j = start + length - 1;
    for (let i = start; i < start + length; i++) {
      const xi = coords[2 * i]!;
      const yi = coords[2 * i + 1]!;
      const xj = coords[2 * j]!;
      const yj = coords[2 * j + 1]!;
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      j = i;
    }
  }
  return inside;
}

/** Signed shoelace area and centroid of one ring. */
function ringMoments(points: readonly number[]): { area: number; cx: number; cy: number } {
  let a = 0;
  let cx = 0;
  let cy = 0;
  const n = points.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i, i++) {
    const xi = points[2 * i]!;
    const yi = points[2 * i + 1]!;
    const xj = points[2 * j]!;
    const yj = points[2 * j + 1]!;
    const cross = xj * yi - xi * yj;
    a += cross;
    cx += (xj + xi) * cross;
    cy += (yj + yi) * cross;
  }
  a /= 2;
  if (a === 0) return { area: 0, cx: points[0] ?? 0, cy: points[1] ?? 0 };
  return { area: a, cx: cx / (6 * a), cy: cy / (6 * a) };
}

/** Squared distance from (x, y) to the nearest edge of a province's rings. */
function boundaryDistance2(coords: Float32Array, ringStart: Uint32Array, ringLength: Uint32Array, first: number, count: number, x: number, y: number): number {
  let best = Infinity;
  for (let r = first; r < first + count; r++) {
    const start = ringStart[r]!;
    const length = ringLength[r]!;
    let j = start + length - 1;
    for (let i = start; i < start + length; i++) {
      const ax = coords[2 * j]!;
      const ay = coords[2 * j + 1]!;
      const dx = coords[2 * i]! - ax;
      const dy = coords[2 * i + 1]! - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2));
      const ex = ax + t * dx - x;
      const ey = ay + t * dy - y;
      best = Math.min(best, ex * ex + ey * ey);
      j = i;
    }
  }
  return best;
}

/** Grid steps per side when neither the centroid nor the anchor lies inside. */
const LABEL_GRID = 9;

// ------------------------------------------------------------- the build

/** Projects the topology for `map` (ProvinceIx order); throws if the two files disagree. */
export function buildGeometry(topology: ProvincesTopology, map: MapStatic): MapGeometry {
  const project = makeProjection();
  const projected = projectArcs(topology, project);
  const geometries = geometriesByProvince(topology, map);
  const count = map.provinces.length;

  const points: number[] = [];
  const ringStarts: number[] = [];
  const ringLengths: number[] = [];
  const provinceRingStart = new Uint32Array(count);
  const provinceRingCount = new Uint16Array(count);
  const bbox = new Float32Array(count * 4);
  const anchor = new Float32Array(count * 2);
  const labelAt = new Float32Array(count * 2);
  const area = new Float32Array(count);
  /** Per province: the largest exterior ring's centroid and bbox, for the label point. */
  const largest: { area: number; cx: number; cy: number; box: [number, number, number, number] }[] = [];

  geometries.forEach((geometry, ix) => {
    provinceRingStart[ix] = ringStarts.length;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    let total = 0;
    let best = { area: -1, cx: 0, cy: 0, box: [0, 0, 0, 0] as [number, number, number, number] };
    for (const polygon of polygonsOf(geometry)) {
      polygon.forEach((ring, ringIndex) => {
        const ringPoints: number[] = [];
        ring.forEach((index, k) => {
          const arc = projected[index < 0 ? ~index : index]!;
          const n = arc.length / 2;
          // Consecutive arcs share their joining point; keep it once.
          for (let s = k === 0 ? 0 : 1; s < n; s++) {
            const at = index < 0 ? n - 1 - s : s;
            ringPoints.push(arc[2 * at]!, arc[2 * at + 1]!);
          }
        });
        const n = ringPoints.length / 2;
        if (n > 1 && ringPoints[0] === ringPoints[2 * n - 2] && ringPoints[1] === ringPoints[2 * n - 1]) ringPoints.length -= 2;
        if (ringPoints.length < 6) return;
        ringStarts.push(points.length / 2);
        ringLengths.push(ringPoints.length / 2);
        let rx0 = Infinity;
        let ry0 = Infinity;
        let rx1 = -Infinity;
        let ry1 = -Infinity;
        for (let i = 0; i < ringPoints.length; i += 2) {
          const x = ringPoints[i]!;
          const y = ringPoints[i + 1]!;
          points.push(x, y);
          rx0 = Math.min(rx0, x);
          ry0 = Math.min(ry0, y);
          rx1 = Math.max(rx1, x);
          ry1 = Math.max(ry1, y);
        }
        x0 = Math.min(x0, rx0);
        y0 = Math.min(y0, ry0);
        x1 = Math.max(x1, rx1);
        y1 = Math.max(y1, ry1);
        const moments = ringMoments(ringPoints);
        const size = Math.abs(moments.area);
        // Ring 0 of a polygon is its exterior; later rings are holes.
        total += ringIndex === 0 ? size : -size;
        if (ringIndex === 0 && size > best.area) best = { area: size, cx: moments.cx, cy: moments.cy, box: [rx0, ry0, rx1, ry1] };
      });
    }
    provinceRingCount[ix] = ringStarts.length - provinceRingStart[ix]!;
    if (provinceRingCount[ix] === 0) throw new Error(`Province ${map.provinces[ix]!.id} has no drawable ring`);
    bbox.set([x0, y0, x1, y1], ix * 4);
    area[ix] = Math.max(0, total);
    const [ax, ay] = project(map.provinces[ix]!.anchor[0], map.provinces[ix]!.anchor[1]);
    anchor[2 * ix] = ax;
    anchor[2 * ix + 1] = ay;
    largest.push(best);
  });

  const coords = new Float32Array(points);
  const ringStart = new Uint32Array(ringStarts);
  const ringLength = new Uint32Array(ringLengths);
  const inside = (ix: number, x: number, y: number): boolean =>
    ringsContain(coords, ringStart, ringLength, provinceRingStart[ix]!, provinceRingCount[ix]!, x, y);

  // Labels sit at the centroid of the largest polygon, which reads better than
  // the city anchor; when that falls outside (a crescent), the anchor, and
  // failing both the grid point farthest from the boundary.
  largest.forEach((best, ix) => {
    const candidates: [number, number][] = [
      [best.cx, best.cy],
      [anchor[2 * ix]!, anchor[2 * ix + 1]!],
    ];
    let chosen = candidates.find(([x, y]) => inside(ix, x, y));
    if (chosen === undefined) {
      let bestDistance = -1;
      const [bx0, by0, bx1, by1] = best.box;
      for (let i = 0; i < LABEL_GRID; i++) {
        for (let j = 0; j < LABEL_GRID; j++) {
          const x = bx0 + ((i + 0.5) / LABEL_GRID) * (bx1 - bx0);
          const y = by0 + ((j + 0.5) / LABEL_GRID) * (by1 - by0);
          if (!inside(ix, x, y)) continue;
          const d = boundaryDistance2(coords, ringStart, ringLength, provinceRingStart[ix]!, provinceRingCount[ix]!, x, y);
          if (d > bestDistance) {
            bestDistance = d;
            chosen = [x, y];
          }
        }
      }
    }
    const [lx, ly] = chosen ?? candidates[1]!;
    labelAt[2 * ix] = lx;
    labelAt[2 * ix + 1] = ly;
  });

  const sides = arcSides(topology, map);
  const arcs: MapArc[] = projected.map((arcCoords, i) => {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let k = 0; k < arcCoords.length; k += 2) {
      x0 = Math.min(x0, arcCoords[k]!);
      x1 = Math.max(x1, arcCoords[k]!);
      y0 = Math.min(y0, arcCoords[k + 1]!);
      y1 = Math.max(y1, arcCoords[k + 1]!);
    }
    const side = sides[i]!;
    return { coords: arcCoords, left: side.left, right: side.right, bbox: [x0, y0, x1, y1] };
  });

  return {
    width: RENDER.WORLD_WIDTH,
    height: RENDER.WORLD_HEIGHT,
    coords,
    ringStart,
    ringLength,
    provinceRingStart,
    provinceRingCount,
    bbox,
    anchor,
    labelAt,
    area,
    arcs,
    sphere: sphereOutline(project),
    graticule: geoGraticule10().coordinates.map((line) => {
      const out = new Float32Array(line.length * 2);
      line.forEach((position, i) => {
        const [x, y] = project(position[0] ?? 0, position[1] ?? 0);
        out[2 * i] = x;
        out[2 * i + 1] = y;
      });
      return out;
    }),
  };
}

/** The projected globe's outline: the ±180° meridians, one point per degree. */
function sphereOutline(project: Project): Float32Array {
  const out: number[] = [];
  for (let lat = 90; lat >= -90; lat--) out.push(...project(180, lat));
  for (let lat = -90; lat <= 90; lat++) out.push(...project(-180, lat));
  return new Float32Array(out);
}

// ----------------------------------------------------------- border filters

/** An arc between provinces of two different owners (`owners` by ProvinceIx). */
export function isNationBorder(arc: MapArc, owners: ArrayLike<number>): boolean {
  return arc.right !== null && arc.right !== arc.left && owners[arc.left] !== owners[arc.right];
}

/** An arc with the player's land on exactly one side, coastlines included. */
export function isPlayerBorder(arc: MapArc, owners: ArrayLike<number>, player: number): boolean {
  const left = owners[arc.left] === player;
  const right = arc.right !== null && owners[arc.right] === player;
  return left !== right;
}

/** An arc between two different provinces (the internal border mesh). */
export function isProvinceBorder(arc: MapArc): boolean {
  return arc.right !== null && arc.right !== arc.left;
}

/** The base-space bounds of a set of provinces, or null for none. */
export function boundsOf(g: MapGeometry, provinces: readonly ProvinceIx[]): [number, number, number, number] | null {
  if (provinces.length === 0) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of provinces) {
    x0 = Math.min(x0, g.bbox[4 * p]!);
    y0 = Math.min(y0, g.bbox[4 * p + 1]!);
    x1 = Math.max(x1, g.bbox[4 * p + 2]!);
    y1 = Math.max(y1, g.bbox[4 * p + 3]!);
  }
  return [x0, y0, x1, y1];
}
