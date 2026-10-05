import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { isIdle } from '@/next/game/armies';
import { armyById, armiesOf, ownedProvinces } from '@/next/game/cache';
import { totalCount } from '@/next/game/units';
import type { ArmyId, ProvinceIx, Sim } from '@/next/game/types';
import { getMapFrame, playerNation, useGameStore } from '../gameStore';
import { getSession } from '../session';

/** The store against the real map, in Node: fetch reads public/, frames run when the test says so. */
const PUBLIC = join(process.cwd(), 'public');
let frames: ((now: number) => void)[] = [];
let clock = 0;

function runFrames(count: number, stepMs: number): void {
  for (let i = 0; i < count; i += 1) {
    clock += stepMs;
    const callback = frames.shift();
    callback?.(clock);
  }
}

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, v),
  };
}

function sim(): Sim {
  const s = getSession()?.sim;
  if (s === undefined) throw new Error('no game');
  return s;
}

function store() {
  return useGameStore.getState();
}

/** A hostile province next to the player's land that one of `army`'s neighbours borders. */
function hostileNeighbour(s: Sim, at: ProvinceIx): ProvinceIx | null {
  for (const e of s.map.edges[at]!) if (!e.sea && s.state.provinces[e.to]!.owner !== s.state.player) return e.to;
  return null;
}

beforeAll(async () => {
  vi.stubGlobal('localStorage', memoryStorage());
  vi.stubGlobal('requestAnimationFrame', (cb: (now: number) => void) => frames.push(cb));
  vi.stubGlobal('cancelAnimationFrame', () => {
    frames = [];
  });
  vi.stubGlobal('fetch', (url: string) => {
    const file = url.split('/').pop() ?? '';
    const text = readFileSync(join(PUBLIC, file), 'utf8');
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(JSON.parse(text) as unknown) });
  });
  await store().init('');
}, 60_000);

afterAll(() => {
  store().abandonGame();
  vi.unstubAllGlobals();
});

describe('gameStore', () => {
  it('loads the world, starts a paused game with the coach and frames the map once', () => {
    expect(store().phase).toBe('menu');
    expect(store().hasSavedGame).toBe(false);
    store().startGame('250', 'standard', 'store');
    expect(store().phase).toBe('playing');
    expect(store().speed).toBe(0);
    expect(store().coachStep).toBe(1);
    expect(playerNation()).toBe(sim().state.player);
    // The first save goes out when idle; the frame object is stable while nothing changes.
    const first = getMapFrame();
    expect(first).not.toBeNull();
    expect(getMapFrame()).toBe(first);
  }, 60_000);

  it('selects an army, drafts an attack with a preview, and orders it through a command', () => {
    const s = sim();
    const army = armiesOf(s, s.state.player)[0]!;
    store().clickMarker([army.id], false);
    expect(store().selection).toEqual({ kind: 'armies', armies: [army.id] });
    expect(store().coachStep).toBe(2);
    const target = hostileNeighbour(s, army.at);
    expect(target).not.toBeNull();
    store().clickProvince(target!, false);
    expect(store().draft?.to).toBe(target);
    expect(store().preview?.intent).toBe('attack');
    expect(getMapFrame()?.preview).toBe(store().preview);
    store().confirmDraft();
    expect(store().draft).toBeNull();
    const moved = armyById(s, army.id)!;
    expect(moved.path.length + (moved.leg === null ? 0 : 1)).toBeGreaterThan(0);
    expect(store().coachStep).toBe(3);
  });

  it('runs at the chosen speed, publishes views and pauses with Space', () => {
    const tick = sim().state.tick;
    const version = store().uiVersion;
    store().togglePause();
    expect(store().speed).toBe(1);
    expect(store().coachStep).toBe(4);
    runFrames(40, 50);
    expect(sim().state.tick).toBeGreaterThan(tick);
    expect(store().uiVersion).toBeGreaterThan(version);
    store().togglePause();
    expect(store().speed).toBe(0);
    expect(store().resumeSpeed).toBe(1);
    const paused = sim().state.tick;
    runFrames(10, 50);
    expect(sim().state.tick).toBe(paused);
  });

  it('refuses a bad command with a toast, and cancels the draft, the selection, then the panel', () => {
    const s = sim();
    const result = store().command({ kind: 'disband', nation: s.state.player, army: 999_999 as ArmyId });
    expect(result.ok).toBe(false);
    expect(store().toasts[0]?.entry.severity).toBe('bad');
    const army = armiesOf(s, s.state.player)[0]!;
    store().selectArmies([army.id]);
    store().openPanel('economy');
    store().cancel();
    expect(store().selection.kind).toBe('none');
    expect(store().panel).toBe('economy');
    store().cancel();
    expect(store().panel).toBeNull();
  });

  it('opens Attack with… pre-ticked, splits and merges by keyboard action, and cycles idle armies', () => {
    const s = sim();
    const own = ownedProvinces(s, s.state.player);
    const target = hostileNeighbour(s, own.find((p) => hostileNeighbour(s, p) !== null)!)!;
    store().openAttackWith(target);
    expect(store().attackWith?.target).toBe(target);
    expect(store().panel).toBe('attackWith');
    store().cancel();
    expect(store().attackWith).toBeNull();

    const guard = armiesOf(s, s.state.player).find((a) => isIdle(s, a) && totalCount(a.units) >= 2)!;
    store().selectArmies([guard.id]);
    const before = armiesOf(s, s.state.player).length;
    store().splitSelected();
    expect(armiesOf(s, s.state.player).length).toBe(before + 1);
    const split = store().selection;
    expect(split.kind === 'armies' ? split.armies.length : 0).toBe(2);
    store().mergeSelected();
    expect(armiesOf(s, s.state.player).length).toBe(before);

    store().nextIdleArmy(1);
    expect(store().selection.kind).toBe('armies');
  });

  it('saves on demand and comes back to the menu with a save to continue', () => {
    store().saveNow();
    expect(store().saveWarning).toBeNull();
    store().abandonGame();
    expect(store().phase).toBe('menu');
    expect(store().hasSavedGame).toBe(true);
    store().resumeGame();
    expect(store().phase).toBe('playing');
    expect(sim().state.tick).toBeGreaterThan(0);
  }, 60_000);
});
