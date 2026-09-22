'use client';

import { create } from 'zustand';
import seedData from '@/data/countries.seed.json';
import seaLinkData from '@/data/sea-links.json';
import { attack, invest, moveTroops, recruit } from '@/game/actions';
import { createGame } from '@/game/init';
import { endTurn as runEndTurn } from '@/game/turn';
import type {
  CountryId,
  CountrySeed,
  Difficulty,
  GameState,
  SeaLink,
} from '@/game/types';
import { buildWorld, fetchTopology, type World } from '@/lib/world';
import { clearSave, loadGame, saveGame } from './persistence';

const seeds = seedData as CountrySeed[];
const seaLinks = seaLinkData as SeaLink[];

export type Phase = 'loading' | 'menu' | 'playing' | 'error';

interface GameStore {
  phase: Phase;
  world: World | null;
  game: GameState | null;
  selectedId: CountryId | null;
  /** Staging country for a pending move or attack. */
  orderFromId: CountryId | null;
  message: string | null;
  loadError: string | null;
  hasSavedGame: boolean;

  init: (basePath: string) => Promise<void>;
  startGame: (playerCountryId: CountryId, difficulty: Difficulty) => void;
  resumeGame: () => void;
  abandonGame: () => void;
  select: (id: CountryId | null) => void;
  beginOrder: (fromId: CountryId | null) => void;
  doInvest: (countryId: CountryId) => void;
  doRecruit: (countryId: CountryId, troops: number) => void;
  doMove: (fromId: CountryId, toId: CountryId, troops: number) => void;
  doAttack: (fromId: CountryId, targetId: CountryId, troops: number) => void;
  endTurn: () => void;
  dismissMessage: () => void;
}

export const useGameStore = create<GameStore>((set, get) => {
  /** Applies a pure action result: keeps the error as a transient message. */
  const apply = (outcome: { state: GameState; error?: string }): void => {
    if (outcome.error) {
      set({ message: outcome.error });
      return;
    }
    saveGame(outcome.state);
    set({ game: outcome.state, message: null, orderFromId: null });
  };

  return {
    phase: 'loading',
    world: null,
    game: null,
    selectedId: null,
    orderFromId: null,
    message: null,
    loadError: null,
    hasSavedGame: false,

    init: async (basePath) => {
      try {
        const topology = await fetchTopology(basePath);
        const world = buildWorld(topology, seeds, seaLinks);
        set({
          world,
          phase: 'menu',
          hasSavedGame: loadGame(world.adjacency) !== null,
        });
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
      saveGame(game);
      set({
        game,
        phase: 'playing',
        selectedId: playerCountryId,
        orderFromId: null,
        message: null,
        hasSavedGame: true,
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
      set({ game, phase: 'playing', selectedId: game.playerId, orderFromId: null });
    },

    abandonGame: () => {
      clearSave();
      set({
        game: null,
        phase: 'menu',
        selectedId: null,
        orderFromId: null,
        message: null,
        hasSavedGame: false,
      });
    },

    select: (id) => set({ selectedId: id }),
    beginOrder: (fromId) => set({ orderFromId: fromId }),
    dismissMessage: () => set({ message: null }),

    doInvest: (countryId) => {
      const game = get().game;
      if (!game) return;
      apply(invest(game, game.playerId, countryId));
    },

    doRecruit: (countryId, troops) => {
      const game = get().game;
      if (!game) return;
      apply(recruit(game, game.playerId, countryId, troops));
    },

    doMove: (fromId, toId, troops) => {
      const game = get().game;
      if (!game) return;
      apply(moveTroops(game, game.playerId, fromId, toId, troops));
      set({ selectedId: toId });
    },

    doAttack: (fromId, targetId, troops) => {
      const game = get().game;
      if (!game) return;
      apply(attack(game, game.playerId, fromId, targetId, troops));
    },

    endTurn: () => {
      const game = get().game;
      if (!game || game.status !== 'playing') return;
      const next = runEndTurn(game);
      saveGame(next);
      set({ game: next, orderFromId: null, message: null });
    },
  };
});
