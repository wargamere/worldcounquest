/**
 * Game time and the fixed-step frame planner. Ticks are the only clock inside
 * src/next/game; real milliseconds appear only in planFrame/settleFrame, which
 * the store's loop feeds with measured frame gaps.
 */
import { TIME } from './balance';
import type { RunSpeed, Speed, Tick } from './types';

const HOURS_PER_DAY = TIME.TICKS_PER_DAY / TIME.TICKS_PER_HOUR;

/** Hour of the day, 0..23. */
export function hourOf(tick: Tick): number {
  return Math.floor(tick / TIME.TICKS_PER_HOUR) % HOURS_PER_DAY;
}

/** Day number, 1-based: tick 0 is Day 1 00:00. */
export function dayOf(tick: Tick): number {
  return Math.floor(tick / TIME.TICKS_PER_DAY) + 1;
}

export function isHourStart(tick: Tick): boolean {
  return tick % TIME.TICKS_PER_HOUR === 0;
}

export function isDayStart(tick: Tick): boolean {
  return tick % TIME.TICKS_PER_DAY === 0;
}

/** Whole ticks for a span of game hours, rounded to the nearest tick. */
export function hoursToTicks(hours: number): number {
  return Math.round(hours * TIME.TICKS_PER_HOUR);
}

/** Real milliseconds per tick at a running speed. */
export function tickMs(speed: RunSpeed): number {
  return TIME.REAL_MS_PER_TICK_AT_1X / speed;
}

const twoDigits = (n: number): string => (n < 10 ? `0${n}` : `${n}`);

/** "Day 37 · 14:00" (minutes step by the tick length). */
export function formatClock(tick: Tick): string {
  const minutes = (tick % TIME.TICKS_PER_HOUR) * TIME.TICK_MINUTES;
  return `Day ${dayOf(tick)} · ${twoDigits(hourOf(tick))}:${twoDigits(minutes)}`;
}

/** "9 h", "1 d 4 h", "2 d". Part hours round up, so an imminent arrival never reads "0 h". */
export function formatDuration(ticks: number): string {
  const hours = Math.max(0, Math.ceil(ticks / TIME.TICKS_PER_HOUR));
  if (hours < HOURS_PER_DAY) return `${hours} h`;
  const days = Math.floor(hours / HOURS_PER_DAY);
  const rest = hours % HOURS_PER_DAY;
  return rest === 0 ? `${days} d` : `${days} d ${rest} h`;
}

export interface FramePlan {
  ticks: number;
  accumulatorMs: number;
}

/**
 * Adds a frame's elapsed time (capped at MAX_FRAME_MS, so a stalled tab never
 * catches up) and plans at most MAX_TICKS_PER_FRAME ticks. While paused nothing
 * accrues and the accumulator is left as it was.
 */
export function planFrame(accumulatorMs: number, elapsedMs: number, speed: Speed): FramePlan {
  if (speed === 0) return { ticks: 0, accumulatorMs };
  const acc = accumulatorMs + Math.min(Math.max(elapsedMs, 0), TIME.MAX_FRAME_MS);
  const ticks = Math.min(Math.floor(acc / tickMs(speed)), TIME.MAX_TICKS_PER_FRAME);
  return { ticks, accumulatorMs: acc };
}

export interface FrameSettle {
  accumulatorMs: number;
  alpha: number;
  throttled: boolean;
}

/** Largest alpha reported: the interpolation share stays strictly below one tick. */
const ALPHA_CEILING = 1 - Number.EPSILON;

/**
 * Subtracts the ticks actually run. If the loop stopped early (sim budget) or
 * two or more ticks are still owed, the backlog is dropped down to one tick, so
 * the game runs slower instead of spiralling. Alpha is the interpolation share
 * toward the next tick, in [0, 1). While paused the accumulator is kept and
 * alpha is 0: the loop keeps drawing the alpha it had when it paused.
 */
export function settleFrame(plan: FramePlan, ticksRun: number, speed: Speed): FrameSettle {
  if (speed === 0) return { accumulatorMs: plan.accumulatorMs, alpha: 0, throttled: false };
  const ms = tickMs(speed);
  let acc = plan.accumulatorMs - ticksRun * ms;
  const stoppedEarly = ticksRun < plan.ticks;
  const throttled = stoppedEarly || acc >= 2 * ms;
  if (throttled) acc = Math.min(acc, ms);
  acc = Math.max(acc, 0);
  return { accumulatorMs: acc, alpha: Math.min(acc / ms, ALPHA_CEILING), throttled };
}
