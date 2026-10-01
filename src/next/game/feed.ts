/**
 * The notifications feed. Every system reports through pushFeed, which drops
 * news the player would never see, coalesces repeats, throttles sightings and
 * keeps the feed capped; the tick's new entries also go to events.feed for
 * toasts. Alerts only travel in events (they drive auto-pause) and are not saved.
 */
import { CAPITAL, FEED } from './balance';
import { hoursToTicks } from './clock';
import type { Alert, FeedEntry, FeedKind, FeedScope, NationIx, ProvinceIx, Sim, SimCache } from './types';

export type FeedDraft = Omit<FeedEntry, 'id' | 'tick' | 'count'>;

/** Kinds that are world news whatever their scale. */
const ALWAYS_WORLD: ReadonlySet<FeedKind> = new Set<FeedKind>(['capitalLost', 'milestone']);
/** Kinds that are world news when an empire is involved. */
const EMPIRE_WORLD: ReadonlySet<FeedKind> = new Set<FeedKind>(['capitulation', 'eliminated']);

/** What lies around the player's land, recomputed when ownership changes. */
interface Surroundings {
  version: number;
  /** 1 for provinces within 2 hops of the player's land (the land included). */
  near: Uint8Array;
  /** 1 for nations holding a province next to the player's land. */
  neighbours: Uint8Array;
}
const NEAR_HOPS = 2;
const surroundingsByCache = new WeakMap<SimCache, Surroundings>();

function surroundings(sim: Sim): Surroundings {
  const { map, state, cache } = sim;
  const known = surroundingsByCache.get(cache);
  if (known !== undefined && known.version === cache.ownershipVersion) return known;
  const near = new Uint8Array(map.provinces.length);
  const neighbours = new Uint8Array(map.nations.length);
  let frontier: number[] = [];
  for (const p of cache.nationProvinces[state.player] ?? []) {
    near[p] = 1;
    frontier.push(p);
  }
  for (let hop = 0; hop < NEAR_HOPS; hop += 1) {
    const next: number[] = [];
    for (const p of frontier) {
      for (const edge of map.edges[p]!) {
        const owner = state.provinces[edge.to]!.owner;
        if (hop === 0 && owner !== state.player) neighbours[owner] = 1;
        if (near[edge.to] === 0) {
          near[edge.to] = 1;
          next.push(edge.to);
        }
      }
    }
    frontier = next;
  }
  const fresh = { version: cache.ownershipVersion, near, neighbours };
  surroundingsByCache.set(cache, fresh);
  return fresh;
}

/** True when the player is one of `nations`, or owns `province`. */
export function concernsPlayer(sim: Sim, nations: readonly NationIx[], province: ProvinceIx | null): boolean {
  const { player } = sim.state;
  if (nations.includes(player)) return true;
  return province !== null && sim.state.provinces[province]?.owner === player;
}

function isNearby(sim: Sim, nations: readonly NationIx[], province: ProvinceIx | null): boolean {
  const around = surroundings(sim);
  if (province !== null && around.near[province] === 1) return true;
  return nations.some((n) => around.neighbours[n] === 1);
}

function isEmpire(sim: Sim, n: NationIx): boolean {
  const size = Math.max(sim.map.nations[n]?.home.length ?? 0, sim.cache.nationProvinces[n]?.length ?? 0);
  return size >= CAPITAL.EMPIRE_PROVINCES;
}

function isWorldNews(sim: Sim, kind: FeedKind, nations: readonly NationIx[]): boolean {
  if (ALWAYS_WORLD.has(kind)) return true;
  return EMPIRE_WORLD.has(kind) && nations.some((n) => isEmpire(sim, n));
}

/** Whether an entry belongs in any tab at all; nothing else is stored. */
function isRelevant(sim: Sim, entry: FeedDraft): boolean {
  return (
    concernsPlayer(sim, entry.nations, entry.province) ||
    isNearby(sim, entry.nations, entry.province) ||
    isWorldNews(sim, entry.kind, entry.nations)
  );
}

function inScope(sim: Sim, entry: FeedDraft, scope: FeedScope): boolean {
  const mine = concernsPlayer(sim, entry.nations, entry.province);
  if (scope === 'mine') return mine;
  if (scope === 'nearby') return !mine && isNearby(sim, entry.nations, entry.province);
  return isWorldNews(sim, entry.kind, entry.nations);
}

function sameSubject(entry: FeedEntry, draft: FeedDraft): boolean {
  if (entry.kind !== draft.kind || entry.province !== draft.province) return false;
  if (entry.nations.length !== draft.nations.length) return false;
  return entry.nations.every((n, i) => n === draft.nations[i]);
}

/** Records a feed entry if it belongs in any tab, coalescing it with a recent same-subject entry. */
export function pushFeed(sim: Sim, entry: FeedDraft): void {
  const { state, cache } = sim;
  if (!isRelevant(sim, entry)) return;
  if (entry.kind === 'enemySighted' && entry.province !== null) {
    if (state.tick - cache.sightedAt[entry.province]! < hoursToTicks(FEED.SIGHTED_COOLDOWN_HOURS)) return;
    cache.sightedAt[entry.province] = state.tick;
  }
  const window = entry.kind === 'unitsReady' ? FEED.UNITS_READY_MERGE_TICKS : FEED.MERGE_WINDOW_TICKS;
  // The feed is newest first and ticks never decrease, so the scan stops at the window's edge.
  for (let i = 0; i < state.feed.length; i += 1) {
    const recent = state.feed[i]!;
    if (state.tick - recent.tick >= window) break;
    if (!sameSubject(recent, entry)) continue;
    recent.count += 1;
    recent.tick = state.tick;
    recent.text = entry.text;
    recent.severity = entry.severity;
    recent.army = entry.army;
    state.feed.splice(i, 1);
    state.feed.unshift(recent);
    if (!cache.events.feed.includes(recent)) cache.events.feed.push(recent);
    return;
  }
  const created: FeedEntry = {
    id: state.nextFeedId,
    tick: state.tick,
    kind: entry.kind,
    severity: entry.severity,
    text: entry.text,
    nations: [...entry.nations],
    province: entry.province,
    army: entry.army,
    count: 1,
  };
  state.nextFeedId += 1;
  state.feed.unshift(created);
  if (state.feed.length > FEED.MAX_ENTRIES) state.feed.length = FEED.MAX_ENTRIES;
  cache.events.feed.push(created);
}

/** Queues an alert for the store (auto-pause, the "latest alert" key); duplicates within a batch are dropped. */
export function raiseAlert(sim: Sim, alert: Alert): void {
  const alerts = sim.cache.events.alerts;
  const duplicate = alerts.some((a) => a.kind === alert.kind && a.province === alert.province && a.nation === alert.nation);
  if (!duplicate) alerts.push({ ...alert });
}

/**
 * Entries for one tab, newest first. Mine involves the player; Nearby involves
 * the player's neighbours or lies within 2 hops of the player's land (and is not
 * Mine); World is capitals, milestones and empire-scale surrenders.
 */
export function feedFor(sim: Sim, scope: FeedScope, limit: number): readonly FeedEntry[] {
  const out: FeedEntry[] = [];
  for (const entry of sim.state.feed) {
    if (out.length >= limit) break;
    if (inScope(sim, entry, scope)) out.push(entry);
  }
  return out;
}
