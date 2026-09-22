import type { AdjacencyGraph, GameState } from '@/game/types';

const KEY = 'hegemon.save.v1';

/** The adjacency graph is derived from the map file, so it is never persisted. */
type SavedGame = Omit<GameState, 'adjacency'>;

export function saveGame(state: GameState): void {
  try {
    const { adjacency: _adjacency, ...rest } = state;
    window.localStorage.setItem(KEY, JSON.stringify(rest));
  } catch {
    // Storage can be full or blocked (private browsing). A lost autosave is not
    // worth interrupting play for.
  }
}

export function loadGame(adjacency: AdjacencyGraph): GameState | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw) as SavedGame;
    if (!saved.countries || !saved.nations || !saved.playerId) return null;
    return { ...saved, adjacency };
  } catch {
    return null;
  }
}

export function hasSave(): boolean {
  try {
    return window.localStorage.getItem(KEY) !== null;
  } catch {
    return false;
  }
}

export function clearSave(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // Nothing to do — see saveGame.
  }
}
