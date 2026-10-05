import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tinySim } from '@/next/game/__tests__/helpers';
import type { Sim, Speed, TickEvents } from '@/next/game/types';
import { registerRenderer, startLoop, wake, type FrameInfo } from '../loop';
import { closeSession, getSession, issue, openSession, subscribeSession } from '../session';

/** requestAnimationFrame under test control: frames run only when the test says so. */
let queued: ((now: number) => void)[] = [];
function frameAt(now: number): boolean {
  const callback = queued.shift();
  callback?.(now);
  return callback !== undefined;
}

function world(): Sim {
  return tinySim({
    // Three nations, so nobody holds half the VP at tick 0.
    provinces: { a: { owner: 'me', capitalOf: 'me' }, b: { owner: 'me' }, c: { owner: 'foe', capitalOf: 'foe' }, d: { owner: 'foe' }, e: { owner: 'far', capitalOf: 'far' } },
    edges: [
      ['a', 'b'],
      ['b', 'c'],
      ['c', 'd'],
      ['d', 'e'],
    ],
    armies: [{ owner: 'me', at: 'a', units: { rifles: 2 } }],
    stocks: { me: { funds: 1000, food: 1000 } },
  }).sim;
}

interface Harness {
  sim: Sim;
  frames: FrameInfo[];
  events: TickEvents[];
  setSpeed(speed: Speed): void;
  stop(): void;
}

function harness(sim = world()): Harness {
  let speed: Speed = 1;
  const frames: FrameInfo[] = [];
  const events: TickEvents[] = [];
  const stop = startLoop({
    sim: () => sim,
    speed: () => speed,
    coarse: false,
    onEvents: (e) => events.push(e),
    onFrame: (info) => frames.push(info),
  });
  return { sim, frames, events, setSpeed: (s) => void (speed = s), stop };
}

beforeEach(() => {
  queued = [];
  // The sim budget is measured with performance.now; frozen, it never runs out unless a test says so.
  vi.spyOn(performance, 'now').mockReturnValue(0);
  vi.stubGlobal('requestAnimationFrame', (cb: (now: number) => void) => queued.push(cb));
  vi.stubGlobal('cancelAnimationFrame', () => {
    queued = [];
  });
});

afterEach(() => {
  closeSession();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('the frame loop', () => {
  it('runs whole ticks from real time and reports the interpolation alpha', () => {
    const h = harness();
    frameAt(0);
    expect(h.frames[0]).toMatchObject({ ticksRun: 0, alpha: 0 });
    frameAt(250);
    expect(h.frames[1]).toMatchObject({ ticksRun: 1, alpha: 0 });
    frameAt(375);
    expect(h.frames[2]).toMatchObject({ ticksRun: 0, alpha: 0.5 });
    expect(h.sim.state.tick).toBe(1);
    expect(h.events.map((e) => e.ticks)).toEqual([1]);
    h.setSpeed(8);
    frameAt(475);
    // Half a tick was owed; at 8x that is 15.625 ms, plus 100 ms: 3 ticks and 0.7 of the next.
    expect(h.frames[3]).toMatchObject({ ticksRun: 3 });
    expect(h.frames[3]!.alpha).toBeCloseTo(0.7, 9);
    h.stop();
  });

  it('caps a long gap at one frame of game time: no catch-up', () => {
    const h = harness();
    h.setSpeed(8);
    frameAt(0);
    frameAt(5000);
    expect(h.frames[1]!.ticksRun).toBe(8);
    h.stop();
  });

  it('keeps the last alpha while paused, then sleeps until woken', () => {
    const h = harness();
    frameAt(0);
    frameAt(125);
    expect(h.frames[1]!.alpha).toBe(0.5);
    h.setSpeed(0);
    frameAt(250);
    expect(h.frames[2]).toMatchObject({ ticksRun: 0, alpha: 0.5, effectiveSpeed: 0 });
    expect(queued).toHaveLength(0);
    wake();
    expect(queued).toHaveLength(1);
    expect(frameAt(9000)).toBe(true);
    expect(h.frames[3]).toMatchObject({ ticksRun: 0, alpha: 0.5 });
    expect(queued).toHaveLength(0);
    h.setSpeed(1);
    wake();
    // The first frame after a sleep measures from itself, not from before the sleep.
    frameAt(20_000);
    expect(h.frames[4]!.ticksRun).toBe(0);
    frameAt(20_250);
    expect(h.frames[5]!.ticksRun).toBe(1);
    h.stop();
  });

  it('runs nothing once the game is decided, unless in the sandbox', () => {
    const h = harness();
    h.sim.state.status = 'won';
    frameAt(0);
    frameAt(250);
    expect(h.sim.state.tick).toBe(0);
    h.sim.state.sandbox = true;
    wake();
    frameAt(500);
    frameAt(750);
    expect(h.sim.state.tick).toBe(1);
    h.stop();
  });

  it('stops at its sim budget and then reports the effective speed', () => {
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => (clock += 10));
    const h = harness();
    h.setSpeed(8);
    for (let t = 0; t <= 3000; t += 250) frameAt(t);
    expect(h.frames.slice(1).every((f) => f.ticksRun === 1)).toBe(true);
    const last = h.frames[h.frames.length - 1]!;
    expect(last.effectiveSpeed).toBeCloseTo(1, 9);
    expect(last.throttled).toBe(true);
    expect(h.frames[4]!.throttled).toBe(false);
    h.stop();
  });

  it('calls every registered renderer once per frame', () => {
    const h = harness();
    const drawn: number[] = [];
    const unregister = registerRenderer((info) => drawn.push(info.ticksRun));
    frameAt(0);
    frameAt(250);
    unregister();
    frameAt(500);
    expect(drawn).toEqual([0, 1]);
    h.stop();
    expect(frameAt(750)).toBe(false);
  });
});

describe('the session', () => {
  const geometry = {} as Parameters<typeof openSession>[1];

  it('holds the running game, applies the player commands and counts played time', () => {
    const notified: number[] = [];
    const unsubscribe = subscribeSession(() => notified.push(1));
    expect(issue({ kind: 'stop', nation: world().state.player, armies: [] })).toEqual({ ok: false, reason: 'No game is running' });
    const base = world();
    const session = openSession(base.map, geometry, base.state, 1000);
    expect(getSession()).toBe(session);
    expect(session.sim.cache.commandLog).toEqual([]);
    const army = session.sim.state.armies[0]!;
    expect(issue({ kind: 'move', nation: session.sim.state.player, armies: [army.id], to: session.sim.map.provinceById.get('b')!, together: false, append: false }).ok).toBe(true);
    expect(issue({ kind: 'merge', nation: session.sim.state.player, armies: [army.id] }).ok).toBe(false);
    expect(session.sim.cache.commandLog).toHaveLength(1);
    expect(notified).toHaveLength(2);

    const stop = startLoop({ sim: () => getSession()?.sim ?? null, speed: () => 2, coarse: true, onEvents: () => undefined, onFrame: () => undefined });
    frameAt(0);
    frameAt(200);
    frameAt(400);
    expect(session.playedMs).toBe(1400);
    stop();
    closeSession();
    expect(getSession()).toBeNull();
    expect(notified).toHaveLength(3);
    unsubscribe();
  });
});
