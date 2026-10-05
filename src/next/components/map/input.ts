/**
 * Map input (§4.7). Pinch, pan and wheel zoom belong to d3-zoom (MapCanvas);
 * this module turns pointer events into the game's gestures:
 *
 * - tap or click a marker: select (Shift adds or removes); a province: tap;
 *   empty sea: an empty, non-additive box, which clears the selection;
 * - right-click a province: the instant order (Shift appends a waypoint);
 * - long-press (touch, RENDER.LONG_PRESS_MS within LONG_PRESS_SLOP_PX): on a
 *   marker always multi-select, on a province always info;
 * - drag a marker onto a province: the pre-filled order;
 * - Shift-drag on the map (mouse): box select, additive;
 * - double-click: every own army in that province;
 * - hover (mouse): the province under the pointer.
 *
 * The recognizer is DOM-free and driven by plain samples, so it is tested in
 * Node; attachInput only wires DOM events and the long-press timer to it.
 */
import { RENDER } from '@/next/game/balance';
import type { ArmyId, ProvinceIx } from '@/next/game/types';
import type { Rect } from './drawBase';
import type { MapInputHandlers } from './types';

/** What a pointer gesture shows on the overlay while it lasts. */
export interface InputFeedback {
  box: Rect | null;
  drag: { from: [number, number]; to: [number, number] } | null;
}
/**
 * Hit tests in CSS px relative to the map element. The first two are the
 * §11.5 shape; the optional rest give box select, double-click and gesture
 * feedback when the host provides them.
 */
export interface MapPick {
  marker(x: number, y: number): readonly ArmyId[] | null;
  province(x: number, y: number): ProvinceIx | null;
  armiesIn?(x0: number, y0: number, x1: number, y1: number): readonly ArmyId[];
  ownArmiesAt?(p: ProvinceIx): readonly ArmyId[];
  feedback?(f: InputFeedback): void;
}
export interface PointerSample {
  id: number;
  x: number;
  y: number;
  /** Milliseconds, any monotonic clock. */
  t: number;
  touch: boolean;
  /** 0 primary, 2 secondary. */
  button: number;
  shift: boolean;
}

type Mode = 'pending' | 'drag' | 'box' | 'pan' | 'longPressed' | 'multi';
interface Press {
  id: number;
  x0: number;
  y0: number;
  touch: boolean;
  button: number;
  shift: boolean;
  marker: readonly ArmyId[] | null;
  mode: Mode;
}

const NO_FEEDBACK: InputFeedback = { box: null, drag: null };

export class GestureRecognizer {
  private readonly pointers = new Set<number>();
  private press: Press | null = null;
  private hovered: ProvinceIx | null = null;
  /** When the pending long-press fires (same clock as the samples), or null. */
  longPressAt: number | null = null;

  constructor(
    private readonly pick: MapPick,
    private readonly handlers: MapInputHandlers,
    /** Touch-first devices: every pointer type can long-press. */
    private readonly coarse: boolean,
  ) {}

  down(s: PointerSample): void {
    this.pointers.add(s.id);
    if (this.pointers.size > 1) {
      // A second finger makes it a pinch, which d3-zoom owns.
      if (this.press !== null) this.endFeedback(this.press);
      if (this.press !== null) this.press.mode = 'multi';
      this.longPressAt = null;
      return;
    }
    this.press = { id: s.id, x0: s.x, y0: s.y, touch: s.touch, button: s.button, shift: s.shift, marker: this.pick.marker(s.x, s.y), mode: 'pending' };
    this.longPressAt = (s.touch || this.coarse) && s.button === 0 ? s.t + RENDER.LONG_PRESS_MS : null;
  }

  /** Whether pointer `id` is pressed on the map. */
  tracks(id: number): boolean {
    return this.pointers.has(id);
  }

  move(s: PointerSample): void {
    if (!this.pointers.has(s.id)) {
      if (!s.touch) this.hover(this.pick.province(s.x, s.y));
      return;
    }
    const press = this.press;
    if (press === null || press.id !== s.id) return;
    const dx = s.x - press.x0;
    const dy = s.y - press.y0;
    if (press.mode === 'pending' && dx * dx + dy * dy > RENDER.LONG_PRESS_SLOP_PX * RENDER.LONG_PRESS_SLOP_PX) {
      this.longPressAt = null;
      if (press.marker !== null && press.button === 0) press.mode = 'drag';
      else if (press.shift && !press.touch && press.button === 0) press.mode = 'box';
      else press.mode = 'pan';
    }
    if (press.mode === 'drag') {
      this.pick.feedback?.({ box: null, drag: { from: [press.x0, press.y0], to: [s.x, s.y] } });
      this.hover(this.pick.province(s.x, s.y));
    } else if (press.mode === 'box') {
      this.pick.feedback?.({ box: rectOf(press.x0, press.y0, s.x, s.y), drag: null });
    }
  }

  up(s: PointerSample): void {
    this.pointers.delete(s.id);
    const press = this.press;
    if (press === null || press.id !== s.id) {
      if (this.pointers.size === 0 && press?.mode === 'multi') this.press = null;
      return;
    }
    this.press = null;
    this.longPressAt = null;
    switch (press.mode) {
      case 'multi':
      case 'longPressed':
      case 'pan':
        return;
      case 'drag': {
        this.endFeedback(press);
        const p = this.pick.province(s.x, s.y);
        if (p !== null && press.marker !== null) this.handlers.dragOrder(press.marker, p);
        return;
      }
      case 'box': {
        this.endFeedback(press);
        this.handlers.box(this.pick.armiesIn?.(press.x0, press.y0, s.x, s.y) ?? [], true);
        return;
      }
      case 'pending':
        this.tap(press, s);
        return;
    }
  }

  cancel(id: number): void {
    this.pointers.delete(id);
    if (this.press?.id !== id) return;
    this.endFeedback(this.press);
    this.press = null;
    this.longPressAt = null;
  }

  /** The long-press timer fired at `t`. */
  longPressDue(t: number): void {
    const press = this.press;
    if (press === null || press.mode !== 'pending' || this.longPressAt === null || t < this.longPressAt) return;
    press.mode = 'longPressed';
    this.longPressAt = null;
    if (press.marker !== null) {
      this.handlers.longPressMarker(press.marker);
      return;
    }
    const p = this.pick.province(press.x0, press.y0);
    if (p !== null) this.handlers.longPressProvince(p);
  }

  /** A mouse double-click: every own army standing in that province. */
  doubleClick(x: number, y: number): void {
    const p = this.pick.province(x, y);
    if (p === null || this.pick.ownArmiesAt === undefined) return;
    const armies = this.pick.ownArmiesAt(p);
    if (armies.length > 0) this.handlers.box(armies, false);
  }

  /** The pointer left the map. */
  leave(): void {
    if (this.pointers.size === 0) this.hover(null);
  }

  private tap(press: Press, s: PointerSample): void {
    if (press.button === 2) {
      const p = this.pick.province(s.x, s.y);
      if (p !== null) this.handlers.secondary(p, s.shift);
      return;
    }
    if (press.button !== 0) return;
    if (press.marker !== null) {
      this.handlers.tapMarker(press.marker, press.shift);
      return;
    }
    const p = this.pick.province(s.x, s.y);
    if (p !== null) this.handlers.tapProvince(p, press.shift);
    else if (!press.shift) this.handlers.box([], false);
  }

  private hover(p: ProvinceIx | null): void {
    if (p === this.hovered) return;
    this.hovered = p;
    this.handlers.hover(p);
  }

  private endFeedback(press: Press): void {
    if (press.mode === 'drag' || press.mode === 'box') this.pick.feedback?.(NO_FEEDBACK);
  }
}

export function rectOf(x0: number, y0: number, x1: number, y1: number): Rect {
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
}

/** Wires pointer events on `el` to a GestureRecognizer; returns the detach function. */
export function attachInput(el: HTMLElement, pick: MapPick, handlers: MapInputHandlers, coarse: boolean): () => void {
  const recognizer = new GestureRecognizer(pick, handlers, coarse);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const sample = (e: PointerEvent): PointerSample => {
    const box = el.getBoundingClientRect();
    return { id: e.pointerId, x: e.clientX - box.left, y: e.clientY - box.top, t: performance.now(), touch: e.pointerType !== 'mouse', button: e.button, shift: e.shiftKey };
  };
  const clearTimer = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const armTimer = (): void => {
    clearTimer();
    const at = recognizer.longPressAt;
    if (at === null) return;
    timer = setTimeout(() => {
      timer = null;
      recognizer.longPressDue(performance.now());
    }, Math.max(0, at - performance.now()));
  };

  const onDown = (e: PointerEvent): void => {
    recognizer.down(sample(e));
    armTimer();
  };
  const onMove = (e: PointerEvent): void => {
    // Hover only counts over the map itself, not over panels floating above it.
    if (!recognizer.tracks(e.pointerId) && !(e.target instanceof Node && el.contains(e.target))) return;
    recognizer.move(sample(e));
    if (recognizer.longPressAt === null) clearTimer();
  };
  const onUp = (e: PointerEvent): void => {
    recognizer.up(sample(e));
    clearTimer();
  };
  const onCancel = (e: PointerEvent): void => {
    recognizer.cancel(e.pointerId);
    clearTimer();
  };
  const onLeave = (): void => recognizer.leave();
  const onDoubleClick = (e: MouseEvent): void => {
    const box = el.getBoundingClientRect();
    recognizer.doubleClick(e.clientX - box.left, e.clientY - box.top);
  };
  const onContextMenu = (e: MouseEvent): void => e.preventDefault();

  el.addEventListener('pointerdown', onDown);
  // Moves and releases are heard on the window so a drag that leaves the map still ends.
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onCancel);
  el.addEventListener('pointerleave', onLeave);
  el.addEventListener('dblclick', onDoubleClick);
  el.addEventListener('contextmenu', onContextMenu);
  return () => {
    clearTimer();
    el.removeEventListener('pointerdown', onDown);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    el.removeEventListener('pointerleave', onLeave);
    el.removeEventListener('dblclick', onDoubleClick);
    el.removeEventListener('contextmenu', onContextMenu);
  };
}
