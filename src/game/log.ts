import { LOG } from './balance';
import type { CombatRecord, GameState, LogEntry, LogKind, NationId } from './types';

/** Appends an entry, trimming the oldest once the cap is hit. Returns new state. */
export function appendLog(
  state: GameState,
  kind: LogKind,
  text: string,
  nationIds: NationId[],
  combat?: CombatRecord,
): GameState {
  const entry: LogEntry = {
    id: state.nextLogId,
    turn: state.turn,
    kind,
    text,
    nationIds,
    ...(combat ? { combat } : {}),
  };
  const log = [entry, ...state.log].slice(0, LOG.MAX_ENTRIES);
  return { ...state, log, nextLogId: state.nextLogId + 1 };
}

/**
 * The player's default view: events involving the player, a nation bordering the
 * player, or a major power. Everything else is noise from the other side of the
 * world. The UI can still show the unfiltered log.
 */
export function visibleLog(state: GameState): LogEntry[] {
  const relevant = new Set<NationId>([state.playerId]);
  for (const nation of Object.values(state.nations)) {
    if (nation.isMajor) relevant.add(nation.id);
  }
  for (const country of Object.values(state.countries)) {
    if (country.ownerId !== state.playerId) continue;
    for (const neighbourId of state.adjacency[country.id] ?? []) {
      const neighbour = state.countries[neighbourId];
      if (neighbour) relevant.add(neighbour.ownerId);
    }
  }
  return state.log.filter(
    (entry) => entry.nationIds.length === 0 || entry.nationIds.some((id) => relevant.has(id)),
  );
}

/** Turn index -> calendar label, e.g. "March 1936". */
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

export function formatTurn(turn: number, startYear: number, startMonth: number): string {
  const absolute = (startMonth - 1) + turn;
  const year = startYear + Math.floor(absolute / 12);
  const month = MONTHS[absolute % 12] ?? MONTHS[0];
  return `${month} ${year}`;
}

/** Entries appended between two states of the same game, newest first. */
export function entriesSince(before: GameState, after: GameState): LogEntry[] {
  return after.log.filter((entry) => entry.id >= before.nextLogId);
}
