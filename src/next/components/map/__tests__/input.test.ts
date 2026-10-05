import { describe, expect, it } from 'vitest';
import { RENDER } from '@/next/game/balance';
import { asProvince } from '@/next/game/ids';
import type { ArmyId, ProvinceIx } from '@/next/game/types';
import { GestureRecognizer, rectOf, type InputFeedback, type MapPick, type PointerSample } from '../input';
import type { MapInputHandlers } from '../types';
import { ids } from './fixtures';

/** A marker at (100, 100) holding armies 1 and 2; land left of x = 500 is province 7, sea beyond. */
function setup(coarse = false): { r: GestureRecognizer; calls: unknown[][]; feedback: InputFeedback[] } {
  const calls: unknown[][] = [];
  const feedback: InputFeedback[] = [];
  const record =
    (name: string) =>
    (...args: unknown[]): void => {
      calls.push([name, ...args]);
    };
  const handlers: MapInputHandlers = {
    tapMarker: record('tapMarker'),
    tapProvince: record('tapProvince'),
    secondary: record('secondary'),
    longPressMarker: record('longPressMarker'),
    longPressProvince: record('longPressProvince'),
    box: record('box'),
    hover: record('hover'),
    dragOrder: record('dragOrder'),
    cameraChanged: record('cameraChanged'),
  };
  const pick: MapPick = {
    marker: (x, y): readonly ArmyId[] | null => (Math.abs(x - 100) <= 14 && Math.abs(y - 100) <= 14 ? ids(1, 2) : null),
    province: (x): ProvinceIx | null => (x < 500 ? asProvince(7) : null),
    armiesIn: (x0, _y0, x1) => (Math.min(x0, x1) <= 100 && Math.max(x0, x1) >= 100 ? ids(1, 2) : []),
    ownArmiesAt: (p) => (p === 7 ? ids(1, 2, 3) : []),
    feedback: (f) => feedback.push(f),
  };
  return { r: new GestureRecognizer(pick, handlers, coarse), calls, feedback };
}

const at = (x: number, y: number, t: number, over: Partial<PointerSample> = {}): PointerSample => ({ id: 1, x, y, t, touch: false, button: 0, shift: false, ...over });

describe('taps and clicks', () => {
  it('selects a marker, a province, or clears on empty sea', () => {
    const { r, calls } = setup();
    r.down(at(102, 98, 0));
    r.up(at(103, 99, 80));
    r.down(at(300, 300, 200, { shift: true }));
    r.up(at(300, 300, 260, { shift: true }));
    r.down(at(800, 300, 400));
    r.up(at(800, 300, 450));
    expect(calls).toEqual([
      ['tapMarker', ids(1, 2), false],
      ['tapProvince', 7, true],
      ['box', [], false],
    ]);
  });

  it('right-click is the instant order; Shift appends', () => {
    const { r, calls } = setup();
    r.down(at(300, 300, 0, { button: 2 }));
    r.up(at(300, 300, 50, { button: 2, shift: true }));
    expect(calls).toEqual([['secondary', 7, true]]);
  });

  it('double-click selects every own army in the province', () => {
    const { r, calls } = setup();
    r.doubleClick(300, 300);
    r.doubleClick(800, 300);
    expect(calls).toEqual([['box', ids(1, 2, 3), false]]);
  });

  it('hovers with the mouse, only on change, and clears on leave', () => {
    const { r, calls } = setup();
    r.move(at(300, 300, 0));
    r.move(at(310, 300, 10));
    r.move(at(800, 300, 20));
    r.move(at(300, 300, 30, { touch: true }));
    r.leave();
    expect(calls).toEqual([
      ['hover', 7],
      ['hover', null],
    ]);
  });
});

describe('long-press', () => {
  it('on a marker is multi-select and on a province is info, after LONG_PRESS_MS', () => {
    const { r, calls } = setup();
    r.down(at(100, 100, 0, { touch: true }));
    expect(r.longPressAt).toBe(RENDER.LONG_PRESS_MS);
    r.longPressDue(RENDER.LONG_PRESS_MS - 1);
    expect(calls).toEqual([]);
    r.longPressDue(RENDER.LONG_PRESS_MS);
    r.up(at(100, 100, 600, { touch: true }));
    r.down(at(300, 300, 1000, { touch: true }));
    r.longPressDue(1000 + RENDER.LONG_PRESS_MS);
    r.up(at(300, 300, 1600, { touch: true }));
    expect(calls).toEqual([
      ['longPressMarker', ids(1, 2)],
      ['longPressProvince', 7],
    ]);
  });

  it('is cancelled by moving more than the slop, and is touch-only on fine pointers', () => {
    const { r, calls } = setup();
    r.down(at(300, 300, 0, { touch: true }));
    r.move(at(300 + RENDER.LONG_PRESS_SLOP_PX + 1, 300, 100, { touch: true }));
    expect(r.longPressAt).toBeNull();
    r.longPressDue(RENDER.LONG_PRESS_MS);
    r.up(at(320, 300, 600, { touch: true }));
    // A pan is not a tap either.
    expect(calls).toEqual([]);
    r.down(at(300, 300, 1000));
    expect(r.longPressAt).toBeNull();
    const touchFirst = setup(true);
    touchFirst.r.down(at(300, 300, 0));
    expect(touchFirst.r.longPressAt).toBe(RENDER.LONG_PRESS_MS);
  });

  it('a small wobble within the slop still counts', () => {
    const { r, calls } = setup();
    r.down(at(300, 300, 0, { touch: true }));
    r.move(at(303, 302, 100, { touch: true }));
    r.longPressDue(RENDER.LONG_PRESS_MS);
    expect(calls).toEqual([['longPressProvince', 7]]);
  });
});

describe('drags', () => {
  it('drags a marker onto a province as an order, with feedback', () => {
    const { r, calls, feedback } = setup();
    r.down(at(100, 100, 0));
    r.move(at(200, 150, 50));
    r.move(at(300, 200, 100));
    r.up(at(300, 200, 150));
    expect(calls).toEqual([
      ['hover', 7],
      ['dragOrder', ids(1, 2), 7],
    ]);
    expect(feedback.at(-2)).toEqual({ box: null, drag: { from: [100, 100], to: [300, 200] } });
    expect(feedback.at(-1)).toEqual({ box: null, drag: null });
  });

  it('a drag dropped on the sea orders nothing', () => {
    const { r, calls } = setup();
    r.down(at(100, 100, 0));
    r.move(at(900, 100, 50));
    r.up(at(900, 100, 100));
    expect(calls.filter((c) => c[0] === 'dragOrder')).toEqual([]);
  });

  it('Shift-drag on the map is an additive box select', () => {
    const { r, calls, feedback } = setup();
    r.down(at(50, 50, 0, { shift: true }));
    r.move(at(150, 160, 50, { shift: true }));
    r.up(at(150, 160, 100, { shift: true }));
    expect(feedback[0]).toEqual({ box: rectOf(50, 50, 150, 160), drag: null });
    expect(feedback.at(-1)).toEqual({ box: null, drag: null });
    expect(calls).toEqual([['box', ids(1, 2), true]]);
  });

  it('a second finger turns the gesture into a pinch: no tap, no drag', () => {
    const { r, calls } = setup();
    r.down(at(100, 100, 0, { touch: true }));
    r.down(at(300, 300, 10, { id: 2, touch: true }));
    expect(r.longPressAt).toBeNull();
    r.move(at(150, 150, 50, { touch: true }));
    r.up(at(150, 150, 100, { touch: true }));
    r.up(at(300, 300, 110, { id: 2, touch: true }));
    r.down(at(300, 300, 500, { touch: true }));
    r.up(at(300, 300, 550, { touch: true }));
    expect(calls).toEqual([['tapProvince', 7, false]]);
  });

  it('a cancelled pointer ends its gesture', () => {
    const { r, calls, feedback } = setup();
    r.down(at(100, 100, 0));
    r.move(at(200, 100, 50));
    r.cancel(1);
    r.up(at(200, 100, 100));
    expect(calls.filter((c) => c[0] === 'dragOrder')).toEqual([]);
    expect(feedback.at(-1)).toEqual({ box: null, drag: null });
  });
});
