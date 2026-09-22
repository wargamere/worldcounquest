/** ISO 3166-1 numeric code as a zero-padded string, e.g. "826". */
export type CountryId = string;

/** A nation is identified by the country it started from. */
export type NationId = string;

export type Difficulty = 'relaxed' | 'standard' | 'ruthless';

export type GameStatus = 'playing' | 'won' | 'lost';

/** Authored game data. Not derived from the map. */
export interface CountrySeed {
  id: CountryId;
  name: string;
  population: number;
  economyTier: number;
}

export interface SeaLink {
  a: CountryId;
  b: CountryId;
  note: string;
}

export interface Country {
  id: CountryId;
  name: string;
  population: number;
  /** 1..5, authored. Never changes during a game. */
  economyTier: number;
  ownerId: NationId;
  troops: number;
  /** 1..10, raised by investing. */
  development: number;
  /** Troops here have already moved or attacked this turn. */
  hasMoved: boolean;
}

export interface Nation {
  id: NationId;
  name: string;
  colour: string;
  treasury: number;
  manpower: number;
  isPlayer: boolean;
  /** Full AI logic this turn, as opposed to the cheap defensive heuristic. */
  isMajor: boolean;
}

export type LogKind = 'combat' | 'economy' | 'action' | 'system';

export interface LogEntry {
  id: number;
  turn: number;
  kind: LogKind;
  text: string;
  /** Nations involved, used to filter the log down to what the player cares about. */
  nationIds: NationId[];
}

/** countryId -> neighbouring countryIds, land and sea combined. Symmetric. */
export type AdjacencyGraph = Record<CountryId, CountryId[]>;

export interface GameState {
  /** Months elapsed since the start date. */
  turn: number;
  countries: Record<CountryId, Country>;
  nations: Record<NationId, Nation>;
  adjacency: AdjacencyGraph;
  playerId: NationId;
  difficulty: Difficulty;
  status: GameStatus;
  log: LogEntry[];
  nextLogId: number;
  rngState: number;
}

export interface CombatResult {
  captured: boolean;
  /** Attacker's rolled strength. */
  attackPower: number;
  /** Defender's rolled strength. */
  defencePower: number;
  /** Attacking troops still alive after the battle. */
  attackerSurvivors: number;
  /** Defending troops still alive after the battle. */
  defenderSurvivors: number;
}
