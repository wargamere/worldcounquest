import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { captureProvince } from '../capture';
import { assignColours, borderCost, PALETTE, PLAYER_COLOUR, separateColours, UNCLAIMED_COLOUR } from '../colours';
import type { CountrySeed } from '../types';
import { buildMap, countryGraph, parseFacts } from '../world';
import { tinySim } from './helpers';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const readJson = (path: string): unknown => JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
const map = buildMap(parseFacts(readJson('public/province-facts.json')), readJson('src/data/countries.seed.json') as CountrySeed[]);
const graph = countryGraph(map);
const ids = map.nations.map((n) => n.id);

function borders(colours: Record<string, string>): { count: number; weak: number; cost: number } {
  let count = 0;
  let weak = 0;
  let cost = 0;
  for (const id of ids) {
    for (const other of graph[id] ?? []) {
      if (id >= other) continue;
      const c = borderCost(colours[id]!, colours[other]!);
      count += 1;
      cost += c;
      if (c >= 10) weak += 1;
    }
  }
  return { count, weak, cost };
}

describe('assignColours on countryGraph', () => {
  it('never gives two neighbours the same colour on the real map', () => {
    for (const player of ['250', '643', '156', '840', '036']) {
      const colours = assignColours(ids, graph, player);
      expect(colours[player]).toBe(PLAYER_COLOUR);
      for (const id of ids) {
        if (id !== player) expect(PALETTE).toContain(colours[id]);
        for (const other of graph[id] ?? []) expect(colours[other], `${id} and ${other} share a colour`).not.toBe(colours[id]);
      }
    }
  });

  it('keeps hard-to-tell pairs to a small share of borders', () => {
    // Seven hues cannot pass all-pairs, and no colouring of this map keeps every
    // failing pair apart; this bounds how many borders are left with one.
    const result = borders(assignColours(ids, graph, '250'));
    expect(result.count).toBeGreaterThan(300);
    expect(result.weak / result.count).toBeLessThan(0.08);
    expect(result.cost).toBeLessThan(260);
  });

  it('scores identical colours as impossible and validated pairs as free', () => {
    expect(borderCost('#3987e5', '#3987e5')).toBe(Number.POSITIVE_INFINITY);
    expect(borderCost('#3987e5', '#9085e9')).toBe(10);
    expect(borderCost('#9085e9', '#3987e5')).toBe(10);
    expect(borderCost('#3987e5', '#d95926')).toBe(0);
    expect(PALETTE).not.toContain(PLAYER_COLOUR);
    expect(PALETTE).not.toContain(UNCLAIMED_COLOUR);
  });

  it('is deterministic', () => {
    expect(assignColours(ids, graph, '250')).toEqual(assignColours(ids, graph, '250'));
  });

  it('colours a tiny map from its country graph', () => {
    const { sim } = tinySim({
      provinces: { a: { owner: 'me' }, b: { owner: 'x' }, c: { owner: 'y' }, d: { owner: 'z' } },
      edges: [
        ['a', 'b'],
        ['b', 'c'],
        ['c', 'd'],
        ['d', 'b'],
      ],
    });
    const tinyGraph = countryGraph(sim.map);
    const colours = assignColours(['me', 'x', 'y', 'z'], tinyGraph, 'me');
    expect(new Set([colours.x, colours.y, colours.z]).size).toBe(3);
    expect(colours.me).toBe(PLAYER_COLOUR);
  });
});

describe('separateColours', () => {
  /** big (two provinces) and small share a colour; capturing mid's land brings them into contact. */
  function contact() {
    const world = tinySim({
      provinces: { h: { owner: 'me' }, a: { owner: 'big' }, a2: { owner: 'big' }, b: { owner: 'mid' }, c: { owner: 'small' } },
      edges: [
        ['h', 'a'],
        ['a', 'a2'],
        ['a2', 'b'],
        ['b', 'c'],
      ],
    });
    const { sim, n } = world;
    sim.state.nations[n('big')]!.colour = PALETTE[0];
    sim.state.nations[n('small')]!.colour = PALETTE[0];
    sim.state.nations[n('mid')]!.colour = PALETTE[1];
    return world;
  }

  it('recolours the smaller of two same-coloured nations that conquest brings into contact', () => {
    const { sim, n, p } = contact();
    captureProvince(sim, p('b'), n('big'));
    separateColours(sim);
    const small = sim.state.nations[n('small')]!.colour;
    expect(sim.state.nations[n('big')]!.colour).toBe(PALETTE[0]);
    expect(small).not.toBe(PALETTE[0]);
    expect(PALETTE).toContain(small);
    expect(sim.state.nations[n('me')]!.colour).toBe(PLAYER_COLOUR);
  });

  it('leaves the map alone when no twins meet, and is stable once separated', () => {
    const { sim, n, p } = contact();
    separateColours(sim);
    expect(sim.state.nations[n('small')]!.colour).toBe(PALETTE[0]);
    captureProvince(sim, p('b'), n('big'));
    separateColours(sim);
    const after = sim.state.nations.map((nation) => nation.colour);
    separateColours(sim);
    expect(sim.state.nations.map((nation) => nation.colour)).toEqual(after);
  });
});
