/**
 * A cut-down tick for the armies, movement and combat tests: the movement,
 * index, battle and sweep phases of §1 in their real order, without economy,
 * provinces or AI, so a test sees exactly the rules under test.
 */
import { COMBAT } from '../balance';
import { hourlyArmies, sweepDeadArmies } from '../armies';
import { rebuildArmyIndex } from '../cache';
import { isHourStart } from '../clock';
import { resolveBattles } from '../combat';
import { advanceMovement } from '../movement';
import { refreshSupply } from '../supply';
import type { NationIx, ProvinceIx, Sim, Terrain, UnitCounts } from '../types';
import { totalHp } from '../units';
import { tinySim, type TinyArmy, type TinyEdge, type TinyProvince, type TinySim } from './helpers';

export interface StepOptions {
  /** Also run hourlyArmies (healing and attrition) on hourly ticks. */
  armies?: boolean;
}

export function step(sim: Sim, options: StepOptions = {}): void {
  advanceMovement(sim);
  rebuildArmyIndex(sim);
  if (isHourStart(sim.state.tick)) {
    refreshSupply(sim);
    resolveBattles(sim);
    if (options.armies === true) hourlyArmies(sim);
  }
  sweepDeadArmies(sim);
  sim.state.tick += 1;
}

export function steps(sim: Sim, ticks: number, options: StepOptions = {}): void {
  for (let i = 0; i < ticks; i += 1) step(sim, options);
}

/** Steps until `done` holds (checked before each tick), at most `limit` ticks; returns the ticks run. */
export function stepUntil(sim: Sim, done: () => boolean, limit: number, options: StepOptions = {}): number {
  let ran = 0;
  while (!done() && ran < limit) {
    step(sim, options);
    ran += 1;
  }
  return ran;
}

// ------------------------------------------------------------ battle worlds

export interface BattleSetup {
  terrain?: Terrain;
  garrison: number;
  ramparts?: number;
  /** Units standing in the target for its owner. */
  defenders?: UnitCounts;
  defenderRetreatAt?: number;
  /** One army per entry, each entering from its own province: n armies are n directions. */
  attackers: UnitCounts[];
  attackerRetreatAt?: number;
  seed?: string;
}

/**
 * A battle already joined: the target `t` (owned by `def`, whose capital is the
 * rear province `d0`) holds the defenders and the garrison; each attacking army
 * of `me` (the player) stands in `t` and entered it from its own province `aN`.
 */
export function battleWorld(setup: BattleSetup): TinySim & { target: ProvinceIx } {
  const provinces: Record<string, TinyProvince> = {
    d0: { owner: 'def', capitalOf: 'def' },
    t: { owner: 'def', terrain: setup.terrain ?? 'plains', garrison: setup.garrison, buildings: { ramparts: setup.ramparts ?? 0 } },
  };
  const edges: TinyEdge[] = [['d0', 't']];
  setup.attackers.forEach((_, i) => {
    provinces[`a${i}`] = i === 0 ? { owner: 'me', capitalOf: 'me' } : { owner: 'me' };
    edges.push([`a${i}`, 't']);
  });
  const armies: TinyArmy[] = [];
  if (setup.defenders !== undefined) armies.push({ owner: 'def', at: 't', units: setup.defenders, retreatAt: setup.defenderRetreatAt ?? 0 });
  for (const units of setup.attackers) armies.push({ owner: 'me', at: 't', units, retreatAt: setup.attackerRetreatAt ?? COMBAT.AI_RETREAT_AT });
  const tiny = tinySim({ provinces, edges, armies, player: 'me', ...(setup.seed === undefined ? {} : { seed: setup.seed }) });
  let k = 0;
  for (const army of tiny.sim.state.armies) {
    if (army.owner !== tiny.n('me')) continue;
    const from = tiny.p(`a${k}`);
    army.battle!.direction = from;
    army.cameFrom = from;
    k += 1;
  }
  return { ...tiny, target: tiny.p('t') };
}

export interface BattleRun {
  /** Hourly rounds fought until the battle ended. */
  hours: number;
  captured: boolean;
  /** Army HP left on each side (after any disengage cost) over the army HP they started with. */
  attackerKeeps: number;
  defenderKeeps: number;
}

/** Runs the battle at the target tick by tick until it ends (or `maxHours`). */
export function runBattle(world: TinySim & { target: ProvinceIx }, maxHours = 96): BattleRun {
  const { sim, target } = world;
  const me = world.n('me');
  const def = world.n('def');
  const hpOf = (n: NationIx): number => sim.state.armies.filter((a) => a.alive && a.owner === n).reduce((s, a) => s + totalHp(a.units), 0);
  const startA = hpOf(me);
  const startD = hpOf(def);
  let hours = 0;
  while (hours < maxHours && sim.state.provinces[target]!.battleSince !== null) {
    if (isHourStart(sim.state.tick)) hours += 1;
    step(sim);
  }
  return {
    hours,
    captured: sim.state.provinces[target]!.owner === me,
    attackerKeeps: startA > 0 ? hpOf(me) / startA : 0,
    defenderKeeps: startD > 0 ? hpOf(def) / startD : 0,
  };
}
