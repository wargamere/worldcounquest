/**
 * The running game, held outside React (§9.6, §9.8). One Session at a time:
 * the live Sim, the map geometry built for it, and the real time played. The
 * UI reads the Sim through views and changes it only through issue(), which
 * applies a Command between ticks (paused or running: "active pause").
 *
 * This module is the seam a Worker host would replace; nothing else in the UI
 * reaches the Sim except through it and the loop.
 */
import { applyCommand } from '@/next/game/commands';
import { createSim } from '@/next/game/sim';
import type { Command, CommandResult, GameState, MapStatic, Sim } from '@/next/game/types';
import type { MapGeometry } from '@/next/lib/geometry';

export interface Session {
  sim: Sim;
  geometry: MapGeometry;
  playedMs: number;
}

/** Dev builds and tests keep the command log, so a session can be exported and replayed exactly. */
const RECORD_COMMANDS = process.env.NODE_ENV !== 'production';

let current: Session | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of [...listeners]) fn();
}

/** Wraps a new or loaded GameState in a Sim and makes it the running session. */
export function openSession(map: MapStatic, geometry: MapGeometry, state: GameState, playedMs: number): Session {
  current = { sim: createSim(map, state, { recordCommands: RECORD_COMMANDS }), geometry, playedMs };
  notify();
  return current;
}

export function getSession(): Session | null {
  return current;
}

export function closeSession(): void {
  if (current === null) return;
  current = null;
  notify();
}

/** The player's command, applied at once; subscribers hear about every accepted one. */
export function issue(command: Command): CommandResult {
  if (current === null) return { ok: false, reason: 'No game is running' };
  const result = applyCommand(current.sim, command, 'player');
  if (result.ok) notify();
  return result;
}

/** Called when a session opens or closes and after every accepted command. */
export function subscribeSession(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
