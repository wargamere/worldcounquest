'use client';

/**
 * The UI store (§11.5, §9.6): phase, speed, selection, the order draft and its
 * preview, Suggest cards, panels, toasts, auto-pause, the coach and prefs. The
 * Sim itself lives in session.ts, outside React; this store never copies it.
 * Components read game data through useSimView, which recomputes a view only
 * when `uiVersion` moves: at most every RUNTIME.VIEW_PUBLISH_MS while ticks run,
 * and at once after a command, a selection or panel change, or an alert.
 *
 * Every change to the game goes through `command` (and so through
 * session.issue → applyCommand), with two documented exceptions that have no
 * Command: "Keep playing" sets state.sandbox, and "Show all armies" records
 * stats.fogOff, as the end screen reports it.
 */
import { useMemo, useSyncExternalStore } from 'react';
import { create, type StoreApi, type UseBoundStore } from 'zustand';
import { ADVISOR, MOVEMENT, RUNTIME, TIME } from '@/next/game/balance';
import { advise as adviseCards, suggestFirstTarget, suggestForce, type Suggestion } from '@/next/game/ai/advisor';
import { armyById, armiesAt, ownedProvinces } from '@/next/game/cache';
import { formatDuration } from '@/next/game/clock';
import { concernsPlayer } from '@/next/game/feed';
import { createGame } from '@/next/game/init';
import { previewOrder } from '@/next/game/orders';
import { serialize } from '@/next/game/save';
import { isArmyVisible } from '@/next/game/supply';
import { createSim } from '@/next/game/sim';
import type {
  Alert,
  AlertKind,
  ArmyId,
  Command,
  CommandResult,
  Difficulty,
  FeedEntry,
  GameState,
  MapMode,
  MapStatic,
  NationIx,
  OrderPreview,
  ProvinceIx,
  RunSpeed,
  Severity,
  Sim,
  Speed,
  Stance,
  TickEvents,
  UnitCounts,
} from '@/next/game/types';
import { UNIT_TYPES } from '@/next/game/types';
import { buildMap } from '@/next/game/world';
import { isIdle } from '@/next/game/armies';
import { armyLocation, idleArmies, incomingArmies, nationSummary, playerBattles, VERDICT_LABEL } from '@/next/game/views';
import { buildGeometry, type MapGeometry } from '@/next/lib/geometry';
import { fetchMapFiles } from '@/next/lib/mapData';
import type { MapFrame, MapHandle } from '@/next/components/map/types';
import { onTabHidden, startLoop, wake, type FrameInfo } from './loop';
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
  type Prefs,
  type SaveOutcome,
} from './persistence';
import { closeSession, getSession, issue, openSession, subscribeSession } from './session';

export type Selection =
  | { kind: 'none' }
  | { kind: 'province'; province: ProvinceIx }
  | { kind: 'armies'; armies: ArmyId[] }
  | { kind: 'battle'; province: ProvinceIx };
export type PanelId = 'economy' | 'exchange' | 'production' | 'powers' | 'feed' | 'help' | 'settings' | 'attackWith';
export interface Draft {
  armies: ArmyId[];
  to: ProvinceIx;
  together: boolean;
  append: boolean;
}
/** Attack with… (§4.6): the target and the armies ticked so far. */
export interface AttackWithState {
  target: ProvinceIx;
  picked: ArmyId[];
}
/** A recommended start's card (§8.7). */
export interface StartCard {
  countryId: string;
  name: string;
  provinces: number;
  vp: number;
  fundsPerDay: number;
  goods: { food: number; steel: number; oil: number };
  units: number;
  firstTarget: string | null;
}

export interface GameStore {
  phase: 'loading' | 'menu' | 'playing' | 'error';
  loadError: string | null;
  hasSavedGame: boolean;
  uiVersion: number;
  speed: Speed;
  resumeSpeed: RunSpeed;
  throttled: boolean;
  effectiveSpeed: number;
  pausedReason: string | null;
  selection: Selection;
  hover: ProvinceIx | null;
  draft: Draft | null;
  preview: OrderPreview | null;
  multiSelect: boolean;
  suggestions: Suggestion[];
  suggestionIndex: number;
  panel: PanelId | null;
  sheet: 'peek' | 'half' | 'full';
  mapMode: MapMode;
  toasts: { id: number; entry: FeedEntry }[];
  coachStep: number | null;
  prefs: Prefs;
  tabLost: boolean;
  /** Beyond the §11.5 core. */
  heavyVersion: number;
  legacyNote: boolean;
  attackWith: AttackWithState | null;
  rallyFrom: ProvinceIx | null;
  coachTarget: { target: ProvinceIx; armies: ArmyId[] } | null;
  endDismissed: boolean;
  saveWarning: SaveOutcome | null;
  lastAlert: Alert | null;
  coarse: boolean;
  init(basePath: string): Promise<void>;
  startGame(countryId: string, difficulty: Difficulty, seed: string): void;
  resumeGame(): void;
  abandonGame(): void;
  saveNow(): void;
  setSpeed(speed: Speed): void;
  togglePause(): void;
  stepSpeed(direction: 1 | -1): void;
  clickMarker(armies: readonly ArmyId[], additive: boolean): void;
  clickProvince(p: ProvinceIx, additive: boolean): void;
  boxSelect(armies: readonly ArmyId[], additive: boolean): void;
  setHover(p: ProvinceIx | null): void;
  orderNow(p: ProvinceIx, append: boolean): void;
  openDraft(armies: readonly ArmyId[], p: ProvinceIx): void;
  setDraftOption(o: Partial<Pick<Draft, 'together' | 'append'>>): void;
  confirmDraft(): void;
  cancel(): void;
  command(c: Command): CommandResult;
  advise(): void;
  acceptSuggestion(): void;
  nextSuggestion(): void;
  openAttackWith(p: ProvinceIx): void;
  delegate(stance: Stance, target: 'selected' | 'idle'): void;
  nextIdleArmy(direction: 1 | -1): void;
  nextBattle(): void;
  latestAlert(): void;
  openPanel(p: PanelId | null): void;
  setSheet(s: 'peek' | 'half' | 'full'): void;
  setMapMode(m: MapMode): void;
  focusProvinces(ps: readonly ProvinceIx[]): void;
  focusHome(): void;
  focusCapital(): void;
  dismissToast(id: number): void;
  setPrefs(p: Partial<Prefs>): void;
  advanceCoach(): void;
  skipCoach(): void;
  takeOverTab(): void;
  onEvents(events: TickEvents): void;
  onFrame(info: FrameInfo): void;
  /** Beyond the §11.5 core. */
  selectArmies(armies: readonly ArmyId[]): void;
  selectBattle(p: ProvinceIx): void;
  setMultiSelect(on: boolean): void;
  toggleAttackWith(army: ArmyId): void;
  confirmAttackWith(): void;
  startRally(p: ProvinceIx): void;
  keepPlaying(): void;
  viewMap(): void;
  playAgain(): void;
  newGame(): void;
  deleteSave(): void;
  dismissLegacyNote(): void;
  closeSuggestions(): void;
  toast(text: string, severity: Severity): void;
  nextIncoming(): void;
  focusNation(n: NationIx): void;
  goToEntry(entry: FeedEntry): void;
  replayCoach(): void;
  /** Keyboard actions on the selection (§8.5): M, S, R, Delete, Shift+Delete, T. */
  mergeSelected(): void;
  splitSelected(): void;
  retreatSelected(): void;
  stopSelected(): void;
  disbandSelected(confirm: (name: string) => boolean): void;
  trainingForSelection(): void;
}

// ------------------------------------------------------------ outside React

/** Loaded once per page: the static map and its projected geometry. */
let mapStatic: MapStatic | null = null;
let mapGeometry: MapGeometry | null = null;
let mapHandle: MapHandle | null = null;
let framedSession: Sim | null = null;
let stopLoop: (() => void) | null = null;
let releaseTab: (() => void) | null = null;
let stopHidden: (() => void) | null = null;
let initPromise: Promise<void> | null = null;
/** The renderer's interpolation alpha from the last frame. */
let lastAlpha = 0;
let lastPublishMs = 0;
let lastHeavyMs = 0;
let lastSaveMs = 0;
let lastSavedTick = -1;
let hoverTimer: ReturnType<typeof setTimeout> | null = null;
let lastHoverPreviewMs = 0;
let localToastId = -1;
const toastTimers = new Map<number, ReturnType<typeof setTimeout>>();
const startCards = new Map<string, StartCard>();

export function getMapStatic(): MapStatic | null {
  return mapStatic;
}
export function getGeometry(): MapGeometry | null {
  return mapGeometry;
}
export function getMapHandle(): MapHandle | null {
  return mapHandle;
}
/** The player's nation in the running game, for building Commands. */
export function playerNation(): NationIx | null {
  return currentSim()?.state.player ?? null;
}
/** Dev builds: the session's seed and command log as JSON, for an exact replay (§10). */
export function exportCommandLog(): string | null {
  const sim = currentSim();
  const log = sim?.cache.commandLog ?? null;
  if (sim === null || log === null) return null;
  const { state, map } = sim;
  return JSON.stringify({ seed: state.seed, difficulty: state.difficulty, player: map.nations[state.player]!.id, mapHash: map.hash, commands: log });
}

/** The size of a save of the running game now, in UTF-16 code units (the ?debug=perf overlay). */
export function measureSaveBytes(): number {
  const sim = currentSim();
  return sim === null ? 0 : serialize(sim.state, sim.map, saveMeta()).length;
}

/** Real time played in the running game (running time only). */
export function playedMs(): number {
  return getSession()?.playedMs ?? 0;
}
export function getAlpha(): number {
  return lastAlpha;
}
/** MapCanvas hands its camera controls over once it is ready. */
export function setMapHandle(handle: MapHandle | null): void {
  mapHandle = handle;
  // A new canvas (a remount, or the next game's map) starts unframed.
  if (handle === null) framedSession = null;
  const sim = getSession()?.sim ?? null;
  if (handle !== null && sim !== null && framedSession !== sim) {
    framedSession = sim;
    useGameStore.getState().focusHome();
  }
}

function currentSim(): Sim | null {
  return getSession()?.sim ?? null;
}

const nowMs = (): number => (typeof performance === 'undefined' ? 0 : performance.now());

const RUN_SPEEDS = TIME.SPEEDS.filter((s): s is RunSpeed => s !== 0);

const PAUSE_REASON: Readonly<Record<AlertKind, (sim: Sim, alert: Alert) => string>> = {
  capitalAttacked: () => 'Paused — your capital is under attack',
  provinceAttacked: (sim, a) => `Paused — ${a.province === null ? 'a province' : sim.map.provinces[a.province]!.name} is under attack`,
  provinceLost: (sim, a) => `Paused — you lost ${a.province === null ? 'a province' : sim.map.provinces[a.province]!.name}`,
  armyDestroyed: () => 'Paused — one of your armies was destroyed',
  shortage: () => 'Paused — you are running short',
  capitulation: (sim, a) => `Paused — ${a.nation === null ? 'a nation' : sim.map.nations[a.nation]!.name} capitulated`,
  firstContact: (sim, a) => `Paused — first contact with ${a.nation === null ? 'a new nation' : sim.map.nations[a.nation]!.name}`,
};
export const AWAY_REASON = 'Paused while you were away — press Space to resume.';

function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  return ka.every((k) => Object.is(ra[k], rb[k]));
}

function sameIds(a: readonly ArmyId[], b: readonly ArmyId[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

function selectedArmies(selection: Selection): ArmyId[] {
  return selection.kind === 'armies' ? selection.armies : [];
}

/** The player's own, living armies among `ids`. */
function ownArmies(sim: Sim, ids: readonly ArmyId[]): ArmyId[] {
  return ids.filter((id) => {
    const army = armyById(sim, id);
    return army !== undefined && army.alive && army.owner === sim.state.player;
  });
}

function playerFeedEntry(sim: Sim, text: string, severity: Severity): FeedEntry {
  localToastId -= 1;
  return { id: localToastId, tick: sim.state.tick, kind: 'digest', severity, text, nations: [sim.state.player], province: null, army: null, count: 1 };
}

function saveMeta(): { savedAt: number; playedMs: number } {
  return { savedAt: Date.now(), playedMs: getSession()?.playedMs ?? 0 };
}

/** Phones (§8.6) show fewer toasts. */
function isPhone(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 767px)').matches;
}

function isCoarse(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
}

// ------------------------------------------------------------------ the store

export const useGameStore: UseBoundStore<StoreApi<GameStore>> = create<GameStore>()((set, get) => {
  /** Publishes a new view version now (after input) and the heavy one too. */
  const bump = (): void => {
    lastPublishMs = nowMs();
    lastHeavyMs = lastPublishMs;
    set((s) => ({ uiVersion: s.uiVersion + 1, heavyVersion: s.heavyVersion + 1 }));
    wake();
  };

  const persist = (sync: boolean): void => {
    const sim = currentSim();
    if (sim === null || get().tabLost) return;
    const done = (outcome: SaveOutcome): void => {
      lastSaveMs = nowMs();
      lastSavedTick = sim.state.tick;
      set({ saveWarning: outcome === 'ok' || outcome === 'notOwner' ? null : outcome, hasSavedGame: outcome === 'ok' || hasSave() });
    };
    if (sync) done(saveGame(sim, saveMeta()));
    else saveWhenIdle(sim, saveMeta, done);
  };

  const pushToast = (entry: FeedEntry): void => {
    const existing = toastTimers.get(entry.id);
    if (existing !== undefined) clearTimeout(existing);
    toastTimers.set(
      entry.id,
      setTimeout(() => get().dismissToast(entry.id), RUNTIME.TOAST_MS),
    );
    set((s) => {
      const rest = s.toasts.filter((t) => t.id !== entry.id);
      const toasts = [{ id: entry.id, entry: { ...entry } }, ...rest].slice(0, isPhone() ? RUNTIME.MAX_TOASTS_PHONE : RUNTIME.MAX_TOASTS_DESKTOP);
      return { toasts };
    });
  };

  const pause = (reason: string | null): void => {
    const { speed } = get();
    if (speed !== 0) set({ resumeSpeed: speed });
    set({ speed: 0, pausedReason: reason });
    persist(false);
    bump();
  };

  const refreshPreview = (): void => {
    const sim = currentSim();
    const { draft, attackWith, hover, selection } = get();
    if (sim === null) return;
    if (draft !== null) {
      set({ preview: previewOrder(sim, sim.state.player, draft.armies, draft.to, draft.together) });
      return;
    }
    if (attackWith !== null) {
      set({ preview: attackWith.picked.length === 0 ? null : previewOrder(sim, sim.state.player, attackWith.picked, attackWith.target, true) });
      return;
    }
    const own = ownArmies(sim, selectedArmies(selection));
    if (hover !== null && own.length > 0) {
      lastHoverPreviewMs = nowMs();
      set({ preview: previewOrder(sim, sim.state.player, own, hover, MOVEMENT.ARRIVE_TOGETHER_DEFAULT) });
    } else set({ preview: null });
  };

  const select = (selection: Selection): void => {
    set({ selection, draft: null, attackWith: null, rallyFrom: null, preview: null, panel: get().panel === 'attackWith' ? null : get().panel });
    const step = get().coachStep;
    const sim = currentSim();
    if (step === 1 && sim !== null && ownArmies(sim, selectedArmies(selection)).length > 0) get().advanceCoach();
    bump();
  };

  const focusArmy = (id: ArmyId): void => {
    const sim = currentSim();
    const army = sim === null ? undefined : armyById(sim, id);
    if (army === undefined) return;
    get().focusProvinces([army.leg?.to ?? army.at]);
  };

  /** A coach step that completes on this command (§8.7). */
  const coachOnCommand = (c: Command): void => {
    const step = get().coachStep;
    if (step === 2 && c.kind === 'move') get().advanceCoach();
    else if (step === 6 && c.kind === 'build') get().advanceCoach();
    else if (step === 7 && (c.kind === 'train' || c.kind === 'keepTraining')) get().advanceCoach();
  };

  const findFirstTarget = (sim: Sim): void => {
    setTimeout(() => {
      if (currentSim() !== sim) return;
      const first = suggestFirstTarget(sim);
      set({ coachTarget: first === null ? null : { target: first.target, armies: first.armies } });
      bump();
    }, 0);
  };

  const begin = (state: GameState, playedMs: number): void => {
    const map = mapStatic;
    const geometry = mapGeometry;
    if (map === null || geometry === null) return;
    stopLoop?.();
    releaseTab?.();
    stopHidden?.();
    const session = openSession(map, geometry, state, playedMs);
    const coarse = isCoarse();
    const coach = !onboardingDone() && get().prefs.coach && state.tick === 0 ? 1 : null;
    set({
      phase: 'playing',
      speed: 0,
      resumeSpeed: get().prefs.lastSpeed,
      pausedReason: null,
      selection: { kind: 'none' },
      hover: null,
      draft: null,
      preview: null,
      multiSelect: false,
      suggestions: [],
      suggestionIndex: 0,
      panel: null,
      sheet: 'peek',
      toasts: [],
      coachStep: coach,
      coachTarget: null,
      attackWith: null,
      rallyFrom: null,
      endDismissed: false,
      tabLost: false,
      lastAlert: null,
      coarse,
    });
    lastSavedTick = state.tick;
    lastSaveMs = nowMs();
    stopLoop = startLoop({
      sim: currentSim,
      speed: () => get().speed,
      coarse,
      onEvents: (events) => get().onEvents(events),
      onFrame: (info) => get().onFrame(info),
    });
    releaseTab = claimTab(() => {
      set({ tabLost: true });
      pause('This game is open in another tab');
    });
    stopHidden = onTabHidden(() => {
      if (get().speed !== 0) {
        set({ resumeSpeed: get().speed as RunSpeed, speed: 0, pausedReason: AWAY_REASON });
      }
      persist(true);
    });
    if (mapHandle !== null) {
      framedSession = session.sim;
      get().focusHome();
    }
    if (coach !== null) findFirstTarget(session.sim);
    persist(false);
    bump();
  };

  const end = (): void => {
    stopLoop?.();
    stopLoop = null;
    releaseTab?.();
    releaseTab = null;
    stopHidden?.();
    stopHidden = null;
    closeSession();
    framedSession = null;
  };

  return {
    phase: 'loading',
    loadError: null,
    hasSavedGame: false,
    uiVersion: 0,
    speed: 0,
    resumeSpeed: TIME.DEFAULT_RUN_SPEED,
    throttled: false,
    effectiveSpeed: 0,
    pausedReason: null,
    selection: { kind: 'none' },
    hover: null,
    draft: null,
    preview: null,
    multiSelect: false,
    suggestions: [],
    suggestionIndex: 0,
    panel: null,
    sheet: 'peek',
    mapMode: 'political',
    toasts: [],
    coachStep: null,
    prefs: {
      autoPause: { capitalAttacked: true, provinceAttacked: false, provinceLost: false, armyDestroyed: false, shortage: true, capitulation: false, firstContact: true },
      mapMode: 'political',
      lastSpeed: TIME.DEFAULT_RUN_SPEED,
      instantRightClick: true,
      showAllArmies: false,
      reduceMotion: false,
      coach: true,
      detail: 'auto',
    },
    tabLost: false,
    heavyVersion: 0,
    legacyNote: false,
    attackWith: null,
    rallyFrom: null,
    coachTarget: null,
    endDismissed: false,
    saveWarning: null,
    lastAlert: null,
    coarse: false,

    init(basePath) {
      if (initPromise !== null) return initPromise;
      const prefs = loadPrefs();
      set({ phase: 'loading', prefs, mapMode: prefs.mapMode, legacyNote: purgeLegacySaves() });
      initPromise = (async () => {
        try {
          const files = await fetchMapFiles(basePath);
          mapStatic = buildMap(files.facts, files.seeds);
          mapGeometry = buildGeometry(files.topology, mapStatic);
          set({ phase: 'menu', hasSavedGame: hasSave(), loadError: null });
        } catch (error) {
          set({ phase: 'error', loadError: error instanceof Error ? `The world failed to load: ${error.message}` : 'The world failed to load.' });
        }
      })();
      return initPromise;
    },

    startGame(countryId, difficulty, seed) {
      const map = mapStatic;
      if (map === null) return;
      begin(createGame(map, { playerCountryId: countryId, difficulty, seed }), 0);
    },

    resumeGame() {
      const map = mapStatic;
      if (map === null) return;
      const file = loadGame(map);
      if (file === null) {
        set({ hasSavedGame: false, loadError: 'The saved game could not be read, so it was discarded.' });
        return;
      }
      set({ loadError: null });
      begin(file.state, file.meta.playedMs);
    },

    abandonGame() {
      const sim = currentSim();
      if (sim !== null && !get().tabLost) persist(true);
      end();
      set({ phase: 'menu', hasSavedGame: hasSave(), speed: 0, toasts: [], coachStep: null, panel: null });
    },

    saveNow() {
      persist(true);
      const outcome = get().saveWarning;
      get().toast(outcome === null ? 'Game saved' : 'Could not save: storage is full or blocked', outcome === null ? 'good' : 'bad');
    },

    setSpeed(speed) {
      const sim = currentSim();
      if (sim === null || get().tabLost) return;
      if (speed === 0) {
        pause(null);
        return;
      }
      const prefs = { ...get().prefs, lastSpeed: speed };
      savePrefs(prefs);
      set({ speed, resumeSpeed: speed, pausedReason: null, prefs });
      if (get().coachStep === 3) get().advanceCoach();
      bump();
    },

    togglePause() {
      const { speed, resumeSpeed } = get();
      get().setSpeed(speed === 0 ? resumeSpeed : 0);
    },

    stepSpeed(direction) {
      const { speed } = get();
      if (speed === 0) {
        if (direction > 0) get().setSpeed(get().resumeSpeed);
        return;
      }
      const i = RUN_SPEEDS.indexOf(speed);
      const next = RUN_SPEEDS[i + direction];
      if (next !== undefined) get().setSpeed(next);
      else if (direction < 0) get().setSpeed(0);
    },

    clickMarker(armies, additive) {
      const { selection, multiSelect } = get();
      if ((additive || multiSelect) && selection.kind === 'armies') {
        const current = new Set(selection.armies);
        const all = armies.every((id) => current.has(id));
        for (const id of armies) {
          if (all) current.delete(id);
          else current.add(id);
        }
        const next = [...current].sort((a, b) => a - b);
        select(next.length === 0 ? { kind: 'none' } : { kind: 'armies', armies: next });
        return;
      }
      select({ kind: 'armies', armies: [...armies].sort((a, b) => a - b) });
    },

    clickProvince(p, additive) {
      const sim = currentSim();
      if (sim === null) return;
      const { selection, rallyFrom, multiSelect, coarse } = get();
      if (rallyFrom !== null) {
        get().command({ kind: 'rally', nation: sim.state.player, province: rallyFrom, to: p });
        set({ rallyFrom: null });
        get().toast(`Rally point set to ${sim.map.provinces[p]!.name}`, 'info');
        return;
      }
      const own = ownArmies(sim, selectedArmies(selection));
      const elsewhere = own.some((id) => armyById(sim, id)?.at !== p || armyById(sim, id)?.leg !== null);
      if (own.length > 0 && !additive && !multiSelect && elsewhere) {
        get().openDraft(own, p);
        return;
      }
      select({ kind: 'province', province: p });
      if (coarse) set({ sheet: 'peek' });
    },

    boxSelect(armies, additive) {
      const sim = currentSim();
      if (sim === null) return;
      const own = ownArmies(sim, armies);
      const base = additive ? selectedArmies(get().selection) : [];
      const next = [...new Set([...base, ...own])].sort((a, b) => a - b);
      select(next.length === 0 ? { kind: 'none' } : { kind: 'armies', armies: next });
    },

    setHover(p) {
      if (get().hover === p) return;
      set({ hover: p });
      wake();
      if (get().draft !== null || get().attackWith !== null) return;
      if (hoverTimer !== null) clearTimeout(hoverTimer);
      hoverTimer = null;
      const sim = currentSim();
      if (sim === null || p === null || ownArmies(sim, selectedArmies(get().selection)).length === 0) {
        if (get().preview !== null) set({ preview: null });
        wake();
        return;
      }
      // Previews plan routes and run the odds; at most one per ODDS_PREVIEW_THROTTLE_MS, the latest hover winning.
      const wait = Math.max(0, RUNTIME.ODDS_PREVIEW_THROTTLE_MS - (nowMs() - lastHoverPreviewMs));
      hoverTimer = setTimeout(() => {
        hoverTimer = null;
        refreshPreview();
        wake();
      }, wait);
    },

    orderNow(p, append) {
      const sim = currentSim();
      if (sim === null) return;
      const own = ownArmies(sim, selectedArmies(get().selection));
      if (own.length === 0) return;
      if (!get().prefs.instantRightClick && !append) {
        get().openDraft(own, p);
        return;
      }
      const preview = previewOrder(sim, sim.state.player, own, p, MOVEMENT.ARRIVE_TOGETHER_DEFAULT);
      const result = get().command({ kind: 'move', nation: sim.state.player, armies: own, to: p, together: MOVEMENT.ARRIVE_TOGETHER_DEFAULT, append });
      if (!result.ok) return;
      const name = sim.map.provinces[p]!.name;
      const verdict = preview.forecast === null ? '' : ` · ${VERDICT_LABEL[preview.forecast.verdict]}`;
      const who = own.length === 1 ? (armyById(sim, own[0]!)?.name ?? 'Army') : `${own.length} armies`;
      const hostile = preview.intent === 'move' && preview.warnings.includes('crossesHostile') ? ' · crosses enemy land' : '';
      get().toast(`${who} → ${name} · ${formatDuration(preview.arriveInTicks)}${verdict}${hostile}`, hostile === '' ? 'info' : 'bad');
      const survivors = ownArmies(sim, result.armies.length > 0 ? result.armies : own);
      set({ selection: survivors.length > 0 ? { kind: 'armies', armies: survivors } : { kind: 'none' }, preview: null });
    },

    openDraft(armies, p) {
      const sim = currentSim();
      if (sim === null) return;
      const own = ownArmies(sim, armies);
      if (own.length === 0) return;
      const draft: Draft = { armies: own, to: p, together: MOVEMENT.ARRIVE_TOGETHER_DEFAULT, append: false };
      set({ draft, selection: { kind: 'armies', armies: own }, attackWith: null, panel: get().panel === 'attackWith' ? null : get().panel, sheet: get().coarse ? 'half' : get().sheet });
      refreshPreview();
      bump();
    },

    setDraftOption(o) {
      const draft = get().draft;
      if (draft === null) return;
      set({ draft: { ...draft, ...o } });
      refreshPreview();
      bump();
    },

    confirmDraft() {
      const sim = currentSim();
      const draft = get().draft;
      if (sim === null || draft === null) return;
      const result = get().command({ kind: 'move', nation: sim.state.player, armies: draft.armies, to: draft.to, together: draft.together, append: draft.append });
      if (!result.ok) return;
      const survivors = ownArmies(sim, result.armies.length > 0 ? result.armies : draft.armies);
      set({ draft: null, preview: null, selection: survivors.length > 0 ? { kind: 'armies', armies: survivors } : { kind: 'none' } });
      bump();
    },

    cancel() {
      const { rallyFrom, draft, attackWith, suggestions, selection, panel, multiSelect } = get();
      if (rallyFrom !== null) set({ rallyFrom: null });
      else if (draft !== null) set({ draft: null, preview: null });
      else if (attackWith !== null) set({ attackWith: null, preview: null, panel: panel === 'attackWith' ? null : panel });
      else if (suggestions.length > 0) set({ suggestions: [], suggestionIndex: 0 });
      else if (multiSelect) set({ multiSelect: false });
      else if (selection.kind !== 'none') set({ selection: { kind: 'none' }, preview: null });
      else if (panel !== null) set({ panel: null });
      bump();
    },

    command(c) {
      const sim = currentSim();
      if (sim === null) return { ok: false, reason: 'No game is running' };
      const ids = c.kind === 'move' || c.kind === 'stop' || c.kind === 'retreat' ? [...c.armies] : [];
      const before = new Map(ids.map((id) => [id, armyById(sim, id)?.stance ?? 'manual']));
      const result = issue(c);
      if (!result.ok) {
        get().toast(result.reason, 'bad');
        bump();
        return result;
      }
      for (const [id, stance] of before) {
        const army = armyById(sim, id);
        if (stance !== 'manual' && army !== undefined && army.alive && army.stance === 'manual') get().toast(`${army.name} is back under your command`, 'info');
      }
      if (c.kind === 'merge' || c.kind === 'split') {
        const keep = c.kind === 'split' ? [c.army, ...result.armies] : result.armies;
        const alive = ownArmies(sim, [...new Set(keep)]).sort((a, b) => a - b);
        if (alive.length > 0) set({ selection: { kind: 'armies', armies: alive } });
      } else if (c.kind === 'disband') {
        const rest = ownArmies(sim, selectedArmies(get().selection));
        set({ selection: rest.length > 0 ? { kind: 'armies', armies: rest } : { kind: 'none' } });
      }
      // A card made before this command may no longer validate.
      if (get().suggestions.length > 0 && c.kind !== 'stance') set({ suggestions: [], suggestionIndex: 0 });
      coachOnCommand(c);
      if (get().draft === null && get().attackWith === null) set({ preview: null });
      else refreshPreview();
      bump();
      return result;
    },

    advise() {
      const sim = currentSim();
      if (sim === null) return;
      if (get().suggestions.length > 0) {
        get().nextSuggestion();
        return;
      }
      const cards = adviseCards(sim, ADVISOR.SUGGESTIONS);
      if (cards.length === 0) {
        get().toast('Nothing to suggest right now', 'info');
        return;
      }
      set({ suggestions: cards, suggestionIndex: 0 });
      const first = cards[0]!;
      if ('province' in first) get().focusProvinces([first.province]);
      else if (first.kind === 'attack') get().focusProvinces([first.plan.target]);
      bump();
    },

    acceptSuggestion() {
      const { suggestions, suggestionIndex } = get();
      const card = suggestions[suggestionIndex];
      if (card === undefined) return;
      set({ suggestions: [], suggestionIndex: 0 });
      for (const c of card.commands) if (!get().command(c).ok) break;
    },

    nextSuggestion() {
      const { suggestions, suggestionIndex } = get();
      if (suggestions.length === 0) return;
      const index = (suggestionIndex + 1) % suggestions.length;
      set({ suggestionIndex: index });
      const card = suggestions[index]!;
      if ('province' in card) get().focusProvinces([card.province]);
      else if (card.kind === 'attack') get().focusProvinces([card.plan.target]);
      bump();
    },

    openAttackWith(p) {
      const sim = currentSim();
      if (sim === null) return;
      // suggestForce pre-ticks the fewest armies that win at the advisor's odds (§4.6).
      const picked = suggestForce(sim, p)?.armies ?? [];
      set({ attackWith: { target: p, picked: [...picked].sort((a, b) => a - b) }, draft: null, panel: 'attackWith', selection: { kind: 'province', province: p }, sheet: get().coarse ? 'full' : get().sheet });
      refreshPreview();
      bump();
    },

    delegate(stance, target) {
      const sim = currentSim();
      if (sim === null) return;
      const ids = target === 'selected' ? ownArmies(sim, selectedArmies(get().selection)) : idleArmies(sim);
      const chosen = ids.length > 0 ? ids : target === 'selected' ? idleArmies(sim) : [];
      if (chosen.length === 0) {
        get().toast('No armies to hand over', 'info');
        return;
      }
      const all = chosen.every((id) => armyById(sim, id)?.stance === stance);
      const next: Stance = all ? 'manual' : stance;
      const result = get().command({ kind: 'stance', nation: sim.state.player, armies: chosen, stance: next });
      if (!result.ok) return;
      const who = chosen.length === 1 ? (armyById(sim, chosen[0]!)?.name ?? 'Army') : `${chosen.length} armies`;
      const text = next === 'manual' ? `${who} back under your command` : next === 'delegate' ? `${who} delegated to the Staff` : `${who} set to Defend`;
      get().toast(text, 'info');
    },

    nextIdleArmy(direction) {
      const sim = currentSim();
      if (sim === null) return;
      const list = idleArmies(sim);
      if (list.length === 0) {
        get().toast('No idle armies', 'info');
        return;
      }
      const current = selectedArmies(get().selection)[0];
      const at = current === undefined ? -1 : list.indexOf(current);
      const index = at < 0 ? (direction > 0 ? 0 : list.length - 1) : (at + direction + list.length) % list.length;
      const id = list[index]!;
      select({ kind: 'armies', armies: [id] });
      focusArmy(id);
    },

    nextBattle() {
      const sim = currentSim();
      if (sim === null) return;
      const battles = playerBattles(sim);
      if (battles.length === 0) {
        get().toast('No battles involve you', 'info');
        return;
      }
      const { selection } = get();
      const at = selection.kind === 'battle' ? battles.indexOf(selection.province) : -1;
      const p = battles[(at + 1) % battles.length]!;
      get().selectBattle(p);
      get().focusProvinces([p]);
    },

    latestAlert() {
      const sim = currentSim();
      if (sim === null) return;
      const alert = get().lastAlert;
      let p: ProvinceIx | null = alert?.province ?? null;
      if (p === null) p = sim.state.feed.find((e) => e.province !== null && concernsPlayer(sim, e.nations, e.province))?.province ?? null;
      if (p === null) return;
      select({ kind: 'province', province: p });
      get().focusProvinces([p]);
    },

    openPanel(p) {
      set({ panel: get().panel === p ? null : p, sheet: get().coarse && p !== null ? 'full' : get().sheet });
      if (p !== 'attackWith' && get().attackWith !== null) set({ attackWith: null, preview: null });
      bump();
    },

    setSheet(s) {
      set({ sheet: s });
    },

    setMapMode(m) {
      const prefs = { ...get().prefs, mapMode: m };
      savePrefs(prefs);
      set({ mapMode: m, prefs });
      bump();
    },

    focusProvinces(ps) {
      if (ps.length > 0) mapHandle?.frameProvinces(ps, 600);
      wake();
    },

    focusHome() {
      // The map frames the land joined to the capital, not every owned province:
      // all of France includes French Guiana and framed the Atlantic.
      mapHandle?.home();
      wake();
    },

    focusCapital() {
      const sim = currentSim();
      if (sim === null) return;
      const capital = sim.state.nations[sim.state.player]!.capital;
      if (capital !== null) {
        get().focusProvinces([capital]);
        select({ kind: 'province', province: capital });
      }
    },

    dismissToast(id) {
      const timer = toastTimers.get(id);
      if (timer !== undefined) clearTimeout(timer);
      toastTimers.delete(id);
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    },

    setPrefs(p) {
      const prefs = { ...get().prefs, ...p, autoPause: { ...get().prefs.autoPause, ...(p.autoPause ?? {}) } };
      savePrefs(prefs);
      const sim = currentSim();
      if (p.showAllArmies === true && sim !== null) sim.state.stats.fogOff = true;
      set({ prefs, mapMode: prefs.mapMode });
      if (p.coach === false && get().coachStep !== null) get().skipCoach();
      bump();
    },

    advanceCoach() {
      const step = get().coachStep;
      if (step === null) return;
      if (step >= 8) {
        markOnboardingDone();
        set({ coachStep: null });
      } else set({ coachStep: step + 1 });
      const sim = currentSim();
      const target = get().coachTarget;
      // Step 2 with two armies opens Attack with… pre-ticked (§8.7).
      if (step + 1 === 2 && sim !== null && target !== null && target.armies.length >= 2) {
        set({ attackWith: { target: target.target, picked: [...target.armies] }, panel: 'attackWith', selection: { kind: 'province', province: target.target } });
        refreshPreview();
      }
      bump();
    },

    skipCoach() {
      markOnboardingDone();
      set({ coachStep: null });
      bump();
    },

    takeOverTab() {
      releaseTab?.();
      releaseTab = claimTab(() => {
        set({ tabLost: true });
        pause('This game is open in another tab');
      });
      set({ tabLost: false, pausedReason: null });
      bump();
    },

    onEvents(events) {
      const sim = currentSim();
      if (sim === null) return;
      let urgent = false;
      for (const entry of events.feed) {
        if ((entry.severity === 'bad' || entry.severity === 'critical') && concernsPlayer(sim, entry.nations, entry.province)) {
          pushToast(entry);
          urgent = true;
        }
        if (entry.kind === 'capitulation' && concernsPlayer(sim, entry.nations, entry.province)) persist(false);
      }
      const { prefs } = get();
      let reason: string | null = null;
      for (const alert of events.alerts) {
        set({ lastAlert: alert });
        urgent = true;
        if (reason === null && prefs.autoPause[alert.kind]) reason = PAUSE_REASON[alert.kind](sim, alert);
      }
      if (reason !== null && get().speed !== 0) pause(reason);
      if (events.statusChanged) {
        set({ speed: 0, endDismissed: false });
        persist(false);
        urgent = true;
      }
      const step = get().coachStep;
      const captured = events.ownershipChanged.some((p) => sim.state.provinces[p]!.owner === sim.state.player);
      if (step === 4 && captured) {
        // A walk-in capture skips the battle step; the capture card then waits for Next.
        set({ coachStep: 5 });
        urgent = true;
      } else if (step === 4 && playerBattles(sim).length > 0) {
        const battle = playerBattles(sim)[0]!;
        set({ coachStep: 5, selection: { kind: 'battle', province: battle } });
        urgent = true;
      } else if (step === 5 && captured) {
        set({ coachStep: 6 });
        urgent = true;
      }
      if (get().selection.kind === 'battle') {
        const selection = get().selection;
        if (selection.kind === 'battle' && !sim.cache.battles.includes(selection.province)) set({ selection: { kind: 'province', province: selection.province } });
      }
      if (urgent) bump();
    },

    onFrame(info) {
      lastAlpha = info.alpha;
      const { throttled, effectiveSpeed } = get();
      if (info.throttled !== throttled || Math.abs(info.effectiveSpeed - effectiveSpeed) >= 0.1) set({ throttled: info.throttled, effectiveSpeed: info.effectiveSpeed });
      if (info.ticksRun === 0) return;
      const now = nowMs();
      if (now - lastPublishMs >= RUNTIME.VIEW_PUBLISH_MS) {
        lastPublishMs = now;
        const heavy = now - lastHeavyMs >= RUNTIME.HEAVY_VIEW_MS;
        if (heavy) lastHeavyMs = now;
        if (get().draft !== null || get().attackWith !== null) refreshPreview();
        set((s) => ({ uiVersion: s.uiVersion + 1, heavyVersion: heavy ? s.heavyVersion + 1 : s.heavyVersion }));
      }
      const sim = currentSim();
      if (sim !== null && now - lastSaveMs >= RUNTIME.AUTOSAVE_MS && sim.state.tick !== lastSavedTick) {
        lastSaveMs = now;
        persist(false);
      }
    },

    selectArmies(armies) {
      select(armies.length === 0 ? { kind: 'none' } : { kind: 'armies', armies: [...armies].sort((a, b) => a - b) });
    },

    selectBattle(p) {
      select({ kind: 'battle', province: p });
    },

    setMultiSelect(on) {
      set({ multiSelect: on });
      bump();
    },

    toggleAttackWith(army) {
      const attackWith = get().attackWith;
      if (attackWith === null) return;
      const picked = attackWith.picked.includes(army) ? attackWith.picked.filter((id) => id !== army) : [...attackWith.picked, army].sort((a, b) => a - b);
      set({ attackWith: { ...attackWith, picked } });
      refreshPreview();
      bump();
    },

    confirmAttackWith() {
      const sim = currentSim();
      const attackWith = get().attackWith;
      if (sim === null || attackWith === null || attackWith.picked.length === 0) return;
      const result = get().command({ kind: 'move', nation: sim.state.player, armies: attackWith.picked, to: attackWith.target, together: true, append: false });
      if (!result.ok) return;
      const survivors = ownArmies(sim, result.armies.length > 0 ? result.armies : attackWith.picked);
      set({ attackWith: null, preview: null, panel: null, selection: survivors.length > 0 ? { kind: 'armies', armies: survivors } : { kind: 'none' } });
      bump();
    },

    startRally(p) {
      set({ rallyFrom: p });
      get().toast('Tap the province new units should march to', 'info');
      bump();
    },

    keepPlaying() {
      const sim = currentSim();
      if (sim === null || sim.state.status !== 'won') return;
      sim.state.sandbox = true;
      set({ endDismissed: true });
      persist(false);
      bump();
    },

    viewMap() {
      set({ endDismissed: true });
      bump();
    },

    playAgain() {
      const sim = currentSim();
      if (sim === null) return;
      const countryId = sim.map.nations[sim.state.player]!.id;
      const difficulty = sim.state.difficulty;
      clearSave();
      end();
      get().startGame(countryId, difficulty, randomSeed());
    },

    newGame() {
      const sim = currentSim();
      if (sim !== null && sim.state.status !== 'playing') clearSave();
      end();
      set({ phase: 'menu', hasSavedGame: hasSave(), speed: 0, toasts: [], coachStep: null, panel: null });
    },

    deleteSave() {
      clearSave();
      set({ hasSavedGame: false });
      get().toast('Saved game deleted', 'info');
    },

    dismissLegacyNote() {
      set({ legacyNote: false });
    },

    closeSuggestions() {
      set({ suggestions: [], suggestionIndex: 0 });
      bump();
    },

    toast(text, severity) {
      const sim = currentSim();
      if (sim === null) return;
      pushToast(playerFeedEntry(sim, text, severity));
    },

    mergeSelected() {
      const sim = currentSim();
      if (sim === null) return;
      const own = ownArmies(sim, selectedArmies(get().selection));
      const first = own[0] === undefined ? undefined : armyById(sim, own[0]);
      if (first === undefined) return;
      // One army merges with every idle army of yours standing with it; several merge with each other.
      const ids = own.length >= 2 ? own : armiesAt(sim, first.at).filter((a) => a.alive && a.owner === sim.state.player && isIdle(sim, a)).map((a) => a.id);
      if (ids.length < 2) {
        get().toast('No other idle army stands here to merge with', 'info');
        return;
      }
      get().command({ kind: 'merge', nation: sim.state.player, armies: ids });
    },

    splitSelected() {
      const sim = currentSim();
      if (sim === null) return;
      const own = ownArmies(sim, selectedArmies(get().selection));
      const army = own.length === 1 ? armyById(sim, own[0]!) : undefined;
      if (army === undefined) {
        get().toast('Select one army to split', 'info');
        return;
      }
      const take: UnitCounts = {};
      let total = 0;
      for (const u of UNIT_TYPES) {
        const half = Math.floor(army.units[u].count / 2);
        if (half > 0) take[u] = half;
        total += half;
      }
      if (total === 0) {
        get().toast(`${army.name} is too small to split in half`, 'info');
        return;
      }
      get().command({ kind: 'split', nation: sim.state.player, army: army.id, take });
    },

    retreatSelected() {
      const sim = currentSim();
      if (sim === null) return;
      const own = ownArmies(sim, selectedArmies(get().selection)).filter((id) => armyById(sim, id)?.battle !== null);
      if (own.length === 0) {
        get().toast('None of the selected armies is in a battle', 'info');
        return;
      }
      get().command({ kind: 'retreat', nation: sim.state.player, armies: own, to: null });
    },

    stopSelected() {
      const sim = currentSim();
      if (sim === null) return;
      const own = ownArmies(sim, selectedArmies(get().selection));
      if (own.length > 0) get().command({ kind: 'stop', nation: sim.state.player, armies: own });
    },

    disbandSelected(confirm) {
      const sim = currentSim();
      if (sim === null) return;
      for (const id of ownArmies(sim, selectedArmies(get().selection))) {
        const army = armyById(sim, id);
        if (army !== undefined && confirm(army.name)) get().command({ kind: 'disband', nation: sim.state.player, army: id });
      }
    },

    trainingForSelection() {
      const sim = currentSim();
      if (sim === null) return;
      const { selection } = get();
      let p: ProvinceIx | null = selection.kind === 'province' || selection.kind === 'battle' ? selection.province : null;
      if (selection.kind === 'armies') {
        const army = armyById(sim, selection.armies[0]!);
        p = army?.at ?? null;
      }
      if (p === null) p = sim.state.nations[sim.state.player]!.capital;
      if (p === null) return;
      select({ kind: 'province', province: p });
      if (get().coarse) set({ sheet: 'full' });
      if (typeof document !== 'undefined') setTimeout(() => document.getElementById('training-section')?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 0);
    },

    replayCoach() {
      const sim = currentSim();
      const prefs = { ...get().prefs, coach: true };
      savePrefs(prefs);
      set({ prefs, coachStep: 1, coachTarget: null, panel: null });
      if (sim !== null) findFirstTarget(sim);
      bump();
    },

    goToEntry(entry) {
      const sim = currentSim();
      if (sim === null) return;
      const army = entry.army === null ? undefined : armyById(sim, entry.army);
      if (army !== undefined && army.alive && (army.owner === sim.state.player || isArmyVisible(sim, army) || get().prefs.showAllArmies)) {
        select({ kind: 'armies', armies: [army.id] });
        focusArmy(army.id);
        return;
      }
      if (entry.province === null) return;
      select(sim.cache.battles.includes(entry.province) ? { kind: 'battle', province: entry.province } : { kind: 'province', province: entry.province });
      get().focusProvinces([entry.province]);
    },

    focusNation(n) {
      const sim = currentSim();
      if (sim !== null) get().focusProvinces(ownedProvinces(sim, n));
    },

    nextIncoming() {
      const sim = currentSim();
      if (sim === null) return;
      const list = incomingArmies(sim, get().prefs.showAllArmies);
      if (list.length === 0) {
        get().toast('No hostile armies are heading your way', 'info');
        return;
      }
      const current = selectedArmies(get().selection)[0];
      const at = current === undefined ? -1 : list.indexOf(current);
      const id = list[(at + 1) % list.length]!;
      select({ kind: 'armies', armies: [id] });
      const p = armyLocation(sim, id);
      if (p !== null) get().focusProvinces([p]);
    },
  };
});

/** A short random seed for a new game; the UI may use Math.random, the game never does. */
export function randomSeed(): string {
  return Math.floor(Math.random() * 0xffffffff)
    .toString(36)
    .padStart(6, '0');
}

/** The recommended start's card, built from a throwaway new game for that nation. */
export function startCard(countryId: string, difficulty: Difficulty): StartCard | null {
  const map = mapStatic;
  if (map === null) return null;
  const key = `${countryId}|${difficulty}`;
  const known = startCards.get(key);
  if (known !== undefined) return known;
  const n = map.nationById.get(countryId);
  if (n === undefined) return null;
  const sim = createSim(map, createGame(map, { playerCountryId: countryId, difficulty, seed: 'start' }), { recordCommands: false });
  const summary = nationSummary(sim, n);
  const first = suggestFirstTarget(sim);
  const verdict = first?.preview.forecast?.verdict;
  const card: StartCard = {
    countryId,
    name: summary.name,
    provinces: summary.provinces,
    vp: summary.vp,
    fundsPerDay: summary.fundsPerDay,
    goods: summary.goods,
    units: summary.units,
    firstTarget: first === null ? null : `${map.provinces[first.target]!.name}${verdict === undefined ? '' : ` (${VERDICT_LABEL[verdict]})`}`,
  };
  startCards.set(key, card);
  return card;
}

/** Provinces the map pulses: the coach's first target and the current Suggest card's province. */
let highlightKey = '';
let highlightList: readonly ProvinceIx[] = [];
function highlightsOf(state: GameStore): readonly ProvinceIx[] {
  const out: ProvinceIx[] = [];
  if (state.coachStep === 2 && state.coachTarget !== null) out.push(state.coachTarget.target);
  const card = state.suggestions[state.suggestionIndex];
  if (card !== undefined && card.kind === 'attack') out.push(card.plan.target);
  else if (card !== undefined && card.kind !== 'market') out.push(card.province);
  const key = out.join(',');
  if (key !== highlightKey) {
    highlightKey = key;
    highlightList = out;
  }
  return highlightList;
}

let lastFrame: MapFrame | null = null;
/**
 * The frame the canvas map draws (§9.6): the live Sim plus the UI state it
 * shows, read once per drawn frame; the same object comes back while nothing changed.
 * After the session closes it keeps returning the last frame until the map unmounts.
 */
export function getMapFrame(): MapFrame | null {
  const sim = currentSim();
  if (sim === null) return lastFrame;
  const state = useGameStore.getState();
  const selection = state.selection;
  const frame: MapFrame = {
    sim,
    alpha: lastAlpha,
    selectedArmies: selectedArmySet(selection),
    selectedProvince: selection.kind === 'province' || selection.kind === 'battle' ? selection.province : null,
    hover: state.hover,
    preview: state.preview,
    mode: state.mapMode,
    showAll: state.prefs.showAllArmies,
    highlights: highlightsOf(state),
    coarse: state.coarse,
  };
  const prev = lastFrame;
  if (
    prev !== null &&
    prev.sim === frame.sim &&
    prev.alpha === frame.alpha &&
    prev.selectedArmies === frame.selectedArmies &&
    prev.selectedProvince === frame.selectedProvince &&
    prev.hover === frame.hover &&
    prev.preview === frame.preview &&
    prev.mode === frame.mode &&
    prev.showAll === frame.showAll &&
    prev.highlights === frame.highlights &&
    prev.coarse === frame.coarse
  ) {
    return prev;
  }
  lastFrame = frame;
  return frame;
}

/** The selected armies as the map wants them; the set is rebuilt only when the selection changes. */
let selectionSetFor: Selection | null = null;
let selectionSet: ReadonlySet<ArmyId> = new Set();
export function selectedArmySet(selection: Selection): ReadonlySet<ArmyId> {
  if (selection !== selectionSetFor) {
    selectionSetFor = selection;
    selectionSet = new Set(selectedArmies(selection));
  }
  return selectionSet;
}

// ------------------------------------------------------------------ views

/** A view source per selector: it recomputes only when `uiVersion` (or heavyVersion) or the session changes. */
function viewSource<T>(select: (sim: Sim) => T, heavy: boolean): { subscribe: (fn: () => void) => () => void; get: () => T | null; server: () => T | null } {
  let version = -1;
  let sim: Sim | null = null;
  let value: T | null = null;
  const subscribe = (fn: () => void): (() => void) => {
    const offStore = useGameStore.subscribe((s, prev) => {
      if (heavy ? s.heavyVersion !== prev.heavyVersion : s.uiVersion !== prev.uiVersion) fn();
    });
    const offSession = subscribeSession(fn);
    return () => {
      offStore();
      offSession();
    };
  };
  const get = (): T | null => {
    const state = useGameStore.getState();
    const v = heavy ? state.heavyVersion : state.uiVersion;
    const current = currentSim();
    if (v !== version || current !== sim) {
      version = v;
      sim = current;
      const next = current === null ? null : select(current);
      if (!shallowEqual(next, value)) value = next;
    }
    return value;
  };
  // No session exists while the page is prerendered or hydrated, so the server snapshot is the same read.
  const server = get;
  return { subscribe, get, server };
}

/**
 * A view model of the live Sim, recomputed on `uiVersion` only (and when the
 * selector changes, so callers pass a memoised selector). Results are compared
 * shallowly, so an unchanged view does not re-render its component.
 */
export function useSimView<T>(select: (sim: Sim) => T): T | null {
  const source = useMemo(() => viewSource(select, false), [select]);
  return useSyncExternalStore(source.subscribe, source.get, source.server);
}

/** The same for the heavy views (Economy, Production, Great Powers, Exchange): at most RUNTIME.HEAVY_VIEW_MS apart while running. */
export function useHeavySimView<T>(select: (sim: Sim) => T): T | null {
  const source = useMemo(() => viewSource(select, true), [select]);
  return useSyncExternalStore(source.subscribe, source.get, source.server);
}

/** The order of selections for equality checks in components. */
export function sameSelection(a: Selection, b: Selection): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'armies' && b.kind === 'armies') return sameIds(a.armies, b.armies);
  if ((a.kind === 'province' || a.kind === 'battle') && (b.kind === 'province' || b.kind === 'battle')) return a.province === b.province;
  return true;
}

/** Standing armies of the player at a province, for "Armies here". */
export function playerArmiesAt(sim: Sim, p: ProvinceIx): ArmyId[] {
  return armiesAt(sim, p)
    .filter((a) => a.alive && a.leg === null && a.owner === sim.state.player)
    .map((a) => a.id);
}
