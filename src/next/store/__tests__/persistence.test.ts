import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RUNTIME } from '@/next/game/balance';
import { tinySim } from '@/next/game/__tests__/helpers';
import type { Sim } from '@/next/game/types';
import {
  claimTab,
  clearSave,
  hasSave,
  loadGame,
  loadPrefs,
  markOnboardingDone,
  onboardingDone,
  purgeLegacySaves,
  saveGame,
  savePrefs,
  saveWhenIdle,
} from '../persistence';

/** An in-memory Storage whose writes fail with a quota error above `limit` characters. */
class MemoryStorage implements Storage {
  readonly items = new Map<string, string>();
  limit = Number.POSITIVE_INFINITY;
  get length(): number {
    return this.items.size;
  }
  clear(): void {
    this.items.clear();
  }
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.items.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
  setItem(key: string, value: string): void {
    if (value.length > this.limit) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    this.items.set(key, value);
  }
}

let store: MemoryStorage;
let events: EventTarget;

function world(): Sim {
  return tinySim({
    provinces: { a: { owner: 'me', capitalOf: 'me' }, b: { owner: 'foe', capitalOf: 'foe' } },
    edges: [['a', 'b']],
    armies: [{ owner: 'me', at: 'a', units: { rifles: 2 } }],
    stocks: { me: { funds: 100 } },
  }).sim;
}

beforeEach(() => {
  store = new MemoryStorage();
  events = new EventTarget();
  vi.stubGlobal('localStorage', store);
  vi.stubGlobal('window', events);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('save slots', () => {
  it('rotates between the two slots and loads the latest', () => {
    const sim = world();
    expect(hasSave()).toBe(false);
    expect(saveGame(sim, { savedAt: 1, playedMs: 10 })).toBe('ok');
    expect(store.getItem('hegemon.save.v5.latest')).toBe('a');
    sim.state.nations[sim.state.player]!.stocks.funds = 250;
    expect(saveGame(sim, { savedAt: 2, playedMs: 20 })).toBe('ok');
    expect(store.getItem('hegemon.save.v5.latest')).toBe('b');
    expect(store.getItem('hegemon.save.v5.a')).not.toBeNull();
    const loaded = loadGame(sim.map);
    expect(loaded?.meta).toEqual({ savedAt: 2, playedMs: 20 });
    expect(loaded?.state.nations[sim.state.player]!.stocks.funds).toBe(250);
    expect(hasSave()).toBe(true);
    clearSave();
    expect(hasSave()).toBe(false);
    expect(loadGame(sim.map)).toBeNull();
  });

  it('keeps the previous slot through a quota failure', () => {
    const sim = world();
    expect(saveGame(sim, { savedAt: 1, playedMs: 10 })).toBe('ok');
    store.limit = 10;
    sim.state.tick = 400;
    expect(saveGame(sim, { savedAt: 2, playedMs: 20 })).toBe('quota');
    expect(store.getItem('hegemon.save.v5.latest')).toBe('a');
    expect(loadGame(sim.map)?.meta.savedAt).toBe(1);
    expect(loadGame(sim.map)?.state.tick).toBe(0);
  });

  it('reports blocked storage', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(saveGame(world(), { savedAt: 1, playedMs: 0 })).toBe('blocked');
    expect(hasSave()).toBe(false);
    expect(loadGame(world().map)).toBeNull();
  });

  it('discards a save that does not validate and falls back to the other slot', () => {
    const sim = world();
    saveGame(sim, { savedAt: 1, playedMs: 0 });
    saveGame(sim, { savedAt: 2, playedMs: 0 });
    store.setItem('hegemon.save.v5.b', '{"format":4}');
    expect(loadGame(sim.map)?.meta.savedAt).toBe(1);
    expect(store.getItem('hegemon.save.v5.b')).toBeNull();
    store.setItem('hegemon.save.v5.a', 'not json');
    expect(loadGame(sim.map)).toBeNull();
    expect(hasSave()).toBe(false);
  });

  it('saves when idle, once for a burst of requests', () => {
    vi.useFakeTimers();
    const sim = world();
    const outcomes: string[] = [];
    let metaCalls = 0;
    const meta = (): { savedAt: number; playedMs: number } => {
      metaCalls += 1;
      return { savedAt: 9, playedMs: 0 };
    };
    saveWhenIdle(sim, meta, (o) => outcomes.push(o));
    saveWhenIdle(sim, meta, (o) => outcomes.push(o));
    expect(outcomes).toEqual([]);
    vi.runAllTimers();
    expect(outcomes).toEqual(['ok']);
    expect(metaCalls).toBe(1);
    expect(loadGame(sim.map)?.meta.savedAt).toBe(9);
  });
});

describe('legacy saves, prefs and onboarding', () => {
  it('purges v1 to v4 saves once', () => {
    store.setItem('hegemon.save.v4', '{}');
    store.setItem('hegemon.save.v2', '{}');
    store.setItem('hegemon.help-seen', '1');
    expect(purgeLegacySaves()).toBe(true);
    expect(store.getItem('hegemon.save.v4')).toBeNull();
    expect(store.getItem('hegemon.help-seen')).toBe('1');
    expect(purgeLegacySaves()).toBe(false);
  });

  it('loads defaults, keeps valid fields and ignores malformed ones', () => {
    const defaults = loadPrefs();
    expect(defaults).toMatchObject({ mapMode: 'political', lastSpeed: 1, showAllArmies: false, coach: true, detail: 'auto' });
    expect(defaults.autoPause).toMatchObject({ capitalAttacked: true, firstContact: true, shortage: true, provinceLost: false, armyDestroyed: false, capitulation: false });
    savePrefs({ ...defaults, mapMode: 'supply', lastSpeed: 4, showAllArmies: true, autoPause: { ...defaults.autoPause, provinceLost: true } });
    expect(loadPrefs()).toMatchObject({ mapMode: 'supply', lastSpeed: 4, showAllArmies: true, autoPause: { provinceLost: true } });
    store.setItem('hegemon.prefs.v1', JSON.stringify({ mapMode: 'chaos', lastSpeed: 3, coach: 'yes', reduceMotion: true }));
    expect(loadPrefs()).toMatchObject({ mapMode: 'political', lastSpeed: 1, coach: true, reduceMotion: true });
    store.setItem('hegemon.prefs.v1', '{');
    expect(loadPrefs()).toEqual(defaults);
  });

  it('remembers that onboarding is done', () => {
    expect(onboardingDone()).toBe(false);
    markOnboardingDone();
    expect(onboardingDone()).toBe(true);
  });
});

describe('the two-tab guard', () => {
  const claimFrom = (id: number): Event => Object.assign(new Event('storage'), { key: 'hegemon.session', newValue: JSON.stringify({ id, heartbeat: id }) });

  it('heartbeats, yields to a newer tab and stops saving', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const lost = vi.fn();
    const release = claimTab(lost);
    const claim = JSON.parse(store.getItem('hegemon.session')!) as { id: number; heartbeat: number };
    expect(claim).toEqual({ id: 1_000_000, heartbeat: 1_000_000 });
    vi.advanceTimersByTime(RUNTIME.SESSION_HEARTBEAT_MS);
    expect((JSON.parse(store.getItem('hegemon.session')!) as { heartbeat: number }).heartbeat).toBe(1_000_000 + RUNTIME.SESSION_HEARTBEAT_MS);

    events.dispatchEvent(claimFrom(999_999));
    expect(lost).not.toHaveBeenCalled();
    events.dispatchEvent(claimFrom(2_000_000));
    expect(lost).toHaveBeenCalledTimes(1);
    expect(saveGame(world(), { savedAt: 1, playedMs: 0 })).toBe('notOwner');

    // Take over: a fresh claim, newer than the other tab's, and saving resumes.
    release();
    store.setItem('hegemon.session', JSON.stringify({ id: 2_000_000, heartbeat: 2_000_000 }));
    const releaseAgain = claimTab(lost);
    expect((JSON.parse(store.getItem('hegemon.session')!) as { id: number }).id).toBe(2_000_001);
    expect(saveGame(world(), { savedAt: 1, playedMs: 0 })).toBe('ok');
    releaseAgain();
    expect(store.getItem('hegemon.session')).toBeNull();
  });
});
