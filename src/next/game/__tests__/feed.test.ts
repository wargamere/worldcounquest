import { describe, expect, it } from 'vitest';
import { FEED } from '../balance';
import { setOwner, takeEvents } from '../cache';
import { hoursToTicks } from '../clock';
import type { FeedDraft } from '../feed';
import { concernsPlayer, feedFor, pushFeed, raiseAlert } from '../feed';
import type { NationIx, ProvinceIx } from '../types';
import { tinySim } from './helpers';

/** me(m1) – nb(n1) – nb(n2) – x(x1) – y(y1): n2 is 2 hops from my land, x1 is 3. */
function chain() {
  return tinySim({
    provinces: {
      m1: { owner: 'me' },
      n1: { owner: 'nb' },
      n2: { owner: 'nb' },
      x1: { owner: 'x' },
      y1: { owner: 'y' },
    },
    edges: [
      ['m1', 'n1'],
      ['n1', 'n2'],
      ['n2', 'x1'],
      ['x1', 'y1'],
    ],
  });
}

function draft(kind: FeedDraft['kind'], nations: NationIx[], province: ProvinceIx | null, text: string = kind): FeedDraft {
  return { kind, severity: 'info', text, nations, province, army: null };
}

describe('pushFeed', () => {
  it('records the player’s news newest first, with ids, and reports it in events', () => {
    const { sim, p, n } = chain();
    pushFeed(sim, draft('battleStarted', [n('me'), n('nb')], p('m1')));
    sim.state.tick = 10;
    pushFeed(sim, draft('unitsReady', [n('me')], p('m1')));
    expect(sim.state.feed.map((e) => [e.id, e.kind, e.tick, e.count])).toEqual([
      [2, 'unitsReady', 10, 1],
      [1, 'battleStarted', 0, 1],
    ]);
    expect(takeEvents(sim).feed.map((e) => e.id)).toEqual([1, 2]);
  });

  it('drops distant news, keeps nearby news and world news', () => {
    const { sim, p, n } = chain();
    pushFeed(sim, draft('battleStarted', [n('x'), n('y')], p('y1'), 'far away'));
    pushFeed(sim, draft('battleStarted', [n('y'), n('x')], p('x1'), 'three hops'));
    pushFeed(sim, draft('battleStarted', [n('x'), n('nb')], p('x1'), 'involves a neighbour'));
    pushFeed(sim, draft('provinceCaptured', [n('x')], p('n2'), 'two hops'));
    pushFeed(sim, draft('capitalLost', [n('y'), n('x')], p('y1'), 'a capital falls'));
    expect(sim.state.feed.map((e) => e.text)).toEqual(['a capital falls', 'two hops', 'involves a neighbour']);
  });

  it('coalesces same-subject entries within an hour, and unitsReady within 6 hours', () => {
    const { sim, p, n } = chain();
    pushFeed(sim, draft('battleWon', [n('me')], p('m1'), 'first'));
    sim.state.tick = FEED.MERGE_WINDOW_TICKS - 1;
    pushFeed(sim, draft('battleWon', [n('me')], p('m1'), 'second'));
    expect(sim.state.feed).toHaveLength(1);
    expect(sim.state.feed[0]).toMatchObject({ count: 2, text: 'second', tick: FEED.MERGE_WINDOW_TICKS - 1, id: 1 });
    pushFeed(sim, draft('battleWon', [n('me')], p('n1'), 'elsewhere'));
    expect(sim.state.feed).toHaveLength(2);
    sim.state.tick += FEED.MERGE_WINDOW_TICKS;
    pushFeed(sim, draft('battleWon', [n('me')], p('m1'), 'later'));
    expect(sim.state.feed.map((e) => e.text)).toEqual(['later', 'elsewhere', 'second']);

    pushFeed(sim, draft('unitsReady', [n('me')], p('m1'), 'ready'));
    sim.state.tick += FEED.UNITS_READY_MERGE_TICKS - 1;
    pushFeed(sim, draft('unitsReady', [n('me')], p('m1'), 'ready again'));
    expect(sim.state.feed[0]).toMatchObject({ kind: 'unitsReady', count: 2 });
  });

  it('moves a coalesced entry to the front', () => {
    const { sim, p, n } = chain();
    pushFeed(sim, draft('battleWon', [n('me')], p('m1')));
    pushFeed(sim, draft('battleLost', [n('me')], p('m1')));
    pushFeed(sim, draft('battleWon', [n('me')], p('m1')));
    expect(sim.state.feed.map((e) => [e.kind, e.count])).toEqual([
      ['battleWon', 2],
      ['battleLost', 1],
    ]);
    expect(takeEvents(sim).feed).toHaveLength(2);
  });

  it('reports an enemy sighting at most once per province per 12 hours', () => {
    const { sim, p, n } = chain();
    const sighting = () => pushFeed(sim, draft('enemySighted', [n('me'), n('nb')], p('m1')));
    sighting();
    sim.state.tick = hoursToTicks(2);
    sighting();
    expect(sim.state.feed[0]!.count).toBe(1);
    sim.state.tick = hoursToTicks(FEED.SIGHTED_COOLDOWN_HOURS) - 1;
    sighting();
    expect(sim.state.feed).toHaveLength(1);
    sim.state.tick = hoursToTicks(FEED.SIGHTED_COOLDOWN_HOURS);
    sighting();
    expect(sim.state.feed).toHaveLength(2);
  });

  it('keeps at most FEED.MAX_ENTRIES', () => {
    const { sim, p, n } = chain();
    for (let i = 0; i < FEED.MAX_ENTRIES + 20; i += 1) {
      sim.state.tick = i * FEED.MERGE_WINDOW_TICKS;
      pushFeed(sim, draft('battleWon', [n('me')], p('m1'), `#${i}`));
    }
    expect(sim.state.feed).toHaveLength(FEED.MAX_ENTRIES);
    expect(sim.state.feed[0]!.text).toBe(`#${FEED.MAX_ENTRIES + 19}`);
    expect(sim.state.nextFeedId).toBe(FEED.MAX_ENTRIES + 21);
  });

  it('follows the player’s borders as they move', () => {
    const { sim, p, n } = chain();
    pushFeed(sim, draft('battleStarted', [n('x'), n('y')], p('y1'), 'before'));
    setOwner(sim, p('n2'), n('me'));
    pushFeed(sim, draft('battleStarted', [n('x'), n('y')], p('y1'), 'after'));
    expect(sim.state.feed.map((e) => e.text)).toEqual(['after']);
  });
});

describe('feed tabs', () => {
  it('splits entries into Mine, Nearby and World', () => {
    const { sim, p, n } = chain();
    pushFeed(sim, draft('battleStarted', [n('me'), n('nb')], p('m1'), 'mine'));
    pushFeed(sim, draft('provinceCaptured', [n('nb'), n('x')], p('n2'), 'nearby'));
    pushFeed(sim, draft('capitalLost', [n('x'), n('y')], p('y1'), 'world'));
    pushFeed(sim, draft('milestone', [n('me')], null, 'my milestone'));
    const texts = (scope: 'mine' | 'nearby' | 'world') => feedFor(sim, scope, 10).map((e) => e.text);
    expect(texts('mine')).toEqual(['my milestone', 'mine']);
    expect(texts('nearby')).toEqual(['nearby']);
    expect(texts('world')).toEqual(['my milestone', 'world']);
    expect(feedFor(sim, 'mine', 1).map((e) => e.text)).toEqual(['my milestone']);
  });

  it('counts only empires’ surrenders as world news', () => {
    const provinces: Record<string, { owner: string }> = { m1: { owner: 'me' }, s1: { owner: 'small' } };
    for (let i = 0; i < 8; i += 1) provinces[`e${i}`] = { owner: 'empire' };
    const { sim, n } = tinySim({ provinces, edges: [] });
    pushFeed(sim, draft('capitulation', [n('small')], null, 'small'));
    pushFeed(sim, draft('capitulation', [n('empire')], null, 'empire'));
    expect(feedFor(sim, 'world', 10).map((e) => e.text)).toEqual(['empire']);
  });

  it('concernsPlayer checks the nations and the province owner', () => {
    const { sim, p, n } = chain();
    expect(concernsPlayer(sim, [n('me')], null)).toBe(true);
    expect(concernsPlayer(sim, [n('nb')], p('m1'))).toBe(true);
    expect(concernsPlayer(sim, [n('nb')], p('n1'))).toBe(false);
  });
});

describe('raiseAlert', () => {
  it('queues alerts once per batch', () => {
    const { sim, p, n } = chain();
    raiseAlert(sim, { kind: 'capitalAttacked', province: p('m1'), nation: n('nb') });
    raiseAlert(sim, { kind: 'capitalAttacked', province: p('m1'), nation: n('nb') });
    raiseAlert(sim, { kind: 'shortage', province: null, nation: null });
    expect(takeEvents(sim).alerts.map((a) => a.kind)).toEqual(['capitalAttacked', 'shortage']);
    raiseAlert(sim, { kind: 'capitalAttacked', province: p('m1'), nation: n('nb') });
    expect(takeEvents(sim).alerts).toHaveLength(1);
  });
});
