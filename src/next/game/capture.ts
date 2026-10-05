/**
 * Changes of hands (§5.6–5.8): capture, walk-ins, capitulation, elimination,
 * the player's capital moving, and revolts back to the original nation. Every
 * change of owner goes through cache.setOwner; this module adds everything a
 * change of hands implies.
 */
import { CAPITAL, GARRISON, PROVINCE, REVOLT, TIME } from './balance';
import { armiesAt, armiesOf, isContested, markIncomeDirty, ownedProvinces, rebuildArmyIndex, setOwner } from './cache';
import { damageOnCapture } from './buildings';
import { isContestedNow, removeArmy, transferArmy } from './armies';
import { pushFeed, raiseAlert } from './feed';
import { garrisonCap, onCaptured } from './province';
import { recordStat, recordSurrender } from './stats';
import { STOCK_KEYS } from './types';
import type { Army, NationIx, ProvinceIx, Severity, Sim } from './types';
import { totalCount } from './units';

/** The stocks a capitulation hands over; Recruits are people and are lost. */
const SURRENDERED_STOCKS = STOCK_KEYS.filter((key) => key !== 'recruits');

function provinceName(sim: Sim, p: ProvinceIx): string {
  return sim.map.provinces[p]!.name;
}

function nationName(sim: Sim, n: NationIx): string {
  return sim.map.nations[n]!.name;
}

/** Good news when the player gains, `loss` when the player loses, info otherwise. */
function tone(sim: Sim, gainer: NationIx | null, loser: NationIx | null, loss: Severity = 'bad'): Severity {
  if (gainer !== null && gainer === sim.state.player) return 'good';
  if (loser !== null && loser === sim.state.player) return loss;
  return 'info';
}

/** Standing, living armies at `p`. */
function standingAt(sim: Sim, p: ProvinceIx): Army[] {
  return armiesAt(sim, p).filter((a) => a.alive && a.leg === null && a.at === p);
}

/**
 * After a change of hands mid-battle: if no foreign army is left, the battle is
 * over and everyone in it stands down; otherwise it goes on against the new owner.
 */
function settleBattle(sim: Sim, p: ProvinceIx): void {
  const province = sim.state.provinces[p]!;
  if (province.battleSince === null || isContestedNow(sim, p)) return;
  province.battleSince = null;
  for (const army of standingAt(sim, p)) army.battle = null;
  sim.cache.battleLog.delete(p);
}

/** A nation retaking its original capital sits there again if it had no seat. */
function reclaimSeat(sim: Sim, p: ProvinceIx, n: NationIx): void {
  const nation = sim.state.nations[n]!;
  if (nation.capital === null && sim.map.nations[n]!.capital === p) {
    nation.capital = p;
    sim.cache.supplyDirty[n] = true;
    markIncomeDirty(sim, n);
  }
}

/** Taking `p` from its AI owner would end that nation: it is the AI's original, current capital. */
export function capitulatesOnCapture(sim: Sim, p: ProvinceIx): boolean {
  const owner = sim.state.provinces[p]!.owner;
  const nation = sim.state.nations[owner]!;
  return nation.alive && !nation.isPlayer && sim.map.nations[owner]!.capital === p && nation.capital === p;
}

/**
 * `by` takes `p`: ownership, the reset of stability, garrison and queues, building
 * damage, the battle's continuation, news and statistics, and then whatever the
 * loss sets off: capitulation, the player's capital moving, or elimination.
 */
export function captureProvince(sim: Sim, p: ProvinceIx, by: NationIx): void {
  const { map, state } = sim;
  const province = state.provinces[p]!;
  const loser = province.owner;
  if (loser === by) return;
  const afterBattle = province.battleSince !== null;
  const liberation = map.provinces[p]!.country === by;
  const wasCapital = state.nations[loser]!.capital === p;
  const capitulates = capitulatesOnCapture(sim, p);

  setOwner(sim, p, by);
  onCaptured(sim, p, liberation ? PROVINCE.STABILITY_ON_LIBERATION : PROVINCE.STABILITY_ON_CAPTURE);
  damageOnCapture(sim, p);
  settleBattle(sim, p);
  reclaimSeat(sim, p, by);
  reportCapture(sim, p, by, loser, afterBattle);
  if (by === state.player && !state.nations[loser]!.isPlayer) state.nations[loser]!.ai.provoked = true;

  if (wasCapital) {
    pushFeed(sim, {
      kind: 'capitalLost',
      severity: tone(sim, by, loser, 'critical'),
      text: `${provinceName(sim, p)} has fallen to ${nationName(sim, by)}`,
      nations: [loser, by],
      province: p,
      army: null,
    });
    if (capitulates) capitulate(sim, loser, by);
    else if (loser === state.player) relocatePlayerCapital(sim);
    else state.nations[loser]!.capital = null;
  }
  if (state.nations[loser]!.alive && ownedProvinces(sim, loser).length === 0) eliminate(sim, loser, by);
}

function reportCapture(sim: Sim, p: ProvinceIx, by: NationIx, loser: NationIx, afterBattle: boolean): void {
  const { state } = sim;
  const name = provinceName(sim, p);
  if (by === state.player) {
    recordStat(sim, 'provincesCaptured', 1);
    if (afterBattle) recordStat(sim, 'attacksWon', 1);
    pushFeed(sim, {
      kind: afterBattle ? 'battleWon' : 'provinceCaptured',
      severity: 'good',
      text: `Took ${name} from ${nationName(sim, loser)}`,
      nations: [by, loser],
      province: p,
      army: null,
    });
  } else if (loser === state.player) {
    recordStat(sim, 'provincesLost', 1);
    pushFeed(sim, {
      kind: 'provinceLost',
      severity: 'bad',
      text: `Lost ${name} to ${nationName(sim, by)}`,
      nations: [loser, by],
      province: p,
      army: null,
    });
    raiseAlert(sim, { kind: 'provinceLost', province: p, nation: by });
  } else {
    pushFeed(sim, {
      kind: 'provinceCaptured',
      severity: 'info',
      text: `${nationName(sim, by)} took ${name} from ${nationName(sim, loser)}`,
      nations: [by, loser],
      province: p,
      army: null,
    });
  }
}

/** Walk-in (§4.4): an army arriving in a hostile province with no owner army and no garrison takes it. */
export function tryWalkIn(sim: Sim, army: Army): boolean {
  if (!army.alive || army.leg !== null) return false;
  const p = army.at;
  const province = sim.state.provinces[p]!;
  if (province.owner === army.owner || province.garrison >= GARRISON.EMPTY_BELOW) return false;
  if (standingAt(sim, p).some((a) => a.owner === province.owner)) return false;
  captureProvince(sim, p, army.owner);
  return true;
}

/**
 * An AI nation whose capital fell: its land passes to the winner with half its
 * garrison and a grace period against revolts, its armies at home join the winner
 * at half strength (frozen for a while), those abroad disband, and half its
 * stocks change hands. The loser is dead afterwards.
 */
export function capitulate(sim: Sim, loser: NationIx, winner: NationIx): void {
  const { map, state } = sim;
  const tick = state.tick;
  const handed = new Set<ProvinceIx>(ownedProvinces(sim, loser));
  handed.add(map.nations[loser]!.capital);
  let vp = 0;
  for (const p of [...ownedProvinces(sim, loser)]) {
    const province = state.provinces[p]!;
    const garrison = province.garrison;
    setOwner(sim, p, winner);
    onCaptured(sim, p, PROVINCE.STABILITY_ON_SURRENDER);
    province.garrison = garrison * CAPITAL.GARRISON_KEPT;
    province.graceUntil = tick + REVOLT.SURRENDER_GRACE_DAYS * TIME.TICKS_PER_DAY;
    vp += map.provinces[p]!.vp;
  }
  let units = 0;
  for (const army of [...armiesOf(sim, loser)]) {
    if (!army.alive) continue;
    if (army.leg === null && handed.has(army.at)) {
      const joined = transferArmy(sim, army, winner, CAPITAL.ARMY_KEPT);
      if (joined !== null) units += totalCount(joined.units);
    } else {
      removeArmy(sim, army);
    }
  }
  rebuildArmyIndex(sim);
  for (const p of handed) settleBattle(sim, p);

  const from = state.nations[loser]!;
  const to = state.nations[winner]!;
  for (const key of SURRENDERED_STOCKS) to.stocks[key] += from.stocks[key] * CAPITAL.STOCK_SHARE;
  markIncomeDirty(sim, winner);
  kill(sim, loser);

  const record = { loser, winner, tick, provinces: handed.size, vp: vp + map.provinces[map.nations[loser]!.capital]!.vp, units };
  if (winner === state.player) recordSurrender(sim, record);
  pushFeed(sim, {
    kind: 'capitulation',
    severity: tone(sim, winner, loser),
    text: `${nationName(sim, loser)} capitulates to ${nationName(sim, winner)}`,
    nations: [loser, winner],
    province: map.nations[loser]!.capital,
    army: null,
  });
  if (winner === state.player || map.nations[loser]!.home.length >= CAPITAL.EMPIRE_PROVINCES) {
    raiseAlert(sim, { kind: 'capitulation', province: map.nations[loser]!.capital, nation: loser });
  }
}

/** Marks a nation dead and empties it. */
function kill(sim: Sim, n: NationIx): void {
  const nation = sim.state.nations[n]!;
  nation.alive = false;
  nation.eliminatedAt = sim.state.tick;
  nation.capital = null;
  for (const key of STOCK_KEYS) nation.stocks[key] = 0;
  nation.ai.operations = [];
  nation.ai.alertAt = null;
  sim.cache.supplyDirty[n] = true;
}

/** A nation with no provinces left is gone; its armies disband. */
export function eliminate(sim: Sim, n: NationIx, by: NationIx | null): void {
  const nation = sim.state.nations[n]!;
  if (!nation.alive) return;
  for (const army of [...armiesOf(sim, n)]) removeArmy(sim, army);
  kill(sim, n);
  pushFeed(sim, {
    kind: 'eliminated',
    severity: n === sim.state.player ? 'critical' : tone(sim, by, n),
    text: `${nationName(sim, n)} has been eliminated`,
    nations: by === null ? [n] : [n, by],
    province: null,
    army: null,
  });
}

/**
 * The player's government moves to the most populous uncontested home province,
 * or failing that the most populous province held (ties to the lower index);
 * home provinces lose stability over it.
 */
export function relocatePlayerCapital(sim: Sim): void {
  const { map, state } = sim;
  const player = state.player;
  let best: ProvinceIx | null = null;
  let bestHome = false;
  let bestPop = -1;
  for (const p of ownedProvinces(sim, player)) {
    const home = map.provinces[p]!.country === player && !isContested(sim, p);
    const pop = map.provinces[p]!.population;
    if (best === null || (home && !bestHome) || (home === bestHome && pop > bestPop)) {
      best = p;
      bestHome = home;
      bestPop = pop;
    }
  }
  state.nations[player]!.capital = best;
  sim.cache.supplyDirty[player] = true;
  markIncomeDirty(sim, player);
  if (best === null) return;
  for (const p of ownedProvinces(sim, player)) {
    if (map.provinces[p]!.country !== player) continue;
    const province = state.provinces[p]!;
    province.stability = Math.max(0, province.stability + PROVINCE.STABILITY_RELOCATION);
  }
  recordStat(sim, 'capitalMoves', 1);
  pushFeed(sim, {
    kind: 'capitalMoved',
    severity: 'critical',
    text: `The government has moved to ${provinceName(sim, best)}`,
    nations: [player],
    province: best,
    army: null,
  });
}

/** A revolt: the province returns to its living original nation as home, half garrisoned. */
export function revertProvince(sim: Sim, p: ProvinceIx): void {
  const { map, state } = sim;
  const province = state.provinces[p]!;
  const original = map.provinces[p]!.country;
  const old = province.owner;
  if (old === original || !state.nations[original]!.alive) return;
  const wasSeat = state.nations[old]!.capital === p;
  setOwner(sim, p, original);
  onCaptured(sim, p, REVOLT.STABILITY_AFTER);
  province.garrison = REVOLT.GARRISON_SHARE * garrisonCap(sim, p);
  province.battleSince = null;
  reclaimSeat(sim, p, original);
  pushFeed(sim, {
    kind: 'revolt',
    severity: tone(sim, original, old),
    text: `${provinceName(sim, p)} rose up and returned to ${nationName(sim, original)}`,
    nations: [original, old],
    province: p,
    army: null,
  });
  if (old === state.player) {
    recordStat(sim, 'revoltsSuffered', 1);
    raiseAlert(sim, { kind: 'provinceLost', province: p, nation: original });
    if (wasSeat) relocatePlayerCapital(sim);
  } else if (wasSeat) {
    state.nations[old]!.capital = null;
  }
  if (state.nations[old]!.alive && ownedProvinces(sim, old).length === 0) eliminate(sim, old, original);
}
