/**
 * The single requestAnimationFrame loop (§1, §9.6). It owns the sim step and
 * drawing: each frame it plans whole ticks from the real time that passed,
 * runs them until the plan is done or the frame's sim budget is spent, hands
 * the tick events to the store and calls every registered renderer with the
 * interpolation alpha. Wall time stops here; src/next/game never sees it.
 *
 * While paused and idle the loop sleeps (no frames at all, for the battery);
 * input, camera changes, commands and a speed change call wake().
 */
import { TIME } from '@/next/game/balance';
import { takeEvents } from '@/next/game/cache';
import { planFrame, settleFrame, tickMs } from '@/next/game/clock';
import { stepTick } from '@/next/game/sim';
import type { RunSpeed, Sim, Speed, TickEvents } from '@/next/game/types';
import { getSession } from './session';

export interface FrameInfo {
  alpha: number;
  ticksRun: number;
  simMs: number;
  throttled: boolean;
  effectiveSpeed: number;
}
export interface LoopHooks {
  sim(): Sim | null;
  speed(): Speed;
  coarse: boolean;
  onEvents(events: TickEvents): void;
  onFrame(info: FrameInfo): void;
}

/** Effective speed is measured over windows of about this many real milliseconds. */
const SPEED_WINDOW_MS = 1000;

const renderers = new Set<(info: FrameInfo) => void>();
let wakeLoop: (() => void) | null = null;

/** Adds a draw callback; it runs once per frame after the sim step. */
export function registerRenderer(draw: (info: FrameInfo) => void): () => void {
  renderers.add(draw);
  wake();
  return () => {
    renderers.delete(draw);
  };
}

/** Asks the loop for a frame; while paused and idle it otherwise sleeps. */
export function wake(): void {
  wakeLoop?.();
}

function isHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

/** The speed a frame actually runs at: nothing runs while hidden, without a game, or once it is decided. */
function runningSpeed(sim: Sim | null, requested: Speed): Speed {
  if (sim === null || isHidden()) return 0;
  if (sim.state.status !== 'playing' && !sim.state.sandbox) return 0;
  return requested;
}

/** Starts the loop; the returned function stops it. Only one loop runs at a time. */
export function startLoop(hooks: LoopHooks): () => void {
  const budgetMs = hooks.coarse ? TIME.SIM_BUDGET_MS_COARSE : TIME.SIM_BUDGET_MS_FINE;
  let frame: number | null = null;
  let stopped = false;
  let woken = true;
  let last: number | null = null;
  let accumulatorMs = 0;
  /** The running speed the accumulator's milliseconds were measured at. */
  let accumulatorSpeed: RunSpeed | null = null;
  let alpha = 0;
  let measuredSpeed: Speed = 0;
  let effectiveSpeed = 0;
  let windowMs = 0;
  let windowTicks = 0;
  let slowSince: number | null = null;

  const schedule = (): void => {
    if (frame === null && !stopped) frame = requestAnimationFrame(onFrame);
  };

  const measure = (speed: Speed, elapsed: number, ticksRun: number, now: number): boolean => {
    if (speed !== measuredSpeed) {
      measuredSpeed = speed;
      effectiveSpeed = speed;
      windowMs = 0;
      windowTicks = 0;
      slowSince = null;
    }
    if (speed === 0) return false;
    windowMs += elapsed;
    windowTicks += ticksRun;
    if (windowMs >= SPEED_WINDOW_MS) {
      effectiveSpeed = (windowTicks / TIME.TICKS_PER_HOUR) * (1000 / windowMs);
      windowMs = 0;
      windowTicks = 0;
    }
    if (effectiveSpeed >= TIME.THROTTLE_SHOW_BELOW * speed) {
      slowSince = null;
      return false;
    }
    slowSince ??= now;
    return now - slowSince >= TIME.THROTTLE_NOTICE_MS;
  };

  function onFrame(now: number): void {
    frame = null;
    if (stopped) return;
    // A frame after a sleep (or a hidden spell) starts a fresh measure: time away is never caught up.
    const elapsed = last === null ? 0 : Math.max(0, now - last);
    last = now;
    woken = false;
    const sim = hooks.sim();
    const speed = runningSpeed(sim, hooks.speed());
    if (speed !== 0) {
      // A speed change keeps the share of a tick already owed, so 1x to 8x does not burst ticks.
      if (accumulatorSpeed !== null && accumulatorSpeed !== speed) accumulatorMs *= tickMs(speed) / tickMs(accumulatorSpeed);
      accumulatorSpeed = speed;
    }
    const plan = planFrame(accumulatorMs, elapsed, speed);
    let ticksRun = 0;
    let simMs = 0;
    if (sim !== null && plan.ticks > 0) {
      const started = performance.now();
      // Ticks are atomic; the budget is checked between them.
      while (ticksRun < plan.ticks && simMs < budgetMs) {
        stepTick(sim);
        ticksRun += 1;
        simMs = performance.now() - started;
      }
    }
    const settled = settleFrame(plan, ticksRun, speed);
    accumulatorMs = settled.accumulatorMs;
    // While paused the renderer keeps the alpha it had, so moving armies stay put.
    if (speed !== 0) alpha = settled.alpha;
    const session = getSession();
    if (speed !== 0 && session !== null && session.sim === sim) session.playedMs += Math.min(elapsed, TIME.MAX_FRAME_MS);
    const throttled = measure(speed, elapsed, ticksRun, now);
    if (sim !== null && ticksRun > 0) hooks.onEvents(takeEvents(sim));
    const info: FrameInfo = { alpha, ticksRun, simMs, throttled, effectiveSpeed: speed === 0 ? 0 : effectiveSpeed };
    hooks.onFrame(info);
    for (const draw of renderers) draw(info);
    if (speed !== 0 || woken) schedule();
    else last = null;
  }

  const onVisibility = (): void => {
    last = null;
    if (!isHidden()) wake();
  };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);

  wakeLoop = () => {
    woken = true;
    schedule();
  };
  schedule();

  return () => {
    stopped = true;
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    wakeLoop = null;
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
  };
}

/**
 * Calls `onHidden` when the tab is hidden or the page is being left (§1): the
 * store pauses there, remembers the speed and saves at once. Window blur alone
 * does not count. Returns the unsubscribe function.
 */
export function onTabHidden(onHidden: () => void): () => void {
  if (typeof document === 'undefined' || typeof window === 'undefined') return () => undefined;
  const visibility = (): void => {
    if (isHidden()) onHidden();
  };
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('pagehide', onHidden);
  return () => {
    document.removeEventListener('visibilitychange', visibility);
    window.removeEventListener('pagehide', onHidden);
  };
}
