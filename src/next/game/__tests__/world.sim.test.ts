import { describe, expect, it } from 'vitest';
import { stateHash } from './helpers';
import { checkWorld, runWorld, WORLD_DAYS } from './worldRun';

describe(`the real world, ${WORLD_DAYS} days on Standard with a passive player`, () => {
  it('ci-a: invariants every hour, the world stays alive, and a second run gives the same state', () => {
    const first = runWorld('ci-a', WORLD_DAYS, true);
    checkWorld(first);
    // A passive player issues no commands, so replaying the command log is running the seed again.
    expect(first.sim.cache.commandLog!.some((entry) => entry.source === 'player')).toBe(false);
    expect(first.sim.cache.commandLog!.length).toBeGreaterThan(0);
    const second = runWorld('ci-a', WORLD_DAYS, false);
    expect(stateHash(second.sim)).toBe(stateHash(first.sim));
    expect(second.sim.cache.commandLog).toEqual(first.sim.cache.commandLog);
  }, 180_000);
});
