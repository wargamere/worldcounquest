/**
 * The store's actions for event handlers. Handlers call `act().setSpeed(2)`
 * rather than holding unbound methods, and never keep a stale store snapshot.
 */
import { useGameStore, type GameStore } from '@/next/store/gameStore';

export function act(): GameStore {
  return useGameStore.getState();
}
