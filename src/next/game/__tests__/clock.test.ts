import { describe, expect, it } from 'vitest';
import { TIME } from '../balance';
import {
  dayOf,
  formatClock,
  formatDuration,
  hourOf,
  hoursToTicks,
  isDayStart,
  isHourStart,
  planFrame,
  settleFrame,
  tickMs,
} from '../clock';

describe('game time', () => {
  it('starts on Day 1 at midnight and rolls over on hour and day boundaries', () => {
    expect(dayOf(0)).toBe(1);
    expect(hourOf(0)).toBe(0);
    expect(hourOf(3)).toBe(0);
    expect(hourOf(4)).toBe(1);
    expect(hourOf(95)).toBe(23);
    expect(dayOf(95)).toBe(1);
    expect(dayOf(96)).toBe(2);
    expect(hourOf(96)).toBe(0);
  });

  it('marks the ticks where hourly and daily systems run', () => {
    expect([0, 1, 2, 3, 4, 8].map(isHourStart)).toEqual([true, false, false, false, true, true]);
    expect([0, 4, 95, 96, 192].map(isDayStart)).toEqual([true, false, false, true, true]);
  });

  it('converts hours to ticks and speeds to real milliseconds', () => {
    expect(hoursToTicks(1)).toBe(TIME.TICKS_PER_HOUR);
    expect(hoursToTicks(12)).toBe(48);
    expect(hoursToTicks(0.25)).toBe(1);
    expect(tickMs(1)).toBe(250);
    expect(tickMs(2)).toBe(125);
    expect(tickMs(4)).toBe(62.5);
    expect(tickMs(8)).toBe(31.25);
  });

  it('formats the clock and durations', () => {
    expect(formatClock(0)).toBe('Day 1 · 00:00');
    expect(formatClock(36 * 96 + 14 * 4)).toBe('Day 37 · 14:00');
    expect(formatClock(36 * 96 + 14 * 4 + 3)).toBe('Day 37 · 14:45');
    expect(formatDuration(36)).toBe('9 h');
    expect(formatDuration(28 * 4)).toBe('1 d 4 h');
    expect(formatDuration(96)).toBe('1 d');
    expect(formatDuration(1)).toBe('1 h');
    expect(formatDuration(0)).toBe('0 h');
    expect(formatDuration(-5)).toBe('0 h');
  });
});

describe('planFrame', () => {
  it('drops frame gaps beyond 250 ms instead of catching up', () => {
    expect(planFrame(0, 1000, 1)).toEqual({ ticks: 1, accumulatorMs: 250 });
    expect(planFrame(0, 60_000, 8)).toEqual({ ticks: 8, accumulatorMs: 250 });
  });

  it('caps a frame at 8 ticks', () => {
    const plan = planFrame(100, 250, 8);
    expect(plan.ticks).toBe(TIME.MAX_TICKS_PER_FRAME);
    expect(plan.accumulatorMs).toBe(350);
  });

  it('plans whole ticks only and ignores negative gaps', () => {
    expect(planFrame(0, 16, 1)).toEqual({ ticks: 0, accumulatorMs: 16 });
    expect(planFrame(240, 16, 1)).toEqual({ ticks: 1, accumulatorMs: 256 });
    expect(planFrame(40, -30, 1)).toEqual({ ticks: 0, accumulatorMs: 40 });
  });

  it('accrues nothing while paused', () => {
    expect(planFrame(120, 16, 0)).toEqual({ ticks: 0, accumulatorMs: 120 });
  });
});

describe('settleFrame', () => {
  it('subtracts the ticks run and reports alpha toward the next tick', () => {
    const settle = settleFrame({ ticks: 1, accumulatorMs: 300 }, 1, 1);
    expect(settle.accumulatorMs).toBe(50);
    expect(settle.alpha).toBeCloseTo(0.2, 12);
    expect(settle.throttled).toBe(false);
  });

  it('clamps the backlog to one tick when the loop stopped early', () => {
    const settle = settleFrame({ ticks: 8, accumulatorMs: 250 }, 3, 8);
    expect(settle.accumulatorMs).toBe(tickMs(8));
    expect(settle.throttled).toBe(true);
    expect(settle.alpha).toBeLessThan(1);
    expect(settle.alpha).toBeGreaterThan(0.99);
  });

  it('clamps the backlog when two or more ticks are still owed', () => {
    const settle = settleFrame({ ticks: 8, accumulatorMs: 350 }, 8, 8);
    expect(settle.accumulatorMs).toBe(tickMs(8));
    expect(settle.throttled).toBe(true);
  });

  it('keeps a backlog under two ticks, with alpha still below 1', () => {
    const settle = settleFrame({ ticks: 8, accumulatorMs: 290 }, 8, 8);
    expect(settle.accumulatorMs).toBe(40);
    expect(settle.throttled).toBe(false);
    expect(settle.alpha).toBeLessThan(1);
  });

  it('keeps the accumulator while paused', () => {
    expect(settleFrame({ ticks: 0, accumulatorMs: 120 }, 0, 0)).toEqual({ accumulatorMs: 120, alpha: 0, throttled: false });
  });

  it('runs the same number of ticks per real second at any frame rate', () => {
    for (const frameMs of [8, 16.7, 33.3]) {
      let acc = 0;
      let ticks = 0;
      for (let t = 0; t < 10_000; t += frameMs) {
        const plan = planFrame(acc, frameMs, 4);
        ticks += plan.ticks;
        acc = settleFrame(plan, plan.ticks, 4).accumulatorMs;
      }
      expect(Math.abs(ticks - 160), `frame ${frameMs} ms`).toBeLessThanOrEqual(1);
    }
  });
});
