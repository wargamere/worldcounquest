import { describe, expect, it } from 'vitest';
import { RENDER } from '@/next/game/balance';
import { armyById, rebuildArmyIndex } from '@/next/game/cache';
import { refreshVision } from '@/next/game/supply';
import type { Army, ArmyId } from '@/next/game/types';
import type { Camera } from '../types';
import { armiesInRect, chipSize, fanOffset, isDot, layoutMarkers, markerAt, markerLod, PRIORITY, type Marker } from '../markers';
import { chainWorld, frameOf, ids, legOf, squareGeometry } from './fixtures';

const AT = (k: number): Camera => ({ k, x: 0, y: 0 });
const VIEW_W = 2400;
const VIEW_H = 1200;

function layout(world: ReturnType<typeof chainWorld>, k: number, over: Parameters<typeof frameOf>[1] = {}): Marker[] {
  const out: Marker[] = [];
  const count = layoutMarkers(frameOf(world, over), world.g, AT(k), VIEW_W, VIEW_H, out);
  return out.slice(0, count);
}

function army(world: ReturnType<typeof chainWorld>, index: number): Army {
  return armyById(world.sim, world.a(index))!;
}

describe('level of detail', () => {
  it('switches at the RENDER zoom thresholds', () => {
    expect(markerLod(RENDER.AGGREGATE_MARKERS_BELOW_ZOOM - 0.01)).toBe('aggregate');
    expect(markerLod(RENDER.AGGREGATE_MARKERS_BELOW_ZOOM)).toBe('chips');
    expect(markerLod(RENDER.GLYPH_MARKERS_FROM_ZOOM)).toBe('glyphs');
  });

  it('aggregates one chip per (province, nation) below 2.5 and one per army above', () => {
    const world = chainWorld(['me', 'me', 'foe', 'foe'], {
      armies: [
        { owner: 'me', at: 'p0', units: { rifles: 3 } },
        { owner: 'me', at: 'p0', units: { tanks: 2 } },
        { owner: 'foe', at: 'p2', units: { rifles: 4 } },
      ],
    });
    const low = layout(world, 1);
    expect(low).toHaveLength(2);
    expect(low[0]!.armies).toEqual(ids(1, 2));
    expect(low[0]!.units).toBe(5);
    expect(low[0]!.glyph).toBe('rifles');
    expect(low[0]!.ours).toBe(true);
    expect([low[0]!.x, low[0]!.y]).toEqual([100, 100]);
    expect(low[1]!.armies).toEqual(ids(3));
    expect(low[1]!.ours).toBe(false);

    const high = layout(world, 3);
    const mine = high.filter((m) => m.ours);
    expect(mine.map((m) => m.armies)).toEqual([ids(1), ids(2)]);
    const { w } = chipSize(false);
    // Two chips side by side, centred on the anchor (300 on screen at k = 3).
    expect(mine.map((m) => m.x)).toEqual([300 - (w + 2) / 2, 300 + (w + 2) / 2]);
    expect(mine.every((m) => m.y === 300)).toBe(true);
  });
});

describe('fan placement', () => {
  it('fans up to RENDER.FAN_MAX chips and folds the rest into one "+N" chip', () => {
    const armies = Array.from({ length: 6 }, () => ({ owner: 'me', at: 'p0', units: { rifles: 2 } }));
    const world = chainWorld(['me', 'foe'], { armies });
    const markers = layout(world, 3, { selectedArmies: new Set(ids(6)) });
    expect(markers).toHaveLength(RENDER.FAN_MAX + 1);
    // The selected army gets its own chip; the "+N" chip holds the last two others.
    expect(markers[0]!.armies).toEqual(ids(6));
    expect(markers[0]!.selected).toBe(true);
    const folded = markers.find((m) => m.armies.length > 1)!;
    expect(folded.armies).toEqual(ids(4, 5));
    expect(folded.units).toBe(4);
    const { w, h } = chipSize(false);
    for (let i = 0; i < markers.length; i++) {
      for (let j = i + 1; j < markers.length; j++) {
        const a = markers[i]!;
        const b = markers[j]!;
        expect(Math.abs(a.x - b.x) >= w || Math.abs(a.y - b.y) >= h).toBe(true);
      }
    }
  });

  it('centres symmetric fans on the anchor', () => {
    for (const count of [1, 2, 4]) {
      let sx = 0;
      let sy = 0;
      for (let i = 0; i < count; i++) {
        const [dx, dy] = fanOffset(count, i, 28, 18);
        sx += dx;
        sy += dy;
      }
      expect([sx, sy]).toEqual([0, 0]);
    }
    expect(fanOffset(1, 0, 28, 18)).toEqual([0, 0]);
  });
});

describe('hide rules and fog', () => {
  const spec = {
    armies: [
      { owner: 'foe', at: 'p3', units: { rifles: 5 } }, // 2 hops from my land: small but near
      { owner: 'foe', at: 'p4', units: { rifles: 12 } }, // 3 hops, but a big stack
      { owner: 'foe', at: 'p5', units: { rifles: 5 } }, // 4 hops and small: hidden at low zoom
    ],
  };

  it('hides small hostile stacks far from the player below 2.5, and shows them above', () => {
    const world = chainWorld(['me', 'me', 'foe', 'foe', 'foe', 'foe'], spec);
    expect(layout(world, 1).map((m) => m.armies[0])).toEqual(ids(2, 1));
    expect(layout(world, 3)).toHaveLength(3);
  });

  it('removes armies outside the player vision unless "Show all armies" is on', () => {
    const world = chainWorld(['me', 'me', 'foe', 'foe', 'foe', 'foe'], spec);
    refreshVision(world.sim);
    expect(layout(world, 3, { showAll: false }).map((m) => m.armies[0])).toEqual(ids(1));
    expect(layout(world, 3, { showAll: true })).toHaveLength(3);
  });
});

describe('declutter priority', () => {
  it('orders markers by the §9.4 priorities', () => {
    const world = chainWorld(['me', 'me', 'foe', 'foe'], {
      armies: [
        { owner: 'foe', at: 'p1', units: { rifles: 3 } }, // 1: fighting you, in your province
        { owner: 'foe', at: 'p3', units: { rifles: 3 } }, // 2: marching to you
        { owner: 'foe', at: 'p3', units: { rifles: 12 } }, // 3: a big stack
        { owner: 'foe', at: 'p2', units: { rifles: 2 } }, // 4: everything else
        { owner: 'me', at: 'p0', units: { rifles: 1 } }, // 5: your idle army
        { owner: 'me', at: 'p0', units: { rifles: 1 } }, // 6: your moving army
        { owner: 'me', at: 'p1', units: { rifles: 4 } }, // 7: your army in battle
      ],
    });
    const { sim } = world;
    const marching = army(world, 1);
    marching.leg = legOf(world.p('p3'), world.p('p2'), 8, 4);
    marching.path = [world.p('p1')];
    army(world, 5).leg = legOf(world.p('p0'), world.p('p1'), 8, 4);
    rebuildArmyIndex(sim);
    expect(army(world, 6).battle).not.toBeNull();

    const markers = layout(world, 3);
    expect(markers.map((m) => m.armies[0])).toEqual(ids(7, 6, 5, 1, 2, 3, 4));
    // With a selection, it comes first.
    const selected = layout(world, 3, { selectedArmies: new Set(ids(4)) });
    expect(selected[0]!.armies).toEqual(ids(4));
    expect(PRIORITY.SELECTED).toBeLessThan(PRIORITY.OWN_BATTLE);
  });

  it('drops a lower-priority hostile marker that overlaps, but never an own one', () => {
    const world = chainWorld(['me', 'foe', 'foe', 'me', 'me'], {
      armies: [
        { owner: 'foe', at: 'p1', units: { rifles: 3 } },
        { owner: 'foe', at: 'p2', units: { rifles: 12 } },
        { owner: 'me', at: 'p3', units: { rifles: 1 } },
        { owner: 'me', at: 'p4', units: { rifles: 1 } },
      ],
    });
    // p1 and p2 are 5 base units apart (15 px at k = 3, closer than one chip); so are p3 and p4.
    const g = squareGeometry([
      [100, 100],
      [300, 100],
      [305, 100],
      [330, 100],
      [332, 100],
    ]);
    const out: Marker[] = [];
    const count = layoutMarkers(frameOf(world), g, AT(3), VIEW_W, VIEW_H, out);
    expect(out.slice(0, count).map((m) => m.armies[0])).toEqual(ids(3, 4, 2));
  });

  it('caps markers at 600 with a mouse and 300 on touch', () => {
    const owners = ['me', ...Array.from({ length: 320 }, () => 'foe')];
    const armies = owners.slice(1).map((_, i) => ({ owner: 'foe', at: `p${i + 1}`, units: { rifles: 12 } }));
    const world = chainWorld(owners, { armies });
    // A 20 x 17 grid, 100 x 60 base units apart: no two chips overlap at k = 1.
    const g = squareGeometry(owners.map((_, i) => [50 + 100 * (i % 20), 40 + 60 * Math.floor(i / 20)] as const));
    const fine: Marker[] = [];
    expect(layoutMarkers(frameOf(world), g, AT(1), VIEW_W, VIEW_H, fine)).toBe(320);
    const touch: Marker[] = [];
    expect(layoutMarkers(frameOf(world, { coarse: true }), g, AT(1), VIEW_W, VIEW_H, touch)).toBe(RENDER.MAX_MARKERS_COARSE);
  });

  it('skips armies whose anchor is far off screen', () => {
    const world = chainWorld(['me', 'foe'], { armies: [{ owner: 'me', at: 'p1', units: { rifles: 1 } }] });
    const out: Marker[] = [];
    expect(layoutMarkers(frameOf(world), world.g, { k: 1, x: -5000, y: 0 }, 800, 600, out)).toBe(0);
  });
});

describe('marker state', () => {
  it('places a moving army at (done + alpha) / ticks along its leg, as a dot below 2.5', () => {
    const world = chainWorld(['me', 'me'], { armies: [{ owner: 'me', at: 'p0', units: { rifles: 2 } }] });
    army(world, 0).leg = legOf(world.p('p0'), world.p('p1'), 4, 1);
    rebuildArmyIndex(world.sim);
    const [m] = layout(world, 1, { alpha: 0.5 });
    expect(m!.moving).toBe(true);
    expect(m!.x).toBeCloseTo(100 + 100 * (1.5 / 4), 9);
    expect(isDot(m!, 1)).toBe(true);
    expect(isDot(layout(world, 3, { alpha: 0.5 })[0]!, 3)).toBe(false);
  });

  it('reports waiting ticks, supply, health and the dominant glyph', () => {
    const world = chainWorld(['me', 'me', 'foe', 'foe', 'foe', 'foe'], {
      armies: [
        { owner: 'me', at: 'p0', units: { rifles: 1, tanks: 3 } },
        { owner: 'me', at: 'p5', units: { rifles: 2 } },
      ],
    });
    const waiting = army(world, 0);
    waiting.path = [world.p('p1')];
    waiting.departAt = world.sim.state.tick + 6;
    waiting.units.tanks.hp = waiting.units.tanks.hp / 2;
    const markers = layout(world, 3);
    const first = markers.find((m) => m.armies[0] === world.a(0))!;
    expect(first.waitingTicks).toBe(6);
    expect(first.glyph).toBe('tanks');
    expect(first.hpShare).toBeCloseTo((20 + 54) / (20 + 108), 9);
    expect(first.unsupplied).toBe(false);
    // Four hops beyond the player's land: outside the 2-hop supply halo.
    expect(markers.find((m) => m.armies[0] === world.a(1))!.unsupplied).toBe(true);
  });
});

describe('marker hit tests', () => {
  it('finds the nearest marker within the radius, and armies inside a box', () => {
    const world = chainWorld(['me', 'me', 'me'], {
      armies: [
        { owner: 'me', at: 'p0', units: { rifles: 1 } },
        { owner: 'me', at: 'p1', units: { rifles: 1 } },
        { owner: 'me', at: 'p2', units: { rifles: 1 } },
      ],
    });
    const out: Marker[] = [];
    const count = layoutMarkers(frameOf(world), world.g, AT(1), VIEW_W, VIEW_H, out);
    expect(markerAt(out, count, 195, 104, RENDER.HIT_RADIUS_FINE)).toEqual(ids(2));
    expect(markerAt(out, count, 150, 100, RENDER.HIT_RADIUS_FINE)).toBeNull();
    expect(markerAt(out, count, 150, 100, RENDER.HIT_RADIUS_COARSE * 3)).not.toBeNull();
    const boxed: ArmyId[] = armiesInRect(out, count, 250, 0, 90, 200);
    expect(boxed).toEqual(ids(1, 2));
  });
});
