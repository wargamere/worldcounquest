'use client';

import { create } from 'zustand';
import seedData from '@/data/countries.seed.json';
import seaLinkData from '@/data/sea-links.json';
import { assault, attack, invest, moveTroops, recruit, type Contribution } from '@/game/actions';
import { areAdjacent } from '@/game/adjacency';
import { adviseAttack, adviseMove } from '@/game/ai';
import { entriesSince } from '@/game/log';
import { combinedThreat } from '@/game/threat';
import { createGame } from '@/game/init';
import { endTurn as runEndTurn } from '@/game/turn';
import type { CountryId, CountrySeed, Difficulty, GameState, NationId, SeaLink } from '@/game/types';
import { buildWorld, fetchTopology, type World } from '@/lib/world';
import { clearSave, hasSeenHelp, loadGame, markHelpSeen, saveGame } from './persistence';

const seeds = seedData as CountrySeed[];
const seaLinks = seaLinkData as SeaLink[];

export type Phase = 'loading' | 'menu' | 'playing' | 'error';

export interface Flash {
  tone: 'good' | 'bad' | 'info';
  text: string;
}

/** A request for the map to frame these countries. The nonce makes repeats count. */
export interface FocusRequest {
  countryIds: CountryId[];
  nonce: number;
}

interface GameStore {
  phase: Phase;
  world: World | null;
  game: GameState | null;
  loadError: string | null;
  hasSavedGame: boolean;

  /** The country being inspected — for your own, the source of any order. */
  selectedId: CountryId | null;
  /** An adjacent country picked as the target of a move or attack. */
  targetId: CountryId | null;
  /** Troops the advisor proposed for the current order, if it proposed one. */
  suggestedTroops: number | null;
  /** Other countries proposed to join the current attack. */
  suggestedSupport: Contribution[] | null;
  /** Countries currently ticked to join the attack being set up, for the map. */
  joiningIds: CountryId[];
  /**
   * Game states before each recruit, investment or move this turn. Attacks clear
   * it: undoing a lost battle and trying again would let a player reroll the dice.
   */
  undoStack: GameState[];

  flash: Flash | null;
  showReport: boolean;
  showHelp: boolean;
  focus: FocusRequest | null;

  init: (basePath: string) => Promise<void>;
  startGame: (playerCountryId: CountryId, difficulty: Difficulty) => void;
  resumeGame: () => void;
  abandonGame: () => void;

  clickCountry: (id: CountryId) => void;
  selectCountry: (id: CountryId) => void;
  deselect: () => void;
  setOrder: (sourceId: CountryId, targetId: CountryId, troops?: number, support?: Contribution[]) => void;
  back: () => void;
  setJoining: (ids: CountryId[]) => void;
  selectNextReady: () => void;
  undo: () => void;

  doInvest: (countryId: CountryId) => void;
  doRecruit: (countryId: CountryId, troops: number) => void;
  doMove: (troops: number) => void;
  doAttack: (troops: number, support: Contribution[]) => void;
  advise: () => void;
  endTurn: () => void;

  focusHome: () => void;
  focusNation: (nationId: NationId) => void;
  focusCountries: (countryIds: CountryId[]) => void;
  dismissReport: () => void;
  setHelp: (open: boolean) => void;
}

/** How many reversible actions can be undone within one turn. */
const UNDO_LIMIT = 50;

let focusNonce = 0;
const focusOn = (countryIds: CountryId[]): FocusRequest => ({ countryIds, nonce: (focusNonce += 1) });

const ownedBy = (game: GameState, nationId: NationId): CountryId[] =>
  Object.values(game.countries).filter((c) => c.ownerId === nationId).map((c) => c.id);

export const useGameStore = create<GameStore>((set, get) => {
  const commit = (game: GameState, extra: Partial<GameStore> = {}): void => {
    saveGame(game);
    set({ game, ...extra });
  };

  /** Commits a recruit, investment or move, remembering the state before it. */
  const commitReversible = (before: GameState, game: GameState, extra: Partial<GameStore> = {}): void => {
    commit(game, { ...extra, undoStack: [...get().undoStack, before].slice(-UNDO_LIMIT) });
  };

  return {
    phase: 'loading',
    world: null,
    game: null,
    loadError: null,
    hasSavedGame: false,
    selectedId: null,
    targetId: null,
    suggestedTroops: null,
    suggestedSupport: null,
    joiningIds: [],
    undoStack: [],
    flash: null,
    showReport: false,
    showHelp: false,
    focus: null,

    init: async (basePath) => {
      try {
        const topology = await fetchTopology(basePath);
        const world = buildWorld(topology, seeds, seaLinks);
        set({ world, phase: 'menu', hasSavedGame: loadGame(world.adjacency) !== null });
      } catch (error) {
        set({
          phase: 'error',
          loadError: error instanceof Error ? error.message : 'Could not load the world map.',
        });
      }
    },

    startGame: (playerCountryId, difficulty) => {
      const world = get().world;
      if (!world) return;
      const game = createGame({
        seeds,
        adjacency: world.adjacency,
        playerCountryId,
        difficulty,
        randomSeed: `${playerCountryId}-${difficulty}-${Date.now()}`,
      });
      commit(game, {
        undoStack: [],
        phase: 'playing',
        selectedId: playerCountryId,
        targetId: null,
        suggestedTroops: null,
        suggestedSupport: null,
        flash: null,
        showReport: false,
        showHelp: !hasSeenHelp(),
        hasSavedGame: true,
        focus: focusOn([playerCountryId]),
      });
    },

    resumeGame: () => {
      const world = get().world;
      if (!world) return;
      const game = loadGame(world.adjacency);
      if (!game) {
        set({ hasSavedGame: false });
        return;
      }
      set({
        game,
        undoStack: [],
        phase: 'playing',
        selectedId: null,
        targetId: null,
        suggestedTroops: null,
        suggestedSupport: null,
        flash: null,
        showReport: false,
        focus: focusOn(ownedBy(game, game.playerId)),
      });
    },

    abandonGame: () => {
      clearSave();
      set({
        game: null,
        undoStack: [],
        phase: 'menu',
        selectedId: null,
        targetId: null,
        suggestedTroops: null,
        suggestedSupport: null,
        flash: null,
        showReport: false,
        hasSavedGame: false,
      });
    },

    /**
     * Map clicks. With one of your countries selected, clicking a neighbour makes
     * it the target of an order — an attack if it is foreign, a move if it is
     * yours. Anything else just selects what was clicked.
     */
    clickCountry: (id) => {
      const { game, selectedId } = get();
      if (!game) return;
      const source = selectedId ? game.countries[selectedId] : undefined;
      if (
        source &&
        source.ownerId === game.playerId &&
        source.id !== id &&
        !source.hasMoved &&
        areAdjacent(game.adjacency, source.id, id)
      ) {
        set({ targetId: id, suggestedTroops: null, suggestedSupport: null, flash: null });
        return;
      }
      set({ selectedId: id, targetId: null, suggestedTroops: null, suggestedSupport: null, flash: null });
    },

    selectCountry: (id) => set({ selectedId: id, targetId: null, suggestedTroops: null, suggestedSupport: null, flash: null }),

    deselect: () => set({ selectedId: null, targetId: null, suggestedTroops: null, suggestedSupport: null, flash: null }),

    setOrder: (sourceId, targetId, troops, support) =>
      set({
        selectedId: sourceId,
        targetId,
        suggestedTroops: troops ?? null,
        suggestedSupport: support ?? null,
        flash: null,
      }),

    setJoining: (ids) => {
      const current = get().joiningIds;
      if (current.length !== ids.length || current.some((id, i) => id !== ids[i])) set({ joiningIds: ids });
    },

    /**
     * Selects the next of your countries that can still act, cycling through them
     * in order of how likely each is to fall, so the urgent ones come first.
     */
    selectNextReady: () => {
      const { game, selectedId } = get();
      if (!game) return;
      const ready = Object.values(game.countries)
        .filter((c) => c.ownerId === game.playerId && !c.hasMoved && c.troops > 1)
        .map((c) => ({ id: c.id, risk: combinedThreat(game, c.id) }))
        .sort((a, b) => b.risk - a.risk || a.id.localeCompare(b.id))
        .map((c) => c.id);
      if (ready.length === 0) {
        set({ flash: { tone: 'info', text: 'Every garrison has acted this turn. End the turn to go again.' } });
        return;
      }
      const at = selectedId ? ready.indexOf(selectedId) : -1;
      const next = ready[(at + 1) % ready.length] ?? ready[0]!;
      set({
        selectedId: next,
        targetId: null,
        suggestedTroops: null,
        suggestedSupport: null,
        flash: null,
        focus: focusOn([next]),
      });
    },

    undo: () => {
      const stack = get().undoStack;
      const previous = stack[stack.length - 1];
      if (!previous) return;
      commit(previous, {
        undoStack: stack.slice(0, -1),
        targetId: null,
        suggestedTroops: null,
        suggestedSupport: null,
        flash: { tone: 'info', text: 'Undone.' },
      });
    },

    /** Escape: drop the target first, then the selection. */
    back: () => {
      const { targetId, selectedId } = get();
      if (targetId) set({ targetId: null, suggestedTroops: null, suggestedSupport: null });
      else if (selectedId) set({ selectedId: null, flash: null });
    },

    doInvest: (countryId) => {
      const game = get().game;
      if (!game) return;
      const outcome = invest(game, game.playerId, countryId);
      if (outcome.error) set({ flash: { tone: 'bad', text: outcome.error } });
      else commitReversible(game, outcome.state, { flash: null });
    },

    doRecruit: (countryId, troops) => {
      const game = get().game;
      if (!game) return;
      const outcome = recruit(game, game.playerId, countryId, troops);
      if (outcome.error) set({ flash: { tone: 'bad', text: outcome.error } });
      else commitReversible(game, outcome.state, { flash: { tone: 'info', text: `Recruited ${Math.floor(troops)} troops.` } });
    },

    doMove: (troops) => {
      const { game, selectedId, targetId } = get();
      if (!game || !selectedId || !targetId) return;
      const outcome = moveTroops(game, game.playerId, selectedId, targetId, troops);
      if (outcome.error) {
        set({ flash: { tone: 'bad', text: outcome.error } });
        return;
      }
      commitReversible(game, outcome.state, {
        selectedId: targetId,
        targetId: null,
        suggestedTroops: null,
        suggestedSupport: null,
        flash: { tone: 'info', text: `Moved ${Math.floor(troops)} troops.` },
      });
    },

    doAttack: (troops, support) => {
      const { game, selectedId, targetId } = get();
      if (!game || !selectedId || !targetId) return;
      const outcome =
        support.length === 0
          ? attack(game, game.playerId, selectedId, targetId, troops)
          : assault(game, game.playerId, targetId, [{ fromId: selectedId, troops }, ...support]);
      if (outcome.error) {
        set({ flash: { tone: 'bad', text: outcome.error } });
        return;
      }
      const [entry] = entriesSince(game, outcome.state);
      const target = outcome.state.countries[targetId];
      const won = entry?.combat?.captured ?? false;
      commit(outcome.state, {
        undoStack: [],
        selectedId: won ? targetId : selectedId,
        targetId: null,
        suggestedTroops: null,
        suggestedSupport: null,
        flash: won
          ? { tone: 'good', text: `${target?.name ?? 'Territory'} captured — ${target?.troops ?? 0} troops hold it.` }
          : { tone: 'bad', text: `The attack on ${target?.name ?? 'the territory'} failed.` },
      });
    },

    /** Best safe attack; failing that, the most useful troop movement. */
    advise: () => {
      const game = get().game;
      if (!game) return;
      const plan = adviseAttack(game);
      if (plan) {
        set({
          selectedId: plan.fromId,
          targetId: plan.targetId,
          suggestedTroops: plan.troops,
          suggestedSupport: plan.support,
          flash: null,
          focus: focusOn([plan.fromId, plan.targetId, ...plan.support.map((p) => p.fromId)]),
        });
        return;
      }
      const move = adviseMove(game);
      if (move) {
        set({
          selectedId: move.fromId,
          targetId: move.toId,
          suggestedTroops: move.troops,
          suggestedSupport: null,
          flash: {
            tone: 'info',
            text:
              move.reason === 'threatened'
                ? 'No safe attack. Reinforce this country before it falls.'
                : 'No safe attack. Bring idle troops closer to the front.',
          },
          focus: focusOn([move.fromId, move.toId]),
        });
        return;
      }
      const ready = Object.values(game.countries).some((c) => c.ownerId === game.playerId && !c.hasMoved);
      set({
        flash: {
          tone: 'info',
          text: ready
            ? 'Nothing worth doing with the troops you have. Recruit, or end the turn.'
            : 'Every garrison has acted this turn. End the turn to go again.',
        },
      });
    },

    endTurn: () => {
      const game = get().game;
      if (!game || game.status !== 'playing') return;
      const next = runEndTurn(game);
      const report = next.lastReport;
      const eventful = report !== null && (report.lost.length > 0 || report.held > 0 || report.deserted > 0);
      const selected = get().selectedId;
      commit(next, {
        undoStack: [],
        targetId: null,
        suggestedTroops: null,
        suggestedSupport: null,
        flash: null,
        showReport: eventful,
        // Keep your selection only if it is still yours.
        selectedId: selected && next.countries[selected]?.ownerId === next.playerId ? selected : null,
      });
    },

    focusHome: () => {
      const game = get().game;
      if (game) set({ focus: focusOn(ownedBy(game, game.playerId)) });
    },

    focusNation: (nationId) => {
      const game = get().game;
      if (!game) return;
      const owned = ownedBy(game, nationId);
      const anchor = owned.includes(nationId) ? nationId : owned[0];
      set({ focus: focusOn(owned), selectedId: anchor ?? null, targetId: null, flash: null });
    },

    focusCountries: (countryIds) => {
      if (countryIds.length > 0) set({ focus: focusOn(countryIds) });
    },

    dismissReport: () => set({ showReport: false }),

    setHelp: (open) => {
      if (!open) markHelpSeen();
      set({ showHelp: open });
    },
  };
});
