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

export interface CombatRecord {
  attackerId: NationId;
  defenderId: NationId;
  countryId: CountryId;
  captured: boolean;
}

/** A nation that capitulated when its capital fell. */
export interface SurrenderRecord {
  loserId: NationId;
  winnerId: NationId;
  /** Countries handed over, not counting the capital itself. */
  countries: number;
  /** Troops that changed sides. */
  troops: number;
}

export interface LogEntry {
  id: number;
  turn: number;
  kind: LogKind;
  text: string;
  /** Nations involved, used to filter the log down to what the player cares about. */
  nationIds: NationId[];
  /** Structured outcome for combat entries, so reports never parse the text. */
  combat?: CombatRecord;
  surrender?: SurrenderRecord;
}

export interface PlayerStats {
  battlesWon: number;
  battlesLost: number;
  defencesHeld: number;
  countriesLost: number;
  peakCountries: number;
}

/** Countries held at the end of one month, for the biggest nations and the player. */
export interface HistoryPoint {
  turn: number;
  counts: Record<NationId, number>;
}

/** What happened to the player while the AI nations took their turns. */
export interface TurnReport {
  /** The month that just ended. */
  turn: number;
  lost: { countryId: CountryId; name: string; byId: NationId }[];
  /** Attacks on the player that failed. */
  held: number;
  /** Large nations that capitulated anywhere in the world this month. */
  surrenders: SurrenderRecord[];
  income: number;
  deserted: number;
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
  stats: PlayerStats;
  lastReport: TurnReport | null;
  history: HistoryPoint[];
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
