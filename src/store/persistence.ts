import type { AdjacencyGraph, GameState } from '@/game/types';

/**
 * Bumped whenever GameState changes shape. An older save is discarded rather
 * than loaded half-understood.
 */
const VERSION = 3;
const KEY = `hegemon.save.v${VERSION}`;
const HELP_SEEN_KEY = 'hegemon.help-seen';

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
    if (!saved.countries || !saved.nations || !saved.playerId || !saved.stats || !saved.history) return null;
    return { ...saved, adjacency };
  } catch {
    return null;
  }
}

export function clearSave(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // Nothing to do — see saveGame.
  }
}

export function hasSeenHelp(): boolean {
  try {
    return window.localStorage.getItem(HELP_SEEN_KEY) === '1';
  } catch {
    return false;
  }
}

export function markHelpSeen(): void {
  try {
    window.localStorage.setItem(HELP_SEEN_KEY, '1');
  } catch {
    // A missing flag only means the help shows again next time.
  }
}
