/**
 * localStorage persistence (§10): two rotating save slots, preferences, the
 * onboarding flag, the purge of turn-based saves and the two-tab guard.
 *
 * Every storage access is guarded: private modes and blocked storage throw on
 * access, and a full quota throws on write. A failed save never touches the
 * slot it did not write, so the previous save survives.
 */
import { RUNTIME, TIME } from '@/next/game/balance';
import { deserialize, serialize, type SaveMeta } from '@/next/game/save';
import type { AlertKind, GameState, MapMode, MapStatic, RunSpeed, Sim } from '@/next/game/types';

export type { SaveMeta } from '@/next/game/save';

export interface Prefs {
  autoPause: Record<AlertKind, boolean>;
  mapMode: MapMode;
  lastSpeed: RunSpeed;
  instantRightClick: boolean;
  showAllArmies: boolean;
  reduceMotion: boolean;
  coach: boolean;
  detail: 'auto' | 'low' | 'high';
}
export type SaveOutcome = 'ok' | 'quota' | 'blocked' | 'notOwner';

type Slot = 'a' | 'b';
const SLOT_KEY: Readonly<Record<Slot, string>> = { a: 'hegemon.save.v5.a', b: 'hegemon.save.v5.b' };
const LATEST_KEY = 'hegemon.save.v5.latest';
const PREFS_KEY = 'hegemon.prefs.v1';
const ONBOARDING_KEY = 'hegemon.onboarding.v1';
const SESSION_KEY = 'hegemon.session';
const LEGACY_KEYS = ['hegemon.save.v1', 'hegemon.save.v2', 'hegemon.save.v3', 'hegemon.save.v4'];

const ALERT_KINDS: readonly AlertKind[] = ['capitalAttacked', 'provinceAttacked', 'provinceLost', 'armyDestroyed', 'shortage', 'capitulation', 'firstContact'];
const MAP_MODES: readonly MapMode[] = ['political', 'terrain', 'resources', 'stability', 'supply'];
const DETAILS: readonly Prefs['detail'][] = ['auto', 'low', 'high'];
/** §8.4: on by default for the capital, first contact and shortages. */
const AUTO_PAUSE_DEFAULT: Readonly<Record<AlertKind, boolean>> = {
  capitalAttacked: true,
  provinceAttacked: false,
  provinceLost: false,
  armyDestroyed: false,
  shortage: true,
  capitulation: false,
  firstContact: true,
};

/** False once another tab has taken the game over; saving stops. */
let ownsGame = true;

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function read(key: string): string | null {
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function remove(key: string): void {
  try {
    storage()?.removeItem(key);
  } catch {
    // Nothing to clean up in storage we cannot reach.
  }
}

/** Writes or reports why it could not. */
function write(key: string, value: string): SaveOutcome {
  const store = storage();
  if (store === null) return 'blocked';
  try {
    store.setItem(key, value);
    return 'ok';
  } catch (error) {
    return isQuotaError(error) ? 'quota' : 'blocked';
  }
}

function isQuotaError(error: unknown): boolean {
  if (!(error instanceof DOMException)) return false;
  // 22 is the legacy code, 1014 Firefox's; the names cover current engines.
  return error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED' || error.code === 22 || error.code === 1014;
}

function latestSlot(): Slot | null {
  const latest = read(LATEST_KEY);
  return latest === 'a' || latest === 'b' ? latest : null;
}

/** Writes the slot `latest` does not point at, then flips `latest`. */
export function saveGame(sim: Sim, meta: SaveMeta): SaveOutcome {
  if (!ownsGame) return 'notOwner';
  const target: Slot = latestSlot() === 'a' ? 'b' : 'a';
  const written = write(SLOT_KEY[target], serialize(sim.state, sim.map, meta));
  if (written !== 'ok') return written;
  return write(LATEST_KEY, target);
}

/**
 * The newest save that validates against this map: the latest slot, else the
 * other one. A slot that fails validation is discarded.
 */
export function loadGame(map: MapStatic): { state: GameState; meta: SaveMeta } | null {
  const latest = latestSlot() ?? 'a';
  const order: Slot[] = latest === 'a' ? ['a', 'b'] : ['b', 'a'];
  for (const slot of order) {
    const text = read(SLOT_KEY[slot]);
    if (text === null) continue;
    const file = deserialize(text, map);
    if (file !== null) return file;
    remove(SLOT_KEY[slot]);
  }
  return null;
}

export function hasSave(): boolean {
  return read(SLOT_KEY.a) !== null || read(SLOT_KEY.b) !== null;
}

export function clearSave(): void {
  remove(SLOT_KEY.a);
  remove(SLOT_KEY.b);
  remove(LATEST_KEY);
}

/** Deletes turn-based saves (v1–v4); true when one was found, so the one-time note shows. */
export function purgeLegacySaves(): boolean {
  let found = false;
  for (const key of LEGACY_KEYS) {
    if (read(key) === null) continue;
    found = true;
    remove(key);
  }
  return found;
}

function defaultPrefs(): Prefs {
  return {
    autoPause: { ...AUTO_PAUSE_DEFAULT },
    mapMode: 'political',
    lastSpeed: TIME.DEFAULT_RUN_SPEED,
    instantRightClick: true,
    showAllArmies: false,
    reduceMotion: false,
    coach: true,
    detail: 'auto',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Stored preferences over the defaults; anything malformed falls back field by field. */
export function loadPrefs(): Prefs {
  const prefs = defaultPrefs();
  const text = read(PREFS_KEY);
  if (text === null) return prefs;
  let stored: unknown;
  try {
    stored = JSON.parse(text);
  } catch {
    return prefs;
  }
  if (!isRecord(stored)) return prefs;
  const autoPause = stored.autoPause;
  if (isRecord(autoPause)) {
    for (const kind of ALERT_KINDS) if (typeof autoPause[kind] === 'boolean') prefs.autoPause[kind] = autoPause[kind];
  }
  if (MAP_MODES.includes(stored.mapMode as MapMode)) prefs.mapMode = stored.mapMode as MapMode;
  const speed = TIME.SPEEDS.find((s) => s !== 0 && s === stored.lastSpeed);
  if (speed !== undefined && speed !== 0) prefs.lastSpeed = speed;
  if (DETAILS.includes(stored.detail as Prefs['detail'])) prefs.detail = stored.detail as Prefs['detail'];
  for (const key of ['instantRightClick', 'showAllArmies', 'reduceMotion', 'coach'] as const) {
    const value = stored[key];
    if (typeof value === 'boolean') prefs[key] = value;
  }
  return prefs;
}

export function savePrefs(prefs: Prefs): void {
  write(PREFS_KEY, JSON.stringify(prefs));
}

export function onboardingDone(): boolean {
  return read(ONBOARDING_KEY) === '1';
}

export function markOnboardingDone(): void {
  write(ONBOARDING_KEY, '1');
}

interface TabClaim {
  id: number;
  heartbeat: number;
}

function readClaim(text: string | null): TabClaim | null {
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    if (isRecord(value) && typeof value.id === 'number' && typeof value.heartbeat === 'number') return { id: value.id, heartbeat: value.heartbeat };
  } catch {
    // A malformed claim is no claim.
  }
  return null;
}

/**
 * The two-tab guard: this tab claims the game with an id newer than any
 * claim seen, and refreshes its heartbeat every RUNTIME.SESSION_HEARTBEAT_MS.
 * When another tab writes a newer claim (it opened the game, or pressed Take
 * over), this one stops saving and `onLost` runs. Calling claimTab again is
 * Take over. Returns the release function.
 */
export function claimTab(onLost: () => void): () => void {
  const previous = readClaim(read(SESSION_KEY));
  const id = Math.max(Date.now(), (previous?.id ?? 0) + 1);
  ownsGame = true;
  const beat = (): void => {
    if (ownsGame) write(SESSION_KEY, JSON.stringify({ id, heartbeat: Date.now() }));
  };
  beat();
  const timer = setInterval(beat, RUNTIME.SESSION_HEARTBEAT_MS);
  const target = typeof window === 'undefined' ? null : window;
  const onStorage = (event: Event): void => {
    const { key, newValue } = event as StorageEvent;
    if (key !== SESSION_KEY || !ownsGame) return;
    const claim = readClaim(newValue);
    if (claim === null || claim.id <= id) return;
    ownsGame = false;
    clearInterval(timer);
    onLost();
  };
  target?.addEventListener('storage', onStorage);
  return () => {
    clearInterval(timer);
    target?.removeEventListener('storage', onStorage);
    if (readClaim(read(SESSION_KEY))?.id === id) remove(SESSION_KEY);
  };
}

let pendingSave = false;

/**
 * Saves when the browser is idle (serialising takes a few milliseconds), or on
 * the next macrotask where requestIdleCallback is missing. Saves asked for
 * while one is pending collapse into it; `meta` is read when it runs.
 */
export function saveWhenIdle(sim: Sim, meta: () => SaveMeta, done: (outcome: SaveOutcome) => void): void {
  if (pendingSave) return;
  pendingSave = true;
  const run = (): void => {
    pendingSave = false;
    done(saveGame(sim, meta()));
  };
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: RUNTIME.AUTOSAVE_MS });
  else setTimeout(run, 0);
}
