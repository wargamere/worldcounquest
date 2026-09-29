import { describe, expect, it } from 'vitest';
import { areAdjacent, buildAdjacency, isolatedCountries } from '@/game/adjacency';
import type { SeaLink } from '@/game/types';

const playable = (...ids: string[]) => new Set(ids);
const sea = (a: string, b: string): SeaLink => ({ a, b, note: `${a}-${b}` });

describe('buildAdjacency', () => {
  it('turns neighbour indices into a symmetric id graph', () => {
    const graph = buildAdjacency([[1], [0, 2], [1]], ['a', 'b', 'c'], [], playable('a', 'b', 'c'));
    expect(graph).toEqual({ a: ['b'], b: ['a', 'c'], c: ['b'] });
  });

  it('is symmetric even when the input only lists one direction', () => {
    const graph = buildAdjacency([[1], [], []], ['a', 'b', 'c'], [], playable('a', 'b', 'c'));
    expect(graph['a']).toContain('b');
    expect(graph['b']).toContain('a');
  });

  it('drops geometries with no id', () => {
    const graph = buildAdjacency([[1], [0]], ['a', undefined], [], playable('a'));
    expect(graph).toEqual({ a: [] });
  });

  it('excludes countries outside the playable set, such as Antarctica', () => {
    const graph = buildAdjacency([[1], [0]], ['a', '010'], [], playable('a'));
    expect(Object.keys(graph)).toEqual(['a']);
    expect(graph['a']).toEqual([]);
  });

  it('adds sea links on top of land borders', () => {
    const graph = buildAdjacency([[], []], ['826', '250'], [sea('826', '250')], playable('826', '250'));
    expect(areAdjacent(graph, '826', '250')).toBe(true);
    expect(areAdjacent(graph, '250', '826')).toBe(true);
  });

  it('ignores sea links pointing at unplayable countries', () => {
    const graph = buildAdjacency([[]], ['826'], [sea('826', '999')], playable('826'));
    expect(graph['826']).toEqual([]);
  });

  it('never produces self-edges or duplicates', () => {
    const graph = buildAdjacency(
      [[0, 1, 1], [0, 0]],
      ['a', 'b'],
      [sea('a', 'b'), sea('b', 'a')],
      playable('a', 'b'),
    );
    expect(graph['a']).toEqual(['b']);
    expect(graph['b']).toEqual(['a']);
  });

  it('reports islands with no links at all', () => {
    const graph = buildAdjacency([[], []], ['a', 'b'], [], playable('a', 'b'));
    expect(isolatedCountries(graph).sort()).toEqual(['a', 'b']);
  });
});
