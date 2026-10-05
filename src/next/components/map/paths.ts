/**
 * Path2D builders for the canvas map (§9.2, §9.3). Province paths, the
 * internal border mesh and sea links are built once per load; nation and
 * player borders are an arc filter rebuilt per ownership change, and the
 * low-zoom fills are one solid and one hatched path per colour, rebuilt only
 * for the colours whose provinces changed.
 */
import type { MapStatic } from '@/next/game/types';
import type { MapArc, MapGeometry } from '@/next/lib/geometry';

const provincePathCache = new WeakMap<MapGeometry, Path2D[]>();

/** The province paths of `g`, built on first use and shared by both layers. */
export function provincePathsFor(g: MapGeometry): readonly Path2D[] {
  let paths = provincePathCache.get(g);
  if (paths === undefined) {
    paths = buildProvincePaths(g);
    provincePathCache.set(g, paths);
  }
  return paths;
}

/** One closed Path2D per province, in ProvinceIx order. */
export function buildProvincePaths(g: MapGeometry): Path2D[] {
  const count = g.provinceRingStart.length;
  const out: Path2D[] = new Array<Path2D>(count);
  for (let p = 0; p < count; p++) {
    const path = new Path2D();
    const first = g.provinceRingStart[p]!;
    for (let r = first; r < first + g.provinceRingCount[p]!; r++) {
      const start = g.ringStart[r]!;
      const length = g.ringLength[r]!;
      path.moveTo(g.coords[2 * start]!, g.coords[2 * start + 1]!);
      for (let i = start + 1; i < start + length; i++) path.lineTo(g.coords[2 * i]!, g.coords[2 * i + 1]!);
      path.closePath();
    }
    out[p] = path;
  }
  return out;
}

/** One open polyline per included arc. */
export function buildArcPath(g: MapGeometry, include: (arc: MapArc) => boolean): Path2D {
  const path = new Path2D();
  for (const arc of g.arcs) {
    if (!include(arc)) continue;
    const c = arc.coords;
    path.moveTo(c[0]!, c[1]!);
    for (let i = 2; i < c.length; i += 2) path.lineTo(c[i]!, c[i + 1]!);
  }
  return path;
}

/**
 * Straight anchor-to-anchor segments for every sea link, each once. A link
 * that would cross more than half the map (across the antimeridian) is drawn
 * as two stubs running off either edge instead of a streak across the world.
 */
export function buildSeaLinkPath(map: MapStatic, g: MapGeometry): Path2D {
  const path = new Path2D();
  map.edges.forEach((edges, from) => {
    for (const e of edges) {
      if (!e.sea || e.to < from) continue;
      const x0 = g.anchor[2 * from]!;
      const y0 = g.anchor[2 * from + 1]!;
      const x1 = g.anchor[2 * e.to]!;
      const y1 = g.anchor[2 * e.to + 1]!;
      if (Math.abs(x1 - x0) <= g.width / 2) {
        path.moveTo(x0, y0);
        path.lineTo(x1, y1);
        continue;
      }
      // Wrap the far end by one map width so the segment takes the short way round.
      const wrapped = x1 > x0 ? x1 - g.width : x1 + g.width;
      path.moveTo(x0, y0);
      path.lineTo(wrapped, y1);
      path.moveTo(x1, y1);
      path.lineTo(x0 + (x1 > x0 ? g.width : -g.width), y0);
    }
  });
  return path;
}

export interface ColourBatch {
  solid: Path2D;
  hatched: Path2D;
}

function fillBatch(batch: ColourBatch, colour: string, paths: readonly Path2D[], fills: readonly string[], hatched: readonly boolean[]): void {
  for (let p = 0; p < fills.length; p++) {
    if (fills[p] !== colour) continue;
    (hatched[p] === true ? batch.hatched : batch.solid).addPath(paths[p]!);
  }
}

/** One solid and one hatched path per fill colour (about 16 fills a frame at world zoom). */
export function colourBatches(
  g: MapGeometry,
  paths: readonly Path2D[],
  fills: readonly string[],
  hatched: readonly boolean[],
): Map<string, { solid: Path2D; hatched: Path2D }> {
  const out = new Map<string, ColourBatch>();
  const count = Math.min(g.provinceRingStart.length, fills.length);
  for (let p = 0; p < count; p++) {
    const colour = fills[p]!;
    let batch = out.get(colour);
    if (batch === undefined) {
      batch = { solid: new Path2D(), hatched: new Path2D() };
      out.set(colour, batch);
    }
    (hatched[p] === true ? batch.hatched : batch.solid).addPath(paths[p]!);
  }
  return out;
}

/**
 * Rebuilds, in place, only the batches of `colours` (those a province left or
 * joined); a colour no province uses any more is dropped.
 */
export function rebuildColours(
  batches: Map<string, ColourBatch>,
  colours: ReadonlySet<string>,
  paths: readonly Path2D[],
  fills: readonly string[],
  hatched: readonly boolean[],
): void {
  for (const colour of colours) {
    if (!fills.includes(colour)) {
      batches.delete(colour);
      continue;
    }
    const batch = { solid: new Path2D(), hatched: new Path2D() };
    fillBatch(batch, colour, paths, fills, hatched);
    batches.set(colour, batch);
  }
}

/** The colours whose batch membership differs between two fill sets: the old and new colour of every changed province. */
export function changedColours(beforeFills: readonly string[], beforeHatched: readonly boolean[], fills: readonly string[], hatched: readonly boolean[]): Set<string> {
  const out = new Set<string>();
  for (let p = 0; p < fills.length; p++) {
    if (beforeFills[p] === fills[p] && beforeHatched[p] === hatched[p]) continue;
    const before = beforeFills[p];
    if (before !== undefined) out.add(before);
    out.add(fills[p]!);
  }
  return out;
}
