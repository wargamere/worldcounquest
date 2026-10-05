import { describe, expect, it } from 'vitest';
import { CAPITAL, RENDER, TIME } from '@/next/game/balance';
import { setOwner } from '@/next/game/cache';
import { asProvince } from '@/next/game/ids';
import { tinySim } from '@/next/game/__tests__/helpers';
import { FAR, hopsFromPlayerLand, threatenedProvinces } from '../derived';
import { changedColours } from '../paths';
import {
  capitalStars,
  changedProvinces,
  dirtyRects,
  fillKey,
  GOOD_COLOURS,
  nationLabels,
  ownerChanges,
  provinceFills,
  stabilityColour,
  SUPPLY_COLOURS,
  TERRAIN_COLOURS,
} from '../scene';
import { chainWorld, HALF, squareGeometry } from './fixtures';

describe('province fills per map mode', () => {
  it('political: owner colour, occupied land hatched', () => {
    const world = tinySim({
      provinces: { home: { owner: 'me' }, taken: { owner: 'me', country: 'foe' }, foe: { owner: 'foe' } },
      edges: [
        ['home', 'taken'],
        ['taken', 'foe'],
      ],
      player: 'me',
    });
    const { fills, hatched } = provinceFills(world.sim, 'political');
    const colour = (id: string): string => world.sim.state.nations[world.n(id)]!.colour;
    expect(fills).toEqual([colour('me'), colour('me'), colour('foe')]);
    expect(hatched).toEqual([false, true, false]);
  });

  it('terrain, resources and stability', () => {
    const world = tinySim({
      provinces: { a: { owner: 'me', terrain: 'mountains', stability: 0 }, b: { owner: 'me', terrain: 'desert', good: 'oil', stability: 100 } },
      edges: [['a', 'b']],
      player: 'me',
    });
    expect(provinceFills(world.sim, 'terrain').fills).toEqual([TERRAIN_COLOURS.mountains, TERRAIN_COLOURS.desert]);
    expect(provinceFills(world.sim, 'resources').fills).toEqual([GOOD_COLOURS.steel, GOOD_COLOURS.oil]);
    const stability = provinceFills(world.sim, 'stability');
    expect(stability.fills).toEqual([stabilityColour(0), stabilityColour(100)]);
    expect(stabilityColour(0)).not.toBe(stabilityColour(100));
    expect(stabilityColour(51)).toBe(stabilityColour(49));
    expect(stability.hatched).toEqual([false, false]);
  });

  it('supply: connected, inside the halo, cut off, and the rest', () => {
    const world = chainWorld(['me', 'me', 'foe', 'foe', 'foe', 'me']);
    const { fills } = provinceFills(world.sim, 'supply');
    expect(fills).toEqual([
      SUPPLY_COLOURS.connected,
      SUPPLY_COLOURS.connected,
      SUPPLY_COLOURS.supplied,
      SUPPLY_COLOURS.supplied,
      SUPPLY_COLOURS.none,
      SUPPLY_COLOURS.unsupplied,
    ]);
  });
});

describe('repaint bookkeeping', () => {
  it('keys fills on what can change them', () => {
    const world = chainWorld(['me', 'foe']);
    const { sim } = world;
    const before = { political: fillKey(sim, 'political'), stability: fillKey(sim, 'stability'), terrain: fillKey(sim, 'terrain') };
    sim.state.tick += 1;
    expect(fillKey(sim, 'stability')).toBe(before.stability);
    sim.state.tick += TIME.TICKS_PER_HOUR;
    expect(fillKey(sim, 'stability')).not.toBe(before.stability);
    expect(fillKey(sim, 'political')).toBe(before.political);
    setOwner(sim, world.p('p1'), world.n('me'));
    expect(fillKey(sim, 'political')).not.toBe(before.political);
    sim.state.tick += TIME.TICKS_PER_DAY;
    expect(fillKey(sim, 'terrain')).toBe(before.terrain);
  });

  it('lists changed provinces and owners', () => {
    const world = chainWorld(['me', 'foe', 'foe']);
    const owners = Int32Array.from(world.sim.state.provinces, (p) => p.owner);
    const before = provinceFills(world.sim, 'political');
    setOwner(world.sim, world.p('p2'), world.n('me'));
    const after = provinceFills(world.sim, 'political');
    expect(changedProvinces(before, after)).toEqual([world.p('p2')]);
    expect(ownerChanges(owners, Int32Array.from(world.sim.state.provinces, (p) => p.owner))).toEqual([world.p('p2')]);
    // A captured province turns the captor's colour and gains the hatch.
    expect(changedColours(before.fills, before.hatched, after.fills, after.hatched)).toEqual(new Set([before.fills[2]!, after.fills[2]!]));
    expect(changedColours(after.fills, after.hatched, after.fills, after.hatched).size).toBe(0);
  });

  it('clips repaints to changed boxes plus padding, or repaints all beyond DIRTY_RECT_MAX', () => {
    const g = squareGeometry(Array.from({ length: RENDER.DIRTY_RECT_MAX + 1 }, (_, i) => [100 + 50 * i, 100] as const));
    const camera = { k: 2, x: 10, y: -20 };
    const rects = dirtyRects(g, camera, [asProvince(0), asProvince(3)], 2)!;
    expect(rects).toHaveLength(2);
    const r = rects[0]!;
    // Province 0 spans 80..120 x 80..120 in base space: 170..250 x 140..220 on screen.
    expect(r.x).toBe(168);
    expect(r.y).toBe(138);
    expect(r.w).toBeGreaterThanOrEqual(4 * HALF + 4);
    expect(r.h).toBeGreaterThanOrEqual(4 * HALF + 4);
    const all = Array.from({ length: RENDER.DIRTY_RECT_MAX + 1 }, (_, i) => asProvince(i));
    expect(dirtyRects(g, camera, all.slice(0, RENDER.DIRTY_RECT_MAX), 2)).toHaveLength(RENDER.DIRTY_RECT_MAX);
    expect(dirtyRects(g, camera, all, 2)).toBeNull();
  });
});

describe('labels and stars', () => {
  it('labels each living nation at its largest province, biggest first', () => {
    const world = chainWorld(['me', 'me', 'foe']);
    const g = world.g;
    g.area[1] = 9000;
    const labels = nationLabels(world.sim, g);
    expect(labels.map((l) => l.nation)).toEqual([world.n('me'), world.n('foe')]);
    expect([labels[0]!.x, labels[0]!.y]).toEqual([200, 100]);
    expect(labels[0]!.area).toBe(9000 + 4 * HALF * HALF);
  });

  it("shows the player's seat and empires always, every seat once city dots show", () => {
    const owners = ['me', 'small', ...Array.from({ length: CAPITAL.EMPIRE_PROVINCES }, () => 'empire')];
    const world = chainWorld(owners);
    const seat = (id: string): number => world.sim.state.nations[world.n(id)]!.capital!;
    expect(capitalStars(world.sim, 1)).toEqual([seat('me'), seat('empire')].sort((a, b) => a - b));
    expect(capitalStars(world.sim, RENDER.CITY_DOTS_FROM_ZOOM)).toEqual([seat('me'), seat('small'), seat('empire')].sort((a, b) => a - b));
  });
});

describe('derived map facts', () => {
  it('counts hops from the player land over every edge', () => {
    const world = chainWorld(['foe', 'me', 'foe', 'foe', 'foe']);
    expect([...hopsFromPlayerLand(world.sim)]).toEqual([1, 0, 1, 2, 3]);
    const cut = chainWorld(['me', 'foe']);
    setOwner(cut.sim, cut.p('p0'), cut.n('foe'));
    expect([...hopsFromPlayerLand(cut.sim)]).toEqual([FAR, FAR]);
  });

  it('outlines own provinces whose threat reaches the danger ratio', () => {
    const exposed = chainWorld(['me', 'me', 'foe'], { armies: [{ owner: 'foe', at: 'p2', units: { rifles: 12 } }] });
    expect(threatenedProvinces(exposed.sim, true)).toContain(exposed.p('p1'));
    const held = chainWorld(['me', 'me', 'foe'], {
      armies: [
        { owner: 'foe', at: 'p2', units: { rifles: 12 } },
        { owner: 'me', at: 'p1', units: { rifles: 40 } },
      ],
    });
    expect(threatenedProvinces(held.sim, true)).not.toContain(held.p('p1'));
    const quiet = chainWorld(['me', 'me', 'foe']);
    expect(threatenedProvinces(quiet.sim, true)).toEqual([]);
  });
});
