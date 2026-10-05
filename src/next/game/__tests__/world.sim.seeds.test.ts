import { describe, it } from 'vitest';
import { checkWorld, runWorld, WORLD_DAYS } from './worldRun';

describe(`the real world, ${WORLD_DAYS} days on Standard with a passive player`, () => {
  it.each(['ci-b', 'ci-c'])('%s: invariants every hour and the world stays alive', (seed) => {
    checkWorld(runWorld(seed, WORLD_DAYS, true));
  }, 180_000);
});
