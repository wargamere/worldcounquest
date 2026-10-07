/**
 * Province status, stability, the garrison, integration and revolts (§2.4–2.8).
 *
 * Status is derived, never stored: Home when the owner is the province's
 * original nation, Integrated once `integrated` is set, Occupied otherwise.
 * Revolts are only rolled here; sim.ts hands the list to capture.revertProvince,
 * so this module never imports capture.ts (§11.3).
 */
import { EFFECTS, GARRISON, PROVINCE, REVOLT, TIME } from './balance';
import { armiesAt, isContested, markIncomeDirty } from './cache';
import { pushFeed } from './feed';
import { asProvince } from './ids';
import { roll } from './rng';
import type { ProvinceIx, ProvinceStatus, Sim } from './types';

const HOURS_PER_DAY = TIME.TICKS_PER_DAY / TIME.TICKS_PER_HOUR;

export function statusOf(sim: Sim, p: ProvinceIx): ProvinceStatus {
  const province = sim.state.provinces[p]!;
  if (province.owner === sim.map.provinces[p]!.country) return 'home';
  return province.integrated ? 'integrated' : 'occupied';
}

/** Output multiplier for Funds, goods, Recruits and garrison regeneration. */
export function stabilityFactor(stability: number): number {
  const floor = PROVINCE.STABILITY_OUTPUT_FLOOR;
  return floor + ((1 - floor) * stability) / 100;
}

export function garrisonCap(sim: Sim, p: ProvinceIx): number {
  const ramparts = sim.state.provinces[p]!.buildings.ramparts;
  return sim.map.provinces[p]!.garrisonBase * PROVINCE.GARRISON[statusOf(sim, p)] * (1 + EFFECTS.RAMPARTS_GARRISON_PER_LEVEL * ramparts);
}

/** Garrison HP regained per game hour at the current stability. */
function regenPerHour(sim: Sim, p: ProvinceIx, cap: number): number {
  return (cap * GARRISON.REGEN_SHARE_PER_DAY * stabilityFactor(sim.state.provinces[p]!.stability)) / HOURS_PER_DAY;
}

/**
 * The garrison expected `hoursAhead` game hours from now, at today's stability.
 * A contested province does not regenerate, so its garrison is taken as it is.
 */
export function garrisonAt(sim: Sim, p: ProvinceIx, hoursAhead: number): number {
  const garrison = sim.state.provinces[p]!.garrison;
  if (hoursAhead <= 0 || isContested(sim, p)) return garrison;
  const cap = garrisonCap(sim, p);
  if (garrison >= cap) return garrison;
  return Math.min(cap, garrison + hoursAhead * regenPerHour(sim, p, cap));
}

/**
 * Resets what a change of hands resets. The caller has already called setOwner;
 * capture, surrender, liberation and revolts pass their own stability and then
 * adjust the garrison if theirs is not 0. Keep training goes with the queue: it
 * was the old owner's standing order.
 */
export function onCaptured(sim: Sim, p: ProvinceIx, stability: number): void {
  const province = sim.state.provinces[p]!;
  province.garrison = 0;
  province.stability = stability;
  province.heldSince = sim.state.tick;
  province.integrated = false;
  province.queue = [];
  province.construction = null;
  province.rally = null;
  province.keepTraining = false;
  markIncomeDirty(sim, province.owner);
}

/**
 * A combat hour: a battle ran in the province this hour. `contested` alone is
 * not enough, because a province captured in this hour's round keeps its flag
 * until the index is rebuilt; captureProvince clears battleSince when it ends
 * the battle.
 */
function foughtThisHour(sim: Sim, p: ProvinceIx): boolean {
  return isContested(sim, p) && sim.state.provinces[p]!.battleSince !== null;
}

/** Hourly: battle and hunger losses, drift toward the status target, then garrison regeneration. */
export function hourlyProvinces(sim: Sim): void {
  const { state } = sim;
  const drift = PROVINCE.STABILITY_DRIFT_PER_DAY / HOURS_PER_DAY;
  const hunger = PROVINCE.STABILITY_HUNGER_PER_DAY / HOURS_PER_DAY;
  for (let i = 0; i < state.provinces.length; i += 1) {
    const p = asProvince(i);
    const province = state.provinces[i]!;
    // Regeneration uses the stability the hour started with, as garrisonAt does.
    if (!isContested(sim, p)) {
      const cap = garrisonCap(sim, p);
      if (province.garrison < cap) province.garrison = Math.min(cap, province.garrison + regenPerHour(sim, p, cap));
    }
    let stability = province.stability;
    if (foughtThisHour(sim, p)) stability += PROVINCE.STABILITY_PER_BATTLE_HOUR;
    const hungry = state.nations[province.owner]!.shortage.food;
    if (hungry) stability += hunger;
    const target = PROVINCE.STABILITY_TARGET[statusOf(sim, p)];
    // A hungry province does not recover: drifting back up would cancel the hunger
    // penalty wherever stability sits at its target, which is most provinces.
    if (stability < target) stability = hungry ? stability : Math.min(target, stability + drift);
    else if (stability > target) stability = Math.max(target, stability - drift);
    stability = Math.min(100, Math.max(0, stability));
    // Income depends on stability: keeping the cache equal to a fresh computation
    // is what lets a loaded game (whose cache starts empty) continue identically.
    if (stability !== province.stability) markIncomeDirty(sim, province.owner);
    province.stability = stability;
  }
}

/**
 * Daily: occupied provinces held INTEGRATION_DAYS in a row integrate once their
 * original nation is dead.
 */
export function dailyProvinces(sim: Sim): void {
  const { map, state } = sim;
  const heldTicks = PROVINCE.INTEGRATION_DAYS * TIME.TICKS_PER_DAY;
  for (let i = 0; i < state.provinces.length; i += 1) {
    const p = asProvince(i);
    const province = state.provinces[i]!;
    const country = map.provinces[i]!.country;
    if (province.owner === country || province.integrated) continue;
    if (state.nations[country]!.alive || state.tick - province.heldSince < heldTicks) continue;
    province.integrated = true;
    markIncomeDirty(sim, province.owner);
    if (province.owner === state.player) {
      pushFeed(sim, {
        kind: 'integrated',
        severity: 'good',
        text: `${map.provinces[i]!.name} is integrated`,
        nations: [province.owner, country],
        province: p,
        army: null,
      });
    }
  }
}

/** Every §2.8 condition except the roll. */
function canRevolt(sim: Sim, p: ProvinceIx): boolean {
  const { state } = sim;
  const province = state.provinces[p]!;
  if (statusOf(sim, p) !== 'occupied' || province.stability >= REVOLT.STABILITY_BELOW) return false;
  if (state.tick < province.graceUntil || isContested(sim, p)) return false;
  if (!state.nations[sim.map.provinces[p]!.country]!.alive) return false;
  return !armiesAt(sim, p).some((army) => army.owner === province.owner);
}

/**
 * Hourly: provinces that revolt back to their original nation this hour. Rolls
 * state.rng once per eligible province, in province order; the caller reverts
 * them (capture.revertProvince).
 */
export function rollRevolts(sim: Sim): ProvinceIx[] {
  const out: ProvinceIx[] = [];
  for (let i = 0; i < sim.state.provinces.length; i += 1) {
    const p = asProvince(i);
    if (!canRevolt(sim, p)) continue;
    if (roll(sim, 0, 1) < REVOLT.CHANCE_PER_HOUR) out.push(p);
  }
  return out;
}
