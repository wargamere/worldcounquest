/**
 * The tick: one fixed, tested phase order (§1) over the systems, all iteration
 * by ascending index. Nothing here reads a clock; the store's loop decides how
 * many ticks a frame runs, and SimHooks let the bench time each phase.
 *
 *   movement  departures, leg progress, arrivals; then the army index
 *   combat    (hourly) supply refresh, the battle round
 *   economy   (hourly) income and upkeep, Oil re-timing, construction, training
 *   provinces (hourly) stability and garrisons, army healing, revolts,
 *             the Exchange's decay and the player's auto-trade, the player's vision
 *   daily     (midnight) integration, price history, the VP history, tier
 *             review, the digest
 *   ai        due AI thinks and alerts, then the Staff (every 4 h, by its own schedule)
 *   sweep     the victory check, dead armies, the index, tick + 1
 */
import { AI_TIERS, ECONOMY, MARKET, TIME } from './balance';
import { aiPhase } from './ai/think';
import { reviewTiers } from './ai/scheduler';
import { staffPhase } from './ai/staff';
import { hourlyArmies, sweepDeadArmies } from './armies';
import { progressConstruction } from './buildings';
import { createCache, rebuildArmyIndex, takeEvents } from './cache';
import { separateColours } from './colours';
import { revertProvince } from './capture';
import { dayOf, hoursToTicks, isDayStart, isHourStart } from './clock';
import { resolveBattles } from './combat';
import { accrueHour } from './economy';
import { pushFeed } from './feed';
import { recordDay } from './history';
import { autoTrade, dailyMarket, decayHour } from './market';
import { advanceMovement, onOilShortageChanged } from './movement';
import { dailyProvinces, hourlyProvinces, rollRevolts } from './province';
import { refreshSupply, refreshVision } from './supply';
import { progressTraining } from './training';
import type { GameState, MapStatic, Sim, SimHooks, SimPhase, TickEvents } from './types';
import { evaluateStatus, vpShare } from './victory';

export interface SimOptions {
  recordCommands: boolean;
}

const AUTO_TRADE_EVERY_TICKS = hoursToTicks(MARKET.AUTO_TRADE_HOURS);

/**
 * Wraps a running state in a Sim with a freshly derived cache. The player's
 * vision is computed at once so the fog is right in the first frames; the
 * hourly phase recomputes it, so a loaded game and the uninterrupted one agree
 * from the next hour on (only the views read it in between).
 */
export function createSim(map: MapStatic, state: GameState, options: SimOptions): Sim {
  const sim: Sim = { map, state, cache: createCache(map, state, options.recordCommands) };
  refreshVision(sim);
  return sim;
}

function timed(hooks: SimHooks | undefined, phase: SimPhase, run: () => void): void {
  hooks?.phase(phase, 'start');
  run();
  hooks?.phase(phase, 'end');
}

/** (c) with the Oil re-timing that economy.ts cannot do itself (movement sits above it). */
function economyHour(sim: Sim): void {
  const { state } = sim;
  const oilBefore = state.nations.map((nation) => nation.shortage.oil);
  accrueHour(sim);
  for (const nation of state.nations) {
    const was = oilBefore[nation.ix]!;
    if (was === nation.shortage.oil) continue;
    const oldFactor = was ? ECONOMY.OIL_SHORT_SPEED : 1;
    const newFactor = nation.shortage.oil ? ECONOMY.OIL_SHORT_SPEED : 1;
    onOilShortageChanged(sim, nation.ix, oldFactor, newFactor);
  }
  progressConstruction(sim);
  progressTraining(sim);
}

/** (e) to (g). */
function provincesHour(sim: Sim): void {
  const { state } = sim;
  hourlyProvinces(sim);
  hourlyArmies(sim);
  for (const p of rollRevolts(sim)) revertProvince(sim, p);
  decayHour(sim);
  if (state.tick % AUTO_TRADE_EVERY_TICKS === 0 && state.nations[state.player]!.alive) autoTrade(sim, state.player);
  refreshVision(sim);
}

const percent = (share: number): string => `${(share * 100).toFixed(1)}%`;

/**
 * The midnight digest for the day that just ended. It is built from saved state
 * only (current holdings, the running attack tallies and yesterday's history
 * point), so a loaded game writes the same digest as the uninterrupted one;
 * that is why the attack figures are totals rather than the day's.
 */
function pushDigest(sim: Sim): void {
  const { state, cache } = sim;
  const { player, stats } = state;
  if (!state.nations[player]!.alive) return;
  const today = Math.floor(state.tick / TIME.TICKS_PER_DAY);
  const vp = cache.vp[player] ?? 0;
  let yesterday: number | null = null;
  for (let i = state.history.length - 1; i >= 0; i -= 1) {
    const point = state.history[i]!;
    if (point.day >= today) continue;
    yesterday = point.vp.find(([n]) => n === player)?.[1] ?? null;
    break;
  }
  const change = yesterday === null ? '' : `${vp >= yesterday ? '+' : ''}${vp - yesterday} today, `;
  const provinces = cache.nationProvinces[player]?.length ?? 0;
  // Today's digest supersedes yesterday's: a line every midnight would bury the
  // news in Mine and, once the feed is full, push real events out of it.
  for (let i = state.feed.length - 1; i >= 0; i -= 1) if (state.feed[i]!.kind === 'digest') state.feed.splice(i, 1);
  pushFeed(sim, {
    kind: 'digest',
    severity: 'info',
    text: `Day ${dayOf(state.tick - 1)}: ${provinces} provinces, VP ${vp} (${change}${percent(vpShare(sim, player))}), attacks won ${stats.attacksWon}, lost ${stats.attacksLost}`,
    nations: [player],
    province: null,
    army: null,
  });
}

function dailyPhase(sim: Sim): void {
  const { state } = sim;
  dailyProvinces(sim);
  dailyMarket(sim);
  if (state.tick > 0) pushDigest(sim);
  recordDay(sim);
  if (Math.floor(state.tick / TIME.TICKS_PER_DAY) % AI_TIERS.REVIEW_DAYS === 0) reviewTiers(sim);
}

/** One 15-minute step in the §1 phase order. */
export function stepTick(sim: Sim, hooks?: SimHooks): void {
  const { state, cache } = sim;
  const hourly = isHourStart(state.tick);
  const ownership = cache.ownershipVersion;

  timed(hooks, 'movement', () => {
    advanceMovement(sim);
    rebuildArmyIndex(sim);
  });
  if (hourly) {
    timed(hooks, 'combat', () => {
      refreshSupply(sim);
      resolveBattles(sim);
    });
    timed(hooks, 'economy', () => economyHour(sim));
    timed(hooks, 'provinces', () => provincesHour(sim));
  }
  if (isDayStart(state.tick)) timed(hooks, 'daily', () => dailyPhase(sim));
  timed(hooks, 'ai', () => {
    aiPhase(sim);
    // The Staff keeps its own 4-hour cadence in the player's AiMemory.nextThink.
    staffPhase(sim);
  });
  timed(hooks, 'sweep', () => {
    if (cache.ownershipVersion !== ownership) separateColours(sim);
    if (hourly || cache.ownershipVersion !== ownership) evaluateStatus(sim);
    sweepDeadArmies(sim);
    rebuildArmyIndex(sim);
    state.tick += 1;
    cache.events.ticks += 1;
  });
}

/** Runs `ticks` steps and hands back everything they reported. */
export function advance(sim: Sim, ticks: number, hooks?: SimHooks): TickEvents {
  for (let i = 0; i < ticks; i += 1) stepTick(sim, hooks);
  return takeEvents(sim);
}
