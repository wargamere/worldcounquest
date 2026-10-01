/**
 * The only write path besides the tick. The player's clicks, the AI and the
 * Staff all issue the same Commands; applyCommand validates them, applies them
 * through the owning system and, when recording, appends them to the command
 * log so a session can be replayed exactly from its seed.
 *
 * validateCommand never changes anything. It checks who may give the command
 * and every rule that can be judged without planning a route; the systems check
 * the rest (a route that does not exist, say) when the command is applied.
 */
import {
  armyStatus,
  disbandArmy,
  isIdle,
  mergeArmies,
  ownArmies,
  setRetreatAt,
  setStance,
  splitArmy,
} from './armies';
import { canBuild, cancelConstruction, startConstruction } from './buildings';
import { armyById } from './cache';
import { shortfallReason, STOCK_LABELS } from './economy';
import { quote, setTradePolicy, trade } from './market';
import { orderMove, retreatArmies, stopArmies } from './movement';
import { canTrain, cancelQueued, enqueue, setKeepTraining, setRally } from './training';
import { BUILDING_TYPES, GOODS, UNIT_TYPES } from './types';
import type { Army, ArmyId, Command, CommandKind, CommandResult, CommandSource, NationIx, Sim, Stance } from './types';
import { totalCount } from './units';

const OK: CommandResult = { ok: true, armies: [] };
const fail = (reason: string): CommandResult => ({ ok: false, reason });

const STANCES: readonly Stance[] = ['manual', 'defend', 'delegate'];
/** Orders that move an army; given by the player, they take a Defend or Delegate army back. */
const MOVEMENT_KINDS: ReadonlySet<CommandKind> = new Set<CommandKind>(['move', 'stop', 'retreat']);
/** The Staff only manoeuvres armies; it never trains, builds, trades or changes a stance. */
const STAFF_KINDS: ReadonlySet<CommandKind> = new Set<CommandKind>(['move', 'stop', 'retreat', 'merge', 'split']);

function isProvince(sim: Sim, p: number): boolean {
  return Number.isInteger(p) && p >= 0 && p < sim.map.provinces.length;
}

/** The armies a command names, in the order it names them. */
function namedArmies(command: Command): readonly ArmyId[] {
  switch (command.kind) {
    case 'move':
    case 'stop':
    case 'retreat':
    case 'merge':
    case 'stance':
    case 'retreatAt':
      return command.armies;
    case 'split':
    case 'disband':
      return [command.army];
    default:
      return [];
  }
}

/** Who may give this command for this nation. */
function sourceReason(sim: Sim, command: Command, source: CommandSource): string | null {
  const { state } = sim;
  if (source === 'ai') return command.nation === state.player ? 'The AI cannot command your nation' : null;
  if (command.nation !== state.player) return 'Not your nation';
  if (source === 'player') return null;
  if (!STAFF_KINDS.has(command.kind)) return 'The Staff only commands armies';
  for (const id of namedArmies(command)) {
    const army = armyById(sim, id);
    if (army !== undefined && army.stance === 'manual') return `${army.name} is under your command, not the Staff's`;
  }
  return null;
}

function frozenReason(sim: Sim, armies: readonly Army[]): string | null {
  for (const army of armies) if (armyStatus(sim, army) === 'frozen') return `${army.name} cannot move yet`;
  return null;
}

function armiesReason(sim: Sim, command: Command): string | null {
  const ids = namedArmies(command);
  if (ids.length === 0) return null;
  const armies = ownArmies(sim, command.nation, ids);
  if (typeof armies === 'string') return armies;
  switch (command.kind) {
    case 'move':
      if (!isProvince(sim, command.to)) return 'No such province';
      return frozenReason(sim, armies);
    case 'retreat':
      if (command.to !== null && !isProvince(sim, command.to)) return 'No such province';
      for (const army of armies) if (army.leg !== null) return `${army.name} is on the move`;
      return frozenReason(sim, armies);
    case 'merge': {
      if (armies.length < 2) return 'Pick at least two armies to merge';
      const at = armies[0]!.at;
      for (const army of armies) {
        if (army.leg !== null) return `${army.name} is on the move`;
        if (army.battle !== null) return `${army.name} is in a battle`;
        if (army.at !== at) return 'Only armies in the same province can merge';
      }
      return frozenReason(sim, armies);
    }
    case 'split': {
      const army = armies[0]!;
      if (!isIdle(sim, army)) return 'Only an idle army can split';
      let taking = 0;
      for (const type of UNIT_TYPES) {
        const count = command.take[type] ?? 0;
        if (!Number.isInteger(count) || count < 0) return 'Split whole units';
        if (count > army.units[type].count) return 'Not that many units';
        taking += count;
      }
      if (taking === 0) return 'Pick units to split off';
      if (taking === totalCount(army.units)) return 'Leave at least one unit behind';
      return null;
    }
    case 'stance':
      return STANCES.includes(command.stance) ? null : 'Unknown stance';
    case 'retreatAt':
      return Number.isFinite(command.at) && command.at >= 0 && command.at < 1 ? null : 'Retreat threshold must be between 0 and 1';
    default:
      return null;
  }
}

/** Rules for the province, economy and market commands. */
function economyReason(sim: Sim, command: Command): string | null {
  const { state } = sim;
  const n = command.nation;
  const own = (p: number): boolean => isProvince(sim, p) && state.provinces[p]!.owner === n;
  switch (command.kind) {
    case 'build': {
      if (!BUILDING_TYPES.includes(command.building)) return 'Unknown building';
      if (!isProvince(sim, command.province)) return 'No such province';
      const check = canBuild(sim, n, command.province, command.building);
      return check.ok ? null : check.reason;
    }
    case 'cancelBuild':
      if (!own(command.province)) return 'Not your province';
      return state.provinces[command.province]!.construction === null ? 'Nothing is being built' : null;
    case 'train': {
      if (!UNIT_TYPES.includes(command.unit)) return 'Unknown unit';
      if (!isProvince(sim, command.province)) return 'No such province';
      const check = canTrain(sim, n, command.province, command.unit, command.count);
      return check.ok ? null : check.reason;
    }
    case 'cancelTrain':
      if (!own(command.province)) return 'Not your province';
      return Number.isInteger(command.index) && state.provinces[command.province]!.queue[command.index] !== undefined
        ? null
        : 'No such item in the queue';
    case 'keepTraining':
      if (!own(command.province)) return 'Not your province';
      return command.on && state.provinces[command.province]!.buildings.training === 0 ? 'Needs a Training Ground' : null;
    case 'rally':
      if (!own(command.province)) return 'Not your province';
      if (command.to !== null && !own(command.to)) return 'The rally point must be your province';
      return null;
    case 'trade': {
      if (!GOODS.includes(command.good)) return 'Unknown good';
      if (!Number.isFinite(command.amount) || command.amount === 0) return 'Nothing to trade';
      const q = quote(state.market, command.good, command.amount);
      const stocks = state.nations[n]!.stocks;
      if (q.amount > 0) return shortfallReason(stocks, { funds: q.funds });
      return stocks[command.good] < -q.amount ? `Only ${Math.floor(stocks[command.good])} ${STOCK_LABELS[command.good]} in stock` : null;
    }
    case 'tradePolicy': {
      const valid = (days: Readonly<Record<string, number>>): boolean =>
        GOODS.every((good) => Number.isFinite(days[good]) && days[good]! >= 0);
      return valid(command.policy.keepDays) && valid(command.policy.sellAboveDays) ? null : 'Days must be 0 or more';
    }
    default:
      return null;
  }
}

/** Checks a command without applying it. */
export function validateCommand(sim: Sim, command: Command, source: CommandSource): CommandResult {
  const { state } = sim;
  if (state.status !== 'playing' && !state.sandbox) return fail('The game is over');
  const nation = Number.isInteger(command.nation) ? state.nations[command.nation] : undefined;
  if (nation === undefined) return fail('No such nation');
  if (!nation.alive) return fail(`${sim.map.nations[command.nation]!.name} is no longer in the game`);
  const reason = sourceReason(sim, command, source) ?? armiesReason(sim, command) ?? economyReason(sim, command);
  return reason === null ? OK : fail(reason);
}

function dispatch(sim: Sim, command: Command): CommandResult {
  const n: NationIx = command.nation;
  switch (command.kind) {
    case 'move':
      return orderMove(sim, n, command.armies, command.to, command.together, command.append);
    case 'stop':
      return stopArmies(sim, n, command.armies);
    case 'retreat':
      return retreatArmies(sim, n, command.armies, command.to);
    case 'split':
      return splitArmy(sim, n, command.army, command.take);
    case 'merge':
      return mergeArmies(sim, n, command.armies);
    case 'disband':
      return disbandArmy(sim, n, command.army);
    case 'stance':
      return setStance(sim, n, command.armies, command.stance);
    case 'retreatAt':
      return setRetreatAt(sim, n, command.armies, command.at);
    case 'build':
      return startConstruction(sim, n, command.province, command.building);
    case 'cancelBuild':
      return cancelConstruction(sim, n, command.province);
    case 'train':
      return enqueue(sim, n, command.province, command.unit, command.count);
    case 'cancelTrain':
      return cancelQueued(sim, n, command.province, command.index);
    case 'keepTraining':
      return setKeepTraining(sim, n, command.province, command.on);
    case 'rally':
      return setRally(sim, n, command.province, command.to);
    case 'trade':
      return trade(sim, n, command.good, command.amount);
    case 'tradePolicy':
      return setTradePolicy(sim, n, command.policy);
  }
}

/**
 * A player's movement order takes Defend and Delegate armies back under manual
 * command (§4.3). Armies merged away by the order are gone; the survivor of a
 * merge is already Manual if any member was, since a merge keeps the most
 * cautious stance.
 */
function takeBackFromStaff(sim: Sim, command: Command): void {
  for (const id of namedArmies(command)) {
    const army = armyById(sim, id);
    if (army === undefined || !army.alive || army.stance === 'manual') continue;
    army.stance = 'manual';
    army.post = null;
    sim.cache.armyVersion += 1;
  }
}

/**
 * Validates, applies and (when recording) logs a command. A command that passes
 * validation is logged even if its system then refuses it, because a refusal
 * after validation may already have changed something (an order merges its
 * co-located armies before it plans their route), and a replay must repeat it.
 */
export function applyCommand(sim: Sim, command: Command, source: CommandSource): CommandResult {
  const check = validateCommand(sim, command, source);
  if (!check.ok) return check;
  sim.cache.commandLog?.push({ tick: sim.state.tick, source, command: structuredClone(command) });
  const result = dispatch(sim, command);
  if (result.ok && source === 'player' && MOVEMENT_KINDS.has(command.kind)) takeBackFromStaff(sim, command);
  return result;
}

