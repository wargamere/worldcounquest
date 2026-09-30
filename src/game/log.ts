import { HISTORY, LOG } from './balance';
import type { CombatRecord, GameState, HistoryPoint, LogEntry, LogKind, NationId, SurrenderRecord } from './types';

/** Appends an entry, trimming the oldest once the cap is hit. Returns new state. */
export function appendLog(
  state: GameState,
  kind: LogKind,
  text: string,
  nationIds: NationId[],
  combat?: CombatRecord,
  surrender?: SurrenderRecord,
): GameState {
  const entry: LogEntry = {
    id: state.nextLogId,
    turn: state.turn,
    kind,
    text,
    nationIds,
    ...(combat ? { combat } : {}),
    ...(surrender ? { surrender } : {}),
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

/**
 * A snapshot of who holds how much, for the history chart: the player plus the
 * TRACKED_NATIONS largest nations. Recording every nation every month would
 * bloat saves for lines nobody could read.
 */
export function recordHistory(state: GameState): HistoryPoint {
  const counts = new Map<NationId, number>();
  for (const country of Object.values(state.countries)) {
    counts.set(country.ownerId, (counts.get(country.ownerId) ?? 0) + 1);
  }
  const top = [...counts.entries()]
    .filter(([id]) => id !== state.playerId)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, HISTORY.TRACKED_NATIONS);
  return {
    turn: state.turn,
    counts: Object.fromEntries([[state.playerId, counts.get(state.playerId) ?? 0], ...top]),
  };
}
