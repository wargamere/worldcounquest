/**
 * The order preview (§4.6, §8.3): routes, arrival times, flank directions, the
 * forecast and every warning for a move or attack the viewer is considering.
 * It plans exactly what orderMove would do and changes nothing.
 */
import { TIME } from './balance';
import { armiesAt, armyById, inboundTo, isContested } from './cache';
import { provinceSupplied } from './combat';
import { forecastPlans } from './forecast';
import { planEta, planOrder } from './movement';
import { isArmyVisible } from './supply';
import type { Army, ArmyId, NationIx, OrderPreview, OrderRoute, OrderWarning, ProvinceIx, Sim } from './types';
import { usesOil } from './units';
import { edgeBetween } from './world';

/** Armies whose arrivals are at least an hour apart meet the defence in different rounds. */
const STAGGER_TICKS = TIME.TICKS_PER_HOUR;

export function previewOrder(sim: Sim, viewer: NationIx, ids: readonly ArmyId[], to: ProvinceIx, together: boolean): OrderPreview {
  const { state, map } = sim;
  const armies = ids.map((id) => armyById(sim, id)).filter((a): a is Army => a !== undefined && a.alive);
  const nation = armies[0]?.owner ?? viewer;
  const intent = state.provinces[to]?.owner === nation ? 'move' : 'attack';
  const plans = planOrder(sim, nation, ids, to, together);
  if (typeof plans === 'string') {
    return { to, intent, routes: [], arriveInTicks: 0, directions: 0, forecast: null, warnings: ['noRoute'] };
  }

  const tick = state.tick;
  const routes: OrderRoute[] = plans.map((plan) => ({
    army: plan.army,
    nodes: plan.path.nodes,
    ticks: plan.path.ticks,
    departInTicks: plan.departAt - tick,
    hostileCrossings: plan.path.hostile,
    approach: plan.approach,
  }));
  const etas = plans.filter((p) => p.path.nodes.length > 0).map((p) => planEta(sim, p));
  const arriveInTicks = etas.length > 0 ? Math.max(...etas) : 0;
  const approaches = new Set(plans.map((p) => p.approach).filter((p): p is ProvinceIx => p !== null));
  const warnings: OrderWarning[] = [];
  const warn = (w: OrderWarning): void => {
    if (!warnings.includes(w)) warnings.push(w);
  };

  if (plans.some((p) => p.path.hostile > 0)) warn('crossesHostile');
  if (etas.length >= 2 && Math.max(...etas) - Math.min(...etas) >= STAGGER_TICKS) warn('staggered');
  const nationState = state.nations[nation]!;
  const capital = nationState.capital;
  if (capital !== null) {
    const leaving = armies.filter((a) => a.leg === null && a.at === capital && to !== capital);
    const guards = armiesAt(sim, capital).filter((a) => a.alive && a.owner === nation && a.leg === null);
    if (leaving.length > 0 && guards.every((g) => leaving.includes(g))) warn('capitalExposed');
  }
  if (nationState.shortage.oil && armies.some((a) => usesOil(a.units))) warn('oilShort');
  if (intent === 'attack' && !provinceSupplied(sim, nation, to)) warn('unsupplied');
  if (intent === 'attack' && plans.some((p) => p.approach !== null && edgeBetween(map, p.approach, to)?.sea === true)) warn('landing');
  const owner = state.provinces[to]!.owner;
  const fog = viewer === state.player;
  if (intent === 'attack' && inboundTo(sim, to).some((a) => a.alive && a.owner === owner && (!fog || isArmyVisible(sim, a)))) {
    warn('reinforcementsInbound');
  }
  if (armies.some((a) => a.leg === null && (a.battle !== null || isContested(sim, a.at)) && a.at !== to)) warn('leavesBattle');

  return {
    to,
    intent,
    routes,
    arriveInTicks,
    directions: approaches.size,
    forecast: intent === 'attack' ? forecastPlans(sim, viewer, to, plans) : null,
    warnings,
  };
}
